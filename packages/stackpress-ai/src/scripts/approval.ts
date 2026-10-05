//client
import type {
  AgentAction,
  AgentEvent,
  AgentThread,
  Caller,
  Refusal,
  ToolRequest,
  TurnResult,
  UndoResult,
  Undoing
} from '../types.js';
import type { AgentRuntime, Sink } from './agent.js';
import { isRecord } from '../helpers.js';
import {
  RUNNING,
  contractOf,
  inverseOf,
  offeredTools,
  person,
  refuse
} from './agent.js';
import { continueTurn, execute, recorder } from './turn.js';
import { collectTools } from './tools.js';

//--------------------------------------------------------------------//
// Types

//the person and the action an approval, decline, or undo is about. Both are
// loaded for their owner only, so anyone else never gets this far
type Owned = {
  who: Caller,
  profileId: string,
  action: AgentAction,
  thread: AgentThread
};

//--------------------------------------------------------------------//
// Functions

/**
 * Approve a pending action. The sign-in check runs again here, the action
 * is claimed through the store so exactly one call can run it, the tool runs
 * once as the person, and the turn continues. A repeated approval runs
 * nothing and returns the stored record.
 */
export async function approve(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown,
  sink?: Sink
): Promise<TurnResult> {
  const owned = await load(rt, req, input);
  if (!isOwned(owned)) return owned;
  const { who, profileId, thread } = owned;

  //No message can be stored while an approved action may still act, and a
  // message stored before is found by the claim. A repeated click that finds
  // the gate held still gets the stored record, but a first click that does
  // is turned away with nothing claimed
  const held = await rt.store.gate(thread.id, profileId);
  const { events, emit } = recorder(sink);
  if (!held) {
    const stored = await rt.store.getAction(owned.action.id, profileId);
    if (stored && stored.status !== 'pending') {
      return settled(thread.id, stored, events, emit);
    }
    return refuse(409, 'busy', RUNNING);
  }

  let approval;
  try {
    approval = await rt.store.approveAction(owned.action.id, profileId);
    if (!approval) {
      return refuse(404, 'not_found', 'Action not found.');
    }

    //only the call that claimed the action may run it
    if (!approval.claimed || !approval.claim) {
      return settled(thread.id, approval.action, events, emit);
    }

    //a tool that has since left the registry, or whose contract is no longer
    // the one the person was shown, cannot run, and the action is settled as
    // failed so it does not stay approved forever. A fresh proposal is the
    // way to approve what the tool does now
    const tools = await offeredTools(rt.ctx);
    const tool = tools.get(approval.action.tool);
    const reason = !tool
      ? 'This action is no longer available.'
      : tool.event !== approval.action.event
        //a proposal with no digest cannot be tied to what the person saw
        || approval.action.contract !== contractOf(tool)
        ? 'This action changed after it was proposed, or cannot be checked '
          + 'against it, so it was not run. Ask again to get a new approval.'
        : null;
    if (!tool || reason) {
      await rt.store.completeAction(approval.action.id, approval.claim, {
        status: 'failed', error: reason as string
      });
      emit({
        type: 'action-failed',
        actionId: approval.action.id,
        tool: approval.action.tool,
        input: asInput(approval.action.input),
        error: reason as string
      });
    } else {
      await execute(
        rt, { who, req, emit }, tool, approval.action, approval.claim
      );
    }
  } finally {
    await held.release();
  }

  const status = await continueTurn(rt, {
    who,
    req,
    threadId: thread.id,
    profileId,
    epoch: approval.action.epoch,
    emit
  });
  emit({ type: 'finished', status });
  return {
    ok: true,
    threadId: thread.id,
    status,
    events,
    action: await rt.store.getAction(approval.action.id, profileId) || undefined
  };
}

/**
 * Decline a pending action. The refusal is recorded, the model is told, and
 * the turn continues with no action. A repeated decline runs nothing.
 */
export async function decline(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown,
  sink?: Sink
): Promise<TurnResult> {
  const owned = await load(rt, req, input);
  if (!isOwned(owned)) return owned;
  const { who, profileId, thread } = owned;

  const reason = isRecord(input) && typeof input.reason === 'string'
    ? input.reason.trim().slice(0, 500)
    : undefined;
  const declined = await rt.store.claimDecline(
    owned.action.id, profileId, reason
  );
  if (!declined) {
    return refuse(404, 'not_found', 'Action not found.');
  }
  const { events, emit } = recorder(sink);

  if (!declined.claimed) {
    return settled(thread.id, declined.action, events, emit);
  }

  emit({
    type: 'action-declined',
    actionId: declined.action.id,
    tool: declined.action.tool
  });
  const status = await continueTurn(rt, {
    who,
    req,
    threadId: thread.id,
    profileId,
    epoch: declined.action.epoch,
    emit
  });
  emit({ type: 'finished', status });
  return {
    ok: true,
    threadId: thread.id,
    status,
    events,
    action: declined.action
  };
}

/**
 * Undo a done action by running its inverse tool with the stored inputs, as
 * the person, with no second approval: the click is the person's own. The
 * inverse's event is also told what it is undoing, through the undoing
 * record, kept apart from the input (see `undoing()`). The
 * original is claimed first so a double click runs the inverse once, and the
 * log links the inverse to it. When the app refuses, because the record
 * changed since, the original stands and the reason comes back.
 */
export async function undo(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown,
  sink?: Sink
): Promise<UndoResult> {
  const owned = await load(rt, req, input);
  if (!isOwned(owned)) return owned;
  const { who, profileId, thread, action } = owned;
  const { events, emit } = recorder(sink);

  //undo needs the tool to name an inverse that is still registered
  const tools = await collectTools(rt.ctx);
  const inverse = inverseOf(tools, action.tool);
  if (action.status === 'undone') {
    emit({ type: 'finished', status: 'settled' });
    return { ok: true, threadId: thread.id, status: 'settled', events, action };
  }
  if (action.status !== 'done' || !inverse) {
    return refuse(
      409,
      'conflict',
      action.status !== 'done'
        ? 'Only an action that was done can be undone.'
        : 'This action cannot be undone.'
    );
  }

  const claimed = await rt.store.claimUndo(action.id, profileId);
  if (!claimed) {
    return refuse(404, 'not_found', 'Action not found.');
  }
  if (!claimed.claimed || !claimed.claim) {
    emit({ type: 'finished', status: 'settled' });
    return {
      ok: true,
      threadId: thread.id,
      status: 'settled',
      events,
      action: claimed.action
    };
  }

  //the inverse is logged like any other action, linked to the original, and
  // claimed the same way so it can only run once
  const pending = await rt.store.createAction({
    threadId: thread.id,
    turnId: action.turnId,
    profileId,
    tool: inverse.name,
    event: inverse.event,
    input: asInput(action.input),
    irreversible: false,
    reverses: action.id,
    expires: null
  });
  const approval = await rt.store.approveAction(pending.id, profileId);
  //the undo action exists before the inverse runs, so its id goes with the
  // record. Only the call that claimed the original gets here
  const undone: Undoing = {
    undoActionId: pending.id,
    original: {
      id: action.id,
      tool: action.tool,
      input: asInput(action.input),
      result: action.result,
      operation: action.operation ?? null
    }
  };
  const outcome = approval?.claimed && approval.claim
    ? await execute(
      rt, { who, req, emit }, inverse, pending, approval.claim, undone
    )
    : { failed: true, error: 'The undo could not be started.' };

  if (outcome.failed) {
    //the original still stands, so it gets its place back
    await rt.store.releaseUndo(action.id, claimed.claim);
    emit({ type: 'finished', status: 'failed' });
    return {
      ok: true,
      threadId: thread.id,
      status: 'refused',
      events,
      action: await rt.store.getAction(action.id, profileId) || action,
      undo: await rt.store.getAction(pending.id, profileId) || pending,
      error: outcome.error
    };
  }

  emit({
    type: 'action-undone',
    actionId: action.id,
    tool: action.tool,
    undoActionId: pending.id
  });
  emit({ type: 'finished', status: 'done' });
  return {
    ok: true,
    threadId: thread.id,
    status: 'undone',
    events,
    action: await rt.store.getAction(action.id, profileId) || action,
    undo: await rt.store.getAction(pending.id, profileId) || pending
  };
}

//--------------------------------------------------------------------//
// Helpers

/**
 * Check who is asking and load the action for its owner. Anyone who is not
 * signed in, or not the owner, is refused and nothing runs. A stranger gets
 * the same answer as for an action that does not exist.
 */
async function load(
  rt: AgentRuntime,
  req: ToolRequest,
  input: unknown
): Promise<Owned | Refusal> {
  const who = await person(rt.ctx, req);
  if (!who) {
    return refuse(401, 'unauthorized', 'Sign in to use the agent.');
  }
  const profileId = who.profileId as string;

  const id = isRecord(input) ? input.actionId : undefined;
  if (typeof id !== 'string' || !id) {
    return refuse(400, 'invalid', 'An action is required.');
  }

  const action = await rt.store.getAction(id, profileId);
  const thread = action
    ? await rt.store.getThread(action.threadId, profileId)
    : null;
  if (!action || !thread) {
    return refuse(404, 'not_found', 'Action not found.');
  }
  return { who, profileId, action, thread };
}

function isOwned(value: Owned | Refusal): value is Owned {
  return !('ok' in value);
}

/**
 * The answer for an action that was already answered: the stored record,
 * and nothing ran.
 */
function settled(
  threadId: string,
  action: AgentAction,
  events: AgentEvent[],
  emit: Sink
): TurnResult {
  emit({ type: 'finished', status: 'settled' });
  return {
    ok: true,
    threadId,
    status: 'settled',
    events,
    action,
    replayed: true
  };
}

function asInput(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}
