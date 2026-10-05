//node
import { randomBytes, randomUUID } from 'node:crypto';
//client
import type {
  ActionStatus,
  AgentAction,
  AgentThread,
  AgentTurn,
  AgentUsage,
  StoreEngine,
  StoreOptions,
  ToolResolverServer
} from '../types.js';
import { isRecord } from '../helpers.js';
import { asStore, createEvents } from './records.js';

//--------------------------------------------------------------------//
// Types

export type NewTurn = {
  role: string,
  text?: string,
  toolCalls?: unknown,
  toolResults?: unknown,
  files?: string[],
  provider?: string,
  model?: string,
  //the provider's reply exactly as the adapter gives it. A string is
  // stored as is; anything else is stored as its JSON text
  raw?: unknown,
  inputTokens?: number,
  outputTokens?: number
};

export type NewAction = {
  threadId: string,
  turnId: string,
  profileId: string,
  tool: string,
  event: string,
  input?: Record<string, unknown>,
  irreversible?: boolean,
  operation?: string,
  reverses?: string,
  //overrides the store's approval lifetime
  expires?: Date | null
};

export type Outcome = {
  status: 'done' | 'failed',
  result?: unknown,
  error?: string,
  operation?: string
};

//this is what an approval answers. Only the call that claimed the action
// may run the tool; every other call gets the stored record back.
export type Approval = {
  action: AgentAction,
  claimed: boolean,
  //the token that proves this call claimed the action. It is needed to
  // settle the action and is given only to the call that claimed it
  claim?: string
};

//the store is a plain object of functions: no way to edit or delete a turn
// exists on it, and it keeps no module-level state
export type AgentStore = ReturnType<typeof createStore>;

//--------------------------------------------------------------------//
// Constants

//these names are generated from the model names in schema.idea
const ACTION = 'agent_action';
const USAGE = 'agent_usage';

//--------------------------------------------------------------------//
// Functions

/**
 * The generated JSON columns hold objects only, and an array or a scalar
 * would be stored as an empty object. Values that can be either are boxed
 * in an object on the way in and unboxed on the way out.
 */
export function box(value: unknown) {
  return typeof value === 'undefined' || value === null
    ? value
    : { value };
}

export function unbox(value: unknown) {
  return isRecord(value) && 'value' in value ? value.value : undefined;
}

/**
 * Create the store over the events generated for the agent models. Reads
 * and plain writes go through those events, the way applications and
 * sessions are read. A claim has to be atomic, and an event can only read
 * and then write, so claims are single guarded UPDATE statements run on the
 * database plugin, and their winner is read back by a token.
 */
export function createStore(
  ctx: ToolResolverServer,
  options: StoreOptions = {}
) {
  const now = options.now || (() => new Date());

  //the generated datetime columns keep whole seconds, so rows made in the
  // same second cannot be told apart by time. Turns and actions get ids that
  // sort in the order they were made: the time, then a counter, then random
  // characters. The counter belongs to this store, not to the module, so
  // order is exact within one store and across stores whenever their writes
  // are a millisecond or more apart. Appends to a thread are serial, and each
  // takes several database round trips, so that holds in practice.
  let last = 0;
  let counter = 0;
  function orderedId() {
    const time = Math.max(now().getTime(), last);
    counter = time === last ? counter + 1 : 0;
    last = time;
    return time.toString(36).padStart(9, '0')
      + counter.toString(36).padStart(4, '0')
      + randomBytes(8).toString('hex').slice(0, 11);
  }

  /**
   * Unbox a stored turn.
   */
  function turnOut(row: AgentTurn) {
    return {
      ...row,
      toolCalls: unbox(row.toolCalls),
      toolResults: unbox(row.toolResults)
    } as AgentTurn;
  }

  /**
   * Unbox a stored action and keep its claim token inside the store.
   */
  function actionOut(row: AgentAction | null) {
    if (!row) return null;
    const { claim: _claim, ...rest } = row;
    return { ...rest, result: unbox(row.result) } as AgentAction;
  }

  /**
   * Resolve one model event and return its results, or throw its error.
   */
  async function resolve<T>(event: string, payload: Record<string, unknown>) {
    //the creates of guarded records are open to the store alone
    const response = createEvents().includes(event)
      ? await asStore(event, () => ctx.resolve<T>(event, payload))
      : await ctx.resolve<T>(event, payload);
    if (!response) {
      throw new Error(`Nothing answered the "${event}" event.`);
    }
    if ((response.code && response.code >= 400) || response.error) {
      throw new Error(
        response.error || response.status || `"${event}" failed`
      );
    }
    return response.results as T;
  }

  /**
   * Run one guarded statement on the database plugin. Errors propagate;
   * the generated update builder would swallow them.
   */
  function run(query: (q: string) => string, values: unknown[]) {
    const engine = ctx.plugin<StoreEngine>('database');
    if (!engine) {
      throw new Error('The database plugin is not registered.');
    }
    return engine.query(query(engine.dialect.q), values);
  }

  /**
   * Read one row by id, or null.
   */
  async function detail<T>(event: string, id: string, eq = {}) {
    try {
      const row = await resolve<T>(event, { id, eq, columns: [ '*' ] });
      return isRecord(row) ? row as T : null;
    } catch (error) {
      //a missing row answers 404, which is not an error for a lookup
      if (error instanceof Error && error.message === 'Not Found') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Read the rows that match a filter, or none.
   */
  async function search<T>(event: string, payload: Record<string, unknown>) {
    const rows = await resolve<T[]>(event, { columns: [ '*' ], ...payload });
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * One thread of the owner, or null for anyone else.
   */
  async function thread(id: string, profileId: string) {
    return detail<AgentThread>(
      'agent-thread-detail', id, { profileId }
    );
  }

  /**
   * One stored action of the owner with its claim token, or null for
   * anyone else. The token never leaves the store.
   */
  async function action(id: string, profileId: string) {
    return detail<AgentAction>(
      'agent-action-detail', id, { profileId }
    );
  }

  /**
   * Expire every pending approval on one thread. Used when a new message
   * arrives. One guarded statement, so it cannot overwrite an approval
   * that was claimed a moment earlier.
   */
  async function expirePending(threadId: string) {
    await run(q => (
      `UPDATE ${q}${ACTION}${q} SET ${q}status${q} = ?, ${q}updated${q} = ? `
      + `WHERE ${q}thread_id${q} = ? AND ${q}status${q} = ?`
    ), [ 'expired', now(), threadId, 'pending' ]);
  }

  /**
   * Expire every pending approval whose time has passed, on any thread.
   */
  async function expireDue() {
    const at = now();
    await run(q => (
      `UPDATE ${q}${ACTION}${q} SET ${q}status${q} = ?, ${q}updated${q} = ? `
      + `WHERE ${q}status${q} = ? AND ${q}expires${q} IS NOT NULL `
      + `AND ${q}expires${q} <= ?`
    ), [ 'expired', at, 'pending', at ]);
  }

  /**
   * Move an action from one status to another only while it is still in
   * the status the caller saw. The claim token, when given, must match.
   */
  function move(
    id: string,
    from: ActionStatus,
    to: ActionStatus,
    set: Record<string, unknown> = {},
    claim?: string
  ) {
    const columns = Object.keys(set);
    return run(q => (
      `UPDATE ${q}${ACTION}${q} SET ${q}status${q} = ?, ${q}updated${q} = ?`
      + columns.map(column => `, ${q}${column}${q} = ?`).join('')
      + ` WHERE ${q}id${q} = ? AND ${q}status${q} = ?`
      + (claim ? ` AND ${q}claim${q} = ?` : '')
    ), [
      to, now(), ...columns.map(column => set[column]), id, from,
      ...(claim ? [ claim ] : [])
    ]);
  }

  return {
    //------------------------------------------------------------------//
    // Threads

    /**
     * Start a thread for a person.
     */
    createThread(input: { profileId: string, title: string, model?: string }) {
      //the times come from the store's clock, like every other time it writes
      return resolve<AgentThread>('agent-thread-create', {
        ...input,
        created: now(),
        updated: now()
      });
    },

    /**
     * List a person's own threads, newest activity first.
     */
    listThreads(
      profileId: string,
      page: { skip?: number, take?: number, inactive?: boolean } = {}
    ) {
      return search<AgentThread>('agent-thread-search', {
        eq: page.inactive ? { profileId } : { profileId, active: true },
        sort: { updated: 'desc', id: 'desc' },
        skip: page.skip || 0,
        take: page.take || 50
      });
    },

    /**
     * Load one thread only for its owner. Anyone else gets null, the same
     * as for a thread that does not exist.
     */
    getThread: thread,

    //------------------------------------------------------------------//
    // Turns (append only)

    /**
     * Append a turn to the owner's thread. A message from the person
     * expires the pending approvals of the thread. A turn is never
     * edited or deleted afterwards.
     */
    async appendTurn(threadId: string, profileId: string, turn: NewTurn) {
      const owned = await thread(threadId, profileId);
      if (!owned) {
        throw new Error('Thread not found.');
      }

      //a new message from the person ends any approval still waiting
      if (turn.role === 'user') {
        await expirePending(threadId);
      }

      const created = await resolve<AgentTurn>('agent-turn-create', {
        id: orderedId(),
        threadId,
        role: turn.role,
        text: turn.text,
        toolCalls: box(turn.toolCalls),
        toolResults: box(turn.toolResults),
        files: turn.files || [],
        provider: turn.provider,
        model: turn.model,
        //stored exactly as given
        raw: typeof turn.raw === 'string' || typeof turn.raw === 'undefined'
          ? turn.raw
          : JSON.stringify(turn.raw),
        inputTokens: turn.inputTokens || 0,
        outputTokens: turn.outputTokens || 0,
        created: now()
      });

      //keep History in order of last activity
      await resolve('agent-thread-update', { id: threadId, updated: now() });
      return turnOut(created);
    },

    /**
     * Read the transcript of the owner's thread, oldest turn first.
     */
    async listTurns(threadId: string, profileId: string) {
      if (!await thread(threadId, profileId)) {
        return [];
      }
      const rows = await search<AgentTurn>('agent-turn-search', {
        eq: { threadId },
        sort: { created: 'asc', id: 'asc' },
        take: 1000
      });
      return rows.map(turnOut);
    },

    //------------------------------------------------------------------//
    // Actions

    /**
     * Record an action that is waiting for the person's approval.
     */
    async createAction(input: NewAction) {
      const owned = await thread(input.threadId, input.profileId);
      if (!owned) {
        throw new Error('Thread not found.');
      }
      const expires = typeof input.expires !== 'undefined'
        ? input.expires
        : options.approvalTtl
        ? new Date(now().getTime() + options.approvalTtl)
        : null;
      const created = await resolve<AgentAction>('agent-action-create', {
        id: orderedId(),
        threadId: input.threadId,
        turnId: input.turnId,
        profileId: input.profileId,
        tool: input.tool,
        event: input.event,
        input: input.input,
        status: 'pending',
        operation: input.operation,
        reverses: input.reverses,
        irreversible: Boolean(input.irreversible),
        expires,
        created: now(),
        updated: now()
      });
      return actionOut(created) as AgentAction;
    },

    /**
     * Read one action for its owner.
     */
    async getAction(id: string, profileId: string) {
      return actionOut(await action(id, profileId));
    },

    /**
     * List the actions of one of the owner's threads, oldest first.
     */
    async listActions(threadId: string, profileId: string) {
      const rows = await search<AgentAction>('agent-action-search', {
        eq: { threadId, profileId },
        sort: { created: 'asc', id: 'asc' },
        take: 1000
      });
      return rows.map(row => actionOut(row) as AgentAction);
    },

    /**
     * Approve a pending action. Exactly one call claims it: a single
     * guarded UPDATE moves it from pending to approved and writes this
     * call's token, and the call whose token is on the row after that is
     * the winner and may run the tool. Any other call, including a repeat,
     * gets the stored record and `claimed` false. Someone who is not the
     * owner gets null and nothing changes.
     */
    async approveAction(id: string, profileId: string): Promise<Approval | null> {
      if (!await action(id, profileId)) {
        return null;
      }

      const token = randomUUID();
      const at = now();
      await run(q => (
        `UPDATE ${q}${ACTION}${q} SET ${q}status${q} = ?, ${q}claim${q} = ?, `
        + `${q}updated${q} = ? WHERE ${q}id${q} = ? AND ${q}status${q} = ? `
        + `AND (${q}expires${q} IS NULL OR ${q}expires${q} > ?)`
      ), [ 'approved', token, at, id, 'pending', at ]);

      const stored = await action(id, profileId);
      if (!stored) {
        return null;
      }

      //a time that passed while it waited is settled here, once
      if (stored.status === 'pending') {
        await expireDue();
        const expired = await action(id, profileId);
        return { action: actionOut(expired || stored)!, claimed: false };
      }

      const claimed = stored.status === 'approved' && stored.claim === token;
      return {
        action: actionOut(stored)!,
        claimed,
        ...(claimed ? { claim: token } : {})
      };
    },

    /**
     * Decline a pending action. A settled action is returned as stored.
     */
    async declineAction(id: string, profileId: string, reason?: string) {
      if (!await action(id, profileId)) {
        return null;
      }
      await move(id, 'pending', 'declined', { error: reason || null });
      return actionOut(await action(id, profileId));
    },

    /**
     * Decline a pending action and tell whether this call was the one that
     * declined it, the way an approval tells who claimed. The turn continues
     * only for the call that declined, so a double click cannot continue it
     * twice. Someone who is not the owner gets null and nothing changes.
     */
    async claimDecline(
      id: string,
      profileId: string,
      reason?: string
    ): Promise<Approval | null> {
      if (!await action(id, profileId)) {
        return null;
      }
      const token = randomUUID();
      await move(id, 'pending', 'declined', {
        error: reason || null,
        claim: token
      });
      const stored = await action(id, profileId);
      if (!stored) {
        return null;
      }
      return {
        action: actionOut(stored)!,
        claimed: stored.status === 'declined' && stored.claim === token
      };
    },

    /**
     * Settle a claimed action as done or failed. Only the claim holder can,
     * and only while the action is approved.
     */
    async completeAction(id: string, claim: string, outcome: Outcome) {
      const set: Record<string, unknown> = {
        result: typeof outcome.result === 'undefined'
          ? null
          : JSON.stringify(box(outcome.result)),
        error: outcome.error || null
      };
      if (outcome.operation) {
        set.operation = outcome.operation;
      }
      await move(id, 'approved', outcome.status, set, claim);
    },

    /**
     * Mark a done action as undone, for its owner.
     */
    async markUndone(id: string, profileId: string) {
      if (!await action(id, profileId)) {
        return null;
      }
      await move(id, 'done', 'undone');
      return actionOut(await action(id, profileId));
    },

    /**
     * Take the right to undo a done action. One guarded UPDATE moves it from
     * done to undone and writes this call's token, and the call whose token
     * is on the row afterwards is the only one that may run the inverse. Any
     * other call, including a repeat, gets the stored record and `claimed`
     * false. Someone who is not the owner gets null and nothing changes.
     */
    async claimUndo(id: string, profileId: string): Promise<Approval | null> {
      if (!await action(id, profileId)) {
        return null;
      }
      const token = randomUUID();
      await move(id, 'done', 'undone', { claim: token });
      const stored = await action(id, profileId);
      if (!stored) {
        return null;
      }
      const claimed = stored.status === 'undone' && stored.claim === token;
      return {
        action: actionOut(stored)!,
        claimed,
        ...(claimed ? { claim: token } : {})
      };
    },

    /**
     * Give the right to undo back, for when the inverse was refused and the
     * action therefore stands. Only the claim holder can.
     */
    async releaseUndo(id: string, claim: string) {
      await move(id, 'undone', 'done', { claim: null }, claim);
    },

    /**
     * Expire the pending approvals of a thread (a new message) or of every
     * thread (time passed).
     */
    expirePending(threadId?: string) {
      return threadId ? expirePending(threadId) : expireDue();
    },

    //------------------------------------------------------------------//
    // Usage

    /**
     * Add to a person's usage for today. The row for a person and day is
     * created once, under an id made from both so a second creation fails,
     * and every addition is one UPDATE that adds in the database, so
     * concurrent additions are all counted.
     */
    async addUsage(
      profileId: string,
      add: { inputTokens?: number, outputTokens?: number, turns?: number }
    ) {
      const day = today(now());
      const id = `${profileId}:${day}`;

      if (!await detail<AgentUsage>('agent-usage-detail', id)) {
        try {
          await resolve('agent-usage-create', {
            id, profileId, day, inputTokens: 0, outputTokens: 0, turns: 0,
            created: now(), updated: now()
          });
        } catch (error) {
          //a concurrent first call created it, which is fine
          if (!await detail<AgentUsage>('agent-usage-detail', id)) {
            throw error;
          }
        }
      }

      await run(q => (
        `UPDATE ${q}${USAGE}${q} SET `
        + `${q}input_tokens${q} = ${q}input_tokens${q} + ?, `
        + `${q}output_tokens${q} = ${q}output_tokens${q} + ?, `
        + `${q}turns${q} = ${q}turns${q} + ?, ${q}updated${q} = ? `
        + `WHERE ${q}id${q} = ?`
      ), [
        Math.max(0, Math.trunc(add.inputTokens || 0)),
        Math.max(0, Math.trunc(add.outputTokens || 0)),
        Math.max(0, Math.trunc(add.turns ?? 1)),
        now(),
        id
      ]);

      return detail<AgentUsage>('agent-usage-detail', id);
    },

    /**
     * Read a person's usage for today. A day with no row reads as zero.
     */
    async getUsage(profileId: string) {
      const day = today(now());
      const row = await detail<AgentUsage>(
        'agent-usage-detail', `${profileId}:${day}`
      );
      return row || {
        id: `${profileId}:${day}`,
        profileId,
        day,
        inputTokens: 0,
        outputTokens: 0,
        turns: 0
      } as AgentUsage;
    }
  };
}

/**
 * The day of a moment as YYYY-MM-DD in UTC, which is the usage key.
 */
export function today(at: Date) {
  return at.toISOString().slice(0, 10);
}
