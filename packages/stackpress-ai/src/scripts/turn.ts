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
import type { AgentRuntime, Sink, StoredResult } from './agent.js';
import { isRecord, validateInput } from '../helpers.js';
import { ProviderError } from '../adapters/index.js';
import {
  BUSY,
  NOT_RUN,
  RUNNING,
  SUPERSEDED,
  UNAVAILABLE,
  WAITING,
  buildSystem,
  buildTranscript,
  contractOf,
  lastModel,
  limitOf,
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
  resetsAt,
  DEFAULT_STEPS
} from './agent.js';
import { ThreadBusy } from './store.js';
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
  //the id of the person's message this run answers. Only the run of the
  // newest message of a thread may call a provider or act for the person
  epoch: string,
  adapter: Adapter,
  emit: Sink,
  //plain hints from the page, only ever shown to the model
  hints?: unknown
};

//how one tool call ended, for the model and for the loop
type Attempt = {
  result: StoredResult,
  //true when the call stopped at an approval
  waiting: boolean,
  //true when a newer message replaced this run, which then goes no further
  superseded?: boolean
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

  //with a daily limit a person has one provider call at a time, so a message
  // that would have to wait behind one is turned away before it is stored
  if (limitOf(rt) && await rt.store.busy(profileId)) {
    return refuse(409, 'busy', BUSY);
  }

  const { events, emit } = recorder(sink);
  const target = thread || await rt.store.createThread({
    profileId,
    title: titleOf(parsed.message),
    model: model.model
  });
  emit({ type: 'thread', threadId: target.id, title: target.title });

  //storing a message from the person ends the approvals still waiting and
  // replaces any run still going. It waits for no action: while an approved
  // action is running it is refused, and nothing is stored
  let message;
  try {
    message = await rt.store.appendMessage(target.id, profileId, {
      role: 'user',
      text: parsed.message,
      files: parsed.files
    });
  } catch (error) {
    if (error instanceof ThreadBusy) {
      return refuse(409, 'busy', RUNNING);
    }
    throw error;
  }

  const status = await converse(rt, {
    who,
    req,
    threadId: target.id,
    profileId,
    epoch: message.epoch,
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
  run: Omit<Run, 'adapter' | 'epoch'> & { epoch?: string | null }
): Promise<TurnStatus> {
  const turns = await rt.store.listTurns(run.threadId, run.profileId);
  const thread = await rt.store.getThread(run.threadId, run.profileId);
  const model = pick(rt, lastModel(turns), thread?.model);
  const adapter = model ? await open(rt, model) : null;
  if (!adapter) {
    run.emit({ type: 'error', status: 'unavailable', message: UNAVAILABLE });
    return 'unavailable';
  }
  //an action from before tokens were kept belongs to the newest message
  const epoch = run.epoch ?? await rt.store.epoch(run.threadId);
  return converse(rt, { ...run, epoch, adapter });
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
    //a message that came after this run began replaced it, and the person
    // is answered by the run of that message
    if (!await store.current(run.threadId, run.epoch)) return 'settled';

    //every provider call is checked, including the ones a turn makes after
    // an approval and the later steps of one long turn. Under a limit the
    // check and the right to call are one step, so calls that start together
    // cannot all pass it
    const limit = limitOf(rt);
    const admission = limit
      ? await store.admit(run.profileId, limit)
      : null;
    if (admission && !admission.ok) {
      if (admission.reason === 'busy') {
        run.emit({ type: 'error', status: 'busy', message: BUSY });
        return 'busy';
      }
      const reset = resetsAt(rt.now());
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
      //nothing was spent, so the right to call is given back as it was
      if (admission?.ok) await admission.settle();
      return fail(rt, run, error);
    }

    //what the call used is counted whether or not the run is still wanted,
    // and before the next call can be admitted
    const used = {
      inputTokens: reply.usage.input,
      outputTokens: reply.usage.output,
      turns: 1
    };
    try {
      if (admission?.ok) {
        await admission.settle(used);
      } else {
        await store.addUsage(run.profileId, used);
      }
    } catch (error) {
      //the reply is dropped, since its cost could not be recorded. With a
      // limit the slot stays held, so no call is admitted against the
      // allowance as it was before this one
      rt.log('The usage of a provider call could not be recorded.', error);
      run.emit({
        type: 'error',
        status: 'failed',
        message: 'The model could not answer. Try again.'
      });
      return 'failed';
    }

    //a reply that arrives after a newer message is dropped
    const assistant = await store.appendReply(
      run.threadId,
      run.profileId,
      run.epoch,
      {
        role: 'assistant',
        text: reply.text,
        toolCalls: reply.toolCalls.length ? reply.toolCalls : undefined,
        provider: run.adapter.provider,
        model: run.adapter.model,
        raw: reply.raw ?? undefined,
        inputTokens: reply.usage.input,
        outputTokens: reply.usage.output
      }
    );
    if (!assistant) return 'settled';
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
      //a newer message ended this run. Whatever it has not done stays
      // undone, and the model is told on the next call that it was lost
      if (attempt.superseded) return 'settled';
      results.push(attempt.result);
      waiting = waiting || attempt.waiting;
    }
    if (!await store.appendReply(
      run.threadId, run.profileId, run.epoch, {
        role: 'tool',
        toolResults: results
      }
    )) {
      return 'settled';
    }

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
  if (failed(result)) {
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

  const proposal = {
    threadId: run.threadId,
    turnId,
    profileId: run.profileId,
    tool: tool.name,
    event: tool.event,
    input,
    epoch: run.epoch,
    contract: contractOf(tool)
  };

  if (needsApproval(tool)) {
    //a run that a newer message replaced makes no card, so the person is
    // never shown an approval that cannot be given
    const action = await rt.store.propose({
      ...proposal,
      irreversible: true
    });
    if (!action) {
      return { result: answer(SUPERSEDED, true), waiting: false, superseded: true };
    }
    run.emit({
      type: 'action-waiting',
      actionId: action.id,
      tool: tool.name,
      input,
      expires: action.expires ? new Date(action.expires).toISOString() : null
    });
    return { result: answer(WAITING, false, action.id), waiting: true };
  }

  //A reversible tool, or a read, runs now and is logged. It goes through
  // the same claim as an approval so it can only ever run once, and a write
  // holds the gate of the thread from before the claim until it is settled,
  // so no message is stored while it may still act and any message stored
  // before it is found by the claim
  const held = tool.method === 'GET'
    ? null
    : await rt.store.gate(run.threadId, run.profileId);
  if (tool.method !== 'GET' && !held) {
    return { result: answer(SUPERSEDED, true), waiting: false, superseded: true };
  }
  try {
    const action = await rt.store.createAction({
      ...proposal,
      irreversible: false,
      expires: null
    });
    const approval = await rt.store.approveAction(action.id, run.profileId);
    if (!approval?.claimed || !approval.claim) {
      return approval && approval.action.status === 'expired'
        ? {
          result: answer(SUPERSEDED, true),
          waiting: false,
          superseded: true
        }
        : {
          result: answer('The action could not be started.', true),
          waiting: false
        };
    }
    const outcome = await execute(rt, run, tool, action, approval.claim);
    return {
      result: answer(outcome.output, outcome.failed, action.id),
      waiting: false
    };
  } finally {
    await held?.release();
  }
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
