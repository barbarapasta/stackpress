//node
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
//modules
import { expect } from 'chai';
import type { Application, Session } from 'stackpress-api/types';
//client
import type { ToolResolverServer } from '../src/types.js';

//this test-local stub type extends the runtime server with assertion helpers
// that tests use to inspect registrations and emitted events.
type CtxStub = ToolResolverServer & {
  calls: { event: string, req: { data?: Record<string, unknown>, [k: string]: unknown } }[],
  events: string[],
  ranked: string[],
  registered: Record<string, unknown>
};

//this option shape keeps each stub focused on the config and resolve data one
// test actually needs.
type StubOptions = {
  config?: Record<string, unknown>;
  resolves?: Record<string, { results?: unknown }>;
  application?: Record<string, unknown>;
  session?: Record<string, unknown>;
};

/**
 * Create one lightweight ToolResolverServer test double.
 */
export function createCtxStub(options: StubOptions = {}) {
  const {
    config = {},
    resolves = {},
    application,
    session
  } = options;

  const stub = {
    config: {
      //mirror the plugin guard API so tests can enable or disable mcp cleanly
      has(key: string) {
        return key in config;
      },
      get<T = unknown>(key: string) {
        return (key in config ? config[key] : undefined) as T;
      },
      path<T>(key: string, fallback?: T) {
        if (key in config) {
          return config[key] as T;
        }
        return fallback as T;
      }
    },
    events: [] as string[],
    ranked: [] as string[],
    registered: {} as Record<string, unknown>,
    //a listener with a priority outranks the rest and is kept apart, so the
    // lists of plain listeners stay as each test expects them
    on(event: string, _action?: unknown, priority = 0) {
      (priority ? stub.ranked : stub.events).push(event);
    },
    plugin<T = unknown>(name: string) {
      return stub.registered[name] as T;
    },
    register(name: string, value: unknown) {
      stub.registered[name] = value;
    },
    //mirror ctx.request() enough for tool calls: data, method, session, url
    request(init: Record<string, unknown> = {}) {
      return {
        data: init.data,
        method: init.method,
        session: init.session,
        url: init.url
      };
    },
    //every resolve is recorded so tests can see what the event received
    calls: [] as { event: string, req: unknown }[],
    async resolve<T = unknown>(event: string, req?: unknown) {
      stub.calls.push({ event, req });
      if (event === 'application-detail' && application) {
        return { results: application } as { results: T };
      }

      if (event === 'session-detail' && session) {
        return { results: session } as { results: T };
      }

      //an event that was given an answer answered it, so it is a 200 unless
      // the answer says otherwise. An event with none is one nobody answered
      const answer = resolves[event];
      return (answer ? { code: 200, ...answer } : null) as
        { results: T } | null;
    }
  };

  return stub as unknown as CtxStub;
}

/**
 * Build one application record that is live until overridden.
 */
export function createApplication(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app_1',
    name: 'App',
    secret: 'secret',
    scopes: [ 'articles.read' ],
    active: true,
    expires: new Date(Date.now() + 60_000),
    created: new Date(),
    updated: new Date(),
    ...overrides
  } as Application;
}

/**
 * Build one user session record that is live until overridden.
 */
export function createSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session_1',
    applicationId: 'app_1',
    profileId: 'profile_1',
    secret: 'secret',
    scopes: [ 'comments.read' ],
    active: true,
    expires: new Date(Date.now() + 60_000),
    created: new Date(),
    updated: new Date(),
    ...overrides
  } as Session;
}

/**
 * Parse one JSON response body and assert that it was not empty.
 */
export function expectJson<T>(body: string) {
  expect(body).to.not.equal('');
  return JSON.parse(body) as T;
}

/**
 * Read one header value from either Fetch or Node-style header containers.
 */
export function header(
  headers: Headers | IncomingHttpHeaders | Record<string, string>,
  name: string
) {
  const key = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const value = headers[key] ?? headers[name];
  return Array.isArray(value) ? value[0] : value ?? null;
}

/**
 * Create one minimal async-iterable request object for transport tests.
 */
export function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: IncomingHttpHeaders;
  body?: string;
} = {}) {
  const {
    method = 'GET',
    url = '/',
    headers = {},
    body = ''
  } = options;

  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body.length) {
        yield Buffer.from(body);
      }
    }
  };
}

/**
 * This response double captures status, headers, and body for transport tests.
 */
export class MockResponse extends EventEmitter {
  //this body buffer stores the final response payload for assertions
  public statusCode = 200;
  //this flag mirrors the Node response state after end() is called
  public headersSent = false;
  //this string buffer accumulates every body chunk written by tests
  public body = '';
  //this header map lets tests inspect normalized response headers
  public readonly headers = new Map<string, string>();

  /**
   * Store one response header using a lowercased lookup key.
   */
  public setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  /**
   * Mirror Node's writeHead so real SDK transports (like the SSE transport)
   * can open a response without a live socket.
   */
  public writeHead(statusCode: number, headers?: Record<string, string>) {
    this.statusCode = statusCode;
    this.headersSent = true;
    for (const [ name, value ] of Object.entries(headers || {})) {
      this.setHeader(name, value);
    }
    return this;
  }

  /**
   * Mirror Node's write so long-lived streaming responses (like SSE) can
   * append chunks without ending the response.
   */
  public write(chunk: string) {
    this.body += chunk;
    return true;
  }

  /**
   * Finish the response and emit the close event for cleanup hooks.
   */
  public end(body = '') {
    this.headersSent = true;
    this.body += body;
    this.emit('close');
    return this;
  }
}

/**
 * Serve real Node requests through an attached request listener, the way the
 * main Stackpress server hands requests to the MCP transports. The listener's
 * result is reported back as a header so tests can see whether it stopped the
 * queue.
 */
export async function serveAttached(
  listener: Function,
  parse: (req: IncomingMessage) => Promise<unknown>
) {
  const server = createServer(async (im: IncomingMessage, sr: ServerResponse) => {
    const body = im.method === 'POST' ? await parse(im) : undefined;
    let stopped = false;
    const result = await listener({
      req: { resource: im, data: () => body, post: () => body },
      res: { resource: sr, stop: () => { stopped = true; } }
    });

    //a request the listener left alone falls through to a plain 204
    if (!sr.headersSent) {
      sr.statusCode = 204;
      sr.setHeader('x-passed-through', 'yes');
      sr.end();
    }
    expect(result === false).to.equal(stopped);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}
