//node
import { IncomingMessage, ServerResponse } from 'node:http';
//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import {
  attachSseToServer,
  McpSseServer,
  resolveSseConfig
} from '../src/scripts/sse.js';
import { normalizeTool } from '../src/helpers.js';
import {
  createApplication,
  createMockRequest,
  expectJson,
  MockResponse
} from './helpers.js';
import type { AuthContext } from '../src/types.js';

type MessageResponse = {
  jsonrpc: '2.0';
  id: number | null;
  result: {
    ok: boolean;
    method: string | null;
  };
};

//this narrow message body shape keeps the SSE transport test payloads
// explicit without mirroring the full JSON-RPC type tree.
type TestBody = {
  id?: number | null,
  method?: string
};

//this transport shape mirrors the SSE callbacks the base class needs while
// keeping the test replacement intentionally small.
type TestTransport = {
  sessionId: string,
  onclose?: () => Promise<void>,
  close: () => Promise<void>,
  handlePostMessage: (
    req: IncomingMessage,
    reply: ServerResponse,
    body: TestBody | undefined
  ) => Promise<void>
};

//this narrowed session map lets the subclass update protected state without
// leaning on any-casts.
type SessionStore = Record<string, {
  auth: AuthContext,
  server: { close: () => Promise<void> },
  transport: TestTransport
}>;

/**
 * This test server overrides the SSE session setup so request routing can be
 * verified without a live MCP backend.
 */
class TestSseServer extends McpSseServer {
  //this counter shows how many SSE sessions the test opened
  public created = 0;
  //this counter confirms the transport close hooks were reached
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
   * Create one fake SSE session and immediately write a handshake response.
   */
  protected override async _handleSseConnection(
    _req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext
  ) {
    this.created++;
    const sessionId = `sse-${this.created}`;
    const server = {
      close: async () => undefined
    };
    const sessions = this._sessions as SessionStore;

    const transport: TestTransport = {
      sessionId,
      close: async () => {
        this.oncloseCalls++;
        delete sessions[sessionId];
        await transport.onclose?.();
      },
      handlePostMessage: async (
        _req: IncomingMessage,
        reply: ServerResponse,
        body: TestBody | undefined
      ) => {
        reply.statusCode = 200;
        reply.setHeader('Content-Type', 'application/json');
        reply.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result: {
            ok: true,
            method: body?.method ?? null
          }
        }));
      }
    };

    sessions[sessionId] = { auth, server, transport };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`event: endpoint\ndata: ${JSON.stringify({ sessionId })}\n\n`);
  }
}

//this registry holds one scoped write tool and one public tool so the 403
// path can be told apart from a tool that does not exist.
const registry = async () => [
  normalizeTool({
    name: 'article_publish',
    event: 'article-publish',
    type: 'app',
    method: 'POST',
    scopes: [ 'articles.write' ]
  })!,
  normalizeTool({
    name: 'public_ping',
    event: 'public-ping',
    type: 'public',
    method: 'GET'
  })!
];

function makeServer(
  authResolver: (req: IncomingMessage) => Promise<AuthContext> = async () => {
    return { kind: 'public' };
  },
  loader: typeof registry | null = registry
) {
  return new TestSseServer(
    async () => null,
    authResolver,
    '127.0.0.1',
    17759,
    '/sse',
    '/messages',
    {
      resolve: () => undefined,
      reject: error => {
        throw error;
      }
    },
    loader ?? undefined
  );
}

//this caller holds one scope and presents the secret, so it is verified but
// lacks articles.write.
const reader = (): AuthContext => ({
  kind: 'app',
  token: { token: 'app_1:secret', id: 'app_1', secret: 'secret' },
  application: createApplication({ scopes: [ 'articles.read' ] })
});

//this request helper posts one JSON-RPC body to the message endpoint
function post(body: unknown, session = 'sse-1') {
  return createMockRequest({
    method: 'POST',
    url: `/messages?sessionId=${session}`,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const callTool = (name: string) => ({
  jsonrpc: '2.0',
  id: 9,
  method: 'tools/call',
  params: { name, arguments: {} }
});

//this request helper opens the event stream
const connect = () => createMockRequest({
  method: 'GET',
  url: '/sse',
  headers: { host: 'localhost' }
});

//this tiny config shape is enough for the transport config helper tests.
type ConfigStub = {
  config: {
    path<T>(key: string, fallback?: T): T
  },
  on?: (event: string, listener: Function) => void,
  plugin?: <T = unknown>(name: string) => T,
  listener?: () => Function | undefined
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

describe('ai/sse', () => {
  it('should fall back to the main server host and port', () => {
    const resolved = resolveSseConfig(makeCtx({
      'server.host': '0.0.0.0',
      'server.port': 4000
    }));

    expect(resolved.host).to.equal('0.0.0.0');
    expect(resolved.port).to.equal(4000);
  });

  it('should default to localhost and port 3000 when no host and port exist', () => {
    const resolved = resolveSseConfig(makeCtx());

    expect(resolved.host).to.equal('127.0.0.1');
    expect(resolved.port).to.equal(3000);
  });

  it('should open an SSE session and accept message posts', async () => {
    const server = makeServer();

    const connectRes = new MockResponse();
    await server.dispatch(
      createMockRequest({ method: 'GET', url: '/sse', headers: { host: 'localhost' } }),
      connectRes
    );

    expect(connectRes.statusCode).to.equal(200);
    expect(connectRes.body).to.contain('"sessionId":"sse-1"');
    expect(server.created).to.equal(1);

    const messageRes = new MockResponse();
    await server.dispatch(
      createMockRequest({
        method: 'POST',
        url: '/messages?sessionId=sse-1',
        headers: { host: 'localhost', 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        })
      }),
      messageRes
    );

    expect(messageRes.statusCode).to.equal(200);
    expect(expectJson<MessageResponse>(messageRes.body).result).to.deep.equal({
      ok: true,
      method: 'tools/list'
    });
  });

  it('should prefer explicit sse and mcp host and port over server config', () => {
    const resolved = resolveSseConfig(makeCtx({
      'mcp.host': '192.168.1.10',
      'mcp.port': 17759,
      'mcp.sse.host': '10.0.0.5',
      'mcp.sse.port': 18888,
      'server.host': '0.0.0.0',
      'server.port': 4000
    }));

    expect(resolved.host).to.equal('10.0.0.5');
    expect(resolved.port).to.equal(18888);
  });

  it('should bind bearer auth from the initial sse connection', async () => {
    const auth = {
      kind: 'app',
      token: { token: 'app-1:secret-1', id: 'app-1', secret: 'secret-1' },
      application: { id: 'app-1', scopes: [ 'articles.read' ], secret: 'secret-1' }
    } satisfies AuthContext;
    const calls: AuthContext[] = [];
    const ctx = makeAttachCtx(
      {
        mcp: {},
        'mcp.sse.route': '/sse',
        'mcp.messages': '/messages'
      },
      name => {
        if (name !== 'mcp') {
          return null as never;
        }
        return (async (resolved?: AuthContext) => {
          calls.push(resolved || { kind: 'public' });
          return {
            connect: async () => undefined
          };
        }) as never;
      }
    );
    const applicationCtx = {
      config: {
        path<T>(key: string, fallback?: T) {
          const config = {
            mcp: {},
            'mcp.sse.route': '/sse',
            'mcp.messages': '/messages'
          } as Record<string, unknown>;
          return (key in config ? config[key] : fallback) as T;
        },
        has() {
          return true;
        }
      },
      resolve<T = unknown>(event: string) {
        if (event === 'application-detail') {
          return Promise.resolve({ results: auth.application as T });
        }
        return Promise.resolve(null);
      }
    };

    attachSseToServer(Object.assign(ctx, applicationCtx) as never);
    const requestListener = ctx.listener();
    expect(requestListener).to.be.a('function');

    await requestListener!({
      req: {
        data() {
          return null;
        },
        resource: makeAttachedRequest({
          method: 'GET',
          url: '/sse',
          headers: {
            host: 'localhost',
            authorization: 'Bearer app-1:secret-1'
          }
        })
      },
      res: {
        resource: makeAttachedResponse(),
        stop() {}
      }
    });

    expect(calls).to.have.length(1);
    expect(calls[0]).to.deep.equal(auth);
  });

  it('should stop and abort the queue after an attached message request is handled', async () => {
    const ctx = makeAttachCtx({
      'mcp.sse.route': '/sse',
      'mcp.messages': '/messages'
    });
    const originalDispatch = McpSseServer.prototype.dispatch;
    const payload = { method: 'tools/list' };
    let stopped = false;

    McpSseServer.prototype.dispatch = async function (
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
      attachSseToServer(ctx as never);
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
            url: '/messages?sessionId=sse-1',
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
      McpSseServer.prototype.dispatch = originalDispatch;
    }
  });

  describe('key refusals', () => {
    it('should answer 401 on connect for an invalid key', async () => {
      const server = makeServer(async () => ({ kind: 'invalid' }));
      const res = new MockResponse();
      await server.dispatch(connect(), res);

      expect(res.statusCode).to.equal(401);
      expect(res.headers.get('www-authenticate')).to.equal('Bearer');
      expect(server.created).to.equal(0);
    });

    it('should answer 401 on a message post for an invalid key', async () => {
      const server = makeServer(async () => ({ kind: 'invalid' }));
      const res = new MockResponse();
      await server.dispatch(post(callTool('public_ping')), res);

      expect(res.statusCode).to.equal(401);
      expect(res.headers.get('www-authenticate')).to.equal('Bearer');
    });

    it('should answer 403 for a tool missing a scope', async () => {
      const server = makeServer(async () => reader());
      await server.dispatch(connect(), new MockResponse());

      const res = new MockResponse();
      await server.dispatch(post(callTool('article_publish')), res);

      expect(res.statusCode).to.equal(403);
      const payload = expectJson<{
        id: number,
        error: { message: string }
      }>(res.body);
      expect(payload.id).to.equal(9);
      expect(payload.error.message)
        .to.equal('Forbidden MCP tool call: article_publish');
    });

    it('should pass allowed and unregistered tool calls', async () => {
      const server = makeServer(async () => reader());
      await server.dispatch(connect(), new MockResponse());

      for (const name of [ 'public_ping', 'missing_tool' ]) {
        const res = new MockResponse();
        await server.dispatch(post(callTool(name)), res);
        expect(res.statusCode).to.equal(200);
      }
    });

    it('should skip the scope check when no registry loader is given', async () => {
      const server = makeServer(async () => reader(), null);
      await server.dispatch(connect(), new MockResponse());

      const res = new MockResponse();
      await server.dispatch(post(callTool('article_publish')), res);

      expect(res.statusCode).to.equal(200);
    });

    it('should close the session when its key dies', async () => {
      let current: AuthContext = reader();
      const server = makeServer(async () => current);
      await server.dispatch(connect(), new MockResponse());

      const live = new MockResponse();
      await server.dispatch(post(callTool('public_ping')), live);
      expect(live.statusCode).to.equal(200);

      current = { kind: 'invalid' };
      const dead = new MockResponse();
      await server.dispatch(post(callTool('public_ping')), dead);
      expect(dead.statusCode).to.equal(401);
      expect(server.oncloseCalls).to.equal(1);

      //the session is gone, so a later post finds nothing to route to
      current = reader();
      const gone = new MockResponse();
      await server.dispatch(post(callTool('public_ping')), gone);
      expect(gone.statusCode).to.equal(404);
    });

    it('should refuse a post that presents a different key', async () => {
      let current: AuthContext = reader();
      const server = makeServer(async () => current);
      await server.dispatch(connect(), new MockResponse());

      current = { kind: 'public' };
      const res = new MockResponse();
      await server.dispatch(post(callTool('public_ping')), res);

      expect(res.statusCode).to.equal(401);
      expect(server.oncloseCalls).to.equal(0);
    });
  });
});
