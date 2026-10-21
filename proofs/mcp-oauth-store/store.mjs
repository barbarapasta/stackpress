//node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** Hash synthetic credentials so proof storage has no raw bearer values. */
export function hash(value) {
  return createHash('sha256').update(value).digest('hex');
};

/** Create deliberately small tables through the actual Inquire adapter. */
export async function createTables(engine) {
  for (const table of [ 'proof_tokens', 'proof_codes', 'proof_grants' ]) {
    await engine.query(`DROP TABLE IF EXISTS ${table}`);
  }
  await engine.query(`CREATE TABLE proof_grants (
    id VARCHAR(80) PRIMARY KEY, cancelled INTEGER NOT NULL,
    serial INTEGER NOT NULL, deadline BIGINT NOT NULL,
    access_hash VARCHAR(64), access_secret_hash VARCHAR(64),
    access_expires BIGINT NOT NULL
  )`);
  await engine.query(`CREATE TABLE proof_codes (
    token_hash VARCHAR(64) PRIMARY KEY, grant_id VARCHAR(80) NOT NULL,
    used INTEGER NOT NULL
  )`);
  await engine.query(`CREATE TABLE proof_tokens (
    token_hash VARCHAR(64) PRIMARY KEY, grant_id VARCHAR(80) NOT NULL,
    used INTEGER NOT NULL, expires BIGINT NOT NULL
  )`);
};

/** Reset one synthetic approval without touching any application tables. */
export async function seed(engine, id) {
  await engine.query('DELETE FROM proof_tokens WHERE grant_id = ?', [ id ]);
  await engine.query('DELETE FROM proof_codes WHERE grant_id = ?', [ id ]);
  await engine.query('DELETE FROM proof_grants WHERE id = ?', [ id ]);
  await engine.query(`INSERT INTO proof_grants
    (id, cancelled, serial, deadline, access_hash, access_secret_hash, access_expires)
    VALUES (?, 0, 0, 10000, ?, ?, 1000)`,
    [ id, hash(`${id}:access0`), hash(`${id}:secret0`) ]);
  await engine.query(`INSERT INTO proof_codes
    (token_hash, grant_id, used) VALUES (?, ?, 0)`,
    [ hash(`${id}:code`), id ]);
  await engine.query(`INSERT INTO proof_tokens
    (token_hash, grant_id, used, expires) VALUES (?, ?, 0, 10000)`,
    [ hash(`${id}:refresh0`), id ]);
};

/** Serialize each approval by writing its row before reading mutable state. */
export async function operate(adapter, operation, onLock = async () => {}) {
  const { engine, native } = adapter;
  const { id, kind, token, replacement, fail = false, now = 100 } = operation;
  return engine.transaction(async connection => {
    // the callback receives a Connection, not an Engine or a checked-out clone
    assert.equal(connection, engine.connection);
    assert.equal(await connection.resource(), native);
    const query = (sql, values = []) => connection.query({ query: sql, values });
    // this portable UPDATE is the first table access: it obtains the write lock
    await query('UPDATE proof_grants SET serial = serial + 1 WHERE id = ?', [ id ]);
    await onLock();
    const [ grant ] = await query('SELECT * FROM proof_grants WHERE id = ?', [ id ]);
    if (!grant) {
      return { status: 'unknown' };
    }
    if (kind === 'revoke') {
      await query('UPDATE proof_grants SET cancelled = 1 WHERE id = ?', [ id ]);
      return { status: 'revoked' };
    }
    if (grant.cancelled || Number(grant.deadline) <= now) {
      return { status: 'inactive' };
    }
    const table = kind === 'code' ? 'proof_codes' : 'proof_tokens';
    const [ credential ] = await query(
      `SELECT * FROM ${table} WHERE token_hash = ? AND grant_id = ?`,
      [ hash(token), id ]
    );
    if (!credential) {
      return { status: 'unknown' };
    }
    if (credential.used) {
      if (kind === 'refresh') {
        // commit reuse detection and cancellation; throwing would undo both
        await query('UPDATE proof_grants SET cancelled = 1 WHERE id = ?', [ id ]);
      }
      return { status: 'reused' };
    }
    await query(`UPDATE ${table} SET used = 1 WHERE token_hash = ?`, [ hash(token) ]);
    await query(`INSERT INTO proof_tokens
      (token_hash, grant_id, used, expires) VALUES (?, ?, 0, ?)`,
      [ hash(replacement), id, Number(grant.deadline) ]);
    await query(`UPDATE proof_grants SET access_hash = ?, access_secret_hash = ?,
      access_expires = ? WHERE id = ?`,
      [ hash(`${replacement}:access`), hash(`${replacement}:secret`),
      Math.min(now + 900, Number(grant.deadline)), id ]);
    if (fail) {
      // a real database error forces the adapter's rollback path
      await query('INSERT INTO proof_table_that_does_not_exist (id) VALUES (?)', [ id ]);
    }
    return { status: 'issued', replacement };
  });
};
