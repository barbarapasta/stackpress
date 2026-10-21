import { describe, it, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import {
  createAllOAuthTables,
  OAUTH_CLIENT_TABLE,
  OAUTH_GRANT_TABLE
} from '../../src/oauth/storage/tables.js';

describe('OAuth Storage Tables (PGlite, in-memory, corrected Inquire d5f5a07)', () => {
  //in-memory instance, nothing written to disk, no shared VM state left behind
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine = new Engine(connection);

  after(async () => {
    await resource.close();
  });

  it('creates all nine private OAuth tables cleanly, once each', async () => {
    for (const create of createAllOAuthTables()) {
      create.engine = engine;
      await create;
    }
    //repeated generation must be stable: the Pgsql dialect emits
    //`CREATE TABLE IF NOT EXISTS`, so re-running the same Create builder
    //against an already-materialized table is a clean no-op, not an error.
    const duplicate = createAllOAuthTables()[0];
    duplicate.engine = engine;
    await duplicate;
  });

  it('enforces the oauth_client client_id uniqueness constraint', async () => {
    const insertOne = (id: string) => engine.query(
      `INSERT INTO ${OAUTH_CLIENT_TABLE} (id, client_id, kind, created) VALUES (?, ?, 'registered', now())`,
      [ id, 'dup-client-id' ]
    );
    await insertOne('client-row-1');
    let threw = false;
    try {
      await insertOne('client-row-2');
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('enforces the oauth_grant read_id_hash uniqueness constraint while leaving it nullable', async () => {
    const insertGrant = (id: string) => engine.query(
      `INSERT INTO ${OAUTH_GRANT_TABLE} (id, profile_id, client_id, resource, scopes, operation_fingerprints, deadline, access_seconds, generation, lock_version, revision, approved, created, updated) VALUES (?, 'p1', 'c1', 'https://example.com/mcp', '[]', '[]', now(), 900, 0, 0, 0, now(), now(), now())`,
      [ id ]
    );
    //two nullable read_id_hash rows must coexist (unique constraints ignore
    //NULL in standard SQL semantics)
    await insertGrant('grant-row-1');
    await insertGrant('grant-row-2');
    await engine.query(
      `UPDATE ${OAUTH_GRANT_TABLE} SET read_id_hash = ? WHERE id = ?`,
      [ 'same-hash', 'grant-row-1' ]
    );
    let threw = false;
    try {
      await engine.query(
        `UPDATE ${OAUTH_GRANT_TABLE} SET read_id_hash = ? WHERE id = ?`,
        [ 'same-hash', 'grant-row-2' ]
      );
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
