//modules
import type Request from '@stackpress/ingest/Request';
import type Response from '@stackpress/ingest/Response';
import type Server from '@stackpress/ingest/Server';
//client
import type {
  AgentEvent,
  CsrfPlugin,
  ToolRequest,
  ToolResolverServer
} from '../types.js';
import { isRecord } from '../helpers.js';
import { CONTEXT_EVENT } from '../events/helpers.js';
import { person, runtimeOf, watch } from '../scripts/agent.js';

//--------------------------------------------------------------------//
// Types

//the status response an event answers with
export type Answer = {
  code?: number,
  status?: string,
  error?: string,
  errors?: Record<string, unknown>,
  results?: unknown
} | null;

//the hints a message carries from the page
type Hints = { url?: string, items?: unknown[] };

//--------------------------------------------------------------------//
// Constants

const MAX_URL = 500;
const MAX_ITEMS = 20;
const MAX_ITEM = 1000;
const REASONS = [
  'unauthorized', 'invalid', 'not_found', 'conflict', 'busy', 'limit', 'csrf',
  'unavailable'
];
const FAILED = 'The agent could not finish that.';

//--------------------------------------------------------------------//
// Functions

/**
 * Where the chat routes are mounted.
 */
export function base(ctx: Server) {
  const path = ctx.config.path<unknown>('agent.base', '/agent');
  const text = typeof path === 'string' ? path.trim() : '';
  const clean = `/${text.replace(/^\/+|\/+$/g, '')}`;
  return clean === '/' ? '/agent' : clean;
}

/**
 * Write a refusal as JSON. The body is set here, and not left to the error
 * handler, so an app's error page never renders an answer meant for a script.
 */
export function refuse(
  res: Response,
  code: number,
  reason: string,
  error: string,
  extra: Record<string, unknown> = {}
) {
  res.setError(error, { reason, ...extra } as never, [], code);
  const { status, errors } = res.toStatusResponse();
  res.json(JSON.stringify({ code, status, error, errors }), code, status);
}

/**
 * Write what an event answered. A refusal keeps its status, reason and
 * reset time. Nothing answered means no agent is listening.
 */
export function answer(res: Response, response: Answer) {
  if (!response) {
    refuse(res, 503, 'unavailable', 'The agent is unavailable right now.');
    return;
  }
  const code = response.code || 200;
  if (code >= 400 || response.error) {
    //the workflow names the reason of every refusal it makes. A failure
    // with no reason is something unexpected, whose text stays on the server
    const reason = String(response.errors?.reason || '');
    const known = REASONS.includes(reason);
    refuse(
      res,
      code >= 400 ? code : 500,
      known ? reason : 'unavailable',
      known ? response.error || FAILED : FAILED,
      response.errors?.resetsAt
        ? { resetsAt: response.errors.resetsAt }
        : {}
    );
    return;
  }
  res.results((response.results ?? {}) as never, code);
}

/**
 * The checks a write route makes before it calls the workflow, in order: a
 * signed-in person, then a valid anti-forgery token. The workflow checks
 * the person again and goes on to the rest of what can refuse. Without the
 * anti-forgery plugin a write is refused, never let through.
 */
export async function guard(ctx: Server, req: Request, res: Response) {
  if (!await person(ctx as unknown as ToolResolverServer, req)) {
    refuse(res, 401, 'unauthorized', 'Sign in to use the agent.');
    return false;
  }

  const csrf = ctx.plugin<CsrfPlugin>('csrf');
  if (!csrf) {
    refuse(
      res, 503, 'unavailable',
      'Anti-forgery protection is not set up, so changes are refused.'
    );
    return false;
  }

  //a script may send the token as a header instead of in the body
  const name = ctx.config.path<string>('csrf.name', 'csrf');
  const header = req.headers.get('x-csrf-token');
  if (typeof header === 'string' && header && !req.data.has(name)) {
    req.data.set(name, header);
  }
  if (!csrf.valid(req, res)) {
    refuse(
      res, 403, 'csrf',
      'This request could not be verified. Reload the panel and try again.'
    );
    return false;
  }
  return true;
}

/**
 * Whether the request asks for an event stream.
 */
export function wantsStream(req: Request) {
  const accept = req.headers.get('accept');
  if (String(accept || '').includes('text/event-stream')) return true;
  const flag = req.data('stream');
  return flag === true || flag === 'true' || flag === '1' || flag === 1;
}

/**
 * Take the page context a message arrived with, keep only plain, short
 * hints, let the app enrich them, and put the result back on the request.
 * Nothing is decided from them; they only reach the model as hints.
 */
export async function context(ctx: Server, req: Request) {
  const raw = req.data('context');
  req.data.delete('context');
  if (!isRecord(raw)) return;

  const hints: Hints = {};
  if (typeof raw.url === 'string' && raw.url) {
    hints.url = raw.url.slice(0, MAX_URL);
  }
  if (Array.isArray(raw.items)) {
    hints.items = raw.items.slice(0, MAX_ITEMS).filter(item => {
      try {
        return (isRecord(item) || typeof item === 'string')
          && JSON.stringify(item).length <= MAX_ITEM;
      } catch {
        return false;
      }
    });
  }
  if (!hints.url && !hints.items?.length) return;

  req.data.set('context', await enrich(ctx, req, hints));
}

/**
 * Resolve an agent event with the request. When something unexpected
 * breaks, the refusal is already written, its text stays in the log, and
 * undefined comes back.
 */
export async function call(
  ctx: Server,
  req: Request,
  res: Response,
  event: string
): Promise<Answer | undefined> {
  try {
    return await ctx.resolve(event, req as never) as Answer;
  } catch (error) {
    runtimeOf(ctx as unknown as ToolResolverServer).log(
      'An agent route failed.', error
    );
    refuse(res, 500, 'unavailable', FAILED);
    return undefined;
  }
}

/**
 * Run a write or a read the workflow answers and write its answer: one
 * response with every event in it, or, when the request asks for a stream,
 * each event as it happens.
 */
export async function run(
  ctx: Server,
  req: Request,
  res: Response,
  event: string
) {
  if (!wantsStream(req)) {
    const response = await call(ctx, req, res, event);
    if (response !== undefined) answer(res, response);
    return;
  }

  const encoder = new TextEncoder();
  const queue: AgentEvent[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  //a reader that left stops the writing, never the work
  let gone = false;
  let first: () => void = () => undefined;
  const arrived = new Promise<void>(resolve => { first = resolve; });

  const write = (report: AgentEvent) => {
    if (gone || !controller) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(report)}\n\n`));
    } catch {
      gone = true;
    }
  };
  watch(req, report => {
    if (controller) write(report);
    else queue.push(report);
    first();
  });

  //the workflow keeps running whether or not anyone is still reading
  const work = (async () => {
    try {
      return { response: await ctx.resolve(event, req as never) as Answer };
    } catch (error) {
      runtimeOf(ctx as unknown as ToolResolverServer).log(
        'An agent route failed.', error
      );
      return { failure: true };
    }
  })();

  //a refusal arrives before any event, and is answered as a plain error
  const early = await Promise.race([
    arrived.then(() => 'event'),
    work.then(() => 'done')
  ]);
  if (early === 'done' && !queue.length) {
    const { response, failure } = await work;
    if (failure) {
      refuse(res, 500, 'unavailable', FAILED);
    } else {
      answer(res, response as Answer);
    }
    return;
  }

  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      controller = stream;
      for (const report of queue.splice(0)) write(report);
      void work.then(({ response, failure }) => {
        //nothing a person sees may carry what went wrong inside
        const code = response?.code || 200;
        if (failure || code >= 400 || response?.error) {
          write({ type: 'error', status: 'failed', message: FAILED });
          write({ type: 'finished', status: 'failed' });
        }
        try {
          stream.close();
        } catch {
          //the reader already left
        }
      });
    },
    cancel() {
      gone = true;
    }
  });
  res.headers.set('Cache-Control', 'no-cache');
  res.headers.set('X-Accel-Buffering', 'no');
  res.set('text/event-stream', body as never, 200);
}

//--------------------------------------------------------------------//
// Helpers

/**
 * Let the app enrich the hints, when it listens for the event. What it
 * answers replaces the url or items it names; anything that goes wrong
 * leaves the hints as the page sent them.
 */
async function enrich(ctx: Server, req: Request, hints: Hints) {
  try {
    const rt = ctx as unknown as ToolResolverServer;
    //the app gets a new request that carries the person's session and only
    // the hints, as a tool does
    const forwarded = rt.request({
      data: { ...hints },
      method: 'POST',
      session: new Map(
        Object.entries((req as unknown as ToolRequest).session.data)
      ) as never,
      url: new URL(req.url.pathname, req.url.origin)
    });
    const response = await rt.resolve(CONTEXT_EVENT, forwarded);
    if (response?.code === 200 && isRecord(response.results)) {
      const found = response.results as Hints;
      return {
        url: typeof found.url === 'string'
          ? found.url.slice(0, MAX_URL)
          : hints.url,
        items: Array.isArray(found.items)
          ? found.items.slice(0, MAX_ITEMS)
          : hints.items
      };
    }
  } catch {
    //enrichment is a convenience, and the hints stand without it
  }
  return hints;
}
