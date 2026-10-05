//Spec 00004 P-002 (GAP-010): can a chat turn stream on a long-lived server,
//work on a server that is built for every request, fall back to a single
//response, and resume after an approval pause from stored state alone?
//
//The model is a stub. It writes two pieces of text, then asks to run a tool
//that needs the person's approval. After approval it writes two more pieces.
//Turn state lives in a file, standing in for the database, so nothing is
//kept in process memory between requests.

//node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
//modules
import { server as ingest } from '@stackpress/ingest/http';

const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-turn-'));
const PAUSE = 40;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

//--------------------------------------------------------------------//
// Stored State

function load(threadId) {
  const file = path.join(STORE, `${threadId}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function save(threadId, turn) {
  fs.writeFileSync(path.join(STORE, `${threadId}.json`), JSON.stringify(turn));
}

function toolRuns(threadId) {
  const file = path.join(STORE, `${threadId}.runs`);
  return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
}

//--------------------------------------------------------------------//
// Stub Model And Tool

async function* model(phase) {
  if (phase === 'start') {
    yield { type: 'text', text: 'Checking the request. ' };
    await sleep(PAUSE);
    yield { type: 'text', text: 'It can be cancelled. ' };
    await sleep(PAUSE);
    yield { type: 'action', id: 'act-1', name: 'CANCEL_REQUEST', confirm: true };
    return;
  }
  yield { type: 'text', text: 'Cancelled. ' };
  await sleep(PAUSE);
  yield { type: 'text', text: 'Anything else?' };
}

function runTool(threadId) {
  fs.writeFileSync(path.join(STORE, `${threadId}.runs`), String(toolRuns(threadId) + 1));
  return 'Request cancelled';
}

//--------------------------------------------------------------------//
// Turn Runtime

async function runTurn(input, emit) {
  const { threadId } = input;
  if (input.message) {
    save(threadId, { status: 'RUNNING', pending: null });
    for await (const event of model('start')) {
      if (event.type === 'action' && event.confirm) {
        save(threadId, { status: 'WAITING_APPROVAL', pending: event });
        emit({ type: 'action', id: event.id, name: event.name, status: 'needs_approval' });
        return;
      }
      emit(event);
    }
    return;
  }
  const turn = load(threadId);
  if (!turn || turn.pending?.id !== input.approve) {
    emit({ type: 'error', error: 'No such pending action.' });
    return;
  }
  //an approval that was already used answers from the record and runs nothing
  if (turn.status === 'DONE') {
    emit({ type: 'action', id: turn.pending.id, name: turn.pending.name, status: 'done', result: turn.result, replayed: true });
    return;
  }
  const result = runTool(threadId);
  save(threadId, { ...turn, status: 'DONE', result });
  emit({ type: 'action', id: turn.pending.id, name: turn.pending.name, status: 'done', result });
  for await (const event of model('approved')) emit(event);
}

//--------------------------------------------------------------------//
// Application

function makeApp() {
  const app = ingest();
  app.post('/agent/turn', async ({ req, res }) => {
    const input = req.data();
    //fallback: run the step to its end and answer once
    if (!input.stream) {
      const events = [];
      await runTurn(input, event => events.push(event));
      res.results({ events });
      return;
    }
    //streaming: hand Ingest a stream and write events as they happen
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        await runTurn(input, event => controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        ));
        controller.close();
      }
    });
    res.headers.set('Cache-Control', 'no-cache');
    res.set('text/event-stream', body, 200);
  });
  return app;
}

async function listen(listener) {
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${listener.address().port}`;
}

//host A keeps one server for its whole life
const longLived = makeApp().create();
//host B builds a new server for every request, as a serverless entry does
let built = 0;
const perRequest = http.createServer(async (im, sr) => {
  built++;
  await makeApp().handle(im, sr);
});

//--------------------------------------------------------------------//
// Client

async function post(base, body) {
  return await fetch(`${base}/agent/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function once(base, body) {
  return (await (await post(base, body)).json()).results.events;
}

async function stream(base, body) {
  const response = await post(base, { ...body, stream: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const arrivals = [];
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push(Date.now());
    text += decoder.decode(value, { stream: true });
  }
  const events = text.split('\n\n').filter(Boolean).map(
    line => JSON.parse(line.replace(/^data: /, ''))
  );
  return {
    type: response.headers.get('content-type'),
    events,
    reads: arrivals.length,
    spread: arrivals[arrivals.length - 1] - arrivals[0]
  };
}

//--------------------------------------------------------------------//
// Checks

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([ 'PASS', name ]);
  } catch (error) {
    checks.push([ 'FAIL', `${name} :: ${error.message}` ]);
  }
}

const FIRST = [
  { type: 'text', text: 'Checking the request. ' },
  { type: 'text', text: 'It can be cancelled. ' },
  { type: 'action', id: 'act-1', name: 'CANCEL_REQUEST', status: 'needs_approval' }
];
const SECOND = [
  { type: 'action', id: 'act-1', name: 'CANCEL_REQUEST', status: 'done', result: 'Request cancelled' },
  { type: 'text', text: 'Cancelled. ' },
  { type: 'text', text: 'Anything else?' }
];

try {
  const hostA = await listen(longLived);
  const hostB = await listen(perRequest);

  for (const [ label, base ] of [ [ 'long-lived', hostA ], [ 'per-request', hostB ] ]) {
    const threadId = `stream-${label}`;
    const first = await stream(base, { threadId, message: 'Cancel request 12' });
    check(`${label}: the stream is served as an event stream`, () => {
      assert.match(String(first.type), /text\/event-stream/);
    });
    check(`${label}: the stream carries the expected events`, () => {
      assert.deepEqual(first.events, FIRST);
    });
    check(`${label}: events arrive as they happen, not in one piece`, () => {
      assert.ok(first.reads >= 2, `only ${first.reads} read`);
      assert.ok(first.spread >= PAUSE, `arrived within ${first.spread} ms`);
    });
    check(`${label}: the tool has not run while approval is pending`, () => {
      assert.equal(load(threadId).status, 'WAITING_APPROVAL');
      assert.equal(toolRuns(threadId), 0);
    });
    const second = await stream(base, { threadId, approve: 'act-1' });
    check(`${label}: the approved turn resumes and finishes`, () => {
      assert.deepEqual(second.events, SECOND);
      assert.equal(load(threadId).status, 'DONE');
    });
    const again = await once(base, { threadId, approve: 'act-1' });
    check(`${label}: a repeated approval does not run the tool twice`, () => {
      assert.equal(again[0].replayed, true);
      assert.equal(toolRuns(threadId), 1);
    });

    const plainId = `once-${label}`;
    const plainFirst = await once(base, { threadId: plainId, message: 'Cancel request 12' });
    const plainSecond = await once(base, { threadId: plainId, approve: 'act-1' });
    check(`${label}: the single-response fallback gives the same events`, () => {
      assert.deepEqual(plainFirst, FIRST);
      assert.deepEqual(plainSecond, SECOND);
    });
  }

  //start on one host and approve on the other: nothing but the store is shared
  const crossId = 'cross-host';
  await once(hostA, { threadId: crossId, message: 'Cancel request 12' });
  const crossed = await once(hostB, { threadId: crossId, approve: 'act-1' });
  check('a turn paused on one server resumes on a different server', () => {
    assert.deepEqual(crossed, SECOND);
    assert.equal(toolRuns(crossId), 1);
  });
  check('the per-request host really built a server for every request', () => {
    assert.ok(built >= 6, `built ${built}`);
  });
} finally {
  await new Promise(resolve => longLived.close(resolve));
  await new Promise(resolve => perRequest.close(resolve));
  fs.rmSync(STORE, { recursive: true, force: true });
}

for (const [ status, name ] of checks) console.log(status, name);
const failed = checks.filter(([ status ]) => status === 'FAIL').length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
