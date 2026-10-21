import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import type Engine from '@stackpress/inquire/Engine';
import EngineImpl from '@stackpress/inquire/Engine';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { hashWithDomain, newPendingBinding } from '../../src/oauth/storage/ids.js';
import { createFactorReceipt, verifyFactorReceipt } from '../../src/oauth/factor.js';

//Task 00007 regression: the approval factor page saves the full signed
//receipt (factor.ts) on the pending row. The original VARCHAR(255)
//column rejected realistic receipts (found by the 00007 browser run with
//two scopes and two operations); the column is now TEXT. Runs on all
//four adapters with the same connection settings as store-adapters.test.ts
//(PostgreSQL/MySQL skip only when no disposable container is running).

type AdapterContext = { engine: Engine, teardown: () => Promise<void> };

function runSuite(name: string, setup: () => Promise<AdapterContext>) {
  describe(`OAuth factor receipt storage (${name}, task 00007)`, function () {
    this.timeout(30_000);
    let context: AdapterContext | undefined;
    let store: OAuthStore;

    before(async function () {
      try {
        context = await setup();
      } catch {
        this.skip();
        return;
      }
      for (const create of createAllOAuthTables()) {
        create.engine = context.engine;
        await create;
      }
      store = new OAuthStore(context.engine);
    });

    after(async () => {
      if (context) await context.teardown();
    });

    it('saves and reads back a full-length signed receipt for a realistic selection', async () => {
      const expires = new Date(Date.now() + 600_000);
      const pending = await store.createPending({
        id: `oauthp_${newPendingBinding()}`,
        bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
        clientId: 'oauthreg_client-for-receipt-length-check',
        redirectUri: 'http://127.0.0.1:47123/callback',
        codeChallenge: 'challenge-value-for-receipt-length-check-000000000000',
        resource: 'https://example.com/mcp',
        scopes: [ 'articles:read', 'articles:write', 'comments:read', 'comments:write' ],
        operations: [ 'articles.detail', 'articles.update', 'comments.search' ],
        expires
      });
      const content = {
        profileId: 'profile-with-a-reasonably-long-identifier-0001',
        pendingId: pending.id,
        scopes: [ 'articles:read', 'articles:write', 'comments:read', 'comments:write' ],
        operations: [ 'articles.detail', 'articles.update', 'comments.search' ]
      };
      const receipt = createFactorReceipt('seed', content, expires);
      expect(receipt.length).to.be.greaterThan(255);
      await store.setPendingFactorReceipt(pending.id, receipt);
      const saved = await store.getPendingById(pending.id);
      expect(saved?.factorReceipt).to.equal(receipt);
      expect(verifyFactorReceipt('seed', saved!.factorReceipt!, content, expires)).to.equal(true);
    });
  });
}

runSuite('PGlite', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const Connection = (await import('@stackpress/inquire-pglite/Connection')).default;
  const resource = new PGlite();
  return {
    engine: new EngineImpl(new Connection(resource)),
    teardown: async () => { await resource.close(); }
  };
});

runSuite('PostgreSQL', async () => {
  const { Client } = await import('pg');
  const Connection = (await import('@stackpress/inquire-pg/Connection')).default;
  const client = new Client({
    host: process.env.OAUTH_00003_PG_HOST || '127.0.0.1',
    port: Number(process.env.OAUTH_00003_PG_PORT || 55555),
    database: process.env.OAUTH_00003_PG_DATABASE || 'oauth_proof',
    user: process.env.OAUTH_00003_PG_USER || 'postgres'
  });
  await client.connect();
  return {
    engine: new EngineImpl(new Connection(client)),
    teardown: async () => { await client.end(); }
  };
});

runSuite('MySQL', async () => {
  const mysql = (await import('mysql2/promise')).default;
  const Connection = (await import('@stackpress/inquire-mysql2/Connection')).default;
  const client = await mysql.createConnection({
    host: process.env.OAUTH_00003_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.OAUTH_00003_MYSQL_PORT || 55556),
    database: process.env.OAUTH_00003_MYSQL_DATABASE || 'oauth_proof',
    user: process.env.OAUTH_00003_MYSQL_USER || 'root',
    timezone: 'Z'
  });
  return {
    engine: new EngineImpl(new Connection(client)),
    teardown: async () => { await client.end(); }
  };
});

runSuite('SQLite', async () => {
  const sqlite = (await import('better-sqlite3')).default;
  const Connection = (await import('@stackpress/inquire-sqlite3/Connection')).default;
  const resource = sqlite(':memory:');
  return {
    engine: new EngineImpl(new Connection(resource)),
    teardown: async () => { resource.close(); }
  };
});
