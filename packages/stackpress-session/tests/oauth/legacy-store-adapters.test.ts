import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import type Engine from '@stackpress/inquire/Engine';
import EngineImpl from '@stackpress/inquire/Engine';
import Select from '@stackpress/inquire/Select';
import Update from '@stackpress/inquire/Update';
import {
  createAllOAuthTables,
  OAUTH_LEGACY_BINDING_TABLE
} from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { hashWithDomain } from '../../src/oauth/storage/ids.js';

//Task 00008's `createLegacyBinding`/`verifyLegacyBinding` reuse the exact
//same `Select`/`Insert`/`Update`/`engine.transaction()` primitives every
//other OAuthStore operation is already proven on across all four
//adapters (00003/00005); this suite is the dedicated per-adapter proof
//for these two specific methods, condensed to the cases that depend on
//per-adapter SQL/unique-key behavior rather than repeating the full
//input-validation matrix (already covered once, against PGlite, in
//events-legacy.test.ts). A new flat file, not an edit to the shared
//store-adapters.test.ts/store.test.ts task 00005 is still extending.

type AdapterContext = { engine: Engine, teardown: () => Promise<void> };

//Unique per process run so repeated `yarn test` invocations against the
//same persistent (non-disposable) PostgreSQL/MySQL container never see a
//previous run's leftover rows under these deterministic-looking legacy
//IDs (00007A found exactly this: two consecutive runs against the same
//container collided on `legacy-session-${name}`, since that ID's row and
//binding survive the test process exiting). Disposable per-run containers
//already avoid this, but the suite itself should not depend on that.
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function runAdapterSuite(name: string, setup: () => Promise<AdapterContext>) {
  describe(`OAuthStore legacy bindings cross-adapter (${name}, corrected Inquire d41472e)`, function () {
    this.timeout(30_000);
    let engine: Engine;
    let teardown: () => Promise<void>;
    let store: OAuthStore;

    before(async function () {
      //PostgreSQL/MySQL only run against a disposable container started
      //for this verification pass; skip gracefully (reported as
      //"pending", not failing) instead of failing `yarn test` on a
      //machine without one running - same convention as
      //store-adapters.test.ts.
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

    it('migration: oauth_legacy_binding is queryable after generation', async () => {
      const rows = await new Select('*', engine).from(OAUTH_LEGACY_BINDING_TABLE).limit(1);
      expect(Array.isArray(rows)).to.equal(true);
    });

    it('binds a real legacy record and verifies it back', async () => {
      const bind = await store.createLegacyBinding({
        kind: 'app',
        legacyId: `legacy-app-${name}-${RUN_ID}`,
        incarnation: '2026-01-01T00:00:00.000Z',
        resource: 'https://example.com/mcp'
      });
      expect(bind).to.deep.equal({ bound: true });
      const active = await store.verifyLegacyBinding({
        kind: 'app',
        legacyId: `legacy-app-${name}-${RUN_ID}`,
        incarnation: '2026-01-01T00:00:00.000Z',
        resource: 'https://example.com/mcp'
      });
      expect(active).to.equal(true);
    });

    it('migration adapter path: dry-run does no write, then the real bind is repeatable', async () => {
      const legacyId = `legacy-session-${name}-${RUN_ID}`;
      //dry-run equivalent: no store call at all (mirrors migrate.ts's
      //`dryRun` branch, which never calls createLegacyBinding)
      const before = await store.verifyLegacyBinding({
        kind: 'session', legacyId, incarnation: 'incarnation-1',
        resource: 'https://example.com/mcp'
      });
      expect(before).to.equal(false);
      //real bind
      const first = await store.createLegacyBinding({
        kind: 'session', legacyId, incarnation: 'incarnation-1',
        resource: 'https://example.com/mcp'
      });
      expect(first).to.deep.equal({ bound: true });
      //repeated migration run against the same still-valid record
      const second = await store.createLegacyBinding({
        kind: 'session', legacyId, incarnation: 'incarnation-1',
        resource: 'https://example.com/mcp'
      });
      expect(second).to.deep.equal({ bound: true });
    });

    it('rejects an oauth_-namespaced legacy ID', async () => {
      const bind = await store.createLegacyBinding({
        kind: 'app', legacyId: 'oauth_not-legacy', incarnation: 'x',
        resource: 'https://example.com/mcp'
      });
      expect(bind).to.deep.equal({ bound: false, reason: 'namespace_conflict' });
    });

    it('source deletion/recreation: a reused legacy ID with a new incarnation is rejected, not inherited', async () => {
      const legacyId = `legacy-recreate-${name}-${RUN_ID}`;
      await store.createLegacyBinding({
        kind: 'app', legacyId, incarnation: 'incarnation-old',
        resource: 'https://example.com/mcp'
      });
      const recreated = await store.createLegacyBinding({
        kind: 'app', legacyId, incarnation: 'incarnation-new',
        resource: 'https://example.com/mcp'
      });
      expect(recreated).to.deep.equal({ bound: false, reason: 'incarnation_mismatch' });
      //the new incarnation is correctly reported as not (yet) bound
      const verifiedAsNew = await store.verifyLegacyBinding({
        kind: 'app', legacyId, incarnation: 'incarnation-new',
        resource: 'https://example.com/mcp'
      });
      expect(verifiedAsNew).to.equal(false);
    });

    it('binding removal: deactivating the row ends verification, a unique-constraint-safe real UPDATE', async () => {
      const legacyId = `legacy-remove-${name}-${RUN_ID}`;
      await store.createLegacyBinding({
        kind: 'session', legacyId, incarnation: 'incarnation-1',
        resource: 'https://example.com/mcp'
      });
      expect(await store.verifyLegacyBinding({
        kind: 'session', legacyId, incarnation: 'incarnation-1',
        resource: 'https://example.com/mcp'
      })).to.equal(true);
      //removal: the generated admin page (amendment A-001) flips
      //`active` off through this same real table; proven directly here
      //with an ordinary `Update` against the real adapter.
      const rows = await new Select<Record<string, unknown>>('id', engine)
        .from(OAUTH_LEGACY_BINDING_TABLE)
        .where(
          'kind = ? AND legacy_id_hash = ? AND resource = ?',
          [ 'session', hashWithDomain('legacy-id', legacyId), 'https://example.com/mcp' ]
        )
        .limit(1);
      expect(rows.length > 0).to.equal(true);
      const row = rows[0];
      await new Update(OAUTH_LEGACY_BINDING_TABLE, engine)
        .set({ active: false })
        .where('id = ?', [ String(row.id) ]);
      expect(await store.verifyLegacyBinding({
        kind: 'session', legacyId, incarnation: 'incarnation-1',
        resource: 'https://example.com/mcp'
      })).to.equal(false);
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
// `docker run`/cleanup commands used alongside this run. Separate
// env-var prefix/ports from 00003/00005's own disposable containers so a
// concurrent run under the shared /tmp/oauth-db.lock never collides.

const PG_HOST = process.env.OAUTH_00008_PG_HOST || '127.0.0.1';
const PG_PORT = Number(process.env.OAUTH_00008_PG_PORT || 55565);
const PG_DATABASE = process.env.OAUTH_00008_PG_DATABASE || 'oauth_proof';
const PG_USER = process.env.OAUTH_00008_PG_USER || 'postgres';

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

const MYSQL_HOST = process.env.OAUTH_00008_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.OAUTH_00008_MYSQL_PORT || 55566);
const MYSQL_DATABASE = process.env.OAUTH_00008_MYSQL_DATABASE || 'oauth_proof';
const MYSQL_USER = process.env.OAUTH_00008_MYSQL_USER || 'root';

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
