//node
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// proof dependencies live outside the repository workspaces
const require = createRequire(`${process.env.OAUTH_PROOF_DEPS}/package.json`);

/** Open one real native resource and its published Inquire adapter. */
export async function openAdapter(config) {
  const { driver } = config;
  let native;
  let close;
  let version;
  let name;
  if (driver === 'pglite') {
    const { PGlite } = require('@electric-sql/pglite');
    native = new PGlite();
    close = () => native.close();
    name = '@stackpress/inquire-pglite';
  } else if (driver === 'postgres') {
    const { Client } = require('pg');
    native = new Client({
      host: '127.0.0.1', port: config.port,
      database: 'oauth_proof', user: 'postgres'
    });
    await native.connect();
    close = () => native.end();
    name = '@stackpress/inquire-pg';
  } else if (driver === 'mysql') {
    native = await require('mysql2/promise').createConnection({
      host: '127.0.0.1', port: config.port,
      database: 'oauth_proof', user: 'root'
    });
    close = () => native.end();
    name = '@stackpress/inquire-mysql2';
  } else {
    const Database = require('better-sqlite3');
    native = new Database(config.file);
    native.pragma('busy_timeout = 5000');
    close = async () => native.close();
    name = '@stackpress/inquire-sqlite3';
  }
  const engine = require(name).connect(native);
  const queries = [];
  // check resource affinity before every query, including rollback
  engine.connection.before = async request => {
    assert.equal(await engine.connection.resource(), native);
    queries.push(request.query);
  };
  if (driver === 'sqlite') {
    version = (await engine.query('SELECT sqlite_version() AS version'))[0].version;
  } else {
    version = (await engine.query('SELECT version() AS version'))[0].version;
  }
  return { engine, native, close, queries, version };
};
