//node
import { IncomingMessage } from 'node:http';
//modules
import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
//client
import { McpSseServer } from '../src/scripts/sse.js';
import type { AuthContext, ToolConfig } from '../src/types.js';
import { createMockRequest, MockResponse } from './helpers.js';
import { createOAuthFixture, RESOURCE, SSE_RESOURCE, type OAuthFixture } from './oauth-fixture.js';

//Legacy SSE's transport (@modelcontextprotocol/sdk server/sse.js) writes
//directly to the real Node response methods (writeHead/write/end), so a
//MockResponse double is sufficient here - unlike Streamable HTTP's
//hono-bridged transport (see mcp-oauth-http.test.ts), which needs a real
//socket. Driven against the same real session-owned OAuthStore fixture.

const TOOLS: ToolConfig[] = [
  { name: 'ping', title: 'Ping', event: 'ping', method: 'GET', type: 'public' },
  {
    name: 'articles_read', title: 'Read Articles', event: 'articles-read',
    method: 'GET', type: 'user', scopes: [ 'articles:read' ]
  }
];

function noopFactory() {
  return async (_auth?: AuthContext) => null;
}

const liveServers: McpSseServer[] = [];

function makeServer(fixture: OAuthFixture, resource = SSE_RESOURCE) {
  const server = new McpSseServer(
    noopFactory(),
    async () => ({ kind: 'public' }),
    '127.0.0.1',
    0,
    '/sse',
    '/messages',
    { resolve: () => undefined, reject: (error: unknown) => { throw error; } },
    fixture.ctx,
    resource
  );
  liveServers.push(server);
  return server;
}

function req(options: { method: string, url: string, headers?: Record<string, string> }) {
  return createMockRequest({
    method: options.method, url: options.url, headers: options.headers || {}
  }) as unknown as IncomingMessage;
}

async function connect(server: McpSseServer, headers: Record<string, string> = {}) {
  const res = new MockResponse();
  await server.dispatch(req({ method: 'GET', url: '/sse', headers }), res as never);
  const match = res.body.match(/sessionId=([a-f0-9-]+)/);
  return { res, sessionId: match?.[1] };
}

async function post(
  server: McpSseServer,
  sessionId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const res = new MockResponse();
  await server.dispatch(
    req({
      method: 'POST', url: `/messages?sessionId=${sessionId}`,
      headers: { 'content-type': 'application/json', ...headers }
    }),
    res as never,
    body
  );
  return res;
}

function lastJsonRpcFrame(streamBody: string): any {
  const frames = streamBody.split('\n\n').filter(Boolean);
  const last = frames[frames.length - 1];
  const dataLine = last.split('\n').find(line => line.startsWith('data:'));
  return dataLine ? JSON.parse(dataLine.slice(5).trim()) : undefined;
}

//the tool handler resolves asynchronously after handlePostMessage already
//wrote its 202 Accepted response, so the actual JSON-RPC reply lands on
//the GET stream a tick (or more) later; poll briefly instead of racing it.
async function waitForSecondFrame(res: MockResponse, timeoutMs = 2000) {
  const start = Date.now();
  while (res.body.split('\n\n').filter(Boolean).length < 2) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for a second SSE frame: ${res.body}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return lastJsonRpcFrame(res.body);
}

describe('ai/mcp-oauth sse (real SDK, real store)', () => {
  let fixture: OAuthFixture;

  afterEach(async () => {
    //stop any background grant-watcher timers a bound session started, so
    //mocha's process can exit cleanly between test cases - these servers
    //never called start(), so only their session/watcher state (not the
    //never-listening Node HTTP service) needs tearing down.
    while (liveServers.length) {
      const server = liveServers.pop()! as unknown as {
        _closeSessions(): Promise<void>
      };
      await server._closeSessions();
    }
    await fixture?.close();
  });

  it('opens an anonymous GET stream and accepts a public tool message', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);

    const { res: streamRes, sessionId } = await connect(server);
    expect(streamRes.statusCode).to.equal(200);
    expect(sessionId).to.be.a('string');

    const callRes = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} }
    });
    expect(callRes.statusCode).to.equal(202);
  });

  it('delivers an unauthorized protected call as a late JSON-RPC error on the existing GET stream, not a fresh HTTP challenge', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);
    const { res: streamRes, sessionId } = await connect(server);

    const callRes = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'articles_read', arguments: {} }
    });
    //recovery.md: "older SSE POST may already be 202 with its error
    //delivered on the GET reply stream"
    expect(callRes.statusCode).to.equal(202);
    const frame = await waitForSecondFrame(streamRes);
    expect(frame.result?.isError).to.equal(true);
  });

  it('succeeds once a real access key is presented on the POST, replying on the existing GET stream', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);
    const { res: streamRes, sessionId } = await connect(server);
    const { accessToken } = await fixture.issueGrant({
      resource: SSE_RESOURCE, scopes: [ 'articles:read' ]
    });

    const callRes = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'articles_read', arguments: {} }
    }, { authorization: `Bearer ${accessToken}` });
    expect(callRes.statusCode).to.equal(202);

    const frame = await waitForSecondFrame(streamRes);
    expect(frame.result?.isError).to.equal(undefined);
  });

  it('never falls back to anonymous access for an invalid presented key', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);
    const { sessionId } = await connect(server);

    const res = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'articles_read', arguments: {} }
    }, { authorization: 'Bearer oauth_doesnotexist:wrongsecret' });
    expect(res.statusCode).to.equal(401);
    const body = JSON.parse(res.body);
    expect(body.error).to.equal('invalid_token');
  });

  it('binds the session once and rejects a different identity, without destroying the original binding', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);
    const { sessionId } = await connect(server);

    const { accessToken: tokenA } = await fixture.issueGrant({
      resource: SSE_RESOURCE, scopes: [ 'articles:read' ], clientId: 'client-a'
    });
    const bound = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'articles_read', arguments: {} }
    }, { authorization: `Bearer ${tokenA}` });
    expect(bound.statusCode).to.equal(202);

    const { accessToken: tokenB } = await fixture.issueGrant({
      resource: SSE_RESOURCE, scopes: [ 'articles:read' ], clientId: 'client-b'
    });
    const rejected = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'articles_read', arguments: {} }
    }, { authorization: `Bearer ${tokenB}` });
    expect(rejected.statusCode).to.equal(403);
    expect(JSON.parse(rejected.body).error).to.equal('session_identity_mismatch');

    const stillBound = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'articles_read', arguments: {} }
    }, { authorization: `Bearer ${tokenA}` });
    expect(stillBound.statusCode).to.equal(202);
  });

  it('requires a full credential on the GET handshake when any credential is presented', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);
    const { accessToken } = await fixture.issueGrant({
      resource: SSE_RESOURCE, scopes: [ 'articles:read' ]
    });
    const [ id ] = accessToken.split(':');

    const readOnly = await connect(server, { authorization: `Bearer ${id}` });
    expect(readOnly.res.statusCode).to.equal(401);

    const full = await connect(server, { authorization: `Bearer ${accessToken}` });
    expect(full.res.statusCode).to.equal(200);
  });

  it('returns 404 for a message targeting an unknown session', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);

    const res = await post(server, 'does-not-exist', {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} }
    });
    expect(res.statusCode).to.equal(404);
  });

  it('rejects a disallowed browser Origin before SDK dispatch, on both GET and POST', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture);

    const streamRes = new MockResponse();
    await server.dispatch(
      req({ method: 'GET', url: '/sse', headers: { origin: 'https://evil.example' } }),
      streamRes as never
    );
    expect(streamRes.statusCode).to.equal(403);

    const { sessionId } = await connect(server);
    const postRes = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} }
    }, { origin: 'https://evil.example' });
    expect(postRes.statusCode).to.equal(403);
  });

  it('refuses every request with 503 once the oauth plugin is not finalized', async () => {
    fixture = await createOAuthFixture(TOOLS);
    (fixture.ctx.plugin<{ assertFinalized(): void }>('oauth') as any).assertFinalized = () => {
      throw Object.assign(new Error('not finalized'), { code: 503 });
    };
    const server = makeServer(fixture);
    const res = new MockResponse();
    await server.dispatch(req({ method: 'GET', url: '/sse' }), res as never);
    expect(res.statusCode).to.equal(503);
  });

  it('keeps the HTTP resource and the SSE resource as separately bound approvals', async () => {
    fixture = await createOAuthFixture(TOOLS);
    const server = makeServer(fixture, SSE_RESOURCE);
    const { sessionId } = await connect(server);

    //a grant approved for the HTTP resource does not carry over to SSE
    const { accessToken } = await fixture.issueGrant({
      resource: RESOURCE, scopes: [ 'articles:read' ]
    });
    const res = await post(server, sessionId!, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'articles_read', arguments: {} }
    }, { authorization: `Bearer ${accessToken}` });
    expect(res.statusCode).to.equal(401);
  });
});
