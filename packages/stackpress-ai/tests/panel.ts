//client
import type { AgentEvent, Fetch, Memory } from '../src/client/types.js';

//--------------------------------------------------------------------//
// A scripted server for the panel's tests

//These answer the panel's requests the way the chat routes do (the shapes
// are the ones recorded in task 6's evidence), so the panel's own logic can
// be driven through every case, including ones a real server is hard to
// make: a stream that stops half way, a refusal of each kind. The routes
// themselves are tested against the real plugin in `routes.test.ts` and
// `client-routes.test.ts`.

export const MODELS = [
  { provider: 'anthropic', model: 'big', title: 'Big' },
  { provider: 'openrouter', model: 'small', title: 'Small' }
];

export const answer = (results: unknown, status = 200) => new Response(
  JSON.stringify({ code: status, status: 'OK', results, total: 1 }),
  { status, headers: { 'content-type': 'application/json' } }
);

export const refusal = (
  status: number,
  reason: string,
  extra: Record<string, unknown> = {}
) => new Response(
  JSON.stringify({
    code: status,
    status: 'Refused',
    error: 'raw server words that must never be shown',
    errors: { reason, ...extra }
  }),
  { status, headers: { 'content-type': 'application/json' } }
);

export const start = (extra: Record<string, unknown> = {}) => answer({
  ok: true,
  models: MODELS,
  model: 'big',
  usage: { used: 0, limit: 1000, remaining: 1000, resetsAt: '2026-10-06T00:00:00.000Z' },
  csrf: { name: 'csrf', token: 'token-1' },
  ...extra
});

const frame = (event: AgentEvent) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * An event stream that gives its pieces one by one. A piece may end in the
 * middle of an event.
 */
export function stream(pieces: string[], options: { fail?: boolean } = {}) {
  const encoder = new TextEncoder();
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (at < pieces.length) {
        controller.enqueue(encoder.encode(pieces[at++]));
      } else if (options.fail) {
        controller.error(new Error('connection reset'));
      } else {
        controller.close();
      }
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

/**
 * A stream of whole events.
 */
export function events(list: AgentEvent[], options: { fail?: boolean } = {}) {
  return stream(list.map(frame), options);
}

/**
 * A stream the test feeds by hand, to look at the page between pieces.
 */
export function gated() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; }
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }),
    //the same stream, broken the way a browser breaks it when the request is
    // aborted
    abortable: (signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new DOMException('aborted', 'AbortError'));
        } catch {
          //already closed
        }
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    },
    push: (event: AgentEvent) => controller.enqueue(encoder.encode(frame(event))),
    end: () => controller.close()
  };
}

export type Call = {
  method: string,
  path: string,
  headers: Record<string, string>,
  body: any,
  signal?: AbortSignal
};

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * A fetch that answers from routes by "METHOD /path", and remembers what it
 * was asked. A path with no route answers 404 with an HTML body, as a
 * missing page does.
 */
export function server(routes: Record<string, Handler | Response>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (input, init = {}) => {
    const method = init.method || 'GET';
    const call: Call = {
      method,
      path: input,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
      signal: init.signal
    };
    calls.push(call);
    const route = routes[`${method} ${input}`]
      || Object.entries(routes).find(([ key ]) => {
        const [ m, pattern ] = key.split(' ');
        return m === method && pattern.endsWith('*')
          && input.startsWith(pattern.slice(0, -1));
      })?.[1];
    if (!route) {
      return new Response('<html>Not found</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' }
      });
    }
    return typeof route === 'function' ? route(call) : route.clone();
  };
  return {
    fetch,
    calls,
    count: (method: string, path: string) => calls.filter(
      call => call.method === method && call.path === path
    ).length,
    paths: () => calls.map(call => `${call.method} ${call.path}`)
  };
}

/**
 * Wait for what is already started to settle.
 */
export const settle = async (turns = 4) => {
  for (let index = 0; index < turns; index++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

export function storage(initial: Record<string, string> = {}): Memory & {
  data: Record<string, string>
} {
  const data = { ...initial };
  return {
    data,
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: key => { delete data[key]; }
  };
}

//--------------------------------------------------------------------//
// Events and stored records

export const thread = (extra: Record<string, unknown> = {}) => ({
  id: 't1',
  profileId: 'p1',
  title: 'Add a note',
  model: 'big',
  active: true,
  created: '2026-10-05T10:00:00.000Z',
  updated: '2026-10-05T10:00:05.000Z',
  ...extra
});

export const stored = (extra: Record<string, unknown> = {}) => ({
  id: 'a1',
  threadId: 't1',
  turnId: 'x1',
  profileId: 'p1',
  tool: 'note_add',
  event: 'note-add',
  input: { text: 'hi' },
  status: 'done',
  result: { id: 'note-1' },
  error: null,
  operation: null,
  reverses: null,
  irreversible: false,
  expires: null,
  created: '2026-10-05T10:00:01.000Z',
  updated: '2026-10-05T10:00:01.000Z',
  undoable: true,
  ...extra
});

export const turn = (extra: Record<string, unknown> = {}) => ({
  id: 'u1',
  role: 'user',
  text: 'Add a note',
  created: '2026-10-05T10:00:00.000Z',
  ...extra
});
