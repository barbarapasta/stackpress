//node
import { randomUUID } from 'node:crypto';
//modules
import { PGlite } from '@electric-sql/pglite';
import { server as http } from '@stackpress/ingest/http';
import { connect } from '@stackpress/inquire-pglite';
import { Session } from 'stackpress-session';
//client
import stub from '../src/adapters/stub.js';
import type { StubAdapter } from '../src/adapters/stub.js';
import {
  AGENT_EVENTS,
  approve,
  create,
  decline,
  start,
  thread,
  threads,
  turn,
  undo
} from '../src/events/index.js';
import { createRuntime } from '../src/scripts/agent.js';
import { createStore } from '../src/scripts/store.js';
import { caller, undoing } from '../src/scripts/tools.js';
import type {
  AgentConfig,
  AgentModelConfig,
  StoreOptions,
  StubReply,
  ToolConfig,
  ToolRequest,
  ToolResolverServer
} from '../src/types.js';
//tests
import { createCtxStub } from './helpers.js';

//--------------------------------------------------------------------//
// Harness

//The store reads and writes through the events the idea pipeline
// generates, which live in the application's client and are not part of
// this package. This harness answers those events over a real PGlite
// database, with the same table and column names the generated store
// pushes, so the store's own guarded statements run as real SQL.

export const DDL = [
  `CREATE TABLE agent_thread (id VARCHAR(255) PRIMARY KEY,
    profile_id VARCHAR(255) NOT NULL, title VARCHAR(255) NOT NULL,
    model VARCHAR(255), active BOOLEAN NOT NULL DEFAULT TRUE,
    created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE agent_turn (id VARCHAR(255) PRIMARY KEY,
    thread_id VARCHAR(255) NOT NULL, role VARCHAR(255) NOT NULL,
    text TEXT, tool_calls JSONB, tool_results JSONB,
    files JSONB NOT NULL DEFAULT '[]', provider VARCHAR(255),
    model VARCHAR(255), raw TEXT, input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE agent_action (id VARCHAR(255) PRIMARY KEY,
    thread_id VARCHAR(255) NOT NULL, turn_id VARCHAR(255) NOT NULL,
    profile_id VARCHAR(255) NOT NULL, tool VARCHAR(255) NOT NULL,
    event VARCHAR(255) NOT NULL, input JSONB,
    status VARCHAR(255) NOT NULL DEFAULT 'pending', result JSONB,
    error TEXT, operation VARCHAR(255), reverses VARCHAR(255),
    irreversible BOOLEAN NOT NULL, claim VARCHAR(255),
    epoch VARCHAR(255), contract VARCHAR(255), expires TIMESTAMP,
    created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE agent_usage (id VARCHAR(255) PRIMARY KEY,
    profile_id VARCHAR(255) NOT NULL, day VARCHAR(255) NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
    turns INTEGER NOT NULL,
    created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE agent_lock (id VARCHAR(255) PRIMARY KEY,
    profile_id VARCHAR(255) NOT NULL, holder VARCHAR(255),
    epoch VARCHAR(255), since TIMESTAMP,
    created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`
];

export const TABLES: Record<string, string> = {
  'agent-thread': 'agent_thread',
  'agent-turn': 'agent_turn',
  'agent-action': 'agent_action',
  'agent-usage': 'agent_usage',
  'agent-lock': 'agent_lock'
};

const JSON_COLUMNS = [ 'toolCalls', 'toolResults', 'files', 'input', 'result' ];
const DATE_COLUMNS = [ 'created', 'updated', 'expires', 'since' ];

const snake = (name: string) => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function toRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([ key, value ]) => [
    camel(key),
    DATE_COLUMNS.includes(camel(key)) && value ? new Date(`${value}Z`) : value
  ]));
}

export type Harness = ReturnType<typeof createHarness> extends Promise<infer T> ? T : never;

/**
 * Answer one generated model event over the database, or return null for an
 * event that is not one of them. A failing event answers its own failure.
 */
export function answerModelEvent(
  engine: ReturnType<typeof connect>,
  failing: Record<string, { code: number, error: string }>
) {
  return async (event: string, payload: Record<string, unknown> = {}) => {
    if (failing[event]) {
      return failing[event];
    }
    const [ , model, verb ] = event.match(/^(agent-[a-z]+)-([a-z]+)$/) || [];
    const table = TABLES[model];
    if (!table) {
      return null;
    }
    const q = (value: unknown) => value;
    if (verb === 'create') {
      //the defaults the generated create fills in
      const defaults: Record<string, Record<string, unknown>> = {
        agent_thread: { active: true },
        agent_action: { status: 'pending' }
      };
      const input: Record<string, unknown> = {
        id: randomUUID(),
        ...defaults[table],
        ...payload
      };
      const keys = Object.keys(input).filter(
        key => typeof input[key] !== 'undefined'
      );
      const values = keys.map(key =>
        JSON_COLUMNS.includes(key) && input[key] !== null
          ? JSON.stringify(input[key])
          : q(input[key])
      );
      try {
        const rows = await engine.query<Record<string, unknown>>(
          `INSERT INTO ${table} (${keys.map(snake).join(', ')}) `
          + `VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`,
          values as never[]
        );
        return { code: 200, results: toRow(rows[0]) };
      } catch (error) {
        return { code: 400, error: (error as Error).message };
      }
    }
    if (verb === 'detail') {
      const eq = { id: payload.id, ...(payload.eq as object || {}) };
      const keys = Object.keys(eq);
      const rows = await engine.query<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE ${keys.map(k => `${snake(k)} = ?`).join(' AND ')}`,
        Object.values(eq) as never[]
      );
      return rows.length
        ? { code: 200, results: toRow(rows[0]) }
        : { code: 404, error: 'Not Found' };
    }
    if (verb === 'search') {
      const eq = (payload.eq || {}) as Record<string, unknown>;
      const keys = Object.keys(eq);
      const sort = Object.entries((payload.sort || {}) as Record<string, string>);
      const rows = await engine.query<Record<string, unknown>>(
        `SELECT * FROM ${table}`
        + (keys.length ? ` WHERE ${keys.map(k => `${snake(k)} = ?`).join(' AND ')}` : '')
        + (sort.length ? ` ORDER BY ${sort.map(([ k, d ]) => `${snake(k)} ${d === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}` : '')
        + ` LIMIT ${Number(payload.take) || 50} OFFSET ${Number(payload.skip) || 0}`,
        Object.values(eq) as never[]
      );
      return { code: 200, results: rows.map(toRow), total: rows.length };
    }
    if (verb === 'update') {
      const { id, ...set } = payload;
      const keys = Object.keys(set);
      await engine.query(
        `UPDATE ${table} SET ${keys.map(k => `${snake(k)} = ?`).join(', ')} WHERE id = ?`,
        [ ...Object.values(set), id ] as never[]
      );
      return { code: 200, results: { id } };
    }
    return null;
  };
}

/**
 * One database, one clock, and a ctx that answers the model events.
 */
export async function createHarness(start = '2026-10-05T10:00:00.000Z') {
  const engine = connect(async () => new PGlite());
  for (const statement of DDL) {
    await engine.query(statement);
  }
  const clock = { at: new Date(start) };
  const ctx = createCtxStub();
  ctx.register('database', engine);
  //events that failed on purpose, by name
  const failing: Record<string, { code: number, error: string }> = {};

  const answer = answerModelEvent(engine, failing);
  ctx.resolve = (async (event: string, payload: Record<string, unknown> = {}) => {
    ctx.calls.push({ event, req: { data: payload } });
    return answer(event, payload);
  }) as never;

  return {
    engine,
    ctx: ctx as unknown as ToolResolverServer,
    clock,
    failing,
    //a store that shares the database but is a separate instance, the way a
    // second server would be
    store: (options: StoreOptions = {}) => createStore(
      ctx as unknown as ToolResolverServer,
      { now: () => new Date(clock.at), ...options }
    ),
    advance: (ms: number) => { clock.at = new Date(clock.at.getTime() + ms); },
    column: async (table: string, column: string, id: string) => {
      const rows = await engine.query<Record<string, unknown>>(
        `SELECT ${column} FROM ${table} WHERE id = ?`, [ id ]
      );
      return rows[0]?.[column];
    }
  };
}

//--------------------------------------------------------------------//
// Workflow world

//The turn workflow runs on a real Ingest server: a real session plugin
// that verifies real signed tokens, tool events that record what they were
// asked, the model events answered over the database, and the agent events
// the plugin registers. Only the model provider is a stub.

const SEED = 'workflow-test-seed';

//what a tool event saw, as the app would see it
export type Ran = {
  event: string,
  input: Record<string, unknown>,
  caller: ReturnType<typeof caller>,
  undoing: ReturnType<typeof undoing>,
  session: Record<string, unknown>,
  url: string,
  method: string
};

//the models offered unless a test says otherwise
export const MODELS: AgentModelConfig[] = [
  { provider: 'openrouter', model: 'model-a', title: 'Model A' },
  { provider: 'anthropic', model: 'model-b', title: 'Model B' }
];

const TEXT = { type: 'object', properties: { text: { type: 'string' } }, required: [ 'text' ] };

//the tools the world offers. All are marked for the agent except one
export const TOOLS: ToolConfig[] = [
  //reversible: it names its inverse, and reports its own identifier
  { name: 'note_add', event: 'note-add', method: 'POST', agent: true, inverse: 'note_remove', input: TEXT },
  { name: 'note_remove', event: 'note-remove', method: 'DELETE', agent: true, input: TEXT },
  //irreversible by declaration
  {
    name: 'request_cancel',
    event: 'request-cancel',
    method: 'POST',
    agent: true,
    irreversible: true,
    input: { type: 'object', properties: { id: { type: 'string' } }, required: [ 'id' ] }
  },
  //a write with neither an inverse nor the mark
  { name: 'request_poke', event: 'request-poke', method: 'POST', agent: true },
  { name: 'request_find', event: 'request-find', method: 'GET', agent: true },
  { name: 'who_am_i', event: 'who-am-i', method: 'GET', agent: true },
  { name: 'forbidden_thing', event: 'thing-forbidden', method: 'POST', agent: true, inverse: 'note_remove' },
  { name: 'missing_thing', event: 'thing-missing', method: 'POST', agent: true, inverse: 'note_remove' },
  { name: 'conflict_thing', event: 'thing-conflict', method: 'POST', agent: true, inverse: 'note_remove' },
  {
    name: 'file_attach',
    event: 'file-attach',
    method: 'POST',
    agent: true,
    inverse: 'note_remove',
    input: { type: 'object', properties: { file: { type: 'string' } }, required: [ 'file' ] }
  },
  //nothing answers this event
  { name: 'ghost', event: 'ghost-event', method: 'GET', agent: true },
  //this event throws
  { name: 'explode', event: 'explode-event', method: 'GET', agent: true },
  //registered, but not marked for the agent
  { name: 'hidden_tool', event: 'hidden-event', method: 'GET' }
];

//a pair whose inverse needs what only the original's result holds: the id of
// the entry it made. Tests add these to TOOLS when they need them
export const LEDGER: ToolConfig[] = [
  { name: 'ledger_add', event: 'ledger-add', method: 'POST', agent: true, inverse: 'ledger_void', input: TEXT },
  { name: 'ledger_void', event: 'ledger-void', method: 'POST', agent: true, input: TEXT }
];

export type WorldOptions = {
  config?: Partial<AgentConfig>,
  //scripted replies for the model of that name, or for the default one
  replies?: (StubReply | Error)[] | Record<string, (StubReply | Error)[]>,
  env?: Record<string, string | undefined>,
  tools?: ToolConfig[],
  start?: string,
  //how long each model reply takes, so a stream has time to be read in pieces
  pause?: number,
  //more of the app's own listeners, added to every server this world builds
  extra?: (app: ToolResolverServer) => void
};

/**
 * Open a database for workflow tests to share. Tests keep apart by using
 * their own person.
 */
export async function createEngine() {
  const engine = connect(async () => new PGlite());
  for (const statement of DDL) {
    await engine.query(statement);
  }
  return engine;
}

let people = 0;

/**
 * A name nobody else in the run has used.
 */
export function newPerson(label = 'person') {
  people += 1;
  return `${label}_${people}`;
}

/**
 * Build one server over a shared database. Calling the returned `another`
 * builds a second server over the same database, which is all that two
 * servers share.
 */
export function createWorld(
  engine: ReturnType<typeof connect>,
  options: WorldOptions = {}
) {
  const clock = { at: new Date(options.start || '2026-10-05T10:00:00.000Z') };
  const failing: Record<string, { code: number, error: string }> = {};
  const answer = answerModelEvent(engine, failing);
  const ran: Ran[] = [];
  const logs: { message: string, error?: unknown }[] = [];
  const adapters: Record<string, StubAdapter> = {};
  //how the app answers, changed by a test between calls
  const behave = { noteRemove: 'ok' as 'ok' | 'conflict' };

  const agent: AgentConfig = {
    providers: {
      openrouter: { key: 'OPENROUTER_API_KEY' },
      anthropic: { key: 'ANTHROPIC_API_KEY' }
    },
    model: 'model-a',
    models: MODELS,
    ...options.config
  };
  const env = options.env || {
    OPENROUTER_API_KEY: 'sk-test-a',
    ANTHROPIC_API_KEY: 'sk-test-b'
  };

  function build() {
    const app = http() as unknown as ToolResolverServer;
    app.config.set({ mcp: { tools: options.tools || TOOLS }, agent });
    app.register('database', engine);
    app.register('session', Session.configure('session', SEED, {}));

    //model events go to the database, anything else to the real server
    const real = app.resolve.bind(app);
    app.resolve = (async (event: string, payload?: unknown) => (
      /^agent-(thread|turn|action|usage|lock)-/.test(event)
        ? answer(event, payload as Record<string, unknown>)
        : real(event, payload as never)
    )) as never;

    //the app's own events, which record what they saw
    const see = (event: string, req: never, extra: Record<string, unknown> = {}) => {
      const r = req as ToolRequest;
      ran.push({
        event,
        input: { ...(r.data() as Record<string, unknown>) },
        caller: caller(r),
        undoing: undoing(r),
        session: { ...(r.session.data as Record<string, unknown>) },
        url: r.url.toString(),
        method: r.method
      });
      return extra;
    };
    app.on('note-add', ({ req, res }) => {
      see('note-add', req as never);
      res.results({ id: 'note-1', operation: 'op-note-1' });
    });
    app.on('note-remove', ({ req, res }) => {
      see('note-remove', req as never);
      if (behave.noteRemove === 'conflict') {
        res.setError('The note changed since.', {}, [], 409);
        return;
      }
      res.results({ removed: true });
    });
    app.on('ledger-add', ({ req, res }) => {
      see('ledger-add', req as never);
      res.results({ entry: 'entry-7', operation: 'op-ledger-7' });
    });
    //answers with what it was told it is undoing, and a fresh operation
    // identifier derived from the undo action
    app.on('ledger-void', ({ req, res }) => {
      see('ledger-void', req as never);
      const told = undoing(req as never);
      res.results({
        voided: told?.original.result,
        operation: told ? `void-${told.undoActionId}` : undefined
      });
    });
    app.on('request-cancel', ({ req, res }) => {
      see('request-cancel', req as never);
      res.results({ cancelled: true });
    });
    app.on('request-poke', ({ req, res }) => {
      see('request-poke', req as never);
      res.results({ poked: true });
    });
    app.on('request-find', ({ req, res }) => {
      see('request-find', req as never);
      res.results({ items: [ 'REQ-1', 'REQ-2' ] });
    });
    app.on('who-am-i', ({ req, res }) => {
      see('who-am-i', req as never);
      res.results({ session: req.session.data, caller: caller(req as never) || null });
    });
    app.on('thing-forbidden', ({ req, res }) => {
      see('thing-forbidden', req as never);
      res.setError('You may not change this.', {}, [], 403);
    });
    app.on('thing-missing', ({ req, res }) => {
      see('thing-missing', req as never);
      res.setError('That record does not exist.', {}, [], 404);
    });
    app.on('thing-conflict', ({ req, res }) => {
      see('thing-conflict', req as never);
      res.setError('The record changed since.', {}, [], 409);
    });
    app.on('file-attach', ({ req, res }) => {
      see('file-attach', req as never);
      res.results({ attached: (req.data() as Record<string, unknown>).file });
    });
    app.on('explode-event', ({ req }) => {
      see('explode-event', req as never);
      throw new Error('secret internal detail');
    });
    app.on('hidden-event', ({ req, res }) => {
      see('hidden-event', req as never);
      res.results({ hidden: true });
    });

    const rt = createRuntime(app, {
      env,
      now: () => new Date(clock.at),
      log: (message, error) => { logs.push({ message, error }); },
      connect: async model => {
        if (!adapters[model.model]) {
          const replies = Array.isArray(options.replies)
            ? options.replies
            : options.replies?.[model.model];
          adapters[model.model] = stub({ model: model.model, replies });
          if (options.pause) {
            const send = adapters[model.model].send.bind(adapters[model.model]);
            adapters[model.model].send = async request => {
              await new Promise(resolve => setTimeout(resolve, options.pause));
              return send(request);
            };
          }
        }
        return adapters[model.model];
      }
    });
    //what the plugin does when `agent` config exists
    app.register('agent', rt);
    app.on(AGENT_EVENTS.turn, turn);
    app.on(AGENT_EVENTS.approve, approve);
    app.on(AGENT_EVENTS.decline, decline);
    app.on(AGENT_EVENTS.undo, undo);
    app.on(AGENT_EVENTS.threads, threads);
    app.on(AGENT_EVENTS.thread, thread);
    app.on(AGENT_EVENTS.start, start);
    app.on(AGENT_EVENTS.create, create);
    options.extra?.(app);
    return { app, rt };
  }

  const first = build();
  const world = {
    ...first,
    engine,
    clock,
    failing,
    ran,
    logs,
    adapters,
    behave,
    advance: (ms: number) => { clock.at = new Date(clock.at.getTime() + ms); },
    //the model the world answers with by default
    stub: (model = 'model-a') => adapters[model],
    //a signed token for a person, as the session plugin would issue
    token: (profileId: string, roles = [ 'USER' ]) => Session.create({
      id: profileId, name: profileId, roles
    }),
    //a request that carries a token, or none, as a route would build it
    request: (token: string | null, data: Record<string, unknown> = {}, app = first.app) => (
      app.request({
        data,
        method: 'POST',
        url: 'http://example.test/agent/turn?leak=query',
        session: new Map(token ? [ [ 'session', token ] ] : []) as never
      }) as unknown as ToolRequest
    ),
    //another server over the same database and clock
    another: () => build(),
    //what is stored for a thread, read straight from the database
    rows: async (table: string, column: string, value: string) => (
      await engine.query<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE ${column} = ? ORDER BY id`, [ value ]
      )
    )
  };
  return world;
}

export type World = ReturnType<typeof createWorld>;
