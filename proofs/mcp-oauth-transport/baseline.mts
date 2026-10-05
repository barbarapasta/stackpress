//node
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
//client
import { resolveListAuth } from '../../packages/stackpress-ai/src/helpers.js';
import { attachHttpToServer, McpHttpServer }
  from '../../packages/stackpress-ai/src/scripts/http.js';
import { attachSseToServer, McpSseServer }
  from '../../packages/stackpress-ai/src/scripts/sse.js';
import { call, close, context, initialize, keys, listen, report, rpc }
  from './fixture.mjs';

const checks: object[] = [];

//use the current class and registry unchanged, with real SDK and TCP sockets
for (const mode of [ 'stateful', 'stateless' ] as const) {
  const { ctx, resolver, sessions } = context();
  let resolutions = 0;
  const current = new McpHttpServer(ctx.plugin('mcp'), async req => {
    resolutions++;
    return resolveListAuth(resolver, req.headers.authorization);
  }, '127.0.0.1', 0, '/mcp', mode, { resolve() {}, reject() {} });
  const service = createServer((req, res) => current.dispatch(req, res));
  const base = await listen(service);
  try {
    const init = await rpc(base, initialize, keys.alice);
    assert.equal(init.response.status, 200, JSON.stringify(init.data));
    const session = init.response.headers.get('mcp-session-id') || undefined;
    const missing = await rpc(base, call(2), undefined, session);
    if (mode === 'stateful') {
      assert.match(missing.data.result.content[0].text, /alice/);
      const swapped = await rpc(base, call(3), keys.bob, session);
      assert.match(swapped.data.result.content[0].text, /alice/);
      sessions.delete('alice');
      const revoked = await rpc(base, call(4), keys.alice, session);
      assert.match(revoked.data.result.content[0].text, /alice/);
      assert.equal(resolutions, 1);
      checks.push({ name: 'current saved session', result: 'defect reproduced',
        observations: [ 'missing key retains Alice', 'Bob key retains Alice',
          'deleted backing session retains Alice', 'auth resolved only once' ] });
    } else {
      assert.ok(missing.data.error || missing.data.result.isError);
      const swapped = await rpc(base, call(3), keys.bob);
      assert.match(swapped.data.result.content[0].text, /bob/);
      checks.push({ name: 'current stateless', result: 'fresh per-request identity' });
    }
    const evilOrigin = await rpc(base, initialize, undefined, undefined,
      { origin: 'https://unapproved.example' });
    assert.equal(evilOrigin.response.status, 200);
    checks.push({ name: `${mode} browser Origin`, result: 'unapproved Origin accepted' });
  } finally {
    await close(service);
  }
}

//drive the real Ingest Node adapter, including its consumed body and stop logic
{
  const { ctx, resolver } = context();
  attachHttpToServer(resolver);
  const service = ctx.create();
  const base = await listen(service);
  try {
    const init = await rpc(base, initialize, keys.alice);
    assert.equal(init.response.status, 200, JSON.stringify(init.data));
    const session = init.response.headers.get('mcp-session-id')!;
    const read = await rpc(base, call(2), undefined, session);
    assert.match(read.data.result.content[0].text, /alice/);
    for (const method of [ 'GET', 'DELETE' ]) {
      const response = await fetch(`${base}/mcp`, { method,
        headers: { accept: 'text/event-stream', 'mcp-session-id': session },
        signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 404);
      await response.body?.cancel();
    }
    checks.push({ name: 'current real Ingest attached HTTP',
      result: 'POST parses correctly; missing key retains Alice; GET/DELETE fall through 404' });
  } finally {
    await close(service);
  }
}

//the legacy SDK writes tool replies to GET, while POST accepts each message
{
  const { ctx, resolver, sessions } = context();
  let resolutions = 0;
  const current = new McpSseServer(ctx.plugin('mcp'), async req => {
    resolutions++;
    return resolveListAuth(resolver, req.headers.authorization);
  }, '127.0.0.1', 0, '/sse', '/messages', { resolve() {}, reject() {} });
  const service = createServer((req, res) => current.dispatch(req, res));
  const base = await listen(service);
  const controller = new AbortController();
  try {
    const stream = await fetch(`${base}/sse`, {
      headers: { authorization: `Bearer ${keys.alice}` }, signal: controller.signal
    });
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const endpoint = first.match(/data: (.+)/)![1];
    const send = async (body: object) => {
      const response = await fetch(`${base}${endpoint}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
      });
      assert.equal(response.status, 202);
      return new TextDecoder().decode((await reader.read()).value);
    };
    await send(initialize);
    sessions.delete('alice');
    const text = await send(call(2));
    assert.match(text, /alice/);
    assert.equal(resolutions, 1);
    checks.push({ name: 'current legacy SSE', result:
      'missing POST key and deleted backing session retain Alice' });
  } finally {
    controller.abort();
    await close(service);
  }
}
//the attached SSE message URL contains a query that req.data merges into JSON
{
  const { ctx, resolver } = context();
  ctx.config.set('mcp', { ...ctx.config<Record<string, unknown>>('mcp'), sse: { route: '/sse' } });
  attachSseToServer(resolver);
  const service = ctx.create();
  const base = await listen(service);
  const controller = new AbortController();
  try {
    const stream = await fetch(`${base}/sse`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const endpoint = first.match(/data: (.+)/)![1];
    const response = await fetch(`${base}${endpoint}`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initialize), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Invalid message/);
    checks.push({ name: 'current real Ingest attached older SSE', result:
      'initialize rejected400; req.data merges query sessionId into strict JSON-RPC body' });
  } finally {
    controller.abort();
    await close(service);
  }
}
await report('baseline', checks);
