//node
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
//modules
import { server } from '@stackpress/ingest/http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
//client
import type { Grant } from './candidate.mjs';
import { LegacyCandidate } from './legacy-candidate.mjs';
import { close, listen, report } from './fixture.mjs';

/** Use a real SDK client, with a test-controlled credential on every fetch. */
async function connect(base: string, token?: string) {
  const state = { token, origin: undefined as string | undefined,
    responses: [] as { method: string, status: number, challenge: string | null }[] };
  const transport = new SSEClientTransport(new URL(`${base}/sse`), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      if (state.token) headers.set('authorization', `Bearer ${state.token}`);
      else headers.delete('authorization');
      if (state.origin) headers.set('origin', state.origin);
      const response = await fetch(url, { ...init, headers });
      state.responses.push({ method: init?.method || 'GET',
        status: response.status,
        challenge: response.headers.get('www-authenticate') });
      return response;
    }
  });
  const client = new Client({ name: 'legacy-proof', version: '1' });
  await client.connect(transport);
  return { client, state };
}

const checks: object[] = [];
for (const attached of [ false, true ]) {
  const candidate = new LegacyCandidate();
  const alice: Grant = { person: 'alice', client: 'client', approval: 'a',
    scopes: [ 'read', 'write' ], active: true, revoked: false };
  const bob: Grant = { ...alice, person: 'bob', approval: 'b' };
  const initial = candidate.issue(alice);
  const bobToken = candidate.issue(bob);
  const ctx = server();
  ctx.on('request', async ({ req, res }) => {
    if (![ '/sse', '/messages' ].includes(req.url.pathname)) return;
    await candidate.dispatch(req.resource, res.resource, req.post());
    if (res.resource.headersSent) { res.stop(); return false; }
  });
  const service = attached ? ctx.create() : createServer((req, res) =>
    candidate.dispatch(req, res));
  candidate.base = await listen(service);
  const first = await connect(candidate.base);
  const second = await connect(candidate.base, bobToken);
  try {
    assert.match(JSON.stringify(await first.client.callTool({ name: 'public' })), /public/);
    assert.equal((await first.client.listTools()).tools.length, 3);
    await assert.rejects(first.client.ping(), /HTTP 401/);
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 401/);
    assert.match(first.state.responses.at(-1)!.challenge!, /resource_metadata=/);
    first.state.token = initial;
    assert.match(JSON.stringify(await first.client.callTool({ name: 'read' })), /alice/);
    const count = candidate.effects.length;
    await assert.rejects(first.client.callTool({ name: 'unknown' }), /HTTP 400/);
    assert.equal(candidate.effects.length, count);
    first.state.token = undefined;
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 401/);
    first.state.token = bobToken;
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 403/);
    first.state.token = candidate.issue({ ...alice, approval: 'another-approval' });
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 403/);
    const renewed = candidate.issue(alice);
    candidate.credentials.delete(initial.split(':')[0]);
    first.state.token = initial;
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 401/);
    first.state.token = renewed;
    assert.match(JSON.stringify(await first.client.callTool({ name: 'read' })), /alice/);
    first.state.token = renewed.split(':')[0];
    assert.match(JSON.stringify(await first.client.callTool({ name: 'read' })), /alice/);
    await assert.rejects(first.client.callTool({ name: 'write' }), /HTTP 401/);
    await assert.rejects(first.client.ping(), /HTTP 401/);
    first.state.token = `${renewed.split(':')[0]}:wrong`;
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 401/);
    first.state.token = renewed;
    await first.client.ping();
    alice.scopes = [ 'read' ];
    await assert.rejects(first.client.callTool({ name: 'write' }), /HTTP 403/);
    assert.match(first.state.responses.at(-1)!.challenge!, /insufficient_scope/);
    assert.equal((await first.client.listTools()).tools[2]
      ._meta!['stackpress/available'], false);
    alice.active = false;
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 401/);
    alice.active = true;
    alice.revoked = true;
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 401/);
    const deniedGet = await fetch(`${candidate.base}/sse`, {
      headers: { authorization: `Bearer ${renewed}` } });
    assert.equal(deniedGet.status, 401);
    await deniedGet.body?.cancel();
    alice.revoked = false;
    candidate.now += 901;
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 401/);
    first.state.token = candidate.issue(alice);
    second.state.token = candidate.issue(bob);
    first.state.origin = 'https://evil.example';
    await assert.rejects(first.client.callTool({ name: 'read' }), /HTTP 403/);
    const originGet = await fetch(`${candidate.base}/sse`, {
      headers: { origin: 'https://evil.example' } });
    assert.equal(originGet.status, 403);
    await originGet.body?.cancel();
    first.state.origin = candidate.base;
    assert.match(JSON.stringify(await first.client.callTool({ name: 'read' })), /alice/);
    first.state.origin = undefined;
    let arrived = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    candidate.beforeEffect = async () => { if (++arrived === 2) release(); await ready; };
    const overlapping = await Promise.all([
      first.client.callTool({ name: 'read', arguments: { person: 'forged' } }),
      second.client.callTool({ name: 'read' })
    ]);
    assert.match(JSON.stringify(overlapping[0]), /alice/);
    assert.match(JSON.stringify(overlapping[1]), /bob/);
    candidate.beforeEffect = undefined;
    //pause after the accepted POST, then fail the fresh tool-start check
    let entered!: () => void;
    let continueCall!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { continueCall = resolve; });
    candidate.beforeEffect = async () => { entered(); await blocked; };
    const effects = candidate.effects.length;
    const late = first.client.callTool({ name: 'read' });
    const rejected = assert.rejects(late, /invalid_token/);
    await reached;
    alice.revoked = true;
    continueCall();
    await rejected;
    assert.equal(first.state.responses.at(-1)!.status, 202);
    assert.equal(candidate.effects.length, effects);
    checks.push({ name: `${attached ? 'real Ingest attached' : 'standalone'} older SSE`,
      result: 'passed', cases: [ 'real SDK client and server',
        'anonymous GET/init/public/protected discovery',
        'POST401/403 before accepted reply', 'first approval binding',
        'cross-person and cross-approval denial', 'fresh rotated keys',
        'ID-only read and write denial', 'wrong secret denies read',
        'unknown tool has no effect', 'unclassified controls require full key', 'expiry/revoke/disabled account',
        'Origin on GET and POST', 'overlapping request identity',
        'late rejection arrives on GET stream after POST202; no effect' ] });
  } finally {
    await first.client.close();
    await second.client.close();
    await candidate.close();
    await close(service);
  }
}
await report('legacy', checks);
