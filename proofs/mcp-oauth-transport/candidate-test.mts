//node
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
//modules
import { server } from '@stackpress/ingest/http';
//client
import type { Grant } from './candidate.mjs';
import { Candidate } from './candidate.mjs';
import { call, close, initialize, listen, report, rpc } from './fixture.mjs';

const checks: object[] = [];

//repeat the whole identity proof across both hosts and both session modes
for (const attached of [ false, true ]) {
  for (const mode of [ 'stateful', 'stateless' ] as const) {
    const candidate = new Candidate(mode);
    const alice: Grant = { person: 'alice', client: 'client', approval: 'grant-a',
      scopes: [ 'read', 'write' ], revoked: false, active: true };
    const bob: Grant = { ...alice, person: 'bob', approval: 'grant-b' };
    const old = candidate.issue(alice);
    const other = candidate.issue(bob);
    const ctx = server();
    ctx.on('request', async ({ req, res }) => {
      if (req.url.pathname !== '/mcp') return;
      await candidate.dispatch(req.resource, res.resource, req.post());
      if (res.resource.headersSent) { res.stop(); return false; }
    });
    const service = attached ? ctx.create() : createServer((req, res) =>
      candidate.dispatch(req, res));
    candidate.base = await listen(service);
    const base = candidate.base;
    try {
      const init = await rpc(base, initialize);
      assert.equal(init.response.status, 200, JSON.stringify(init.data));
      const session = init.response.headers.get('mcp-session-id') || undefined;
      const control = await rpc(base, { jsonrpc: '2.0', id: 62,
        method: 'ping' }, undefined, session);
      assert.equal(control.response.status, 401);
      if (mode === 'stateful') {
        const anonymousDelete = await fetch(`${base}/mcp`, { method: 'DELETE',
          headers: { 'mcp-session-id': session! } });
        assert.equal(anonymousDelete.status, 401);
        await anonymousDelete.body?.cancel();
      }
      const publicCall = await rpc(base, call(2, 'public'), undefined, session);
      assert.equal(publicCall.response.status, 200);
      const before = await rpc(base, { jsonrpc: '2.0', id: 3,
        method: 'tools/list' }, undefined, session);
      assert.equal(before.data.result.tools.length, 3);
      assert.equal(before.data.result.tools[1]._meta['stackpress/available'], false);
      const challenge = await rpc(base, call(4), undefined, session);
      assert.equal(challenge.response.status, 401);
      assert.match(challenge.response.headers.get('www-authenticate')!,
        /resource_metadata=/);
      const approved = await rpc(base, call(5), old, session);
      assert.match(approved.data.result.content[0].text, /alice/);
      const after = await rpc(base, { jsonrpc: '2.0', id: 6,
        method: 'tools/list' }, old, session);
      assert.equal(after.data.result.tools[1]._meta['stackpress/available'], true);
      const effectCount = candidate.effects.length;
      const unknown = await rpc(base, call(61, 'unknown'), old, session);
      assert.equal(unknown.response.status, 400);
      assert.equal(candidate.effects.length, effectCount);
      const renewed = candidate.issue(alice);
      candidate.credentials.delete(old.split(':')[0]);
      assert.equal((await rpc(base, call(7), old, session)).response.status, 401);
      assert.equal((await rpc(base, call(8), renewed, session)).response.status, 200);
      const readId = renewed.split(':')[0];
      assert.equal((await rpc(base, call(9), readId, session)).response.status, 200);
      assert.equal((await rpc(base, { jsonrpc: '2.0', id: 63, method: 'ping' },
        readId, session)).response.status, 401);
      assert.equal((await rpc(base, { jsonrpc: '2.0', id: 64, method: 'ping' },
        renewed, session)).response.status, 200);
      assert.equal((await rpc(base, call(10, 'write'), readId, session))
        .response.status, 401);
      assert.equal((await rpc(base, call(11), `${readId}:wrong`, session))
        .response.status, 401);
      if (mode === 'stateful') {
        assert.equal((await rpc(base, call(12), other, session)).response.status, 403);
        assert.equal((await rpc(base, call(13), undefined, session)).response.status, 401);
        const samePersonOtherApproval = candidate.issue({ ...alice,
          approval: 'different-approval' });
        assert.equal((await rpc(base, call(14), samePersonOtherApproval, session))
          .response.status, 403);
      }
      alice.scopes = [ 'read' ];
      const insufficient = await rpc(base, call(15, 'write'), renewed, session);
      assert.equal(insufficient.response.status, 403);
      assert.match(insufficient.response.headers.get('www-authenticate')!,
        /insufficient_scope.*scope="write"/);
      const reduced = await rpc(base, { jsonrpc: '2.0', id: 16,
        method: 'tools/list' }, renewed, session);
      assert.equal(reduced.data.result.tools[2]._meta['stackpress/available'], false);
      alice.active = false;
      assert.equal((await rpc(base, call(17), renewed, session)).response.status, 401);
      alice.active = true;
      alice.revoked = true;
      assert.equal((await rpc(base, call(18), renewed, session)).response.status, 401);
      alice.revoked = false;
      candidate.now += 901;
      assert.equal((await rpc(base, call(19), renewed, session)).response.status, 401);
      const fresh = candidate.issue(alice);
      const freshBob = candidate.issue(bob);
      const bobInit = await rpc(base, initialize, freshBob);
      const bobSession = bobInit.response.headers.get('mcp-session-id') || undefined;
      //hold both calls until both handlers entered, making overlap deterministic
      let arrived = 0;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      candidate.beforeEffect = async () => { if (++arrived === 2) release(); await ready; };
      const concurrent = await Promise.all([
        rpc(base, call(20, 'read', { marker: 'A', person: 'forged' }), fresh, session),
        rpc(base, call(21, 'read', { marker: 'B' }), freshBob, bobSession)
      ]);
      assert.match(concurrent[0].data.result.content[0].text, /alice/);
      assert.match(concurrent[1].data.result.content[0].text, /bob/);
      candidate.beforeEffect = undefined;
      assert.equal((await rpc(base, call(22), fresh, session,
        { origin: 'https://evil.example' })).response.status, 403);
      assert.equal((await rpc(base, call(23), fresh, session,
        { origin: base })).response.status, 200);
      assert.equal((await rpc(base, call(24), undefined, session,
        { cookie: 'session=pretend-browser-login' })).response.status, 401);
      //after SSE headers leave, revocation still prevents the tool effect
      const effects = candidate.effects.length;
      let entered!: () => void;
      let continueCall!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { continueCall = resolve; });
      candidate.beforeEffect = async () => { entered(); await blocked; };
      const late = rpc(base, call(25), fresh, session);
      await reached;
      alice.revoked = true;
      continueCall();
      const lateResult = await late;
      assert.equal(lateResult.response.status, 200);
      assert.match(lateResult.data.error.message, /invalid_token/);
      assert.equal(candidate.effects.length, effects);
      candidate.beforeEffect = undefined;
      alice.revoked = false;
      //supported control methods must use the same key/session checks
      for (const method of [ 'GET', 'DELETE' ]) {
        const invalid = await fetch(`${base}/mcp`, { method,
          headers: { accept: 'text/event-stream',
            ...(session ? { 'mcp-session-id': session } : {}) },
          signal: AbortSignal.timeout(3000) });
        assert.equal(invalid.status, mode === 'stateful' ? 401 : 405);
        await invalid.body?.cancel();
      }
      if (mode === 'stateful') {
        const stream = await fetch(`${base}/mcp`, { headers: {
          accept: 'text/event-stream', authorization: `Bearer ${fresh}`,
          'mcp-session-id': session! }, signal: AbortSignal.timeout(3000) });
        assert.equal(stream.status, 200);
        const reader = stream.body!.getReader();
        const notification = reader.read();
        await candidate.changed();
        const text = new TextDecoder().decode((await notification).value);
        assert.match(text, /notifications\/tools\/list_changed/);
        await reader.cancel();
        const deleted = await fetch(`${base}/mcp`, { method: 'DELETE',
          headers: { authorization: `Bearer ${fresh}`, 'mcp-session-id': session! } });
        assert.equal(deleted.status, 200);
        assert.equal((await rpc(base, call(26), fresh, session)).response.status, 404);
      }
      checks.push({ name: `${attached ? 'real Ingest attached' : 'standalone'} ${mode}`,
        result: 'passed', cases: [ 'anonymous init/public/protected discovery',
          '401 before SDK stream', 'unknown tool rejected without effect', 'unclassified controls require full key',
          'fresh renewal',
          'ID-only read and write denial', 'bad secret rejects read',
          'scope removal 403', 'disabled account', 'revocation', 'expiry',
          'concurrent identity isolation', 'forged input cannot replace person',
          'Origin allow/deny', 'cookie alone rejected',
          'late revocation is HTTP200 protocol error with no side effect',
          mode === 'stateful' ? 'one-time approval binding, saved identity, GET list-changed and DELETE'
            : 'GET/DELETE explicit405' ] });
    } finally {
      await candidate.close();
      await close(service);
    }
  }
}
await report('candidate', checks);
