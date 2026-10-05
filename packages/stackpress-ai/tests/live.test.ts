//node
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
//modules
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect } from 'chai';
import { after, afterEach, before, beforeEach, describe, it } from 'mocha';
//client
import { createMcpServer } from '../src/plugin.js';
import { resolveListAuth } from '../src/helpers.js';
import { loadRegistry } from '../src/scripts/tools.js';
import http, { McpHttpServer } from '../src/scripts/http.js';
import sse, { McpSseServer } from '../src/scripts/sse.js';
import type { ToolResolverServer } from '../src/types.js';
import { createApplication, createCtxStub } from './helpers.js';

//this suite drives the real HTTP and SSE transports over real sockets with the
// real MCP SDK server and client, so the refusals are proven end to end and not
// only through the fake sessions in the unit tests.

const tools = [
  { name: 'public_ping', type: 'public', method: 'GET', event: 'ping' },
  {
    name: 'article_search',
    type: 'app',
    method: 'GET',
    event: 'article-search',
    scopes: [ 'articles.read' ]
  },
  {
    name: 'article_publish',
    type: 'app',
    method: 'POST',
    event: 'article-publish',
    scopes: [ 'articles.write' ]
  }
];

//this table stands in for the application-detail lookup, keyed by key id
const applications: Record<string, ReturnType<typeof createApplication>> = {};

function resetApplications() {
  applications.good = createApplication({
    id: 'good',
    secret: 'good-secret',
    scopes: [ 'articles.read' ]
  });
  applications.expired = createApplication({
    id: 'expired',
    secret: 'expired-secret',
    expires: new Date(Date.now() - 1000)
  });
}

//this context resolves keys from the table above and tool events from fixed
// results, so only the package's own code is under test.
function createContext(config: Record<string, unknown> = {}) {
  const ctx = createCtxStub({
    config: { 'mcp.tools': tools, ...config }
  });
  ctx.resolve = (async (event: string, payload: Record<string, unknown>) => {
    if (event === 'application-detail') {
      const found = applications[String(payload.id)];
      return found ? { results: found } : null;
    }
    if (event === 'ping') {
      return { results: 'pong' };
    }
    return { results: { event, hits: [ 'one' ] } };
  }) as never;
  ctx.register('mcp', (auth?: never) => createMcpServer(
    ctx as unknown as ToolResolverServer,
    auth
  ));
  return ctx;
}

//this finds an unused port by binding to 0 and releasing it
async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

//this stops one transport and drops its SIGINT hook; open keep-alive sockets
// from the SDK clients are closed first so shutdown does not wait them out.
async function stopServer(server: McpHttpServer | McpSseServer) {
  const { _service } = server as unknown as { _service: HttpServer };
  _service.closeAllConnections();
  await server.shutdown();
  process.off('SIGINT', server.shutdown);
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const accept = 'application/json, text/event-stream';
const toolCall = (name: string) => ({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name, arguments: {} }
});

describe('ai/live', () => {
  let ctx: ReturnType<typeof createContext>;
  const stops: (() => Promise<void>)[] = [];

  before(() => {
    resetApplications();
    ctx = createContext();
  });

  afterEach(async () => {
    while (stops.length) {
      await stops.pop()!();
    }
    resetApplications();
  });

  after(() => {
    resetApplications();
  });

  //this starts one real HTTP transport and queues its shutdown
  async function startHttp(mode: 'stateful' | 'stateless') {
    const port = await freePort();
    const server = new McpHttpServer(
      (auth?: never) => createMcpServer(
        ctx as unknown as ToolResolverServer,
        auth
      ),
      async req => resolveListAuth(
        ctx as unknown as ToolResolverServer,
        req.headers.authorization
      ),
      '127.0.0.1',
      port,
      '/mcp',
      mode,
      { resolve: () => undefined, reject: error => { throw error; } },
      loadRegistry(ctx as unknown as ToolResolverServer)
    );
    await server.start();
    stops.push(() => stopServer(server));
    return `http://127.0.0.1:${port}/mcp`;
  }

  //this starts one real SSE transport and queues its shutdown
  async function startSse() {
    const port = await freePort();
    const server = new McpSseServer(
      (auth?: never) => createMcpServer(
        ctx as unknown as ToolResolverServer,
        auth
      ),
      async req => resolveListAuth(
        ctx as unknown as ToolResolverServer,
        req.headers.authorization
      ),
      '127.0.0.1',
      port,
      '/sse',
      '/messages',
      { resolve: () => undefined, reject: error => { throw error; } },
      loadRegistry(ctx as unknown as ToolResolverServer)
    );
    await server.start();
    stops.push(() => stopServer(server));
    return `http://127.0.0.1:${port}`;
  }

  //this posts one raw JSON-RPC body, optionally inside a session
  async function rawPost(
    url: string,
    body: unknown,
    token?: string,
    session?: string
  ) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: accept,
        ...(token ? bearer(token) : {}),
        ...(session ? { 'mcp-session-id': session } : {})
      },
      body: JSON.stringify(body)
    });
  }

  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mocha', version: '1.0.0' }
    }
  };

  for (const mode of [ 'stateful', 'stateless' ] as const) {
    describe(`streamable http (${mode})`, () => {
      it('should list and call the tools a valid key allows', async () => {
        const url = await startHttp(mode);
        const client = new Client({ name: 'mocha', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: bearer('good:good-secret') }
        }));

        const listed = await client.listTools();
        expect(listed.tools.map(tool => tool.name))
          .to.deep.equal([ 'public_ping', 'article_search' ]);

        const result = await client.callTool({ name: 'article_search' });
        expect(JSON.stringify(result.content)).to.contain('article-search');
        await client.close();
      });

      it('should answer 401 for an unknown, expired, wrong, or secretless key', async () => {
        const url = await startHttp(mode);

        for (const token of [
          'nobody:good-secret',
          'expired:expired-secret',
          'good:wrong',
          'good'
        ]) {
          const res = await rawPost(url, initialize, token);
          expect(res.status, token).to.equal(401);
          expect(res.headers.get('www-authenticate')).to.equal('Bearer');
        }
      });

      it('should answer 403 for a tool the key lacks a scope for', async () => {
        const url = await startHttp(mode);
        const token = 'good:good-secret';
        let session: string | undefined;

        if (mode === 'stateful') {
          const init = await rawPost(url, initialize, token);
          expect(init.status).to.equal(200);
          session = init.headers.get('mcp-session-id') ?? undefined;
          await init.text();
        }

        const res = await rawPost(url, toolCall('article_publish'), token, session);
        expect(res.status).to.equal(403);
        const body = await res.json() as { id: number, error: { message: string } };
        expect(body.id).to.equal(5);
        expect(body.error.message).to.contain('article_publish');

        //a tool that does not exist is not a scope problem, so it reaches the
        // transport and the SDK reports it
        const missing = await rawPost(url, toolCall('nope'), token, session);
        expect(missing.status).to.equal(200);
        await missing.text();
      });
    });
  }

  describe('streamable http (session lifetime)', () => {
    it('should end a stateful session when its key dies', async () => {
      const url = await startHttp('stateful');
      const token = 'good:good-secret';

      const init = await rawPost(url, initialize, token);
      const session = init.headers.get('mcp-session-id')!;
      await init.text();

      const live = await rawPost(url, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
      }, token, session);
      expect(live.status).to.equal(200);
      await live.text();

      //the key is deactivated while the session is open
      applications.good = createApplication({
        id: 'good',
        secret: 'good-secret',
        active: false
      });
      const dead = await rawPost(url, {
        jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}
      }, token, session);
      expect(dead.status).to.equal(401);
      await dead.text();

      //and the session does not come back when the key does
      resetApplications();
      const gone = await rawPost(url, {
        jsonrpc: '2.0', id: 4, method: 'tools/list', params: {}
      }, token, session);
      expect(gone.status).to.equal(400);
      await gone.text();
    });

    it('should serve a public caller only the public tools', async () => {
      const url = await startHttp('stateless');
      const client = new Client({ name: 'mocha', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));

      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).to.deep.equal([ 'public_ping' ]);
      await client.close();
    });

    it('should answer 405 to a non-POST request in stateless mode', async () => {
      const url = await startHttp('stateless');
      const res = await fetch(url);
      expect(res.status).to.equal(405);
      await res.text();
    });

    it('should answer 404 for an unrelated path', async () => {
      const url = await startHttp('stateful');
      const res = await fetch(url.replace('/mcp', '/other'));
      expect(res.status).to.equal(404);
      await res.text();
    });
  });

  describe('callers that see no tools', () => {
    //every tool here needs a scope, so a key without it sees nothing and
    // there is no public tool to fall back on
    let original: typeof ctx;

    beforeEach(() => {
      original = ctx;
      ctx = createContext({ 'mcp.tools': tools.slice(1) });
      applications.narrow = createApplication({
        id: 'narrow',
        secret: 'narrow-secret',
        scopes: [ 'unrelated.scope' ]
      });
    });

    afterEach(() => {
      ctx = original;
    });

    const keys = [
      [ 'a valid key with no matching scope', 'narrow:narrow-secret' ],
      [ 'a public caller', undefined ]
    ] as const;

    for (const mode of [ 'stateful', 'stateless' ] as const) {
      for (const [ label, token ] of keys) {
        it(`should list zero tools over ${mode} http for ${label}`, async () => {
          const url = await startHttp(mode);
          const client = new Client({ name: 'mocha', version: '1.0.0' });
          await client.connect(new StreamableHTTPClientTransport(
            new URL(url),
            token ? { requestInit: { headers: bearer(token) } } : undefined
          ));

          //an empty list, not a method-not-found error from the SDK
          const listed = await client.listTools();
          expect(listed.tools).to.deep.equal([]);
          await client.close();
        });
      }
    }

    for (const [ label, token ] of keys) {
      it(`should list zero tools over sse for ${label}`, async () => {
        const base = await startSse();
        const client = new Client({ name: 'mocha', version: '1.0.0' });
        const headers = token ? bearer(token) : {};
        await client.connect(new SSEClientTransport(new URL(`${base}/sse`), {
          requestInit: { headers },
          eventSourceInit: {
            fetch: (url, init) => fetch(url, {
              ...init,
              headers: { ...init?.headers, ...headers }
            })
          }
        }));

        const listed = await client.listTools();
        expect(listed.tools).to.deep.equal([]);
        await client.close();
      });
    }

    it('should still refuse a bad key and a call to a tool it lacks', async () => {
      const url = await startHttp('stateless');
      const bad = await rawPost(url, initialize, 'narrow:wrong');
      expect(bad.status).to.equal(401);
      await bad.text();

      const lacks = await rawPost(
        url, toolCall('article_search'), 'narrow:narrow-secret'
      );
      expect(lacks.status).to.equal(403);
      await lacks.text();
    });
  });

  describe('transport errors', () => {
    const empty = async () => null;
    const settle = { resolve: () => undefined, reject: (error: unknown) => { throw error; } };
    const auth = async () => ({ kind: 'public' } as const);

    it('should answer 500 over http when the factory makes no server', async () => {
      const port = await freePort();
      const server = new McpHttpServer(
        empty, auth, '127.0.0.1', port, '/mcp', 'stateless', settle
      );
      await server.start();
      stops.push(() => stopServer(server));

      const res = await rawPost(`http://127.0.0.1:${port}/mcp`, initialize);
      expect(res.status).to.equal(500);
      const body = await res.json() as { error: { message: string } };
      expect(body.error.message)
        .to.equal('No MCP server was created for this caller.');
    });

    it('should answer 500 over sse when the factory makes no server', async () => {
      const port = await freePort();
      const server = new McpSseServer(
        empty, auth, '127.0.0.1', port, '/sse', '/messages', settle
      );
      await server.start();
      stops.push(() => stopServer(server));

      const res = await fetch(`http://127.0.0.1:${port}/sse`);
      expect(res.status).to.equal(500);
      expect(await res.text())
        .to.equal('No MCP server was created for this caller.');
    });

    it('should answer 404 over sse for an unknown session or path', async () => {
      const base = await startSse();
      const post = await fetch(`${base}/messages?sessionId=none`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      expect(post.status).to.equal(404);
      await post.text();

      const other = await fetch(`${base}/other`);
      expect(other.status).to.equal(404);
      await other.text();
    });

    it('should answer 400 over http for a session id it does not know', async () => {
      const url = await startHttp('stateful');
      const res = await rawPost(url, toolCall('public_ping'), undefined, 'none');
      expect(res.status).to.equal(400);
      await res.text();
    });
  });

  describe('sse', () => {
    //this opens the raw event stream and reads the endpoint event it announces
    async function open(base: string, token?: string) {
      const res = await fetch(`${base}/sse`, {
        headers: { Accept: 'text/event-stream', ...(token ? bearer(token) : {}) }
      });
      if (res.status !== 200) {
        await res.text();
        return { res, endpoint: '' };
      }

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      const endpoint = /data: (\S+)/.exec(text)![1];
      return { res, reader, endpoint: `${base}${endpoint}` };
    }

    const post = (endpoint: string, body: unknown, token?: string) => fetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? bearer(token) : {})
        },
        body: JSON.stringify(body)
      }
    );

    it('should list and call the tools a valid key allows', async () => {
      const base = await startSse();
      const client = new Client({ name: 'mocha', version: '1.0.0' });
      await client.connect(new SSEClientTransport(new URL(`${base}/sse`), {
        requestInit: { headers: bearer('good:good-secret') },
        eventSourceInit: {
          fetch: (url, init) => fetch(url, {
            ...init,
            headers: { ...init?.headers, ...bearer('good:good-secret') }
          })
        }
      }));

      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name))
        .to.deep.equal([ 'public_ping', 'article_search' ]);
      const result = await client.callTool({ name: 'public_ping' });
      expect(JSON.stringify(result.content)).to.contain('pong');
      await client.close();
    });

    it('should answer 401 on connect for an unknown, expired, or secretless key', async () => {
      const base = await startSse();

      for (const token of [ 'nobody:x', 'expired:expired-secret', 'good' ]) {
        const { res } = await open(base, token);
        expect(res.status, token).to.equal(401);
        expect(res.headers.get('www-authenticate')).to.equal('Bearer');
      }
    });

    it('should answer 403 for a tool the key lacks a scope for', async () => {
      const base = await startSse();
      const token = 'good:good-secret';
      const { endpoint, reader } = await open(base, token);

      const res = await post(endpoint, toolCall('article_publish'), token);
      expect(res.status).to.equal(403);
      await res.text();
      await reader!.cancel();
    });

    it('should close the stream and answer 401 when the key dies', async () => {
      const base = await startSse();
      const token = 'good:good-secret';
      const { endpoint, reader } = await open(base, token);

      applications.good = createApplication({
        id: 'good',
        secret: 'good-secret',
        expires: new Date(Date.now() - 1000)
      });
      const res = await post(endpoint, toolCall('public_ping'), token);
      expect(res.status).to.equal(401);
      await res.text();

      //the server ended the event stream along with the key
      const next = await reader!.read();
      expect(next.done).to.equal(true);
    });
  });

  describe('entrypoints', () => {
    //these capture the SIGINT shutdown the entrypoints register, so the test
    // can stop the server without signalling the whole mocha process.
    async function run(
      start: (server: never) => Promise<void> | undefined,
      stop: () => void
    ) {
      const original = process.once;
      let shutdown: (() => Promise<void>) | undefined;
      process.once = ((event: string, listener: () => Promise<void>) => {
        if (event === 'SIGINT') {
          shutdown = listener;
          return process;
        }
        return original.call(process, event as never, listener as never);
      }) as never;

      let finished: Promise<void> | undefined;
      try {
        finished = start(ctx as never);
        //wait until the listener is bound
        for (let tries = 0; tries < 50 && !shutdown; tries++) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } finally {
        process.once = original;
      }

      expect(shutdown).to.be.a('function');
      stops.push(async () => {
        await shutdown!();
        await finished;
        stop();
      });
    }

    it('should serve HTTP MCP from its own port with key checks', async () => {
      const port = await freePort();
      const own = createContext({ 'mcp.port': port, 'mcp.host': '127.0.0.1' });
      const previous = ctx;
      ctx = own;
      try {
        await run(
          server => http(server) as Promise<void>,
          () => undefined
        );
        const res = await rawPost(
          `http://127.0.0.1:${port}/mcp`,
          initialize,
          'nobody:x'
        );
        expect(res.status).to.equal(401);
        await res.text();
      } finally {
        ctx = previous;
      }
    });

    it('should serve SSE MCP from its own port with key checks', async () => {
      const port = await freePort();
      const own = createContext({
        'mcp.sse.port': port,
        'mcp.sse.host': '127.0.0.1',
        'mcp.sse.route': '/sse'
      });
      const previous = ctx;
      ctx = own;
      try {
        await run(
          server => sse(server) as Promise<void>,
          () => undefined
        );
        const res = await fetch(`http://127.0.0.1:${port}/sse`, {
          headers: bearer('nobody:x')
        });
        expect(res.status).to.equal(401);
        await res.text();
      } finally {
        ctx = previous;
      }
    });
  });
});
