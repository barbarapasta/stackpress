//client
import type {
  Caller,
  NormalizedToolConfig,
  ToolConfig,
  ToolRegistry,
  ToolRequest,
  ToolResolverServer,
  ToolResult,
  Undoing
} from '../types.js';
import {
  mergeTool,
  normalizeTool,
  resolveToolConfig,
  validateInput,
  withToolData
} from '../helpers.js';

//this event is resolved each time the registry is built so plugins can
// contribute tools by calling contributeTool() from a listener.
export const TOOLS_EVENT = 'ai-tools';

//the CJS and ESM builds of this package can both be loaded into one process,
// as when a plugin imports it as ESM while the server loads it as CJS. State
// therefore lives in one store shared through the global symbol registry, so
// every copy of this module reads and writes the same lookups.
const STORE = Symbol.for('stackpress-ai.tools');
const store: {
  //keeps each caller record apart from the tool input, keyed by the request
  // the event receives, so input can never reach it
  callers: WeakMap<object, Caller>,
  //keeps the record of what an inverse is undoing the same way
  undoings: WeakMap<object, Undoing>,
  //holds the contributions of one collection while the contribution event is
  // resolving. A server has no open collection otherwise
  open: WeakMap<object, ToolConfig[]>,
  //chains collections per server so two registries built at the same time
  // cannot see each other's contributions
  queue: WeakMap<object, Promise<unknown>>
} = ((globalThis as Record<symbol, unknown>)[STORE] ??= {
  callers: new WeakMap(),
  undoings: new WeakMap(),
  open: new WeakMap(),
  queue: new WeakMap()
}) as never;
//a store made by an earlier copy of this package has no lookup for undoings
store.undoings ??= new WeakMap();
const { callers, undoings, open, queue } = store;

//--------------------------------------------------------------------//
// Functions

/**
 * Read the caller record of the request a tool event received. Only the
 * system writes it, after the key or sign-in was checked.
 */
export function caller(req: object): Caller | undefined {
  return callers.get(req);
}

/**
 * Read what the request a tool event received is undoing. It is the record of
 * the original action and the id of the undo action, and only an undo makes
 * it. Anywhere else, including a normal call of the same tool, it is undefined.
 */
export function undoing(req: object): Undoing | undefined {
  return undoings.get(req);
}

/**
 * Add a tool contribution. Call this from a listener of the contribution
 * event, which is resolved every time the registry is built.
 */
export function contributeTool(
  ctx: object,
  contributions: ToolConfig | ToolConfig[]
) {
  const collection = open.get(ctx);

  //outside the contribution event nothing would ever read the tool
  if (!collection) {
    throw new Error(
      `Tools can only be contributed while the ${TOOLS_EVENT} event resolves.`
    );
  }

  collection.push(...(
    Array.isArray(contributions) ? contributions : [ contributions ]
  ));
  return collection;
}

/**
 * Build the full tool registry: contributed tools merged with configured
 * tools by name, where a configured entry overrides the contributed fields.
 */
export function collectTools(ctx: ToolResolverServer) {
  //wait for any collection already running on this server
  const run = (queue.get(ctx) || Promise.resolve()).then(() => collect(ctx));
  queue.set(ctx, run.catch(() => undefined));
  return run;
}

/**
 * Build a loader for the full registry, before caller filtering.
 */
export function loadRegistry(ctx: ToolResolverServer): ToolRegistry {
  return () => collectTools(ctx);
}

/**
 * Run one tool for one caller. This is the single execution path: MCP and
 * the later agent both call it. It validates the input, builds the request,
 * records the caller and resolves the tool's event. Whether the caller may
 * use the tool at all is decided before this call. Only the undo passes the
 * last argument, and it is kept apart from the input like the caller.
 */
export async function callTool(
  ctx: ToolResolverServer,
  tool: NormalizedToolConfig,
  input: Record<string, unknown>,
  who: Caller,
  origin?: ToolRequest,
  undone?: Undoing
): Promise<ToolResult> {
  //a bad input is the caller's mistake and is reported as one
  let payload: Record<string, unknown>;
  try {
    payload = validateInput(tool, input || {});
  } catch (error) {
    return {
      code: 400,
      status: 'Bad Request',
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const init: Parameters<ToolResolverServer['request']>[0] = {
    data: withToolData(tool, payload, who),
    method: tool.method
  };

  //a signed-in person reaches the app's events through their own session.
  // The event gets a new request that carries that session and only the tool
  // arguments. The origin request itself is never forwarded, because its body,
  // headers and query would reach the event as input.
  if (who.kind === 'person') {
    if (!origin) {
      return {
        code: 401,
        status: 'Unauthorized',
        error: 'A person needs the request they signed in with.'
      };
    }
    init.session = new Map(
      Object.entries(origin.session.data)
    ) as Map<string, string>;
    //the address keeps its path but drops the query, which would become data
    init.url = new URL(origin.url.pathname, origin.url.origin);
  }

  const req = ctx.request(init);
  callers.set(req, who);
  if (undone) undoings.set(req, undone);
  const response = await ctx.resolve(tool.event, req);

  return {
    code: response?.code || 0,
    status: response?.status,
    results: response?.results ?? null,
    error: response?.error || undefined
  };
}

/**
 * Whether a tool result is a failure.
 */
export function failed(result: ToolResult) {
  return result.code >= 400 || !!result.error;
}

//--------------------------------------------------------------------//
// Helpers

/**
 * Resolve the contribution event, then merge with the configured tools.
 */
async function collect(ctx: ToolResolverServer) {
  const contributed: ToolConfig[] = [];
  open.set(ctx, contributed);
  try {
    await ctx.resolve(TOOLS_EVENT);
  } finally {
    open.delete(ctx);
  }

  //name every contribution first so duplicates can be found
  const named = new Map<string, ToolConfig>();
  for (const config of contributed) {
    const resolved = await resolveToolConfig(ctx, config);
    if (!resolved) continue;
    const name = resolved.name as string;
    if (named.has(name)) {
      throw new Error(`Tool "${name}" was contributed more than once.`);
    }
    named.set(name, resolved);
  }

  //a configured entry overrides the contributed fields of the same name
  for (const config of ctx.config.path<ToolConfig[]>('mcp.tools', [])) {
    const resolved = await resolveToolConfig(ctx, config);
    if (!resolved) continue;
    const name = resolved.name as string;
    const base = named.get(name);
    named.set(name, base ? mergeTool(base, resolved) : resolved);
  }

  return Array.from(named.values())
    .map(config => normalizeTool(config))
    .filter((tool): tool is NormalizedToolConfig => tool !== null);
}
