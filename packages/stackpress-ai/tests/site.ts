//node
import http from 'node:http';
import type { AddressInfo } from 'node:net';
//modules
import csrf from 'stackpress-csrf/plugin';
//client
import plugin from '../src/plugin.js';
import type { ToolResolverServer } from '../src/types.js';
//tests
import type { World } from './harness.js';

//--------------------------------------------------------------------//
// Hosts

//The chat routes are served by the real plugin and the real anti-forgery
// plugin over a real HTTP listener, on the two kinds of host the proof
// used: one server that lives as long as the process, and one that is built
// again for every request. Every server a world builds shares its database.

export type HostKind = 'long-lived' | 'per-request';

type Prepare = { csrf?: boolean };

/**
 * Give a server what an app with the plugin has: the anti-forgery plugin
 * and the routes the plugin registers when it routes.
 */
export async function prepare(app: ToolResolverServer, options: Prepare = {}) {
  const server = app as never as Parameters<typeof plugin>[0];
  if (options.csrf !== false) {
    csrf(server);
    await app.emit('config', app.request(), app.response());
  }
  plugin(server);
  await app.emit('route', app.request(), app.response());
}

/**
 * Serve a world's server and return where it is. `built` counts the
 * servers a per-request host has made.
 */
export async function serve(
  world: World,
  kind: HostKind,
  options: Prepare = {}
) {
  const counts = { built: 0 };
  let listener: http.Server;
  if (kind === 'long-lived') {
    await prepare(world.app, options);
    listener = world.app.create() as never as http.Server;
  } else {
    listener = http.createServer(async (im, sr) => {
      counts.built += 1;
      const { app } = world.another();
      await prepare(app, options);
      await app.handle(im as never, sr as never);
    });
  }
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    counts,
    close: () => new Promise<void>(resolve => {
      listener.closeAllConnections?.();
      listener.close(() => resolve());
    })
  };
}

//--------------------------------------------------------------------//
// Client

export type Reply = {
  status: number,
  //the parsed JSON body, when there is one
  json: any,
  text: string,
  type: string,
  cookies: string[]
};

/**
 * A browser, as far as the routes can tell: it keeps cookies and sends the
 * anti-forgery token it was given in the body of a write.
 */
export function browser(base: string, token: string | null) {
  const jar = new Map<string, string>();
  if (token) jar.set('session', token);
  const self = {
    base,
    jar,
    csrf: '' as string,
    cookie: () => Array.from(jar).map(([ k, v ]) => `${k}=${v}`).join('; '),
    async fetch(method: string, path: string, init: {
      body?: unknown, headers?: Record<string, string>
    } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(jar.size ? { cookie: self.cookie() } : {}),
          ...init.headers
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      });
      const cookies = response.headers.getSetCookie();
      for (const line of cookies) {
        const [ pair ] = line.split(';');
        const at = pair.indexOf('=');
        jar.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)));
      }
      return { response, cookies };
    },
    async call(method: string, path: string, init: {
      body?: unknown, headers?: Record<string, string>
    } = {}): Promise<Reply> {
      const { response, cookies } = await self.fetch(method, path, init);
      const text = await response.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return {
        status: response.status,
        json,
        text,
        type: response.headers.get('content-type') || '',
        cookies
      };
    },
    get: (path: string, headers?: Record<string, string>) => (
      self.call('GET', path, { headers })
    ),
    //a write, carrying the token unless the test says otherwise
    async post(path: string, body: Record<string, unknown> = {}, extra: {
      csrf?: string | null, headers?: Record<string, string>
    } = {}) {
      const token = extra.csrf === undefined ? self.csrf : extra.csrf;
      return self.call('POST', path, {
        body: token === null ? body : { csrf: token, ...body },
        headers: extra.headers
      });
    },
    //read the start route, which hands out the token
    async start(path = '/agent/start') {
      const reply = await self.get(path);
      self.csrf = reply.json?.results?.csrf?.token || '';
      return reply;
    },
    //a write answered as an event stream, read piece by piece
    async stream(path: string, body: Record<string, unknown>, options: {
      leaveAfter?: number
    } = {}) {
      const { response } = await self.fetch('POST', path, {
        body: { csrf: self.csrf, ...body },
        headers: { accept: 'text/event-stream' }
      });
      const type = response.headers.get('content-type') || '';
      if (!type.includes('text/event-stream')) {
        return {
          status: response.status, type, events: [], reads: 0, spread: 0,
          json: JSON.parse(await response.text()), text: ''
        };
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const arrivals: number[] = [];
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arrivals.push(Date.now());
        text += decoder.decode(value, { stream: true });
        //a reader that walks away mid-stream
        if (options.leaveAfter && arrivals.length >= options.leaveAfter) {
          await reader.cancel();
          break;
        }
      }
      return {
        status: response.status,
        type,
        events: text.split('\n\n').filter(Boolean).map(
          line => JSON.parse(line.replace(/^data: /, ''))
        ) as { type: string, [key: string]: any }[],
        reads: arrivals.length,
        spread: arrivals.length
          ? arrivals[arrivals.length - 1] - arrivals[0]
          : 0,
        json: null,
        text
      };
    }
  };
  return self;
}

export type Browser = ReturnType<typeof browser>;

/**
 * An event with the identifiers that differ between two otherwise equal
 * runs taken out, so the runs can be compared.
 */
export function plain(event: Record<string, unknown>) {
  const copy = { ...event };
  for (const key of [ 'threadId', 'actionId', 'undoActionId', 'expires' ]) {
    if (key in copy) copy[key] = '*';
  }
  return copy;
}
