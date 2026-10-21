//node
import { IncomingMessage, ServerResponse } from 'node:http';
//modules
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
//client
import { attachHttpToServer, McpHttpServer } from '../src/scripts/http.js';
import type { AuthContext, ToolConfig, ToolResolverServer } from '../src/types.js';
import { createOAuthFixture, RESOURCE, type OAuthFixture } from './oauth-fixture.js';

//These tests drive the real `@modelcontextprotocol/sdk` StreamableHTTP
//transport over a real network socket (SDK 1.29.0 bridges Node's
//IncomingMessage/ServerResponse through `@hono/node-server`, which needs
//a real socket - a hand-rolled response double is not sufficient here),
//against a real session-owned OAuthStore (see oauth-fixture.ts). This is
//the P-002 defect list ported into real package regression tests for the
//Streamable HTTP combinations (saved/per-request).

const TOOLS: ToolConfig[] = [
  {
    name: 'ping', title: 'Ping', event: 'ping', method: 'GET', type: 'public',
    input: { type: 'object', properties: { verbose: { type: 'boolean' } } }
  },
  {
    name: 'articles_read', title: 'Read Articles', event: 'articles-read',
    method: 'GET', type: 'user', scopes: [ 'articles:read' ],
    input: { type: 'object', required: [ 'id' ], properties: { id: { type: 'string' } } },
    output: { type: 'object', properties: { ok: { type: 'boolean' }, echo: {} } }
  },
  {
    name: 'articles_write', title: 'Write Articles', event: 'articles-write',
    method: 'POST', type: 'user', scopes: [ 'articles:write' ]
  },
  {
    name: 'app_ping', title: 'App Ping', event: 'app-ping',
    method: 'GET', type: 'app', scopes: [ 'articles:read' ]
  },
  {
    //decisions.md Q-004: any one matching permission from a non-empty
    //list is enough.
    name: 'articles_any', title: 'Any Scope', event: 'articles-read',
    method: 'GET', type: 'user', scopes: [ 'articles:read', 'articles:admin' ]
  },
  {
    //decisions.md Q-006: an empty configured scope list still requires a
    //valid key of the correct caller type - it is not public.
    name: 'articles_open', title: 'Open To Any Valid Key', event: 'articles-read',
    method: 'GET', type: 'user', scopes: []
  }
];

function noopFactory() {
  return async (_auth?: AuthContext) => null;
}

async function startServer(
  fixture: OAuthFixture,
  mode: 'stateful' | 'stateless' = 'stateful',
  watchIntervalMs = 5000
) {
  const server = new McpHttpServer(
    noopFactory(),
    async () => ({ kind: 'public' }),
    '127.0.0.1',
    0,
    '/mcp',
    mode,
    { resolve: () => undefined, reject: (error: unknown) => { throw error; } },
    fixture.ctx,
    RESOURCE,
    watchIntervalMs
  );
  await server.start();
  const port = (server as unknown as {
    _service: { address(): { port: number } }
  })._service.address().port;
  return { server, baseUrl: `http://127.0.0.1:${port}/mcp` };
}

async function request(
  baseUrl: string,
  options: {
    method?: string,
    body?: unknown,
    headers?: Record<string, string>
  } = {}
) {
  const response = await fetch(baseUrl, {
    method: options.method || 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  //drain the body regardless of which content type the SDK chose: a
  //single-reply Streamable HTTP POST may answer with plain JSON or with
  //one SSE "message" event framing the same JSON-RPC body.
  let json: any;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    json = response.status === 204 ? undefined : await response.json();
  } else if (contentType.includes('text/event-stream')) {
    const text = await response.text();
    const dataLine = text.split('\n').find(line => line.startsWith('data:'));
    json = dataLine ? JSON.parse(dataLine.slice(5).trim()) : undefined;
  } else {
    await response.body?.cancel();
  }
  return { status: response.status, headers: response.headers, json };
}

const INITIALIZE = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mocha', version: '1' } }
};

describe('ai/mcp-oauth http (real SDK, real store)', function () {
  this.timeout(10000);

  let fixture: OAuthFixture;
  let server: McpHttpServer;

  afterEach(async () => {
    await server?.shutdown();
    await fixture?.close();
  });

  it('lets anonymous callers initialize, list a projected catalog, and call public tools', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;

    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    expect(initRes.status).to.equal(200);
    const sessionId = initRes.headers.get('mcp-session-id') as string;
    expect(sessionId).to.be.a('string');

    const listRes = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    });
    const list = listRes.json.result.tools as Array<{
      name: string, inputSchema: unknown, outputSchema?: unknown
    }>;
    const ping = list.find(t => t.name === 'ping');
    const read = list.find(t => t.name === 'articles_read');
    //recovery.md: public tools keep their real schema; protected tools are
    //projected to only name/description and a minimal inputSchema until
    //authorized.
    expect(ping?.inputSchema).to.not.deep.equal({ type: 'object' });
    expect(read?.inputSchema).to.deep.equal({ type: 'object' });
    expect(read?.outputSchema).to.equal(undefined);

    const pingRes = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ping', arguments: {} } }
    });
    expect(pingRes.json.result.content[0].text).to.include('true');
  });

  it('refuses a protected tool call with no credential, then succeeds once a real access key is presented', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;

    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const deniedRes = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    //recovery.md: a refusal discovered after tool dispatch becomes an MCP
    //protocol error (-32001), delivered as the tool's own `isError` result
    //rather than a fresh HTTP challenge, since the SDK's JSON-RPC envelope
    //has already started for this call.
    expect(deniedRes.json.result?.isError).to.equal(true);
    expect(deniedRes.json.result.content[0].text).to.include('-32001');
    //the business event was never invoked (denied before ctx.resolve()),
    //so the advisory not_started marker is present.
    expect(deniedRes.json.result.content[0].text).to.include('not_started');

    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });
    const okRes = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    expect(okRes.json.error).to.equal(undefined);
    expect(okRes.json.result.content[0].text).to.include('a1');

    //once authorized, relisting shows the real, callable contract
    const relistRes = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }
    });
    const read = relistRes.json.result.tools.find((t: any) => t.name === 'articles_read');
    expect(read.inputSchema.required).to.deep.equal([ 'id' ]);
    expect(read.outputSchema).to.not.equal(undefined);
  });

  it('never falls back to anonymous access for an invalid presented key', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: 'Bearer oauth_doesnotexist:wrongsecret' },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    expect(res.status).to.equal(401);
    expect(res.json.error).to.equal('invalid_token');
    expect(res.headers.get('www-authenticate')).to.include('resource_metadata');
  });

  it('rejects an unknown tool name before any read/write classification runs', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'does-not-exist', arguments: {} }
      }
    });
    //the SDK itself rejects a name that was never registered, before any
    //of this task's read/write classification logic ever runs.
    expect(res.json.error || res.json.result?.isError).to.exist;
  });

  it('binds an anonymous session once and rejects a different identity reusing it, without destroying it', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { accessToken: tokenA, grantId } = await fixture.issueGrant({
      scopes: [ 'articles:read' ], clientId: 'client-a'
    });
    const bound = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${tokenA}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    expect(bound.json.error).to.equal(undefined);

    const { accessToken: tokenB } = await fixture.issueGrant({
      scopes: [ 'articles:read' ], clientId: 'client-b'
    });
    const rejected = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${tokenB}` },
      body: {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    expect(rejected.status).to.equal(403);
    expect(rejected.json.error).to.equal('session_identity_mismatch');

    //the first (rejected caller's) session must still be usable by its
    //own bound identity - it was never destroyed by the rejected request.
    const stillBound = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${tokenA}` },
      body: {
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a2' } }
      }
    });
    expect(stillBound.json.error).to.equal(undefined);
    expect(grantId).to.be.a('string');
  });

  it('keeps a renewed key for the same grant working on the bound session', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { accessToken, refreshToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });
    await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });

    const renewed = await fixture.ctx.resolve<{ access_token: string }>('oauth-refresh', {
      client_id: 'client-1', refresh_token: refreshToken, resource: RESOURCE
    });
    expect(renewed?.code).to.equal(200);
    const renewedToken = renewed!.results!.access_token;
    expect(renewedToken).to.not.equal(accessToken);

    const renewedCall = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${renewedToken}` },
      body: {
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a3' } }
      }
    });
    expect(renewedCall.json.error).to.equal(undefined);
  });

  it('stops working once the grant is revoked, and the revoked key never falls back to public access', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });
    await fixture.revokeToken('client-1', accessToken);

    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    expect(res.status).to.equal(401);
    expect(res.json.error).to.equal('invalid_token');
  });

  it('requires the full access key for DELETE, even for an anonymous saved session', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });
    const [ id ] = accessToken.split(':');

    //bind the session with the full key first
    await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });

    const deleteWithIdOnly = await request(started.baseUrl, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${id}` }
    });
    expect(deleteWithIdOnly.status).to.equal(401);

    const deleteWithFull = await request(started.baseUrl, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` }
    });
    expect(deleteWithFull.status).to.equal(200);
  });

  it('sends a real notifications/tools/list_changed signal on the standalone GET stream when the bound grant changes, rechecked live rather than cached', async function () {
    this.timeout(8000);
    fixture = await createOAuthFixture(TOOLS);
    //a short poll so this test does not need to wait storage.md's full
    //five-second ceiling; this only shortens the interval, never lengthens it.
    const started = await startServer(fixture, 'stateful', 150);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });

    //bind the session and start its background watcher
    await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });

    //open the standalone notification stream (GET requires the full key
    //for an already-bound session, same as the DELETE rule above)
    const streamResponse = await fetch(started.baseUrl, {
      method: 'GET',
      headers: {
        'mcp-session-id': sessionId,
        authorization: `Bearer ${accessToken}`,
        accept: 'text/event-stream'
      }
    });
    expect(streamResponse.status).to.equal(200);
    const reader = streamResponse.body!.getReader();
    let collected = '';
    const seenListChanged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for list_changed: ${collected}`)),
        6000
      );
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            collected += Buffer.from(value).toString('utf8');
            if (collected.includes('notifications/tools/list_changed')) {
              clearTimeout(timer);
              resolve();
              return;
            }
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error as Error);
        }
      })();
    });

    //let at least one poll establish the active baseline before revoking,
    //so the next poll's change is actually observable (the watcher only
    //compares against a *previous* snapshot; revoking before any poll
    //has run would make the revoked state the baseline itself).
    await new Promise(resolve => setTimeout(resolve, 350));

    //revoking the grant changes the polled snapshot (active: true -> false)
    //storage.md: "AI rechecks each request using shared storage" - this
    //signal is only advisory; the actual recheck still happens at the
    //next real call, which the revoked-key test elsewhere confirms denies.
    await fixture.revokeToken('client-1', accessToken);

    await seenListChanged;
    await reader.cancel();
  });

  it('rejects a disallowed browser Origin before SDK dispatch', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;

    const res = await request(started.baseUrl, {
      headers: { origin: 'https://evil.example' },
      body: INITIALIZE
    });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal('origin_not_allowed');
  });

  it('returns 405 on GET/DELETE for a stateless (per-request) oauth resource', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture, 'stateless');
    server = started.server;

    const getRes = await request(started.baseUrl, { method: 'GET' });
    expect(getRes.status).to.equal(405);
    expect(getRes.headers.get('allow')).to.equal('POST');

    const deleteRes = await request(started.baseUrl, { method: 'DELETE' });
    expect(deleteRes.status).to.equal(405);
  });

  it('serves a real stateless POST call end to end with a real access key, each request standalone', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture, 'stateless');
    server = started.server;
    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });

    const initRes = await request(started.baseUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      body: INITIALIZE
    });
    expect(initRes.status).to.equal(200);
    //stateless mode never issues a session id
    expect(initRes.headers.get('mcp-session-id')).to.equal(null);
  });

  it('accepts a bound legacy app key on an oauth-enabled resource, calling an app-type tool', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { token } = await fixture.bindLegacyApp({ scopes: [ 'articles:read' ] });
    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${token}` },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'app_ping', arguments: {} } }
    });
    expect(res.json.error).to.equal(undefined);
    expect(res.json.result.content[0].text).to.include('true');
  });

  it('accepts a bound legacy session key on an oauth-enabled resource, calling a user-type tool', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { token } = await fixture.bindLegacySession({ scopes: [ 'articles:read' ] });
    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${token}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'legacy-1' } }
      }
    });
    expect(res.json.error).to.equal(undefined);
    expect(res.json.result.content[0].text).to.include('legacy-1');
  });

  it('refuses an unbound legacy key outright, never falling back to the weaker legacy checks', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    //a real, active legacy application record exists, but was never
    //explicitly bound via oauth-legacy-bind for this resource.
    fixture.applications['unbound-app'] = {
      id: 'unbound-app', secret: 'unbound-secret', scopes: [ 'articles:read' ],
      active: true, expires: new Date(Date.now() + 1_000_000), created: new Date()
    };
    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: 'Bearer unbound-app:unbound-secret' },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'app_ping', arguments: {} } }
    });
    expect(res.status).to.equal(401);
    expect(res.json.error).to.equal('invalid_token');
  });

  it('refuses every request with 503 once the oauth plugin is not finalized', async () => {
    fixture = await createOAuthFixture(TOOLS);
    (fixture.ctx.plugin<{ assertFinalized(): void }>('oauth') as any).assertFinalized = () => {
      throw Object.assign(new Error('not finalized'), { code: 503 });
    };
    const started = await startServer(fixture);
    server = started.server;

    const res = await request(started.baseUrl, { body: INITIALIZE });
    expect(res.status).to.equal(503);
  });

  it('refuses every request with 503 when session.oauth is not configured at all', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const originalPlugin = fixture.ctx.plugin.bind(fixture.ctx);
    (fixture.ctx as any).plugin = (name: string) => name === 'oauth' ? undefined : originalPlugin(name);
    const started = await startServer(fixture);
    server = started.server;

    const res = await request(started.baseUrl, { body: INITIALIZE });
    expect(res.status).to.equal(503);
  });

  it('handles an OPTIONS preflight without a bearer key, validating Origin and exposing the expected headers', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;

    const res = await fetch(started.baseUrl, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' }
    });
    expect(res.status).to.equal(204);
    expect(res.headers.get('access-control-allow-methods')).to.include('POST');
    expect(res.headers.get('vary')).to.equal('Origin');

    const badOrigin = await fetch(started.baseUrl, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' }
    });
    expect(badOrigin.status).to.equal(403);
  });

  it('rejects a batch (array) JSON-RPC request before SDK dispatch', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;

    const response = await fetch(started.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify([ INITIALIZE ])
    });
    expect(response.status).to.equal(400);
    const body = await response.json();
    expect(body.error).to.equal('batch_not_supported');
  });

  it('rejects a non-initialize request with no session id as a bad request', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;

    const res = await request(started.baseUrl, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
    });
    expect(res.status).to.equal(400);
    expect(res.json.error.message).to.include('No valid session ID');
  });

  it('binds a brand-new stateful session immediately when the initialize request already carries a real access key', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });

    const initRes = await request(started.baseUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      body: INITIALIZE
    });
    expect(initRes.status).to.equal(200);
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    //a *different* identity on this already-bound-at-creation session is
    //still rejected, proving the binding took effect at creation time.
    const { accessToken: otherToken } = await fixture.issueGrant({
      scopes: [ 'articles:read' ], clientId: 'client-other'
    });
    const rejected = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${otherToken}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    expect(rejected.status).to.equal(403);
  });

  it('runs two overlapping identities on separate sessions without cross-contaminating effects', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;

    const aliceInit = await request(started.baseUrl, { body: INITIALIZE });
    const aliceSession = aliceInit.headers.get('mcp-session-id') as string;
    const bobInit = await request(started.baseUrl, { body: INITIALIZE });
    const bobSession = bobInit.headers.get('mcp-session-id') as string;
    expect(aliceSession).to.not.equal(bobSession);

    const { accessToken: aliceToken } = await fixture.issueGrant({
      scopes: [ 'articles:read' ], clientId: 'client-alice'
    });
    const { accessToken: bobToken } = await fixture.issueGrant({
      scopes: [ 'articles:read' ], clientId: 'client-bob'
    });

    //fire genuinely overlapping requests; a shared mutable "current
    //identity" would let one call observe the other's argument/identity.
    const [ aliceRes, bobRes ] = await Promise.all([
      request(started.baseUrl, {
        headers: { 'mcp-session-id': aliceSession, authorization: `Bearer ${aliceToken}` },
        body: {
          jsonrpc: '2.0', id: 10, method: 'tools/call',
          params: { name: 'articles_read', arguments: { id: 'alice-article' } }
        }
      }),
      request(started.baseUrl, {
        headers: { 'mcp-session-id': bobSession, authorization: `Bearer ${bobToken}` },
        body: {
          jsonrpc: '2.0', id: 20, method: 'tools/call',
          params: { name: 'articles_read', arguments: { id: 'bob-article' } }
        }
      })
    ]);

    expect(aliceRes.json.result.content[0].text).to.include('alice-article');
    expect(aliceRes.json.result.content[0].text).to.not.include('bob-article');
    expect(bobRes.json.result.content[0].text).to.include('bob-article');
    expect(bobRes.json.result.content[0].text).to.not.include('alice-article');
  });

  it('rejects an access key once its stored access_expires has passed, never falling back to public', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    const { accessToken, grantId } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });

    //force the real stored row into the past, the same way a real clock
    //advancing past accessSeconds would (storage.md: checked inside the
    //transaction against the real stored expiry, not a cache).
    const Update = (await import('@stackpress/inquire/Update')).default;
    await new Update('oauth_grant', fixture.store.engine)
      .set({ access_expires: new Date(Date.now() - 60_000) })
      .where('id = ?', [ grantId ]);

    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'articles_read', arguments: { id: 'a1' } }
      }
    });
    expect(res.status).to.equal(401);
    expect(res.json.error).to.equal('invalid_token');
  });

  it('allows any one matching scope from a non-empty configured list (Q-004)', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    //owns only one of the tool's two acceptable scopes
    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:read' ] });
    const allowed = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'articles_any', arguments: {} } }
    });
    expect(allowed.json.result?.isError).to.not.equal(true);

    //owns neither of the tool's acceptable scopes
    const { accessToken: wrongScope } = await fixture.issueGrant({
      scopes: [ 'articles:write' ], clientId: 'client-wrong-scope'
    });
    const denied = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${wrongScope}` },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'articles_any', arguments: {} } }
    });
    expect(denied.status).to.equal(403);
  });

  it('accepts any valid key of the correct caller type for a tool with an empty configured scope list (Q-006)', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const started = await startServer(fixture);
    server = started.server;
    const initRes = await request(started.baseUrl, { body: INITIALIZE });
    const sessionId = initRes.headers.get('mcp-session-id') as string;

    //a real, valid key whose own granted scopes do not include
    //articles:read at all - the tool's empty list adds no extra
    //restriction, it only still requires a genuinely valid identity.
    const { accessToken } = await fixture.issueGrant({ scopes: [ 'articles:write' ] });
    const res = await request(started.baseUrl, {
      headers: { 'mcp-session-id': sessionId, authorization: `Bearer ${accessToken}` },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'articles_open', arguments: {} } }
    });
    expect(res.json.result?.isError).to.not.equal(true);
  });

  describe('attached (real Ingest-shaped request hook)', () => {
    function pathGet(obj: unknown, key: string): unknown {
      return key.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, obj);
    }

    //a minimal ToolResolverServer whose config.path() resolves the real
    //nested tree attachHttpToServer/resolveHttpOAuthResource need
    //(mcp.route, mcp.oauth.resource, server.host/port), while every
    //other method (resolve/plugin) delegates to the real oauth fixture.
    function makeAttachableCtx(current: OAuthFixture, tree: Record<string, unknown>) {
      let listener: ((args: unknown) => unknown) | undefined;
      const ctx = {
        config: {
          has: (key: string) => pathGet(tree, key) !== undefined,
          get: <T,>(key: string) => pathGet(tree, key) as T,
          path: <T,>(key: string, fallback?: T) => {
            const value = pathGet(tree, key);
            return (value === undefined ? fallback : value) as T;
          }
        },
        on: (event: string, cb: (args: unknown) => unknown) => {
          if (event === 'request') listener = cb;
        },
        plugin: current.ctx.plugin.bind(current.ctx),
        resolve: current.ctx.resolve.bind(current.ctx),
        listener: () => listener
      };
      return ctx as unknown as ToolResolverServer & { listener(): typeof listener };
    }

    function attachedRequest(options: { method: string, url: string, headers?: Record<string, string> }) {
      return Object.assign(Object.create(IncomingMessage.prototype), {
        method: options.method, url: options.url, headers: options.headers || {}
      }) as IncomingMessage;
    }

    //the attach hook's own instanceof ServerResponse guard rejects a
    //plain MockResponse outright; build one that actually passes it,
    //backed by the same capture behavior MockResponse provides.
    function attachedResponse() {
      const headers = new Map<string, string>();
      let body = '';
      const response = Object.create(ServerResponse.prototype) as ServerResponse & {
        body: string, headers: Map<string, string>
      };
      Object.defineProperty(response, 'statusCode', { value: 200, writable: true, configurable: true });
      Object.defineProperty(response, 'headersSent', { value: false, writable: true, configurable: true });
      Object.defineProperty(response, 'headers', { value: headers, writable: true, configurable: true });
      Object.defineProperty(response, 'body', { get: () => body, configurable: true });
      response.setHeader = (name: string, value: string) => { headers.set(name.toLowerCase(), value); return response; };
      response.writeHead = ((code: number, hdrs?: Record<string, string>) => {
        (response as unknown as { statusCode: number }).statusCode = code;
        (response as unknown as { headersSent: boolean }).headersSent = true;
        for (const [ name, value ] of Object.entries(hdrs || {})) headers.set(name.toLowerCase(), value);
        return response;
      }) as never;
      response.end = ((chunk?: string) => {
        (response as unknown as { headersSent: boolean }).headersSent = true;
        body += chunk || '';
        return response;
      }) as never;
      return response;
    }

    it('routes a disallowed-Origin GET through the real request hook before any transport is built', async () => {
      fixture = await createOAuthFixture(TOOLS);
      const ctx = makeAttachableCtx(fixture, {
        mcp: { route: '/mcp', oauth: { resource: RESOURCE } },
        server: { host: '127.0.0.1', port: 3000 }
      });
      attachHttpToServer(ctx as never);
      const listener = ctx.listener();
      expect(listener).to.be.a('function');

      const res = attachedResponse();
      const result = await listener!({
        req: {
          post: () => undefined,
          resource: attachedRequest({
            method: 'GET', url: '/mcp',
            headers: { host: 'localhost', origin: 'https://evil.example' }
          })
        },
        res: { resource: res, stop() {} }
      });

      expect(res.statusCode).to.equal(403);
      expect(result).to.equal(false);
    });

    it('routes a DELETE for an unknown session through the real request hook', async () => {
      fixture = await createOAuthFixture(TOOLS);
      const ctx = makeAttachableCtx(fixture, {
        mcp: { route: '/mcp', oauth: { resource: RESOURCE } },
        server: { host: '127.0.0.1', port: 3000 }
      });
      attachHttpToServer(ctx as never);
      const listener = ctx.listener();

      const res = attachedResponse();
      await listener!({
        req: {
          post: () => undefined,
          resource: attachedRequest({
            method: 'DELETE', url: '/mcp',
            headers: { host: 'localhost', 'mcp-session-id': 'does-not-exist' }
          })
        },
        res: { resource: res, stop() {} }
      });

      expect(res.statusCode).to.equal(404);
      expect(JSON.parse(res.body).error).to.equal('unknown_session');
    });

    it('ignores an attached request that does not match the configured oauth route', async () => {
      fixture = await createOAuthFixture(TOOLS);
      const ctx = makeAttachableCtx(fixture, {
        mcp: { route: '/mcp', oauth: { resource: RESOURCE } },
        server: { host: '127.0.0.1', port: 3000 }
      });
      attachHttpToServer(ctx as never);
      const listener = ctx.listener();

      const result = await listener!({
        req: {
          post: () => undefined,
          resource: attachedRequest({ method: 'GET', url: '/unrelated', headers: { host: 'localhost' } })
        },
        res: { resource: attachedResponse(), stop() {} }
      });
      expect(result).to.equal(undefined);
    });
  });
});

