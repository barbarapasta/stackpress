//modules
import { expect } from 'chai';
import { before, describe, it } from 'mocha';
//client
import { AGENT_EVENTS, approve, decline, thread, threads, turn, undo } from '../src/events/index.js';
import plugin from '../src/plugin.js';
import { runtimeOf, watch } from '../src/scripts/agent.js';
import type { AgentEvent } from '../src/types.js';
//tests
import { asks, says, setup as setupWith, types } from './flow.js';
import type { Engine } from './flow.js';
import { createEngine } from './harness.js';
import type { WorldOptions } from './harness.js';
import { createCtxStub } from './helpers.js';

//The agent is exposed as events. These tests resolve them on a real server
// with a request that carries a real signed session, the way a route or a
// job would, and check what the plugin registers for each config.

let engine: Engine;

before(async function () {
  this.timeout(60000);
  engine = await createEngine();
});

const setup = (options: WorldOptions = {}) => setupWith(engine, options);

//the response the event answers with, as a caller of resolve sees it
type Answer = {
  code?: number,
  status?: string,
  error?: string,
  errors?: Record<string, unknown>,
  results?: Record<string, unknown> | null
};

describe('agent events', function () {
  this.timeout(30000);

  it('names the events the agent answers', () => {
    expect(AGENT_EVENTS).to.deep.equal({
      turn: 'ai-turn',
      approve: 'ai-approve',
      decline: 'ai-decline',
      undo: 'ai-undo',
      threads: 'ai-threads',
      thread: 'ai-thread',
      start: 'ai-start',
      create: 'ai-new'
    });
  });

  it('answers a turn, and reports each step to a callback attached to the request', async () => {
    const { world, token } = await setup({
      replies: [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Done.') ]
    });
    const seen: AgentEvent[] = [];
    const req = world.request(token, { message: 'Add a note' });
    watch(req, event => seen.push(event));

    const answer = await world.app.resolve(AGENT_EVENTS.turn, req) as unknown as Answer;
    expect(answer.code).to.equal(200);
    expect(answer.results).to.include({ ok: true, status: 'done' });
    //the same list, with or without streaming
    expect(answer.results!.events).to.deep.equal(seen);
    expect(types(seen)).to.include.members([ 'thread', 'action-start', 'action-done', 'text', 'finished' ]);
  });

  it('answers what the panel starts with, and a new chat, and stops when another listener failed', async () => {
    const { world, token } = await setup({ config: { limit: 100 } });
    const started = await world.app.resolve(
      AGENT_EVENTS.start, world.request(token)
    ) as unknown as Answer;
    expect(started.results).to.deep.include({ ok: true, model: 'model-a' });
    const made = await world.app.resolve(
      AGENT_EVENTS.create, world.request(token, {})
    ) as unknown as Answer;
    expect(made.results).to.include({ ok: true, reused: false });
    for (const event of [ AGENT_EVENTS.start, AGENT_EVENTS.create ]) {
      world.app.on(event, ({ res }) => { res.setError('earlier', {}, [], 418); }, 100);
      const stopped = await world.app.resolve(event, world.request(token, {})) as unknown as Answer;
      expect(stopped.code, event).to.equal(418);
    }
  });

  it('answers a turn with no callback attached', async () => {
    const { world, token } = await setup({ replies: [ says('Hello.') ] });
    const answer = await world.app.resolve(
      AGENT_EVENTS.turn, world.request(token, { message: 'Hi' })
    ) as unknown as Answer;
    expect(answer.results!.events).to.have.length(4);
  });

  it('maps a refusal to its status code and reason', async () => {
    const { world, token } = await setup({
      config: { limit: 1 },
      replies: [ says('A.', 1, 1) ]
    });
    const signedOut = await world.app.resolve(
      AGENT_EVENTS.turn, world.request(null, { message: 'Hi' })
    ) as unknown as Answer;
    expect(signedOut).to.include({ code: 401, error: 'Sign in to use the agent.' });
    expect(signedOut.errors).to.deep.equal({ reason: 'unauthorized' });

    await world.app.resolve(AGENT_EVENTS.turn, world.request(token, { message: 'Hi' }));
    const limited = await world.app.resolve(
      AGENT_EVENTS.turn, world.request(token, { message: 'Hi again' })
    ) as unknown as Answer;
    expect(limited.code).to.equal(429);
    expect(limited.errors).to.deep.equal({ reason: 'limit', resetsAt: '2026-10-06T00:00:00.000Z' });
  });

  it('reads the message and its parts from the request body only', async () => {
    const { world, token } = await setup({ replies: [ says('Hello.') ] });
    const answer = await world.app.resolve(AGENT_EVENTS.turn, world.request(token, {
      message: 'Hi', files: [ 'upload:a' ], model: 'model-a', context: { url: '/x' }
    })) as unknown as Answer;
    expect(answer.code).to.equal(200);
    expect(world.stub().requests[0].system).to.contain('/x');
  });

  it('approves, declines, undoes, lists and loads through events', async () => {
    const { world, token } = await setup({
      replies: [
        asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]),
        says('Cancelled.'),
        asks([ 'c2', 'note_add', { text: 'hi' } ]),
        says('Added.'),
        asks([ 'c3', 'request_poke' ]),
        says('Fine.')
      ]
    });
    const resolve = (event: string, data: Record<string, unknown>) => world.app.resolve(
      event, world.request(token, data)
    ) as unknown as Promise<Answer>;
    const actionOf = async (threadId: string, tool: string) => (
      await world.rows('agent_action', 'thread_id', threadId)
    ).find(row => row.tool === tool)!;

    //approve
    const first = (await resolve(AGENT_EVENTS.turn, { message: 'Cancel it' })).results!;
    const pending = await actionOf(first.threadId as string, 'request_cancel');
    const approved = await resolve(AGENT_EVENTS.approve, { actionId: pending.id });
    expect(approved.results).to.include({ ok: true, status: 'done' });
    expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-cancel' ]);

    //undo
    const second = (await resolve(AGENT_EVENTS.turn, { message: 'Add a note', threadId: first.threadId })).results!;
    const note = await actionOf(second.threadId as string, 'note_add');
    const undone = await resolve(AGENT_EVENTS.undo, { actionId: note.id });
    expect(undone.results).to.include({ ok: true, status: 'undone' });

    //decline
    const third = (await resolve(AGENT_EVENTS.turn, { message: 'Poke it', threadId: first.threadId })).results!;
    const poke = await actionOf(third.threadId as string, 'request_poke');
    const declined = await resolve(AGENT_EVENTS.decline, { actionId: poke.id });
    expect(declined.results).to.include({ ok: true, status: 'done' });
    expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-cancel', 'note-add', 'note-remove' ]);

    //list and load
    const listed = await resolve(AGENT_EVENTS.threads, {});
    expect((listed.results!.threads as unknown[]).length).to.equal(1);
    const loaded = await resolve(AGENT_EVENTS.thread, { threadId: first.threadId as string });
    expect((loaded.results!.actions as unknown[]).length).to.equal(4);

    //refusals map to codes, and the events two names apart do not answer each other
    expect(await resolve(AGENT_EVENTS.thread, { threadId: 'nope' })).to.include({ code: 404 });
    expect(await resolve(AGENT_EVENTS.approve, {})).to.include({ code: 400 });
  });

  it('leaves the response alone when an earlier listener already failed', async () => {
    const { world, token } = await setup({ replies: [ says('Unused.') ] });
    for (const event of [ turn, approve, decline, undo, threads, thread ]) {
      const res = { code: 500 } as { code: number };
      await event({
        ctx: world.app,
        req: world.request(token, { message: 'Hi' }),
        res
      } as never, {} as never);
      expect(res.code).to.equal(500);
    }
    expect(world.stub()).to.equal(undefined);
  });

  it('builds a runtime from config when the plugin registered none', () => {
    const ctx = createCtxStub({ config: { agent: { model: 'm', models: [] } } });
    expect(runtimeOf(ctx).config.model).to.equal('m');
    const registered = runtimeOf(ctx);
    ctx.register('agent', registered);
    expect(runtimeOf(ctx)).to.equal(registered);
  });
});

describe('agent plugin activation', () => {
  //run the plugin for a config and its listen handler on a server stub
  async function activate(keys: string[]) {
    const handlers = new Map<string, Function[]>();
    plugin({
      config: { has: (key: string) => keys.includes(key) },
      on: (event: string, listener: Function) => {
        handlers.set(event, [ ...(handlers.get(event) || []), listener ]);
      }
    } as never);
    const ctx = createCtxStub({
      config: Object.fromEntries(keys.map(key => [ key, {} ]))
    });
    const listen = handlers.get('listen')?.[0];
    if (listen) await listen({ ctx });
    return { handlers, ctx };
  }

  it('activates for agent config alone, with no MCP transports', async () => {
    const { handlers, ctx } = await activate([ 'agent' ]);
    expect(handlers.has('listen')).to.equal(true);
    expect(ctx.events).to.deep.equal([
      'ai-turn', 'ai-approve', 'ai-decline', 'ai-undo', 'ai-threads',
      'ai-thread', 'ai-start', 'ai-new'
    ]);
    expect(ctx.registered.agent).to.be.an('object');
    expect(ctx.registered.mcp).to.equal(undefined);
  });

  it('keeps the MCP transports behind mcp config, and registers no agent events', async () => {
    const { ctx } = await activate([ 'mcp' ]);
    expect(ctx.events.filter(event => event.startsWith('ai-'))).to.deep.equal([]);
    expect(ctx.events).to.include.members([ 'mcp-stdio', 'mcp-http', 'mcp-sse' ]);
    expect(ctx.registered.agent).to.equal(undefined);
    expect(ctx.registered.mcp).to.be.a('function');
  });

  it('registers both when both configs exist', async () => {
    const { ctx } = await activate([ 'mcp', 'agent' ]);
    expect(ctx.events).to.include.members([ 'ai-turn', 'mcp-http' ]);
    expect(ctx.registered.agent).to.be.an('object');
    expect(ctx.registered.mcp).to.be.a('function');
  });

  it('does nothing when neither config exists, so an app behaves as before', async () => {
    const { handlers } = await activate([]);
    expect(handlers.size).to.equal(0);
  });

  it('still contributes its idea transform when only agent config exists', async () => {
    const { handlers } = await activate([ 'agent' ]);
    expect(handlers.has('idea')).to.equal(true);
  });
});
