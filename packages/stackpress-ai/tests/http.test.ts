//node
import { IncomingMessage, ServerResponse } from 'node:http';
//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import {
  attachHttpToServer,
  McpHttpServer,
  resolveHttpConfig,
  shouldAttachHttpToServer
} from '../src/scripts/http.js';
import startHttp from '../src/scripts/http.js';
import { createMcpServer } from '../src/plugin.js';
import type { AuthContext, ToolResolverServer } from '../src/types.js';
import {
  createCtxStub,
  createMockRequest,
  expectJson,
  header,
  MockResponse
} from './helpers.js';

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | null;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
};

//this narrow request body shape keeps the transport test payloads explicit
// without reproducing the full JSON-RPC schema.
type TestBody = {
  id?: number | null,
  method?: string,
  params?: {
    protocolVersion?: string
  }
};

//this session transport shape mirrors the methods the base class expects
// while still staying lightweight for the test harness.
type TestTransport = {
  sessionId: string,
  onclose?: () => Promise<void>,
  close: () => Promise<void>,
  handleRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    body: TestBody | undefined
  ) => Promise<void>
};

//this narrowed session map type lets the subclass mutate protected state
// without reaching for any-casts.
type SessionStore = Record<string, {
  server: { close: () => Promise<void> },
  transport: TestTransport
}>;

/**
 * This test server overrides session creation so transport behavior can be
 * verified without booting a real MCP server.
 */
class TestHttpServer extends McpHttpServer {
  //this counter shows how many logical sessions the transport created
  public created = 0;
  //this counter confirms close handlers ran when sessions were torn down
  public oncloseCalls = 0;

  /**
   * Re-expose request dispatch so tests can drive the protected flow directly.
   */
  public override async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    body?: TestBody | null
  ) {
    await this._handleRequest(req, res, body);
  }

  /**
   * Create one fake session with deterministic request handling for tests.
   */
  protected override async _createSession() {
    this.created++;
    const server = {
      close: async () => undefined
    };
    const sessionId = `session-${this.created}`;
    const sessions = this._sessions as SessionStore;

    const transport: TestTransport = {
      sessionId,
      close: async () => {
        this.oncloseCalls++;
        delete sessions[sessionId];
        await transport.onclose?.();
      },
      handleRequest: async (
        req: IncomingMessage,
        res: ServerResponse,
        body: TestBody | undefined
      ) => {
        if (body?.method === 'initialize') {
          sessions[sessionId] = { server, transport };
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('mcp-session-id', sessionId);
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id ?? null,
            result: {
              protocolVersion: body.params?.protocolVersion ?? 'test',
              serverInfo: { name: 'test-mcp', version: '1.0.0' },
              capabilities: {}
            }
          }));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result: {
            ok: true,
            method: body?.method ?? null,
            transport: req.method
          }
        }));
      }
    };

    return { server, transport };
  }
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {
      name: 'mocha',
      version: '1.0.0'
    }
  }
};

function makeServer(mode: 'stateful' | 'stateless') {
  return new TestHttpServer(
    async () => null,
    async () => ({ kind: 'public' }),
    '127.0.0.1',
    17759,
    '/mcp',
    mode,
    {
      resolve: () => undefined,
      reject: error => {
        throw error;
      }
    }
  );
}

//this tiny config shape is enough for the transport config helper tests.
type ConfigStub = {
  config: {
    path<T>(key: string, fallback?: T): T
  },
  on?: (event: string, listener: Function) => void,
  plugin?: <T = unknown>(name: string) => T
};

/**
 * Create one minimal config-only server stub for helper tests.
 */
function makeCtx(config: Record<string, unknown> = {}) {
  const ctx: ConfigStub = {
    config: {
      path<T>(key: string, fallback?: T) {
        return (key in config ? config[key] : fallback) as T;
      }
    }
  };

  return ctx;
}

/**
 * Create one minimal attached-server stub that captures the request listener.
 */
function makeAttachCtx(
  config: Record<string, unknown> = {},
  pluginFactory?: <T = unknown>(name: string) => T
) {
  let listener: Function | undefined;
  const ctx: ConfigStub & {
    listener: () => Function | undefined
  } = {
    config: {
      path<T>(key: string, fallback?: T) {
        return (key in config ? config[key] : fallback) as T;
      }
    },
    on(event: string, callback: Function) {
      if (event === 'request') {
        listener = callback;
      }
    },
    plugin<T = unknown>(name: string) {
      if (pluginFactory) {
        return pluginFactory<T>(name);
      }
      return (async () => null) as T;
    },
    listener() {
      return listener;
    }
  };

  return ctx;
}

/**
 * Create one Node-shaped request object that passes the attach-mode guards.
 */
function makeAttachedRequest(options: {
  method: string,
  url: string,
  headers?: Record<string, string>
}) {
  return Object.assign(
    Object.create(IncomingMessage.prototype),
    {
      method: options.method,
      url: options.url,
      headers: options.headers || {}
    }
  ) as IncomingMessage;
}

/**
 * Create one Node-shaped response object that passes the attach-mode guards.
 */
function makeAttachedResponse() {
  const headers = new Map<string, string>();
  const response = Object.create(ServerResponse.prototype) as ServerResponse & {
    body: string,
    headers: Map<string, string>
  };

  Object.defineProperty(response, 'statusCode', {
    value: 200,
    writable: true,
    configurable: true
  });
  Object.defineProperty(response, 'headersSent', {
    value: false,
    writable: true,
    configurable: true
  });
  Object.defineProperty(response, 'body', {
    value: '',
    writable: true,
    configurable: true
  });
  Object.defineProperty(response, 'headers', {
    value: headers,
    writable: true,
    configurable: true
  });

  response.setHeader = (name: string, value: string) => {
    headers.set(name.toLowerCase(), value);
    return response;
  };

  response.end = (body = '') => {
    response.headersSent = true;
    response.body += body;
    return response;
  };

  return response as MockResponse as ServerResponse;
}

describe('ai/http', () => {
  it('should fall back to the main server host and port', () => {
    const resolved = resolveHttpConfig(makeCtx({
      'server.host': '0.0.0.0',
      'server.port': 4000
    }));

    expect(resolved.host).to.equal('0.0.0.0');
    expect(resolved.port).to.equal(4000);
  });

  it('should default to localhost and port 3000 when no host and port exist', () => {
    const resolved = resolveHttpConfig(makeCtx());

    expect(resolved.host).to.equal('127.0.0.1');
    expect(resolved.port).to.equal(3000);
  });

  it('should reject unrelated paths', async () => {
    const server = makeServer('stateful');
    const res = new MockResponse();
    await server.dispatch(
      createMockRequest({ url: '/wrong', headers: { host: 'localhost' } }),
      res
    );

    expect(res.statusCode).to.equal(404);
    expect(res.body).to.equal('Not Found');
  });

  it('should create and reuse stateful sessions', async () => {
    const server = makeServer('stateful');

    const initRes = new MockResponse();
    await server.dispatch(
      createMockRequest({
        method: 'POST',
        url: '/mcp',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: JSON.stringify(initialize)
      }),
      initRes
    );

    expect(initRes.statusCode).to.equal(200);
    expect(server.created).to.equal(1);
    expect(header(Object.fromEntries(initRes.headers), 'mcp-session-id'))
      .to.equal('session-1');

    const initPayload = expectJson<JsonRpcResponse>(initRes.body);
    expect(initPayload.result?.serverInfo).to.deep.equal({
      name: 'test-mcp',
      version: '1.0.0'
    });

    const toolRes = new MockResponse();
    await server.dispatch(
      createMockRequest({
        method: 'POST',
        url: '/mcp',
        headers: {
          host: 'localhost',
          'content-type': 'application/json',
          'mcp-session-id': 'session-1'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        })
      }),
      toolRes
    );

    expect(toolRes.statusCode).to.equal(200);
    expect(expectJson<JsonRpcResponse>(toolRes.body).result).to.deep.equal({
      ok: true,
      method: 'tools/list',
      transport: 'POST'
    });
    expect(server.created).to.equal(1);
  });

  it('should accept attached request bodies without rereading the stream', async () => {
    const server = makeServer('stateful');
    const res = new MockResponse();

    //simulate the main server having already parsed the request body before
    // the MCP route sees the raw Node request.
    await server.dispatch(
      createMockRequest({
        method: 'POST',
        url: '/mcp',
        headers: { host: 'localhost', 'content-type': 'application/json' }
      }),
      res,
      initialize
    );

    expect(res.statusCode).to.equal(200);
    expect(server.created).to.equal(1);
    expect(header(Object.fromEntries(res.headers), 'mcp-session-id'))
      .to.equal('session-1');
  });

  it('should stop and abort the queue after an attached request is handled', async () => {
    const ctx = makeAttachCtx({ 'mcp.route': '/mcp' });
    const originalDispatch = McpHttpServer.prototype.dispatch;
    const payload = { method: 'initialize' };
    let stopped = false;

    McpHttpServer.prototype.dispatch = async function (
      _req: IncomingMessage,
      res: ServerResponse,
      body?: unknown
    ) {
      expect(body).to.equal(payload);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    };

    try {
      attachHttpToServer(ctx as never);
      const listener = ctx.listener();
      expect(listener).to.be.a('function');

      const result = await listener!({
        req: {
          body: payload,
          data() {
            return payload;
          },
          resource: makeAttachedRequest({
            method: 'POST',
            url: '/mcp',
            headers: { host: 'localhost' }
          })
        },
        res: {
          resource: makeAttachedResponse(),
          stop() {
            stopped = true;
          }
        }
      });

      expect(stopped).to.equal(true);
      expect(result).to.equal(false);
    } finally {
      McpHttpServer.prototype.dispatch = originalDispatch;
    }
  });

  it('should prefer explicit mcp host and port over server config', () => {
    const resolved = resolveHttpConfig(makeCtx({
      'mcp.host': '192.168.1.10',
      'mcp.port': 17759,
      'server.host': '0.0.0.0',
      'server.port': 4000
    }));

    expect(resolved.host).to.equal('192.168.1.10');
    expect(resolved.port).to.equal(17759);
  });

  /**
   * Build a real MCP tool factory backed by one simple public GET tool so
   * the transport-level tests below exercise the unsubclassed transport
   * against a real @modelcontextprotocol/sdk McpServer instance.
   */
  function makeRealFactory() {
    const ctx = createCtxStub({
      config: {
        'mcp.tools': [{
          name: 'ping',
          title: 'Ping',
          event: 'ping',
          method: 'GET'
        }]
      },
      resolves: {
        ping: { results: { ok: true } }
      }
    });

    return async (auth?: AuthContext) => createMcpServer(
      ctx as unknown as ToolResolverServer,
      auth
    );
  }

  it('should create a real session over a live socket and then shut down cleanly', async function () {
    this.timeout(10000);

    const server = new McpHttpServer(
      makeRealFactory(),
      async () => ({ kind: 'public' }),
      '127.0.0.1',
      0,
      '/mcp',
      'stateful',
      {
        resolve: () => undefined,
        reject: error => { throw error; }
      }
    );

    await server.start();
    const port = (server as unknown as {
      _service: { address(): { port: number } }
    })._service.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(initialize)
      });

      expect(response.status).to.equal(200);
      expect(response.headers.get('mcp-session-id')).to.be.a('string');
    } finally {
      await server.shutdown();
    }
  });

  it('should create a real stateless session per request over a live socket', async function () {
    this.timeout(10000);

    const server = new McpHttpServer(
      makeRealFactory(),
      async () => ({ kind: 'public' }),
      '127.0.0.1',
      0,
      '/mcp',
      'stateless',
      {
        resolve: () => undefined,
        reject: error => { throw error; }
      }
    );

    await server.start();
    const port = (server as unknown as {
      _service: { address(): { port: number } }
    })._service.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(initialize)
      });

      expect(response.status).to.equal(200);
      //stateless sessions do not persist a reusable session id
      expect(response.headers.get('mcp-session-id')).to.equal(null);
    } finally {
      await server.shutdown();
    }
  });

  it('should translate a failed session factory into a JSON-RPC 500 error', async () => {
    const server = new McpHttpServer(
      async () => null,
      async () => ({ kind: 'public' }),
      '127.0.0.1',
      17764,
      '/mcp',
      'stateful',
      {
        resolve: () => undefined,
        reject: error => { throw error; }
      }
    );

    const res = new MockResponse();
    await server.dispatch(
      createMockRequest({
        method: 'POST',
        url: '/mcp',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: JSON.stringify(initialize)
      }),
      res
    );

    expect(res.statusCode).to.equal(500);
    const body = expectJson<JsonRpcResponse>(res.body);
    expect(body.error?.message).to.equal('Resolved MCP tool registry is empty.');
  });

  it('should reject a follow-up request with no session id as a bad request', async () => {
    const server = new McpHttpServer(
      async () => null,
      async () => ({ kind: 'public' }),
      '127.0.0.1',
      17765,
      '/mcp',
      'stateful',
      {
        resolve: () => undefined,
        reject: error => { throw error; }
      }
    );

    const res = new MockResponse();
    await server.dispatch(
      createMockRequest({
        method: 'POST',
        url: '/mcp',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      }),
      res
    );

    expect(res.statusCode).to.equal(400);
    expect(expectJson<JsonRpcResponse>(res.body).error?.message)
      .to.contain('No valid session ID');
  });

  it('should reject non-POST requests in stateless mode', async () => {
    const server = new McpHttpServer(
      async () => null,
      async () => ({ kind: 'public' }),
      '127.0.0.1',
      17766,
      '/mcp',
      'stateless',
      {
        resolve: () => undefined,
        reject: error => { throw error; }
      }
    );

    const res = new MockResponse();
    await server.dispatch(
      createMockRequest({
        method: 'GET',
        url: '/mcp',
        headers: { host: 'localhost' }
      }),
      res
    );

    expect(res.statusCode).to.equal(405);
  });

  it('should attach through the main server when mcp host and port match', async () => {
    //this exercises the free `http()` function's early return branch that
    // hands off to attachHttpToServer instead of starting its own listener.
    const ctx = createCtxStub({ config: { mcp: {} } });
    ctx.on = () => undefined;
    await startHttp(ctx as unknown as never);
    expect(shouldAttachHttpToServer(ctx as unknown as never)).to.equal(true);
  });

  it('should start a standalone listener and resolve once shut down when mcp is on its own port', async function () {
    this.timeout(10000);

    let captured: InstanceType<typeof McpHttpServer> | undefined;
    const originalStart = McpHttpServer.prototype.start;
    McpHttpServer.prototype.start = async function (this: InstanceType<typeof McpHttpServer>) {
      captured = this;
      return originalStart.call(this);
    };

    try {
      const ctx = createCtxStub({
        config: {
          mcp: {},
          'mcp.host': '127.0.0.1',
          'mcp.port': 0,
          'server.host': '127.0.0.1',
          'server.port': 3000
        }
      });
      ctx.registered.mcp = makeRealFactory();

      const pending = startHttp(ctx as unknown as never);
      //give the listener a tick to bind before shutting it down
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(captured).to.exist;

      await captured!.shutdown();
      await pending;
    } finally {
      McpHttpServer.prototype.start = originalStart;
    }
  });

  it('should only attach the http request handler once per server', () => {
    const ctx = makeAttachCtx({ 'mcp.route': '/mcp' });
    attachHttpToServer(ctx as never);
    const first = ctx.listener();
    attachHttpToServer(ctx as never);
    const second = ctx.listener();

    expect(second).to.equal(first);
  });

  it('should ignore attached requests whose resource is not a Node request/response pair', async () => {
    const ctx = makeAttachCtx({ 'mcp.route': '/mcp' });
    attachHttpToServer(ctx as never);
    const listener = ctx.listener();

    const result = await listener!({
      req: { data() { return {}; }, resource: {} },
      res: { resource: makeAttachedResponse(), stop() {} }
    });

    expect(result).to.equal(undefined);
  });

  it('should ignore attached requests that do not match the mcp method or path', async () => {
    const ctx = makeAttachCtx({ 'mcp.route': '/mcp' });
    attachHttpToServer(ctx as never);
    const listener = ctx.listener();

    const result = await listener!({
      req: {
        data() { return {}; },
        resource: makeAttachedRequest({
          method: 'GET',
          url: '/not-mcp',
          headers: { host: 'localhost' }
        })
      },
      res: { resource: makeAttachedResponse(), stop() {} }
    });

    expect(result).to.equal(undefined);
  });

  it('should parse an authorization header presented as an array of values', async () => {
    const application = {
      id: 'app_1',
      name: 'App',
      secret: 'secret-1',
      scopes: [ 'articles.read' ],
      active: true,
      expires: new Date(),
      created: new Date(),
      updated: new Date()
    };
    const calls: (AuthContext | undefined)[] = [];
    const ctx = makeAttachCtx(
      { 'mcp.route': '/mcp' },
      name => {
        if (name !== 'mcp') {
          return null as never;
        }
        return (async (resolved?: AuthContext) => {
          calls.push(resolved);
          return null;
        }) as never;
      }
    );
    const applicationCtx = {
      resolve<T = unknown>(event: string) {
        if (event === 'application-detail') {
          return Promise.resolve({ results: application as T });
        }
        return Promise.resolve(null);
      }
    };

    attachHttpToServer(Object.assign(ctx, applicationCtx) as never);
    const listener = ctx.listener();

    await listener!({
      req: {
        data() {
          return initialize;
        },
        resource: makeAttachedRequest({
          method: 'POST',
          url: '/mcp',
          headers: {
            host: 'localhost',
            authorization: [ 'Bearer app_1:secret-1' ] as unknown as string
          }
        })
      },
      res: { resource: makeAttachedResponse(), stop() {} }
    });

    expect(calls).to.have.length(1);
    expect(calls[0]?.kind).to.equal('app');
  });
});
