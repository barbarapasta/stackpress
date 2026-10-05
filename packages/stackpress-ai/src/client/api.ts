//NOTE: Browser safe. Plain functions over `fetch`, so it runs under Node in
// tests as well.
import type {
  AgentEvent,
  AgentThread,
  ClientOptions,
  Csrf,
  Failure,
  Fetch,
  Reason,
  SendBody,
  Sent,
  StartInfo,
  ThreadAction,
  ThreadTurn
} from './types.js';

//--------------------------------------------------------------------//
// Constants

//the reasons the chat routes name when they refuse
const REASONS = [
  'unauthorized', 'invalid', 'not_found', 'conflict', 'busy', 'limit', 'csrf',
  'unavailable'
];

//--------------------------------------------------------------------//
// Functions

/**
 * Work out why a request failed from its status and its body, when the
 * body is the chat routes' own refusal. An answer from anywhere else (an
 * error page, a missing route) is read from the status alone.
 */
export function reasonOf(status: number, body: unknown): Reason {
  const errors = (body as { errors?: { reason?: unknown } } | null)?.errors;
  const reason = typeof errors?.reason === 'string' ? errors.reason : '';
  if (REASONS.includes(reason)) {
    return reason as Reason;
  }
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'limit';
  if (status === 400) return 'invalid';
  if (status === 409) return 'conflict';
  return status >= 400 ? 'unavailable' : 'unknown';
}

/**
 * Turn a refused answer into a failure. Only the status, the reason and,
 * for the daily limit, the reset time are kept; the words are not.
 */
export function failure(status: number, body: unknown): Failure {
  const errors = (body as { errors?: { resetsAt?: unknown } } | null)?.errors;
  const result: Failure = { ok: false, status, reason: reasonOf(status, body) };
  if (typeof errors?.resetsAt === 'string') {
    result.resetsAt = errors.resetsAt;
  }
  return result;
}

/**
 * Take the events out of text received so far. What is left over, an event
 * that has not fully arrived, comes back to be put in front of the next
 * piece. A block that is not an event is skipped.
 */
export function parseEvents(text: string) {
  const events: AgentEvent[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  const rest = blocks.pop() || '';
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      const event = JSON.parse(data);
      if (event && typeof event === 'object' && typeof event.type === 'string') {
        events.push(event as AgentEvent);
      }
    } catch {
      //not an event
    }
  }
  return { events, rest };
}

//a failure carries a reason, and a response does not
function failed(value: Response | Failure): value is Failure {
  return 'reason' in value;
}

/**
 * A client for the chat routes. It keeps the anti-forgery token the start
 * route gave, and sends it back with every write.
 */
export function createClient(options: ClientOptions = {}) {
  const base = `/${(options.base || '/agent').replace(/^\/+|\/+$/g, '')}`;
  const wantStream = options.stream !== false;
  let csrf: Csrf | null = null;

  const fetcher: Fetch = (input, init) => (
    options.fetch || (globalThis.fetch.bind(globalThis) as Fetch)
  )(input, init);

  //one request. A request that never got an answer is a failure too
  const attempt = async (
    path: string,
    init: Parameters<Fetch>[1]
  ): Promise<Response | Failure> => {
    try {
      return await fetcher(base + path, { credentials: 'same-origin', ...init });
    } catch (error) {
      const aborted = (error as { name?: string })?.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        reason: aborted ? 'aborted' : 'network'
      };
    }
  };

  const json = async (res: Response) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  const get = async (path: string) => {
    const res = await attempt(path, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    if (failed(res)) return res;
    const body = await json(res);
    if (!res.ok) return failure(res.status, body);
    return {
      ok: true as const,
      results: (body?.results || {}) as Record<string, unknown>
    };
  };

  //read an event stream to its end, handing over each event as it comes
  const readStream = async (
    res: Response,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal
  ): Promise<Sent | Failure> => {
    let finished = false;
    const hand = (events: AgentEvent[]) => {
      for (const event of events) {
        if (event.type === 'finished') finished = true;
        onEvent?.(event);
      }
    };
    const reader = res.body?.getReader();
    if (!reader) {
      //no way to read it piece by piece: read it whole
      const text = await res.text();
      hand(parseEvents(`${text}\n\n`).events);
      return { ok: true, finished };
    }
    const decoder = new TextDecoder();
    let rest = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const parsed = parseEvents(rest + decoder.decode(value, { stream: true }));
        rest = parsed.rest;
        hand(parsed.events);
      }
      hand(parseEvents(`${rest + decoder.decode()}\n\n`).events);
    } catch {
      if (signal?.aborted) {
        return { ok: false, status: 0, reason: 'aborted' };
      }
      //the connection dropped. The run goes on at the server, and what it
      // stored is there to load
      return { ok: true, finished };
    }
    return { ok: true, finished };
  };

  const start = async (): Promise<(StartInfo & { ok: true }) | Failure> => {
    const answer = await get('/start');
    if (!answer.ok) return answer;
    const found = answer.results;
    if (!Array.isArray(found.models) || typeof found.model !== 'string') {
      return { ok: false, status: 200, reason: 'unknown' };
    }
    const token = found.csrf as Partial<Csrf> | null | undefined;
    csrf = token
      && typeof token.name === 'string'
      && typeof token.token === 'string'
      ? { name: token.name, token: token.token }
      : null;
    return {
      ok: true,
      models: found.models as StartInfo['models'],
      model: found.model,
      usage: (found.usage || { used: 0 }) as StartInfo['usage'],
      csrf
    };
  };

  const write = async (
    path: string,
    fields: Record<string, unknown>,
    mode: {
      stream: boolean,
      onEvent?: (event: AgentEvent) => void,
      signal?: AbortSignal
    },
    again = true
  ): Promise<Sent | Failure> => {
    if (!csrf) {
      const started = await start();
      if (!started.ok) return started;
      if (!csrf) {
        return { ok: false, status: 503, reason: 'unavailable' };
      }
    }
    const token = csrf as Csrf;
    const res = await attempt(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: mode.stream
          ? 'text/event-stream, application/json'
          : 'application/json'
      },
      body: JSON.stringify({ ...fields, [token.name]: token.token }),
      signal: mode.signal
    });
    if (failed(res)) return res;
    const type = res.headers.get('content-type') || '';
    if (res.ok && type.includes('text/event-stream')) {
      return readStream(res, mode.onEvent, mode.signal);
    }
    const body = await json(res);
    if (!res.ok) {
      const refused = failure(res.status, body);
      if (refused.reason === 'csrf' && again) {
        //the token may be stale: take a fresh one and try once more
        csrf = null;
        const started = await start();
        if (started.ok && csrf) {
          return write(path, fields, mode, false);
        }
      }
      return refused;
    }
    //a success that is not an answer of the routes, such as a page from a
    // proxy in the way, did not do what was asked
    if (!body || typeof body !== 'object') {
      return { ok: false, status: res.status, reason: 'unknown' };
    }
    const results = (body.results || {}) as Record<string, unknown>;
    if (Array.isArray(results.events)) {
      for (const event of results.events) {
        if (event && typeof event.type === 'string') mode.onEvent?.(event);
      }
    }
    return { ok: true, finished: true, results };
  };

  const id = encodeURIComponent;

  return {
    base,
    //the token in use, for a test to look at
    csrf: () => csrf,
    start,
    async threads() {
      const answer = await get('/threads');
      if (!answer.ok) return answer;
      const rows = answer.results.threads;
      return {
        ok: true as const,
        threads: (Array.isArray(rows) ? rows : []) as AgentThread[]
      };
    },
    async thread(threadId: string) {
      const answer = await get(`/threads/${id(threadId)}`);
      if (!answer.ok) return answer;
      const found = answer.results;
      if (!found.thread || typeof found.thread !== 'object') {
        return { ok: false as const, status: 200, reason: 'unknown' as Reason };
      }
      return {
        ok: true as const,
        thread: found.thread as AgentThread,
        turns: (Array.isArray(found.turns) ? found.turns : []) as ThreadTurn[],
        actions: (Array.isArray(found.actions)
          ? found.actions
          : []) as ThreadAction[]
      };
    },
    create(context?: SendBody['context']) {
      return write('/threads', context ? { context } : {}, { stream: false });
    },
    send(
      body: SendBody,
      onEvent?: (event: AgentEvent) => void,
      signal?: AbortSignal
    ) {
      return write(
        '/turn',
        { ...body },
        { stream: wantStream, onEvent, signal }
      );
    },
    approve(
      actionId: string,
      onEvent?: (event: AgentEvent) => void,
      signal?: AbortSignal
    ) {
      return write(
        `/actions/${id(actionId)}/approve`,
        {},
        { stream: wantStream, onEvent, signal }
      );
    },
    decline(
      actionId: string,
      onEvent?: (event: AgentEvent) => void,
      signal?: AbortSignal
    ) {
      return write(
        `/actions/${id(actionId)}/decline`,
        {},
        { stream: wantStream, onEvent, signal }
      );
    },
    //an undo answers once: how it ended is in the answer, not in a stream
    undo(actionId: string) {
      return write(
        `/actions/${id(actionId)}/undo`,
        {},
        { stream: false }
      );
    }
  };
}

export type Client = ReturnType<typeof createClient>;
