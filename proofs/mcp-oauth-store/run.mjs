//node
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
//client
import { openAdapter } from './adapters.mjs';
import { createTables, hash, operate, seed } from './store.mjs';

/** Start a separate native database connection in an independent worker. */
function startWorker(config, operation, hold = false) {
  const location = new URL('./worker.mjs', import.meta.url);
  const input = { config, operation, hold };
  const worker = config.driver === 'sqlite'
    ? fork(location, [], { env: { ...process.env,
      OAUTH_PROOF_WORKER: JSON.stringify(input) } })
    : new Worker(location, { workerData: input });
  const postMessage = message => config.driver === 'sqlite'
    ? worker.send(message) : worker.postMessage(message);
  const events = {};
  const resolve = {};
  for (const name of [ 'ready', 'started', 'locked', 'result' ]) {
    events[name] = new Promise(done => { resolve[name] = done; });
  }
  worker.on('message', message => resolve[message.type](message));
  worker.on('error', error => {
    throw error;
  });
  return { worker: { postMessage }, ...events };
}

/** Reproduce unsafe overlap on the unmodified, shared adapter connection. */
async function sharedConnectionCounterexample(adapter) {
  const { engine } = adapter;
  await engine.query('DROP TABLE IF EXISTS proof_overlap');
  await engine.query('CREATE TABLE proof_overlap (id VARCHAR(30) PRIMARY KEY)');
  let innerError;
  let outerError;
  try {
    await engine.transaction(async connection => {
      await connection.query({
        query: 'INSERT INTO proof_overlap (id) VALUES (?)', values: [ 'outer' ]
      });
      // a second request starts while the first callback has yielded
      try {
        await engine.transaction(async other => {
          await other.query({
            query: 'INSERT INTO proof_overlap (id) VALUES (?)', values: [ 'inner' ]
          });
        });
      } catch (error) {
        innerError = error.message;
      }
      throw new Error('force outer rollback');
    });
  } catch (error) {
    outerError = error.message;
  }
  const rows = await engine.query('SELECT id FROM proof_overlap ORDER BY id');
  const isolated = !innerError && rows.length === 1 && rows[0].id === 'inner';
  assert.equal(isolated, false, 'expected current adapter overlap to be unsafe');
  // an ordinary query can also join another request's open transaction
  await engine.query('DELETE FROM proof_overlap');
  try {
    await engine.transaction(async () => {
      await engine.query('INSERT INTO proof_overlap (id) VALUES (?)', [ 'outsider' ]);
      throw new Error('force rollback after unrelated successful query');
    });
  } catch (error) {
    assert.equal(error.message, 'force rollback after unrelated successful query');
  }
  const outsiderLost = (await engine.query('SELECT * FROM proof_overlap')).length === 0;
  assert.equal(outsiderLost, true);
  return { isolated, rows, innerError, outerError, outsiderLost };
}

/** Exercise the candidate with connection ownership and a grant-row lock. */
async function runDriver(config) {
  const adapter = await openAdapter(config);
  const checks = [];
  const workerQueries = [];
  const baseline = await sharedConnectionCounterexample(adapter);
  await createTables(adapter.engine);
  let queue = Promise.resolve();
  // PGlite has one native session: exclusive ownership covers whole transactions
  const queued = operation => {
    const result = queue.then(() => operate(adapter, operation));
    queue = result.catch(() => {});
    return result;
  };
  const single = async operation => {
    try {
      return config.driver === 'pglite'
        ? await queued(operation) : await operate(adapter, operation);
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  };
  const pair = async (first, second, ordered = false) => {
    if (config.driver === 'pglite') {
      return Promise.all([ queued(first), queued(second) ]);
    }
    const left = startWorker(config, first, ordered);
    const right = startWorker(config, second);
    await Promise.all([ left.ready, right.ready ]);
    left.worker.postMessage('start');
    if (ordered) {
      await left.locked;
      right.worker.postMessage('start');
      await right.started;
      left.worker.postMessage('release');
    } else {
      right.worker.postMessage('start');
    }
    const results = await Promise.all([ left.result, right.result ]);
    workerQueries.push(...results.flatMap(result => result.queries));
    return results.map(result => result.result);
  };
  const grant = async id => (await adapter.engine.query(
    'SELECT * FROM proof_grants WHERE id = ?', [ id ]
  ))[0];
  const tokens = id => adapter.engine.query(
    'SELECT * FROM proof_tokens WHERE grant_id = ?', [ id ]
  );
  const code = id => ({
    id, kind: 'code', token: `${id}:code`, replacement: `${id}:first`
  });
  const refresh = (id, suffix = 'next') => ({
    id, kind: 'refresh', token: `${id}:refresh0`, replacement: `${id}:${suffix}`
  });

  // repeated runs alternate actual scheduling without relying on a sleep
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `code${attempt}`;
    await seed(adapter.engine, id);
    const results = await pair(code(id), { ...code(id), replacement: `${id}:second` });
    assert.deepEqual(results.map(result => result.status).sort(), [ 'issued', 'reused' ]);
    assert.equal((await tokens(id)).length, 2);
  }
  checks.push('five concurrent code exchanges: exactly one winner each');

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `refresh${attempt}`;
    await seed(adapter.engine, id);
    const results = await pair(refresh(id, 'left'), refresh(id, 'right'));
    assert.deepEqual(results.map(result => result.status).sort(), [ 'issued', 'reused' ]);
    assert.equal((await tokens(id)).length, 2);
    assert.equal((await grant(id)).cancelled, 1);
    const winner = results.find(result => result.status === 'issued');
    assert.equal((await single({ ...refresh(id), token: winner.replacement })).status,
      'inactive');
  }
  checks.push('five competing renewals: one winner; replay cancels the whole approval');

  await seed(adapter.engine, 'renew-first');
  assert.deepEqual((await pair(refresh('renew-first'), {
    id: 'renew-first', kind: 'revoke'
  }, true)).map(result => result.status), [ 'issued', 'revoked' ]);
  assert.equal((await grant('renew-first')).cancelled, 1);
  await seed(adapter.engine, 'revoke-first');
  assert.deepEqual((await pair({ id: 'revoke-first', kind: 'revoke' },
    refresh('revoke-first'), true)).map(result => result.status),
  [ 'revoked', 'inactive' ]);
  assert.equal((await tokens('revoke-first')).length, 1);
  checks.push('both renewal/revocation lock orders preserve cancellation');

  for (const kind of [ 'code', 'refresh' ]) {
    const id = `rollback-${kind}`;
    await seed(adapter.engine, id);
    const operation = kind === 'code' ? code(id) : refresh(id);
    assert.equal((await single({ ...operation, fail: true })).status, 'error');
    assert.equal((await tokens(id)).length, 1);
    assert.equal((await grant(id)).access_hash, hash(`${id}:access0`));
    assert.equal((await grant(id)).access_secret_hash, hash(`${id}:secret0`));
    assert.equal((await grant(id)).serial, 0);
    assert.equal((await single(operation)).status, 'issued');
  }
  checks.push('real SQL failure rolls back consumption, replacement, access key and lock row');

  await seed(adapter.engine, 'history');
  let current = 'history:refresh0';
  for (let generation = 1; generation <= 4; generation++) {
    const replacement = `history:refresh${generation}`;
    assert.equal((await single({ ...refresh('history'), token: current,
      replacement })).status, 'issued');
    current = replacement;
  }
  assert.equal((await tokens('history')).length, 5);
  assert.equal((await single(refresh('history'))).status, 'reused');
  assert.equal((await grant('history')).cancelled, 1);
  assert.equal((await single({ ...refresh('history'), token: current })).status,
    'inactive');
  checks.push('reuse four generations back is retained and stops the latest key');

  await seed(adapter.engine, 'deadline');
  assert.equal((await single({ ...refresh('deadline'), now: 9900 })).status, 'issued');
  assert.equal(Number((await grant('deadline')).deadline), 10000);
  assert.equal(Number((await grant('deadline')).access_expires), 10000);
  assert.notEqual((await grant('deadline')).access_hash, hash('deadline:access0'));
  assert.notEqual((await grant('deadline')).access_secret_hash, hash('deadline:secret0'));
  assert.equal((await single({ ...refresh('deadline'), token: 'deadline:next',
    now: 10000 })).status, 'inactive');
  checks.push('renewal preserves final deadline, caps access expiry, replaces old read ID and secret');

  await seed(adapter.engine, 'unknown');
  assert.equal((await single({ ...refresh('unknown'), token: 'not-a-real-token' }))
    .status, 'unknown');
  assert.equal((await grant('unknown')).cancelled, 0);
  checks.push('unknown token does not cancel someone else’s approval');
  checks.push('every callback and query retains the exact native transaction resource');
  const result = { driver: config.driver, version: adapter.version,
    baseline, candidate: 'pass', checks,
    queryCount: adapter.queries.length + workerQueries.length,
    queries: [...new Set([...adapter.queries, ...workerQueries])] };
  await adapter.close();
  return result;
}

const configs = [
  { driver: 'pglite' },
  { driver: 'postgres', port: Number(process.env.OAUTH_PROOF_PG_PORT) },
  { driver: 'mysql', port: Number(process.env.OAUTH_PROOF_MYSQL_PORT) },
  { driver: 'sqlite', file: `${process.env.OAUTH_PROOF_DEPS}/proof.sqlite` }
];
const results = [];
for (const config of configs) {
  const result = await runDriver(config);
  results.push(result);
  process.stdout.write(`${config.driver}: ${result.candidate}, ${result.checks.length} checks\n`);
  await writeFile(new URL('./results.json', import.meta.url), JSON.stringify({
    timestamp: new Date().toISOString(), node: process.version, results
  }, null, 2) + '\n');
}
