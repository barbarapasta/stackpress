//node
import { randomBytes, randomUUID } from 'node:crypto';
//client
import type {
  ActionStatus,
  AgentAction,
  AgentLock,
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
  //the token stored with the person's message the run began from. The action
  // can only be claimed while that is still the newest message of the thread
  epoch?: string,
  //the digest of the tool's execution contract when it was proposed
  contract?: string,
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

//the right to make one provider call for a person, or why it was refused.
// 'busy' means another call of theirs holds the slot, and 'limit' means the
// day's allowance is already spent.
export type Admission =
  | {
    ok: true,
    //counts the call's tokens against the day it was admitted on, then frees
    // the slot. Frees it without counting when nothing was spent
    settle: (add?: Usage) => Promise<void>
  }
  | { ok: false, reason: 'busy' | 'limit' };

//the right to store a message or run an approved action in one thread. Only
// the holder frees it
export type Gate = {
  //makes a token the thread's current one, which replaces every other
  mark: (epoch: string) => Promise<void>,
  release: () => Promise<void>
};

//thrown when a message cannot be stored because an action of the thread is
// running, so that nothing is acknowledged while it still might act
export class ThreadBusy extends Error {
  constructor() {
    super('An action in this thread is still running.');
  }
}

export type Usage = { inputTokens?: number, outputTokens?: number, turns?: number };

//the store is a plain object of functions: no way to edit or delete a turn
// exists on it, and it keeps no module-level state
export type AgentStore = ReturnType<typeof createStore>;

//--------------------------------------------------------------------//
// Constants

//these names are generated from the model names in schema.idea
const ACTION = 'agent_action';
const TURN = 'agent_turn';
const USAGE = 'agent_usage';
const LOCK = 'agent_lock';

//one page of a long list. A transcript is read to its end, page by page
const PAGE = 1000;

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
  // this order is exact only within one store. A turn is therefore given its
  // id by `nextTurnId`, which continues from the greatest id the thread has
  // stored whatever store or clock made it, and a transcript is read in id
  // order alone. Actions keep these ids as they are, which orders them for
  // display only, so across stores their order is exact only when their
  // writes are a millisecond or more apart.
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
   * The condition that holds while an action may still be claimed: the token
   * it was proposed under is the one the thread's lock holds now. A message
   * replaces that token while it is stored, under the same lock, so no
   * ordering of ids or clocks is involved, only equality. Because this is
   * part of the claiming statement, a message stored a moment earlier wins
   * and an approval or an automatic write that comes after it cannot start,
   * however long the run that proposed it took. It holds one placeholder,
   * the id of the thread's lock, which the caller supplies in its values.
   */
  function fence(q: string) {
    return `(${q}${ACTION}${q}.${q}epoch${q} IS NULL OR EXISTS (`
      + `SELECT 1 FROM ${q}${LOCK}${q} WHERE ${q}${LOCK}${q}.${q}id${q} = ? `
      + `AND ${q}${LOCK}${q}.${q}epoch${q} = ${q}${ACTION}${q}.${q}epoch${q}))`;
  }

  /**
   * Expire the pending approvals that a newer message has replaced, which
   * are the ones no claim can win any more.
   */
  async function expireSuperseded(threadId: string) {
    const lock = `thread:${threadId}`;
    await run(q => (
      `UPDATE ${q}${ACTION}${q} SET ${q}status${q} = ?, ${q}updated${q} = ? `
      + `WHERE ${q}thread_id${q} = ? AND ${q}status${q} = ? `
      + `AND NOT ${fence(q)}`
    ), [ 'expired', now(), threadId, 'pending', lock ]);
  }

  /**
   * Whether a run that began under this token is still the newest of its
   * thread, which is the only run that may go on. A thread no message has
   * been stored in through the store has no token, and nothing is replaced.
   */
  async function newest(threadId: string, epoch: string) {
    const row = await detail<AgentLock>('agent-lock-detail', `thread:${threadId}`);
    return (row?.epoch ?? '') === epoch;
  }

  /**
   * Read every row a search matches, a page at a time.
   */
  async function every<T>(event: string, payload: Record<string, unknown>) {
    const rows: T[] = [];
    for (let skip = 0; ; skip += PAGE) {
      const page = await search<T>(event, { ...payload, skip, take: PAGE });
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  /**
   * Make sure the row for a person and day exists. It is created once, under
   * an id made from both, so a second creation fails and the loser reads the
   * winner's row.
   */
  async function ensureUsage(profileId: string, day: string) {
    const id = `${profileId}:${day}`;
    if (await detail<AgentUsage>('agent-usage-detail', id)) return id;
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
    return id;
  }

  /**
   * Make sure a lock row exists, the same way.
   */
  async function ensureLock(id: string, profileId: string) {
    if (await detail<AgentLock>('agent-lock-detail', id)) return;
    try {
      await resolve('agent-lock-create', {
        id, profileId, created: now(), updated: now()
      });
    } catch (error) {
      if (!await detail<AgentLock>('agent-lock-detail', id)) {
        throw error;
      }
    }
  }

  /**
   * Take a lock for the holder. One guarded UPDATE succeeds only while the
   * lock is free and the extra condition, if any, holds, and the call whose
   * token is on the row afterwards owns it. It is never taken over: it stays
   * with its holder until the holder frees it, however long that takes, so a
   * slow provider or tool can never see a second caller let in beside it.
   */
  async function take(
    id: string,
    profileId: string,
    holder: string,
    also: (q: string) => string = () => '',
    values: unknown[] = []
  ) {
    await ensureLock(id, profileId);
    const at = now();
    await run(q => (
      `UPDATE ${q}${LOCK}${q} SET ${q}holder${q} = ?, ${q}since${q} = ?, `
      + `${q}updated${q} = ? WHERE ${q}id${q} = ? AND ${q}holder${q} IS NULL`
      + also(q)
    ), [ holder, at, at, id, ...values ]);
    const row = await detail<AgentLock>('agent-lock-detail', id);
    return row?.holder === holder;
  }

  /**
   * Free a lock, but only for the holder.
   */
  function free(id: string, holder: string) {
    return run(q => (
      `UPDATE ${q}${LOCK}${q} SET ${q}holder${q} = NULL, ${q}since${q} = NULL, `
      + `${q}updated${q} = ? WHERE ${q}id${q} = ? AND ${q}holder${q} = ?`
    ), [ now(), id, holder ]);
  }

  /**
   * Take the gate of a thread for its owner, or null while another holds it.
   */
  async function gate(threadId: string, profileId: string): Promise<Gate | null> {
    const id = `thread:${threadId}`;
    const holder = randomUUID();
    return await take(id, profileId, holder)
      ? {
        mark: async epoch => {
          await run(q => (
            `UPDATE ${q}${LOCK}${q} SET ${q}epoch${q} = ?, ${q}updated${q} = ? `
            + `WHERE ${q}id${q} = ? AND ${q}holder${q} = ?`
          ), [ epoch, now(), id, holder ]);
        },
        release: () => free(id, holder).then(() => undefined)
      }
      : null;
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

  /**
   * The id of the next turn of a thread. The store's own ids sort in the
   * order it made them, but two stores, as two servers are, can make ids in
   * the same millisecond whose order is chance. Turns of one thread are
   * stored one at a time under its gate, so the next id is made to sort
   * after the greatest id already stored, whatever store or clock made it.
   */
  async function nextTurnId(threadId: string) {
    const [ latest ] = await run(q => (
      `SELECT MAX(${q}id${q}) AS ${q}id${q} FROM ${q}${TURN}${q} `
      + `WHERE ${q}thread_id${q} = ?`
    ), [ threadId ]) as { id: string | null }[];
    const id = orderedId();
    //an id the store did not make has no head to continue from
    if (!latest?.id || id > latest.id || !/^[0-9a-z]{24}$/.test(latest.id)) {
      return id;
    }
    //the time and the counter, one more, with fresh random characters
    return increment(latest.id.slice(0, 13)) + id.slice(13);
  }

  /**
   * Store one turn and keep History in order of last activity.
   */
  async function insert(threadId: string, turn: NewTurn) {
    const created = await resolve<AgentTurn>('agent-turn-create', {
      id: await nextTurnId(threadId),
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
    await resolve('agent-thread-update', { id: threadId, updated: now() });
    return turnOut(created);
  }

  const self = {
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
     * Store a message from the person, and give back the token that stands
     * for it. It is the thread's current token from the moment it is stored:
     * every approval and write proposed under an earlier one is replaced
     * and every earlier run is stale. Storing and replacing the token
     * happen under the gate of the thread, which an approved action also
     * holds while it runs, so a message that cannot get the gate is refused
     * with `ThreadBusy` and nothing is stored or acknowledged while an old
     * action may still act. A message does not wait for a provider call,
     * only an action, so it replaces the run that is waiting on one.
     */
    async appendMessage(
      threadId: string,
      profileId: string,
      turn: NewTurn
    ) {
      if (!await thread(threadId, profileId)) {
        throw new Error('Thread not found.');
      }
      const held = await gate(threadId, profileId);
      if (!held) {
        throw new ThreadBusy();
      }
      const epoch = randomUUID();
      let created: AgentTurn;
      try {
        created = await insert(threadId, { ...turn, role: 'user' });
        await held.mark(epoch);
        //Ending the cards still showing is for display only, since no claim
        // can win them any more. It runs under the gate, because a proposal
        // under the new token can only be made once the gate is free, so
        // this can never end a card of the message that replaced it
        await expirePending(threadId);
      } finally {
        await held.release();
      }
      return { turn: created, epoch };
    },

    /**
     * Append a turn to the owner's thread. A message from the person is
     * stored by `appendMessage`. A turn is never edited or deleted
     * afterwards.
     */
    async appendTurn(threadId: string, profileId: string, turn: NewTurn) {
      if (turn.role === 'user') {
        return (await self.appendMessage(threadId, profileId, turn)).turn;
      }
      if (!await thread(threadId, profileId)) {
        throw new Error('Thread not found.');
      }
      return insert(threadId, turn);
    },

    /**
     * Append the reply of a run, only while the token it began under is
     * still the thread's current one. The check and the append happen under
     * the gate, so a reply cannot land after a message that replaced its run.
     * A stale run, or one that finds the gate held because a message is being
     * stored, gets null and stores nothing.
     */
    async appendReply(
      threadId: string,
      profileId: string,
      epoch: string,
      turn: NewTurn
    ): Promise<AgentTurn | null> {
      if (!await thread(threadId, profileId)) {
        throw new Error('Thread not found.');
      }
      const held = await gate(threadId, profileId);
      if (!held) return null;
      try {
        return await newest(threadId, epoch)
          ? await insert(threadId, turn)
          : null;
      } finally {
        await held.release();
      }
    },

    /**
     * Record an action that needs approval, only while the token it is
     * proposed under is still the thread's current one, under the gate. A
     * run that a message replaced gets null, and no waiting card is made.
     */
    async propose(input: NewAction & { epoch: string }) {
      const held = await gate(input.threadId, input.profileId);
      if (!held) return null;
      try {
        return await newest(input.threadId, input.epoch)
          ? await self.createAction(input)
          : null;
      } finally {
        await held.release();
      }
    },

    /**
     * Whether a run that began under this token may still go on.
     */
    current: newest,

    /**
     * The token of the thread's newest message, or empty for a thread no
     * message was stored in through the store.
     */
    async epoch(threadId: string) {
      const row = await detail<AgentLock>(
        'agent-lock-detail', `thread:${threadId}`
      );
      return row?.epoch ?? '';
    },

    /**
     * Read the whole transcript of the owner's thread, oldest turn first.
     */
    async listTurns(threadId: string, profileId: string) {
      if (!await thread(threadId, profileId)) {
        return [];
      }
      //by id alone: ids of a thread's turns are made to rise (see
      // `nextTurnId`), and a store's clock can differ from another's
      const rows = await every<AgentTurn>('agent-turn-search', {
        eq: { threadId },
        sort: { id: 'asc' }
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
        epoch: input.epoch,
        contract: input.contract,
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
     * List every action of one of the owner's threads, oldest first.
     */
    async listActions(threadId: string, profileId: string) {
      const rows = await every<AgentAction>('agent-action-search', {
        eq: { threadId, profileId },
        sort: { created: 'asc', id: 'asc' }
      });
      return rows.map(row => actionOut(row) as AgentAction);
    },

    /**
     * Approve a pending action. Exactly one call claims it: a single
     * guarded UPDATE moves it from pending to approved and writes this
     * call's token, and the call whose token is on the row after that is
     * the winner and may run the tool. Any other call, including a repeat,
     * gets the stored record and `claimed` false. So does a call for an
     * action that a newer message replaced, which is settled as expired.
     * Someone who is not the owner gets null and nothing changes.
     */
    async approveAction(id: string, profileId: string): Promise<Approval | null> {
      const found = await action(id, profileId);
      if (!found) {
        return null;
      }

      const token = randomUUID();
      const at = now();
      const lock = `thread:${found.threadId}`;
      await run(q => (
        `UPDATE ${q}${ACTION}${q} SET ${q}status${q} = ?, ${q}claim${q} = ?, `
        + `${q}updated${q} = ? WHERE ${q}id${q} = ? AND ${q}status${q} = ? `
        + `AND (${q}expires${q} IS NULL OR ${q}expires${q} > ?) `
        + `AND ${fence(q)}`
      ), [ 'approved', token, at, id, 'pending', at, lock ]);

      const stored = await action(id, profileId);
      if (!stored) {
        return null;
      }

      //a time that passed while it waited, or a message that replaced it, is
      // settled here, once
      if (stored.status === 'pending') {
        await expireSuperseded(stored.threadId);
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
     * Add to a person's usage for a day, today unless one is given. The row
     * for a person and day is created once, and every addition is one UPDATE
     * that adds in the database, so concurrent additions are all counted.
     */
    async addUsage(
      profileId: string,
      add: Usage & { day?: string }
    ) {
      const id = await ensureUsage(profileId, add.day || today(now()));

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
     * Take the right to make one provider call for a person, under a daily
     * limit. Reading the allowance and then calling would let calls that
     * start together all see the same unspent allowance, so the slot is
     * taken by one guarded UPDATE that also holds only while the day's
     * tokens are still under the limit: the limit is checked again at the
     * moment of the claim. A call that gets in may spend more than what is
     * left, which is the policy for one call, but the next cannot start
     * until its tokens are counted.
     *
     * The slot is per person and not per day, so a call that runs past
     * midnight still blocks the next, and its tokens are counted against the
     * day it was admitted on. It is never taken over (see `take`). A process
     * that stopped during a call, or whose usage could not be recorded
     * afterwards, leaves it held, and the person is then told the agent is
     * busy until the operator clears the holder of the `profile:` lock.
     */
    async admit(profileId: string, limit: number): Promise<Admission> {
      const day = today(now());
      const usage = await ensureUsage(profileId, day);
      const id = `profile:${profileId}`;
      const holder = randomUUID();

      const taken = await take(id, profileId, holder, q => (
        ` AND (SELECT ${q}input_tokens${q} + ${q}output_tokens${q} `
        + `FROM ${q}${USAGE}${q} WHERE ${q}id${q} = ?) < ?`
      ), [ usage, limit ]);
      if (!taken) {
        const spent = await detail<AgentUsage>('agent-usage-detail', usage);
        return {
          ok: false,
          reason: spent && spent.inputTokens + spent.outputTokens >= limit
            ? 'limit'
            : 'busy'
        };
      }

      return {
        ok: true,
        settle: async add => {
          //The slot is freed only after the tokens are counted. When
          // counting fails the provider's answer is known to have cost
          // something that was not recorded, so the slot stays held and the
          // next call is not admitted against a stale allowance. The count
          // is not retried here, because whether the failed write landed is
          // not known and a retry could count it twice. The operator checks
          // the usage row and clears the holder of the `profile:` lock.
          if (add) await self.addUsage(profileId, { ...add, day });
          await free(id, holder);
        }
      };
    },

    /**
     * Whether a call of this person holds the slot right now, as far as a
     * look can tell. A quick way to turn a message away before storing it.
     */
    async busy(profileId: string) {
      const row = await detail<AgentLock>(
        'agent-lock-detail', `profile:${profileId}`
      );
      return Boolean(row?.holder);
    },

    /**
     * Take the right to run an action in a thread, which no message can be
     * stored while it is held. Null while a message is being stored or
     * another action runs.
     */
    gate,

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

  return self;
}

/**
 * Add one to a base 36 number written as text, keeping its width. The head
 * of an id is wider than a number can hold exactly, so it is carried digit
 * by digit.
 */
function increment(head: string) {
  const digits = head.split('');
  for (let at = digits.length - 1; at >= 0; at--) {
    if (digits[at] !== 'z') {
      digits[at] = (parseInt(digits[at], 36) + 1).toString(36);
      return digits.join('');
    }
    digits[at] = '0';
  }
  return digits.join('');
}

/**
 * The day of a moment as YYYY-MM-DD in UTC, which is the usage key.
 */
export function today(at: Date) {
  return at.toISOString().slice(0, 10);
}
