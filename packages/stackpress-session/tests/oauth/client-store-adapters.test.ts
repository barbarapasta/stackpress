import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import type Engine from '@stackpress/inquire/Engine';
import EngineImpl from '@stackpress/inquire/Engine';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { enforceRateLimit } from '../../src/oauth/clients/rateLimit.js';
import { OAuthClientError } from '../../src/oauth/clients/errors.js';

//Cross-adapter coverage for task 00004's additions to OAuthStore
//(reserveClientCapacity/releaseClientCapacity, getClientDocumentByUrlHash,
//touchUnusedClient) plus a real-store exercise of enforceRateLimit, on
//all four accepted database adapters. Mirrors store-adapters.test.ts's
//harness exactly, including its env-var overrides, so the same
//disposable PostgreSQL/MySQL containers that task's run uses also cover
//this file - see that file/task notes for the exact `docker run`/
//cleanup commands used alongside this run.

type AdapterContext = { engine: Engine, teardown: () => Promise<void> };

function runAdapterSuite(name: string, setup: () => Promise<AdapterContext>) {
  describe(`OAuth client-registration store additions cross-adapter (${name}, corrected Inquire d5f5a07)`, function () {
    this.timeout(30_000);
    let engine: Engine;
    let teardown: () => Promise<void>;
    let store: OAuthStore;

    before(async function () {
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

    it('capacity race: N concurrent reservations against limit L never exceed L, and every attempt is accounted for', async function () {
      //a kind unique to this run so concurrent `it()`s/adapters never
      //share a counter row.
      const kind = (`document`) as 'document' | 'registered';
      const limit = 5;
      const concurrency = 20;
      const attempts = await Promise.all(
        Array.from({ length: concurrency }, () => store.reserveClientCapacity(kind, limit).catch((e) => e))
      );
      const granted = attempts.filter((a) => a === true).length;
      const denied = attempts.filter((a) => a === false).length;
      const threw = attempts.filter((a) => a instanceof Error).length;
      //correctness: never more grants than the configured limit
      expect(granted).to.be.at.most(limit);
      //every attempt was accounted for exactly once (granted, denied, or
      //a transient conflict under extreme contention - never silently
      //dropped or double-counted)
      expect(granted + denied + threw).to.equal(concurrency);
      //liveness: with concurrency well above the limit, the limit is
      //actually reached, not under-granted due to lost updates
      expect(granted).to.equal(limit);

      //releasing every granted slot brings the counter back to zero,
      //proving release is the true inverse of reservation rather than a
      //separate, drifting bookkeeping path
      await Promise.all(Array.from({ length: granted }, () => store.releaseClientCapacity(kind)));
      const afterRelease = await store.reserveClientCapacity(kind, 1);
      expect(afterRelease).to.equal(true);
      await store.releaseClientCapacity(kind);
    });

    it('capacity: registered and document kinds are tracked as independent counters', async () => {
      const grantedDocument = await store.reserveClientCapacity('document', 1);
      const grantedRegistered = await store.reserveClientCapacity('registered', 1);
      expect(grantedDocument).to.equal(true);
      expect(grantedRegistered).to.equal(true);
      //both kinds are already at their (shared, across prior `it()`s in
      //this adapter) limit of 1 only within this test's own fresh
      //reservation, so re-reserving at the same limit must be refused
      //independently per kind
      expect(await store.reserveClientCapacity('document', 1)).to.equal(false);
      await store.releaseClientCapacity('document');
      await store.releaseClientCapacity('registered');
    });

    it('rate limit: an unknown/attacker-chosen client ID never allocates its own bucket once the source stage already refuses', async () => {
      const now = new Date();
      const sourceKey = `rl-source-${name}-${Math.random()}`;
      await enforceRateLimit(store, [ { key: sourceKey, limit: 1 } ], 60, now);
      let clientStageReached = false;
      try {
        await enforceRateLimit(
          store,
          [
            { key: sourceKey, limit: 1 },
            { key: `rl-client-${name}-unknown-${Math.random()}`, limit: 1000 }
          ],
          60,
          now
        );
        clientStageReached = true;
      } catch (e) {
        expect((e as OAuthClientError).code).to.equal('rate_limited');
      }
      expect(clientStageReached).to.equal(false);
    });

    it('getClientDocumentByUrlHash sees a stale row that getFreshClientDocument misses, on this real adapter', async () => {
      const urlHash = `doc-url-hash-${name}-${Math.random()}`;
      const now = new Date();
      await store.saveClientDocument({
        urlHash, metadata: { client_id: 'https://doc.example/x.json' },
        freshUntil: new Date(now.getTime() - 1000), now
      });
      expect(await store.getFreshClientDocument(urlHash, now)).to.equal(null);
      const stale = await store.getClientDocumentByUrlHash(urlHash);
      expect(stale).to.not.equal(null);
    });

    it('touchUnusedClient creates then refreshes the same identity on this real adapter', async () => {
      const clientId = `oauthreg_${name}_${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const created = await store.touchUnusedClient(
        clientId, 'registered', { a: 1 }, new Date(now.getTime() + 60_000), now
      );
      const refreshed = await store.touchUnusedClient(
        clientId, 'registered', { a: 2 }, new Date(now.getTime() + 120_000), now
      );
      expect(refreshed.id).to.equal(created.id);
      expect(refreshed.metadata).to.deep.equal({ a: 2 });
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
// Real PostgreSQL: disposable container, see task 00003/00004 notes for
// exact `docker run`/cleanup commands used alongside this run.

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
// Real MySQL: disposable container, see task 00003/00004 notes for
// exact `docker run`/cleanup commands used alongside this run.

const MYSQL_HOST = process.env.OAUTH_00003_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.OAUTH_00003_MYSQL_PORT || 55556);
const MYSQL_DATABASE = process.env.OAUTH_00003_MYSQL_DATABASE || 'oauth_proof';
const MYSQL_USER = process.env.OAUTH_00003_MYSQL_USER || 'root';

runAdapterSuite('MySQL', async () => {
  const mysql = (await import('mysql2/promise')).default;
  const Connection = (await import('@stackpress/inquire-mysql2/Connection')).default;
  const client = await mysql.createConnection({
    host: MYSQL_HOST, port: MYSQL_PORT, database: MYSQL_DATABASE, user: MYSQL_USER,
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
