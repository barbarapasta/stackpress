//node
import { IncomingMessage, ServerResponse } from 'node:http';
//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import {
  attachHttpToServer,
  McpHttpServer,
  resolveHttpConfig
} from '../src/scripts/http.js';
import { createServer } from 'node:http';
import { normalizeTool, readJsonBody } from '../src/helpers.js';
import type { AuthContext } from '../src/types.js';
import {
  createApplication,
  createMockRequest,
  expectJson,
  header,
  MockResponse,
  serveAttached
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
  auth: AuthContext,
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
  protected override async _createSession(auth: AuthContext) {
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
          sessions[sessionId] = { auth, server, transport };
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

    return { auth, server, transport };
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
  mode: 'stateful' | 'stateless',
  authResolver: (req: IncomingMessage) => Promise<AuthContext> = async () => {
    return { kind: 'public' };
  }
) {
  return new TestHttpServer(
    async () => null,
    authResolver,
    '127.0.0.1',
    17759,
    '/mcp',
    mode,
    {
      resolve: () => undefined,
      reject: error => {
        throw error;
      }
    },
    registry
  );
}

//this caller holds one scope and presents the secret, so it is verified but
// lacks articles.write.
const reader = (): AuthContext => ({
  kind: 'app',
  token: { token: 'app_1:secret', id: 'app_1', secret: 'secret' },
  application: createApplication({ scopes: [ 'articles.read' ] })
});

//this request helper posts one JSON-RPC body, optionally inside a session
function post(body: unknown, session?: string) {
  return createMockRequest({
    method: 'POST',
    url: '/mcp',
    headers: {
      host: 'localhost',
      'content-type': 'application/json',
      ...(session ? { 'mcp-session-id': session } : {})
    },
    body: JSON.stringify(body)
  });
}

const callTool = (name: string) => ({
  jsonrpc: '2.0',
  id: 9,
  method: 'tools/call',
  params: { name, arguments: {} }
});

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
function makeAttachCtx(config: Record<string, unknown> = {}) {
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
    plugin<T = unknown>() {
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

  describe('key refusals', () => {
    const authenticate = (kind: () => AuthContext) => async () => kind();

    for (const mode of [ 'stateless', 'stateful' ] as const) {
      it(`should answer 401 for an invalid key in ${mode} mode`, async () => {
        const server = makeServer(mode, async () => ({ kind: 'invalid' }));
        const res = new MockResponse();
        await server.dispatch(post(initialize), res);

        expect(res.statusCode).to.equal(401);
        expect(res.headers.get('www-authenticate')).to.equal('Bearer');
        expect(expectJson<JsonRpcResponse>(res.body).error?.message)
          .to.equal('Unauthorized');
        expect(server.created).to.equal(0);
      });

      it(`should answer 403 for a tool missing a scope in ${mode} mode`, async () => {
        const server = makeServer(mode, authenticate(reader));
        const res = new MockResponse();
        const body = mode === 'stateless' ? callTool('article_publish') : initialize;
        let session: string | undefined;

        //a stateful caller first opens a session, then calls inside it
        if (mode === 'stateful') {
          const init = new MockResponse();
          await server.dispatch(post(initialize), init);
          session = header(Object.fromEntries(init.headers), 'mcp-session-id')!;
        }

        await server.dispatch(
          post(mode === 'stateful' ? callTool('article_publish') : body, session),
          res
        );

        expect(res.statusCode).to.equal(403);
        const payload = expectJson<JsonRpcResponse>(res.body);
        expect(payload.id).to.equal(9);
        expect(payload.error?.message)
          .to.equal('Forbidden MCP tool call: article_publish');
      });

      it(`should pass allowed and unregistered tool calls in ${mode} mode`, async () => {
        const server = makeServer(mode, authenticate(reader));
        let session: string | undefined;

        if (mode === 'stateful') {
          const init = new MockResponse();
          await server.dispatch(post(initialize), init);
          session = header(Object.fromEntries(init.headers), 'mcp-session-id')!;
        }

        //a public tool and a name the registry never heard of both reach the
        // transport; the SDK answers the unknown name as not found.
        for (const name of [ 'public_ping', 'missing_tool' ]) {
          const res = new MockResponse();
          await server.dispatch(post(callTool(name), session), res);
          expect(res.statusCode).to.equal(200);
        }
      });
    }

    it('should answer 401 for an invalid key with no session in stateful mode', async () => {
      const server = makeServer('stateful', async () => ({ kind: 'invalid' }));
      const res = new MockResponse();
      await server.dispatch(post(callTool('public_ping'), 'session-9'), res);

      expect(res.statusCode).to.equal(401);
    });

    it('should end a live session when its key dies', async () => {
      let current: AuthContext = reader();
      const server = makeServer('stateful', async () => current);

      const init = new MockResponse();
      await server.dispatch(post(initialize), init);
      const session = header(Object.fromEntries(init.headers), 'mcp-session-id')!;

      //while the key is live the session keeps answering
      const live = new MockResponse();
      await server.dispatch(post(callTool('public_ping'), session), live);
      expect(live.statusCode).to.equal(200);

      //once the key dies the next request is refused and the session closed
      current = { kind: 'invalid' };
      const dead = new MockResponse();
      await server.dispatch(post(callTool('public_ping'), session), dead);
      expect(dead.statusCode).to.equal(401);
      expect(dead.headers.get('www-authenticate')).to.equal('Bearer');
      expect(server.oncloseCalls).to.equal(1);

      //and it stays gone even if the key somehow resolves again
      current = reader();
      const gone = new MockResponse();
      await server.dispatch(post(callTool('public_ping'), session), gone);
      expect(gone.statusCode).to.equal(400);
    });

    it('should refuse a session request that presents a different key', async () => {
      let current: AuthContext = reader();
      const server = makeServer('stateful', async () => current);

      const init = new MockResponse();
      await server.dispatch(post(initialize), init);
      const session = header(Object.fromEntries(init.headers), 'mcp-session-id')!;

      //a valid but different caller, and an anonymous one, cannot use it
      current = {
        kind: 'app',
        token: { token: 'app_2:secret', id: 'app_2', secret: 'secret' },
        application: createApplication({ id: 'app_2' })
      };
      for (const caller of [ current, { kind: 'public' } as AuthContext ]) {
        current = caller;
        const res = new MockResponse();
        await server.dispatch(post(callTool('public_ping'), session), res);
        expect(res.statusCode).to.equal(401);
      }

      //refusing them does not close the session for its real owner
      expect(server.oncloseCalls).to.equal(0);
      current = reader();
      const owner = new MockResponse();
      await server.dispatch(post(callTool('public_ping'), session), owner);
      expect(owner.statusCode).to.equal(200);
    });

    it('should skip the scope check when no registry loader is given', async () => {
      const server = new TestHttpServer(
        async () => null,
        async () => reader(),
        '127.0.0.1',
        17759,
        '/mcp',
        'stateless',
        { resolve: () => undefined, reject: error => { throw error; } }
      );
      const res = new MockResponse();
      await server.dispatch(post(callTool('article_publish')), res);

      expect(res.statusCode).to.equal(200);
    });
  });

  describe('plumbing', () => {
    //this promiser records what the transport settles with
    const settle = () => {
      const errors: unknown[] = [];
      return {
        errors,
        promiser: {
          resolve: () => undefined,
          reject: (error: unknown) => { errors.push(error); }
        }
      };
    };
    const base = (port: number, promiser: ReturnType<typeof settle>['promiser']) =>
      new McpHttpServer(
        async () => null,
        async () => ({ kind: 'public' }),
        '127.0.0.1',
        port,
        '/mcp',
        'stateful',
        promiser
      );

    it('should answer 404 to a bare request through the public dispatch', async () => {
      const server = base(17760, settle().promiser);
      const res = new MockResponse();

      //no url and no host header, so both fall back to the configured address
      await server.dispatch(
        createMockRequest({ url: '', headers: {} }),
        res as unknown as ServerResponse
      );

      expect(res.statusCode).to.equal(404);
    });

    it('should end the socket when a failure comes after headers were sent', async () => {
      const server = new McpHttpServer(
        async () => null,
        async () => { throw new Error('resolver failed'); },
        '127.0.0.1',
        17760,
        '/mcp',
        'stateful',
        settle().promiser
      );
      const res = new MockResponse();
      res.headersSent = true;

      await server.dispatch(post(initialize), res as unknown as ServerResponse);

      //nothing more is written once the response has already started
      expect(res.body).to.equal('');
    });

    it('should answer 400 for a session id header sent more than once', async () => {
      const server = makeServer('stateful');
      const res = new MockResponse();

      await server.dispatch(
        createMockRequest({
          method: 'POST',
          url: '/mcp',
          headers: { host: 'localhost', 'mcp-session-id': [ 'one', 'two' ] },
          body: JSON.stringify(callTool('public_ping'))
        }),
        res
      );

      expect(res.statusCode).to.equal(400);
    });

    it('should reject start when the port is taken and settle the promiser', async () => {
      const taken = createServer();
      await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
      const { port } = taken.address() as { port: number };
      const { errors, promiser } = settle();
      const server = base(port, promiser);

      try {
        await server.start();
        expect.fail('Expected start to reject');
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).to.equal('EADDRINUSE');
      } finally {
        process.off('SIGINT', server.shutdown);
        await new Promise<void>(resolve => taken.close(() => resolve()));
      }
      expect(errors).to.have.length(1);
    });

    it('should surface a close failure and run shutdown only once', async () => {
      const server = base(17760, settle().promiser);

      //the service never listened, so closing it is an error the first time
      try {
        await server.shutdown();
        expect.fail('Expected shutdown to reject');
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code)
          .to.equal('ERR_SERVER_NOT_RUNNING');
      }

      //and a second call is a no-op instead of failing again
      await server.shutdown();
    });

    describe('attached request hook', () => {
      const attach = () => {
        let listener: Function | undefined;
        const ctx = {
          requests: 0,
          config: {
            path<T>(key: string, fallback?: T) {
              return (key === 'mcp.route' ? '/mcp' : fallback) as T;
            }
          },
          on(event: string, callback: Function) {
            if (event === 'request') {
              ctx.requests++;
              listener = callback;
            }
          },
          plugin: <T>() => (async () => null) as T,
          resolve: async () => null
        };
        attachHttpToServer(ctx as never);
        return { ctx, listener: () => listener! };
      };

      it('should attach only once per server', () => {
        const { ctx } = attach();
        attachHttpToServer(ctx as never);

        expect(ctx.requests).to.equal(1);
      });

      it('should refuse a bad key and let other requests pass through', async () => {
        const { listener } = attach();
        const served = await serveAttached(listener(), readJsonBody);

        try {
          //an unknown key is looked up, found missing, and answered 401
          const bad = await fetch(`${served.base}/mcp`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer nobody:x'
            },
            body: JSON.stringify(initialize)
          });
          expect(bad.status).to.equal(401);
          await bad.text();

          //no key is a public caller, which reaches the factory; this test
          // factory resolves no server, so the request ends in a 500
          const anon = await fetch(`${served.base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(initialize)
          });
          expect(anon.status).to.equal(500);
          await anon.text();

          //a different path or method is not this transport's request
          for (const [ method, path ] of [ [ 'POST', '/other' ], [ 'GET', '/mcp' ] ]) {
            const other = await fetch(`${served.base}${path}`, {
              method,
              ...(method === 'POST' ? { body: '{}' } : {})
            });
            expect(other.status).to.equal(204);
            expect(other.headers.get('x-passed-through')).to.equal('yes');
          }
        } finally {
          await served.close();
        }
      });

      it('should ignore requests that are not Node requests', async () => {
        const { listener } = attach();

        const result = await listener()({
          req: { resource: {}, data: () => null },
          res: { resource: {}, stop: () => undefined }
        });

        expect(result).to.equal(undefined);
      });

      it('should fall back to the configured address for a bare request', async () => {
        const { listener } = attach();
        const result = await listener()({
          req: {
            resource: Object.assign(Object.create(IncomingMessage.prototype), {
              method: 'POST',
              headers: {}
            }),
            data: () => null
          },
          res: { resource: Object.create(ServerResponse.prototype), stop: () => undefined }
        });

        //no url means the root path, which is not the MCP endpoint
        expect(result).to.equal(undefined);
      });
    });
  });
});
