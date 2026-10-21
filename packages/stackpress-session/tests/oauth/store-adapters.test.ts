import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import type Engine from '@stackpress/inquire/Engine';
import EngineImpl from '@stackpress/inquire/Engine';
import Select from '@stackpress/inquire/Select';
import Insert from '@stackpress/inquire/Insert';
import Update from '@stackpress/inquire/Update';
import { createAllOAuthTables, OAUTH_RATE_BUCKET_TABLE, OAUTH_CODE_TABLE } from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { OAuthStoreError } from '../../src/oauth/storage/errors.js';
import { hashWithDomain, newPendingBinding } from '../../src/oauth/storage/ids.js';
import { computeS256Challenge } from '../../src/oauth/pkce.js';

//Same scenario set run against all four real adapters on the corrected
//Inquire d5f5a07 build: PGlite (in-memory, no external server), real
//PostgreSQL and MySQL (disposable tmpfs-backed Docker containers started
//for this run only - see task notes for exact commands/cleanup), and
//real SQLite (better-sqlite3, in-memory). This is a condensed version of
//store.test.ts's scenarios - migration, approval, exchange, reuse,
//refresh, concurrency and cleanup are the ones that most depend on
//per-adapter SQL/transaction behavior; the full input-validation matrix
//is only exercised once, against PGlite, in store.test.ts.

type AdapterContext = { engine: Engine, teardown: () => Promise<void> };
const CODE_VERIFIER = 'test-code-verifier-0123456789-abcdefghijk';
const CODE_CHALLENGE = computeS256Challenge(CODE_VERIFIER);

function runAdapterSuite(name: string, setup: () => Promise<AdapterContext>) {
  describe(`OAuthStore cross-adapter (${name}, corrected Inquire d5f5a07)`, function () {
    this.timeout(30_000);
    let engine: Engine;
    let teardown: () => Promise<void>;
    let store: OAuthStore;

    before(async function () {
      //PostgreSQL/MySQL only run against a disposable container started
      //for this verification pass (see task notes for the exact
      //docker run/cleanup commands); skip gracefully instead of failing
      //`yarn test` on a machine without one running.
      let ctx: AdapterContext;
      try {
        ctx = await setup();
      } catch (e) {
        this.skip();
        return;
      }
      engine = ctx.engine;
      teardown = ctx.teardown;
      for (const create of createAllOAuthTables()) {
        create.engine = engine;
        await create;
      }
      store = new OAuthStore(engine);
    });

    after(async () => {
      if (teardown) {
        await teardown();
      }
    });

    async function approvedGrant() {
      const pending = await store.createPending({
        id: `pending_${Math.random().toString(36).slice(2)}`,
        bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        codeChallenge: CODE_CHALLENGE,
        resource: 'https://example.com/mcp',
        scopes: [ 'articles:read' ],
        operations: [],
        expires: new Date(Date.now() + 600_000)
      });
      return store.approvePending({
        pendingId: pending.id,
        profileId: 'profile-1',
        approvedScopes: [ 'articles:read' ],
        approvedOperations: [],
        operationFingerprints: [],
        accessSeconds: 900,
        renewalSeconds: 604_800,
        codeSeconds: 60
      });
    }

    it('migration: all nine tables are queryable after generation', async () => {
      //asserts the tables exist and are queryable, not that they are
      //empty: real PostgreSQL/MySQL containers may be reused across
      //manual re-runs of this suite within one session (the disposable
      //container itself, not its data, is what task notes say is
      //removed after the run), so emptiness is not a safe assumption
      //here the way it is for the fresh in-memory PGlite/SQLite cases.
      for (const table of [
        'oauth_client', 'oauth_client_document', 'oauth_pending',
        'oauth_grant', 'oauth_code', 'oauth_refresh_token',
        'oauth_legacy_binding', 'oauth_factor_use', 'oauth_rate_bucket'
      ]) {
        const rows = await new Select('*', engine).from(table).limit(1);
        expect(Array.isArray(rows)).to.equal(true);
      }
    });

    it('approval + code exchange: issues a real access key bound to the grant', async () => {
      const { grant, code } = await approvedGrant();
      const issued = await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
      });
      expect(issued.grantId).to.equal(grant.id);
      expect(issued.accessId.startsWith('oauth_')).to.equal(true);
    });

    it('reuse: replaying a consumed code cancels the whole grant', async () => {
      const { grant, code } = await approvedGrant();
      await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
      });
      let threw: unknown = null;
      try {
        await store.exchangeCode({
          code,
          clientId: 'client-1',
          redirectUri: 'https://client.example/callback',
          resource: 'https://example.com/mcp',
          codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
        });
      } catch (e) {
        threw = e;
      }
      expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
      const grants = await store.listGrantsForProfile('profile-1');
      expect(grants.find((row) => row.id === grant.id)).to.equal(undefined);
    });

    it('refresh: rotates access and refresh token', async () => {
      const { code } = await approvedGrant();
      const first = await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
      });
      const refreshed = await store.refreshGrant({
        refreshToken: first.refreshToken as string,
        clientId: 'client-1',
        resource: 'https://example.com/mcp'
      });
      expect(refreshed.accessId).to.not.equal(first.accessId);
    });

    it('concurrency: two true-concurrent exchanges of the same code succeed exactly once', async () => {
      const { code } = await approvedGrant();
      const attempt = () => store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
      }).then(() => 'issued' as const).catch(() => 'rejected' as const);
      const results = await Promise.all([ attempt(), attempt() ]);
      expect(results.filter((r) => r === 'issued').length).to.equal(1);
      expect(results.filter((r) => r === 'rejected').length).to.equal(1);
    });

    async function freshPending() {
      return store.createPending({
        id: `pending_${Math.random().toString(36).slice(2)}`,
        bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        codeChallenge: CODE_CHALLENGE,
        resource: 'https://example.com/mcp',
        scopes: [ 'articles:read' ],
        operations: [],
        expires: new Date(Date.now() + 600_000)
      });
    }

    it('concurrency: two true-concurrent approvals of the same pending request create exactly one grant/code', async () => {
      const pending = await freshPending();
      const attempt = () => store.approvePending({
        pendingId: pending.id,
        profileId: 'profile-1',
        approvedScopes: [ 'articles:read' ],
        approvedOperations: [],
        operationFingerprints: [],
        accessSeconds: 900,
        renewalSeconds: 604_800,
        codeSeconds: 60
      }).then(() => 'approved' as const).catch(() => 'rejected' as const);
      const results = await Promise.all([ attempt(), attempt() ]);
      expect(results.filter((r) => r === 'approved').length).to.equal(1);
      expect(results.filter((r) => r === 'rejected').length).to.equal(1);
    });

    it('concurrency: two true-concurrent refreshes of the same token succeed exactly once', async () => {
      const { code } = await approvedGrant();
      const first = await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
      });
      const attempt = () => store.refreshGrant({
        refreshToken: first.refreshToken as string,
        clientId: 'client-1',
        resource: 'https://example.com/mcp'
      }).then(() => 'rotated' as const).catch(() => 'rejected' as const);
      const results = await Promise.all([ attempt(), attempt() ]);
      expect(results.filter((r) => r === 'rotated').length).to.equal(1);
      expect(results.filter((r) => r === 'rejected').length).to.equal(1);
    });

    it('reuse: an older-generation refresh token (two rotations behind) still cancels the whole grant', async () => {
      const { grant, code } = await approvedGrant();
      const gen1 = await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
      });
      const gen2 = await store.refreshGrant({
        refreshToken: gen1.refreshToken as string,
        clientId: 'client-1',
        resource: 'https://example.com/mcp'
      });
      //rotate once more so gen1's token is now two generations behind
      await store.refreshGrant({
        refreshToken: gen2.refreshToken as string,
        clientId: 'client-1',
        resource: 'https://example.com/mcp'
      });
      let threw: unknown = null;
      try {
        await store.refreshGrant({
          refreshToken: gen1.refreshToken as string,
          clientId: 'client-1',
          resource: 'https://example.com/mcp'
        });
      } catch (e) {
        threw = e;
      }
      expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
      const grants = await store.listGrantsForProfile('profile-1');
      expect(grants.find((row) => row.id === grant.id)).to.equal(undefined);
    });

    it('reuse: a consumed code presented again after its own short expiry still cancels the grant (replay, not a plain expiry rejection)', async () => {
      const { grant, code } = await approvedGrant();
      await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
        renewalSeconds: 604_800
      });
      //age the now-consumed code's own short expiry into the past,
      //while the grant's final deadline (not touched here) is still
      //well in the future - storage.md: "Recognize used-code replay
      //until the grant deadline even after the short code expiry."
      await new Update(OAUTH_CODE_TABLE, store.engine)
        .set({ expires: new Date(Date.now() - 1000) })
        .where('code_hash = ?', [ hashWithDomain('code', code) ]);
      let threw: unknown = null;
      try {
        await store.exchangeCode({
          code,
          clientId: 'client-1',
          redirectUri: 'https://client.example/callback',
          resource: 'https://example.com/mcp',
          codeVerifier: CODE_VERIFIER,
          renewalSeconds: 604_800
        });
      } catch (e) {
        threw = e;
      }
      expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
      const grants = await store.listGrantsForProfile('profile-1');
      expect(grants.find((row) => row.id === grant.id)).to.equal(undefined);
    });

    it('cancellation vs refresh races: competing refresh can never restore cancelled access, in either order and under true concurrency', async () => {
      //order A: revoke, then try to refresh with the pre-cancellation token
      {
        const { grant, code } = await approvedGrant();
        const issued = await store.exchangeCode({
          code,
          clientId: 'client-1',
          redirectUri: 'https://client.example/callback',
          resource: 'https://example.com/mcp',
          codeVerifier: CODE_VERIFIER,
          renewalSeconds: 604_800
        });
        expect(await store.cancelGrant(grant.id)).to.equal(true);
        let threw: unknown = null;
        try {
          await store.refreshGrant({
            refreshToken: issued.refreshToken as string,
            clientId: 'client-1',
            resource: 'https://example.com/mcp'
          });
        } catch (e) {
          threw = e;
        }
        expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
      }

      //order B: refresh (rotate), then revoke - the freshly rotated
      //token must also become unusable, not just the one it replaced
      {
        const { grant, code } = await approvedGrant();
        const issued = await store.exchangeCode({
          code,
          clientId: 'client-1',
          redirectUri: 'https://client.example/callback',
          resource: 'https://example.com/mcp',
          codeVerifier: CODE_VERIFIER,
          renewalSeconds: 604_800
        });
        const refreshed = await store.refreshGrant({
          refreshToken: issued.refreshToken as string,
          clientId: 'client-1',
          resource: 'https://example.com/mcp'
        });
        expect(await store.cancelGrant(grant.id)).to.equal(true);
        let threw: unknown = null;
        try {
          await store.refreshGrant({
            refreshToken: refreshed.refreshToken as string,
            clientId: 'client-1',
            resource: 'https://example.com/mcp'
          });
        } catch (e) {
          threw = e;
        }
        expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
      }

      //true concurrency: race cancelGrant and refreshGrant on the same
      //grant lock - whichever order the lock actually serializes them
      //in, the grant must end cancelled and any access issued by a
      //refresh that happened to win the race must not survive it
      {
        const { grant, code } = await approvedGrant();
        const issued = await store.exchangeCode({
          code,
          clientId: 'client-1',
          redirectUri: 'https://client.example/callback',
          resource: 'https://example.com/mcp',
          codeVerifier: CODE_VERIFIER,
          renewalSeconds: 604_800
        });
        const [ cancelResult, refreshResult ] = await Promise.allSettled([
          store.cancelGrant(grant.id),
          store.refreshGrant({
            refreshToken: issued.refreshToken as string,
            clientId: 'client-1',
            resource: 'https://example.com/mcp'
          })
        ]);
        expect(cancelResult.status).to.equal('fulfilled');
        const grants = await store.listGrantsForProfile('profile-1');
        expect(grants.find((row) => row.id === grant.id)).to.equal(undefined);
        if (refreshResult.status === 'fulfilled') {
          let threw: unknown = null;
          try {
            await store.refreshGrant({
              refreshToken: refreshResult.value.refreshToken as string,
              clientId: 'client-1',
              resource: 'https://example.com/mcp'
            });
          } catch (e) {
            threw = e;
          }
          expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
        }
      }
    });

    it('rollback: a forced real SQL failure inside a transaction leaves no partial write behind', async () => {
      const probeId = `rollback_probe_${Math.random().toString(36).slice(2)}`;
      let threw = false;
      try {
        await engine.transaction(async () => {
          await new Insert(OAUTH_RATE_BUCKET_TABLE, engine).values({
            id: probeId,
            key_hash: 'rollback-probe',
            window_start: new Date(),
            count: 1,
            expires: new Date()
          });
          //a real driver error: the table does not exist on any adapter
          await engine.query('INSERT INTO oauth_table_that_does_not_exist (x) VALUES (1)');
        });
      } catch (e) {
        threw = true;
      }
      expect(threw).to.equal(true);
      const rows = await new Select('*', engine)
        .from(OAUTH_RATE_BUCKET_TABLE)
        .where('id = ?', [ probeId ]);
      expect(rows.length).to.equal(0);
    });

    it('cleanup: removes an expired pending request without touching a live grant', async () => {
      const expiredId = `pending_expired_${name}_${Math.random().toString(36).slice(2)}`;
      await store.createPending({
        id: expiredId,
        bindingHash: hashWithDomain('pending-binding', `expired-${name}-${Math.random()}`),
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge',
        resource: 'https://example.com/mcp',
        scopes: [],
        operations: [],
        expires: new Date(Date.now() - 1000)
      });
      const { grant: liveGrant } = await approvedGrant();
      const counts = await store.cleanup(100);
      expect(counts.pending).to.be.greaterThan(0);
      expect(await store.getPendingById(expiredId)).to.equal(null);
      const liveGrants = await store.listGrantsForProfile('profile-1');
      expect(liveGrants.find((row) => row.id === liveGrant.id)).to.not.equal(undefined);
    });
  });
}

// ---------------------------------------------------------------------
// PGlite: in-memory, no external server

runAdapterSuite('PGlite', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const Connection = (await import('@stackpress/inquire-pglite/Connection')).default;
  const resource = new PGlite();
  const connection = new Connection(resource);
  return {
    engine: new EngineImpl(connection),
    teardown: async () => { await resource.close(); }
  };
});

// ---------------------------------------------------------------------
// Real PostgreSQL: disposable container, see task notes for exact
// `docker run`/cleanup commands used alongside this run.

const PG_HOST = process.env.OAUTH_00003_PG_HOST || '127.0.0.1';
const PG_PORT = Number(process.env.OAUTH_00003_PG_PORT || 55555);
const PG_DATABASE = process.env.OAUTH_00003_PG_DATABASE || 'oauth_proof';
const PG_USER = process.env.OAUTH_00003_PG_USER || 'postgres';

runAdapterSuite('PostgreSQL', async () => {
  const { Client } = await import('pg');
  const Connection = (await import('@stackpress/inquire-pg/Connection')).default;
  const client = new Client({ host: PG_HOST, port: PG_PORT, database: PG_DATABASE, user: PG_USER });
  await client.connect();
  const connection = new Connection(client);
  return {
    engine: new EngineImpl(connection),
    teardown: async () => { await client.end(); }
  };
});

// ---------------------------------------------------------------------
// Real MySQL: disposable container, see task notes for exact
// `docker run`/cleanup commands used alongside this run.

const MYSQL_HOST = process.env.OAUTH_00003_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.OAUTH_00003_MYSQL_PORT || 55556);
const MYSQL_DATABASE = process.env.OAUTH_00003_MYSQL_DATABASE || 'oauth_proof';
const MYSQL_USER = process.env.OAUTH_00003_MYSQL_USER || 'root';

runAdapterSuite('MySQL', async () => {
  const mysql = (await import('mysql2/promise')).default;
  const Connection = (await import('@stackpress/inquire-mysql2/Connection')).default;
  const client = await mysql.createConnection({
    host: MYSQL_HOST, port: MYSQL_PORT, database: MYSQL_DATABASE, user: MYSQL_USER,
    //required so DATETIME columns round-trip as the correct UTC instant;
    //see OAuthStore.ts's `withMysqlDateSafety()` doc comment
    timezone: 'Z'
  });
  const connection = new Connection(client);
  return {
    engine: new EngineImpl(connection),
    teardown: async () => { await client.end(); }
  };
});

// ---------------------------------------------------------------------
// Real SQLite: in-memory, no external server

runAdapterSuite('SQLite', async () => {
  const sqlite = (await import('better-sqlite3')).default;
  const Connection = (await import('@stackpress/inquire-sqlite3/Connection')).default;
  const resource = sqlite(':memory:');
  const connection = new Connection(resource);
  return {
    engine: new EngineImpl(connection),
    teardown: async () => { resource.close(); }
  };
});
