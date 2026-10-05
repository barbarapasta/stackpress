//client
import type {
  NewThreadResult,
  StartResult,
  ThreadAction,
  ThreadResult,
  ThreadsResult,
  ThreadTurn,
  ToolRequest
} from '../types.js';
import type { AgentRuntime } from './agent.js';
import { isRecord } from '../helpers.js';
import { inverseOf, offered, person, pick, refuse, resetsAt } from './agent.js';
import { collectTools } from './tools.js';

//--------------------------------------------------------------------//
// Functions

/**
 * List the signed-in person's own threads, newest activity first. Nobody
 * else's thread is ever in the list.
 */
export async function listThreads(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown = {}
): Promise<ThreadsResult> {
  const who = await person(rt.ctx, req);
  if (!who) {
    return refuse(401, 'unauthorized', 'Sign in to use the agent.');
  }
  const data = isRecord(input) ? input : {};
  const threads = await rt.store.listThreads(who.profileId as string, {
    skip: count(data.skip, 0, 10000),
    take: count(data.take, 50, 100)
  });
  return { ok: true, threads };
}

/**
 * Load one of the signed-in person's threads with what the panel shows:
 * the messages, and the actions with whether Undo applies. A thread that
 * is someone else's is answered like one that does not exist.
 */
export async function loadThread(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown = {}
): Promise<ThreadResult> {
  const who = await person(rt.ctx, req);
  if (!who) {
    return refuse(401, 'unauthorized', 'Sign in to use the agent.');
  }
  const profileId = who.profileId as string;
  const id = isRecord(input) ? input.threadId : undefined;
  if (typeof id !== 'string' || !id) {
    return refuse(400, 'invalid', 'A thread is required.');
  }

  const thread = await rt.store.getThread(id, profileId);
  if (!thread) {
    return refuse(404, 'not_found', 'Thread not found.');
  }

  //an approval whose time has passed is shown as expired
  await rt.store.expirePending();
  const [ turns, actions, tools ] = await Promise.all([
    rt.store.listTurns(id, profileId),
    rt.store.listActions(id, profileId),
    collectTools(rt.ctx)
  ]);

  return {
    ok: true,
    thread,
    //tool turns and the provider's own record of a reply stay on the server
    turns: turns.filter(turn => turn.role !== 'tool').map(turn => ({
      id: turn.id,
      role: turn.role,
      text: turn.text,
      files: turn.files,
      model: turn.model,
      created: turn.created
    }) as ThreadTurn),
    actions: actions.map(action => ({
      ...action,
      undoable: action.status === 'done' && Boolean(inverseOf(tools, action.tool))
    }) as ThreadAction)
  };
}

//--------------------------------------------------------------------//
// Helpers

/**
 * Read a count from input, keeping it between zero and a maximum.
 */
function count(value: unknown, fallback: number, max: number) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0
    ? Math.min(number, max)
    : fallback;
}

/**
 * What the panel needs before the first message: the models on offer and
 * what is left of the person's daily allowance.
 */
export async function startInfo(
  rt: AgentRuntime,
  req: ToolRequest
): Promise<StartResult> {
  const who = await person(rt.ctx, req);
  if (!who) {
    return refuse(401, 'unauthorized', 'Sign in to use the agent.');
  }
  const usage = await rt.store.getUsage(who.profileId as string);
  const used = usage.inputTokens + usage.outputTokens;
  const limit = Number(rt.config.limit);
  const limited = Number.isFinite(limit) && limit > 0;
  return {
    ok: true,
    models: rt.config.models.map(({ provider, model, title }) => ({
      provider, model, ...(title ? { title } : {})
    })),
    model: pick(rt)?.model || '',
    usage: {
      used,
      ...(limited ? {
        limit,
        remaining: Math.max(0, limit - used),
        resetsAt: resetsAt(rt.now())
      } : {})
    }
  };
}

/**
 * Start an empty chat for the person. When their newest thread has no
 * messages yet it is handed back instead, so opening a chat and leaving
 * again does not fill their history.
 */
export async function newThread(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown = {}
): Promise<NewThreadResult> {
  const who = await person(rt.ctx, req);
  if (!who) {
    return refuse(401, 'unauthorized', 'Sign in to use the agent.');
  }
  const profileId = who.profileId as string;
  const data = isRecord(input) ? input : {};
  if (data.model !== undefined && data.model !== null && data.model !== '') {
    if (typeof data.model !== 'string' || !offered(rt, data.model)) {
      return refuse(400, 'invalid', 'That model is not available.');
    }
  }
  const model = pick(rt, (data.model || undefined) as string | undefined);

  const [ latest ] = await rt.store.listThreads(profileId, { take: 1 });
  if (latest && !(await rt.store.listTurns(latest.id, profileId)).length) {
    return { ok: true, thread: latest, reused: true };
  }
  const thread = await rt.store.createThread({
    profileId, title: 'New chat', model: model?.model
  });
  return { ok: true, thread, reused: false };
}
