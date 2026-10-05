//client
import type {
  Adapter,
  AdapterReply,
  AdapterTool,
  AgentAction,
  AgentEvent,
  Caller,
  NormalizedToolConfig,
  ToolRequest,
  ToolResult,
  TurnResult,
  TurnStatus,
  Undoing
} from '../types.js';
import { isRecord, validateInput } from '../helpers.js';
import { ProviderError } from '../adapters/index.js';
import {
  NOT_RUN,
  UNAVAILABLE,
  WAITING,
  buildSystem,
  buildTranscript,
  lastModel,
  limited,
  needsApproval,
  offered,
  offeredTools,
  open,
  operationOf,
  parseInput,
  person,
  pick,
  refuse,
  render,
  DEFAULT_STEPS
} from './agent.js';
import type { AgentRuntime, Sink, StoredResult } from './agent.js';
import { callTool, failed } from './tools.js';

//--------------------------------------------------------------------//
// Types

//what one run needs besides the runtime: who it acts as, the request they
// signed in with, the thread, and where to report
export type Run = {
  who: Caller,
  req: ToolRequest,
  threadId: string,
  profileId: string,
  adapter: Adapter,
  emit: Sink,
  //plain hints from the page, only ever shown to the model
  hints?: unknown
};

//how one tool call ended, for the model and for the loop
type Attempt = {
  result: StoredResult,
  //true when the call stopped at an approval
  waiting: boolean
};

//how one execution of a stored action ended
export type Execution = {
  failed: boolean,
  output: string,
  error?: string,
  operation?: string
};

//--------------------------------------------------------------------//
// Functions

/**
 * Collect the reports of a run, passing each to a callback as it happens.
 * A callback that throws, as a closed stream would, never stops the run: the
 * person already asked for the work and its state is stored.
 */
export function recorder(sink?: Sink) {
  const events: AgentEvent[] = [];
  const emit: Sink = event => {
    events.push(event);
    try {
      sink?.(event);
    } catch {
      //nothing to do
    }
  };
  return { events, emit };
}

/**
 * Take one message from a signed-in person, run the model with the tools
 * the person may use, and store everything. The run stops when the model is
 * done, when an action needs approval, or at the step limit.
 *
 * Everything that can refuse does so before the message is stored and before
 * any provider is called, so a refused message costs nothing.
 */
export async function runTurn(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown,
  sink?: Sink
): Promise<TurnResult> {
  //who is asking comes only from the verified session of this request
  const who = await person(rt.ctx, req);
  if (!who) {
    return refuse(401, 'unauthorized', 'Sign in to use the agent.');
  }
  const profileId = who.profileId as string;

  const parsed = parseInput(input);
  if ('error' in parsed) {
    return refuse(400, 'invalid', parsed.error as string);
  }

  //only the owner can write to a thread, and anyone else is told what a
  // missing thread would be told
  const thread = parsed.threadId
    ? await rt.store.getThread(parsed.threadId, profileId)
    : null;
  if (parsed.threadId && !thread) {
    return refuse(404, 'not_found', 'Thread not found.');
  }
  const history = thread
    ? await rt.store.listTurns(thread.id, profileId)
    : [];

  if (parsed.model && !offered(rt, parsed.model)) {
    return refuse(400, 'invalid', 'That model is not available.');
  }
  const model = pick(rt, parsed.model, lastModel(history), thread?.model);
  const adapter = model ? await open(rt, model) : null;
  if (!model || !adapter) {
    return refuse(503, 'unavailable', UNAVAILABLE);
  }

  const reset = await limited(rt, profileId);
  if (reset) {
    return refuse(
      429,
      'limit',
      `The daily limit for the agent was reached. It resets at ${reset}.`,
      reset
    );
  }

  const { events, emit } = recorder(sink);
  const target = thread || await rt.store.createThread({
    profileId,
    title: titleOf(parsed.message),
    model: model.model
  });
  emit({ type: 'thread', threadId: target.id, title: target.title });

  //storing a message from the person expires any approval still waiting
  await rt.store.appendTurn(target.id, profileId, {
    role: 'user',
    text: parsed.message,
    files: parsed.files
  });

  const status = await converse(rt, {
    who,
    req,
    threadId: target.id,
    profileId,
    adapter,
    emit,
    hints: parsed.context
  });
  emit({ type: 'finished', status });
  return { ok: true, threadId: target.id, status, events };
}

/**
 * Continue a turn that paused for approval, on the model that was answering.
 * Whether a provider can be reached is checked again here, and when it
 * cannot the run reports that and stops, because the action the person
 * answered has already been settled.
 */
export async function continueTurn(
  rt: AgentRuntime,
  run: Omit<Run, 'adapter'>
): Promise<TurnStatus> {
  const turns = await rt.store.listTurns(run.threadId, run.profileId);
  const thread = await rt.store.getThread(run.threadId, run.profileId);
  const model = pick(rt, lastModel(turns), thread?.model);
  const adapter = model ? await open(rt, model) : null;
  if (!adapter) {
    run.emit({ type: 'error', status: 'unavailable', message: UNAVAILABLE });
    return 'unavailable';
  }
  return converse(rt, { ...run, adapter });
}

/**
 * The conversation loop. Each step sends the stored transcript to the
 * model, stores the reply with its usage, and runs the tools it asked for.
 */
export async function converse(
  rt: AgentRuntime,
  run: Run
): Promise<TurnStatus> {
  const { store } = rt;
  const tools = await offeredTools(rt.ctx);
  const offer = Array.from(tools.values()).map(asAdapterTool);
  const system = buildSystem(rt, run.hints);
  const transcript = buildTranscript(
    await store.listTurns(run.threadId, run.profileId),
    await store.listActions(run.threadId, run.profileId)
  );
  const steps = Number.isInteger(rt.config.steps) && rt.config.steps! > 0
    ? rt.config.steps!
    : DEFAULT_STEPS;

  for (let step = 0; step < steps; step++) {
    //every provider call is checked, including the ones a turn makes after
    // an approval and the later steps of one long turn
    const reset = await limited(rt, run.profileId);
    if (reset) {
      run.emit({
        type: 'error',
        status: 'limit',
        message: `The daily limit for the agent was reached. It resets at ${reset}.`,
        resetsAt: reset
      });
      return 'limit';
    }

    let reply: AdapterReply;
    try {
      reply = await run.adapter.send({
        system,
        tools: offer,
        turns: transcript,
        onText: text => run.emit({ type: 'text', text })
      });
    } catch (error) {
      return fail(rt, run, error);
    }

    const assistant = await store.appendTurn(run.threadId, run.profileId, {
      role: 'assistant',
      text: reply.text,
      toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined,
      provider: run.adapter.provider,
      model: run.adapter.model,
      raw: reply.raw ?? undefined,
      inputTokens: reply.usage.input,
      outputTokens: reply.usage.output
    });
    await store.addUsage(run.profileId, {
      inputTokens: reply.usage.input,
      outputTokens: reply.usage.output,
      turns: 1
    });
    run.emit({
      type: 'usage', input: reply.usage.input, output: reply.usage.output
    });
    transcript.push({
      role: 'assistant',
      text: reply.text,
      toolCalls: reply.toolCalls,
      usage: reply.usage,
      raw: reply.raw
    });

    //a paused provider turn is resumed by sending it again
    if (reply.stop === 'pause') continue;
    if (reply.stop === 'refusal') {
      run.emit({
        type: 'error',
        status: 'refusal',
        message: 'The model declined to answer that.'
      });
      return 'refusal';
    }
    if (reply.stop === 'length') {
      run.emit({
        type: 'error',
        status: 'length',
        message: 'The reply was cut off before it finished.'
      });
      return 'length';
    }
    if (reply.stop !== 'tools' || !reply.toolCalls.length) {
      return 'done';
    }

    //Calls run in the order the model asked. The first one that needs the
    // person's approval stops the step: it becomes a pending action, and every
    // call after it is answered as not run, because it may depend on it.
    // Every call still gets a result, which the provider requires.
    const results: StoredResult[] = [];
    let waiting = false;
    for (const call of reply.toolCalls) {
      const attempt = await attempted(
        rt, run, assistant.id, tools, call, waiting
      );
      results.push(attempt.result);
      waiting = waiting || attempt.waiting;
    }
    await store.appendTurn(run.threadId, run.profileId, {
      role: 'tool',
      toolResults: results
    });

    //nothing is held in memory: the pending action and these turns are the
    // whole state, and an approval rebuilds the rest from the store
    if (waiting) return 'waiting';
    transcript.push({
      role: 'tool',
      results: results.map(({ action: _action, ...result }) => result)
    });
  }

  return 'steps';
}

/**
 * Run a stored action that was claimed, as the person, and settle it. The
 * event answers as the person's own session would, and its own refusal is
 * the final word: forbidden, not found, and conflict are logged as failed.
 */
export async function execute(
  rt: AgentRuntime,
  run: Pick<Run, 'who' | 'req' | 'emit'>,
  tool: NormalizedToolConfig,
  action: AgentAction,
  claim: string,
  undone?: Undoing
): Promise<Execution> {
  const input = isRecord(action.input) ? action.input : {};
  run.emit({ type: 'action-start', actionId: action.id, tool: tool.name, input });

  let result: ToolResult;
  try {
    result = await callTool(rt.ctx, tool, input, run.who, run.req, undone);
  } catch (error) {
    //an event that threw is not the person's business
    rt.log(`The "${tool.name}" tool threw.`, error);
    result = {
      code: 500,
      status: 'Internal Server Error',
      error: 'The action failed unexpectedly.'
    };
  }

  //an event nobody answered has a code of zero, and nothing was done
  if (failed(result) || !result.code) {
    const error = describeFailure(result);
    await rt.store.completeAction(action.id, claim, {
      status: 'failed',
      error,
      result: result.results ?? undefined
    });
    run.emit({
      type: 'action-failed',
      actionId: action.id,
      tool: tool.name,
      input,
      error,
      ...(result.code ? { code: result.code } : {})
    });
    return { failed: true, output: error, error };
  }

  const operation = operationOf(tool, result.results);
  await rt.store.completeAction(action.id, claim, {
    status: 'done',
    result: result.results ?? undefined,
    operation
  });
  run.emit({
    type: 'action-done',
    actionId: action.id,
    tool: tool.name,
    input,
    result: result.results ?? null,
    ...(operation ? { operation } : {}),
    undoable: Boolean(tool.inverse)
  });
  return { failed: false, output: render(result.results), operation };
}

//--------------------------------------------------------------------//
// Helpers

/**
 * Handle one call from the model.
 */
async function attempted(
  rt: AgentRuntime,
  run: Run,
  turnId: string,
  tools: Map<string, NormalizedToolConfig>,
  call: { id: string, name: string, input: Record<string, unknown> },
  gated: boolean
): Promise<Attempt> {
  const answer = (
    output: string,
    isError = false,
    action?: string
  ): StoredResult => ({
    id: call.id,
    name: call.name,
    output,
    ...(isError ? { isError: true } : {}),
    ...(action ? { action } : {})
  });

  if (gated) {
    return { result: answer(NOT_RUN, true), waiting: false };
  }

  //a name the model made up, or a tool it was not offered, never runs
  const tool = tools.get(call.name);
  if (!tool) {
    return {
      result: answer(`There is no tool named "${call.name}".`, true),
      waiting: false
    };
  }

  //a bad input is the model's mistake and is handed back to it. It is
  // checked before an approval is asked for, so the person is never asked to
  // approve a call that cannot run
  const input = isRecord(call.input) ? call.input : {};
  try {
    validateInput(tool, input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      result: answer(
        `The input was not valid. ${reason.slice(0, 1000)}`, true
      ),
      waiting: false
    };
  }

  if (needsApproval(tool)) {
    const action = await rt.store.createAction({
      threadId: run.threadId,
      turnId,
      profileId: run.profileId,
      tool: tool.name,
      event: tool.event,
      input,
      irreversible: true
    });
    run.emit({
      type: 'action-waiting',
      actionId: action.id,
      tool: tool.name,
      input,
      expires: action.expires ? new Date(action.expires).toISOString() : null
    });
    return { result: answer(WAITING, false, action.id), waiting: true };
  }

  //a reversible tool, or a read, runs now and is logged. It goes through the
  // same claim as an approval so it can only ever run once
  const action = await rt.store.createAction({
    threadId: run.threadId,
    turnId,
    profileId: run.profileId,
    tool: tool.name,
    event: tool.event,
    input,
    irreversible: false,
    expires: null
  });
  const approval = await rt.store.approveAction(action.id, run.profileId);
  if (!approval?.claimed || !approval.claim) {
    return {
      result: answer('The action could not be started.', true),
      waiting: false
    };
  }
  const outcome = await execute(rt, run, tool, action, approval.claim);
  return { result: answer(outcome.output, outcome.failed), waiting: false };
}

/**
 * Settle a run that a provider call ended. What the person is told is fixed
 * text by kind; the provider's own message goes only to the operator's log,
 * because it can name keys or accounts.
 */
function fail(rt: AgentRuntime, run: Run, error: unknown): TurnStatus {
  const kind = error instanceof ProviderError ? error.kind : 'other';

  if (kind === 'rate_limit') {
    run.emit({
      type: 'error',
      status: 'busy',
      message: 'The model is busy. Try again in a moment.',
      ...(error instanceof ProviderError && error.retryAfter !== undefined
        ? { retryAfter: error.retryAfter }
        : {})
    });
    return 'busy';
  }
  if (kind === 'refusal') {
    run.emit({
      type: 'error',
      status: 'refusal',
      message: 'The model declined to answer that.'
    });
    return 'refusal';
  }

  rt.log('The provider call failed.', error);
  if (kind === 'authentication') {
    run.emit({ type: 'error', status: 'unavailable', message: UNAVAILABLE });
    return 'unavailable';
  }
  run.emit({
    type: 'error',
    status: 'failed',
    message: 'The model could not answer. Try again.'
  });
  return 'failed';
}

/**
 * How the model is told about one tool.
 */
function asAdapterTool(tool: NormalizedToolConfig): AdapterTool {
  return {
    name: tool.name,
    description: tool.description || tool.title,
    input: tool.input || { type: 'object', properties: {} }
  };
}

/**
 * Say why an action failed, from the event's own answer.
 */
function describeFailure(result: ToolResult) {
  if (!result.code && !result.error) {
    return 'Nothing answered this action, so it was not done.';
  }
  const label = [ result.code || '', result.status || '' ]
    .filter(Boolean).join(' ');
  const reason = result.error || result.status || 'The action failed.';
  return label && result.error ? `${reason} (${label})` : reason;
}

/**
 * A thread's title is the start of its first message.
 */
function titleOf(message: string) {
  const line = message.split('\n')[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}...` : line || 'New chat';
}
