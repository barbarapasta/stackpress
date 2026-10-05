//modules
import { server as http } from '@stackpress/ingest/http';
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import guardRecords, { GUARD_MESSAGE } from '../src/events/guard.js';
import {
  RECORD_MODELS,
  RECORD_REFUSED,
  asStore,
  createEvents,
  refusedEvents
} from '../src/scripts/records.js';
import { createStore } from '../src/scripts/store.js';
import type { ToolResolverServer } from '../src/types.js';
//tests
import { answerModelEvent, createEngine } from './harness.js';

//These tests run the guards on a real Ingest server, where the generated
// model events are listeners of priority 0 over a real database, the way they
// are in an application. The store is the real store on that same server.

const VERBS = [ 'create', 'detail', 'search', 'update' ];

/**
 * A server whose agent model events are answered over a database, and a spy
 * that counts how many times each of those events reached its listener.
 */
async function createApp(guardFirst = false) {
  const engine = await createEngine();
  const app = http() as unknown as ToolResolverServer;
  app.register('database', engine);
  const reached: string[] = [];
  const answer = answerModelEvent(engine, {});

  const generated = () => {
    for (const model of [ 'thread', 'turn', 'action', 'usage' ]) {
      for (const verb of [ ...VERBS, ...RECORD_REFUSED, 'get' ]) {
        const event = `agent-${model}-${verb}`;
        app.on(event, async ({ req, res }) => {
          //like the generated listeners, pass a response already made through
          if (res.body || (res.code && res.code !== 200)) return;
          reached.push(event);
          const out = await answer(event, req.data() as Record<string, unknown>);
          if (!out) {
            res.results({ done: true });
          } else if (out.code && out.code >= 400) {
            res.setError(out.error as string, {}, [], out.code);
          } else {
            res.results(out.results as never);
          }
        });
      }
    }
  };

  //the order the plugins register in must not matter
  if (guardFirst) {
    guardRecords(app);
    generated();
  } else {
    generated();
    guardRecords(app);
  }
  return { app, engine, reached, store: createStore(app) };
}

type App = Awaited<ReturnType<typeof createApp>>;

//one thread, one turn and one action made through the store
async function seed(world: App) {
  const thread = await world.store.createThread({ profileId: 'p1', title: 'T' });
  const turn = await world.store.appendTurn(thread.id, 'p1', {
    role: 'assistant', text: 'original'
  });
  const action = await world.store.createAction({
    threadId: thread.id,
    turnId: turn.id,
    profileId: 'p1',
    tool: 'note_add',
    event: 'note-add',
    input: {},
    irreversible: true
  });
  return { thread, turn, action };
}

const count = async (world: App, table: string) => (
  await world.engine.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
)[0].n;

describe('agent record guards', () => {
  describe('which events are guarded', () => {
    it('refuses the six write events of turns, actions and usage', () => {
      const events = refusedEvents();
      for (const model of RECORD_MODELS) {
        for (const verb of [
          'update', 'remove', 'restore', 'purge', 'upsert', 'batch'
        ]) {
          expect(events).to.include(`${model}-${verb}`);
        }
      }
    });

    it('leaves reads open and refuses outside creates of the records only', () => {
      expect(createEvents()).to.deep.equal([
        'agent-turn-create', 'agent-action-create', 'agent-usage-create'
      ]);
      const events = refusedEvents();
      for (const model of RECORD_MODELS) {
        for (const verb of [ 'detail', 'search', 'get', 'create' ]) {
          expect(events).to.not.include(`${model}-${verb}`);
        }
      }
    });

    it('leaves a thread editable and refuses only the purge of its table', () => {
      const events = refusedEvents();
      expect(events.filter(event => event.startsWith('agent-thread')))
        .to.deep.equal([ 'agent-thread-purge' ]);
    });
  });

  for (const guardFirst of [ false, true ]) {
    describe(`registered ${guardFirst ? 'before' : 'after'} the generated listeners`, () => {
      it('refuses every guarded write with 403 and never reaches the generated listener', async () => {
        const world = await createApp(guardFirst);
        const { turn, action } = await seed(world);
        world.reached.length = 0;

        for (const [ model, id ] of [
          [ 'turn', turn.id ], [ 'action', action.id ], [ 'usage', 'p1:2026-10-05' ]
        ]) {
          for (const verb of RECORD_REFUSED) {
            const event = `agent-${model}-${verb}`;
            const res = await world.app.resolve(event, {
              id, text: 'edited', status: 'done', rows: []
            });
            expect(res?.code, event).to.equal(403);
            expect(res?.error, event).to.equal(GUARD_MESSAGE);
          }
        }
        expect(world.reached).to.deep.equal([]);
      });

      it('leaves the stored turn and the action log as they were', async () => {
        const world = await createApp(guardFirst);
        const { turn, action } = await seed(world);

        await world.app.resolve('agent-turn-update', { id: turn.id, text: 'edited' });
        await world.app.resolve('agent-turn-remove', { id: turn.id });
        await world.app.resolve('agent-turn-purge', {});
        await world.app.resolve('agent-action-update', { id: action.id, status: 'done' });
        await world.app.resolve('agent-action-purge', {});

        expect(await world.engine.query(
          'SELECT text FROM agent_turn WHERE id = ?', [ turn.id ]
        )).to.deep.equal([ { text: 'original' } ]);
        expect(await world.engine.query(
          'SELECT status FROM agent_action WHERE id = ?', [ action.id ]
        )).to.deep.equal([ { status: 'pending' } ]);
        expect(await count(world, 'agent_turn')).to.equal(1);
        expect(await count(world, 'agent_action')).to.equal(1);
      });

      it('refuses a create that does not come from the store', async () => {
        const world = await createApp(guardFirst);
        const { thread, turn } = await seed(world);
        world.reached.length = 0;

        const forged = {
          threadId: thread.id, turnId: turn.id, profileId: 'p1', tool: 'x',
          event: 'x', irreversible: false, role: 'user', day: 'd',
          inputTokens: 0, outputTokens: 0, turns: 0, id: 'made-up',
          //nothing in the data can claim to be the store
          store: true, asStore: true, ai: { store: true }
        };
        for (const model of [ 'turn', 'action', 'usage' ]) {
          const res = await world.app.resolve(`agent-${model}-create`, forged);
          expect(res?.code, model).to.equal(403);
          expect(res?.error).to.equal(GUARD_MESSAGE);
        }
        expect(world.reached).to.deep.equal([]);
        expect(await count(world, 'agent_turn')).to.equal(1);
        expect(await count(world, 'agent_action')).to.equal(1);
        expect(await count(world, 'agent_usage')).to.equal(0);
      });

      it('lets reads through, and edits and creates of a thread', async () => {
        const world = await createApp(guardFirst);
        const { thread, action } = await seed(world);

        for (const [ event, data ] of [
          [ 'agent-thread-search', {} ],
          [ 'agent-thread-detail', { id: thread.id } ],
          [ 'agent-turn-search', {} ],
          [ 'agent-action-detail', { id: action.id } ],
          [ 'agent-action-search', {} ]
        ] as const) {
          expect((await world.app.resolve(event, data as never))?.code, event)
            .to.equal(200);
        }

        const edit = await world.app.resolve('agent-thread-update', {
          id: thread.id, title: 'Renamed'
        });
        expect(edit?.code).to.equal(200);
        expect(await world.engine.query(
          'SELECT title FROM agent_thread WHERE id = ?', [ thread.id ]
        )).to.deep.equal([ { title: 'Renamed' } ]);

        const purge = await world.app.resolve('agent-thread-purge', {});
        expect(purge?.code).to.equal(403);
        expect(await count(world, 'agent_thread')).to.equal(1);
      });
    });
  }

  describe('the store with the guards in place', () => {
    it('runs every store method', async () => {
      const world = await createApp();
      const { store } = world;
      const { thread, turn, action } = await seed(world);

      expect(await store.getThread(thread.id, 'p1')).to.have.property('id', thread.id);
      expect((await store.listThreads('p1')).length).to.equal(1);
      expect((await store.listTurns(thread.id, 'p1')).length).to.equal(1);
      expect(await store.getAction(action.id, 'p1')).to.have.property('status', 'pending');
      expect((await store.listActions(thread.id, 'p1')).length).to.equal(1);

      const claimed = await store.approveAction(action.id, 'p1');
      expect(claimed).to.have.property('claimed', true);
      const done = await store.completeAction(action.id, 'p1', {
        claim: (claimed as { claim: string }).claim,
        status: 'done',
        result: { ok: true }
      } as never);
      expect(done).to.not.equal(null);
      expect(await store.markUndone(action.id, 'p1')).to.not.equal(null);

      await store.addUsage('p1', { inputTokens: 3, outputTokens: 4 });
      await store.addUsage('p1', { inputTokens: 1, outputTokens: 1 });
      expect(await store.getUsage('p1')).to.include({
        inputTokens: 4, outputTokens: 5, turns: 2
      });

      //a user turn expires what is still pending, which is a guarded update
      const second = await store.createAction({
        threadId: thread.id, turnId: turn.id, profileId: 'p1', tool: 'note_add',
        event: 'note-add', input: {}, irreversible: true
      });
      await store.appendTurn(thread.id, 'p1', { role: 'user', text: 'again' });
      expect(await store.getAction(second.id, 'p1')).to.have.property('status', 'expired');
      await store.declineAction(
        (await store.createAction({
          threadId: thread.id, turnId: turn.id, profileId: 'p1', tool: 'note_add',
          event: 'note-add', input: {}, irreversible: true
        })).id,
        'p1'
      );
      await store.expirePending();
      expect(await count(world, 'agent_turn')).to.equal(2);
    });

    it('is the only way to create after it has finished', async () => {
      const world = await createApp();
      const { thread, turn } = await seed(world);
      const data = {
        threadId: thread.id, turnId: turn.id, profileId: 'p1', tool: 'x',
        event: 'x', irreversible: false
      };

      //an outside create made while the store is creating is still refused
      const [ , outside ] = await Promise.all([
        world.store.appendTurn(thread.id, 'p1', { role: 'user', text: 'busy' }),
        world.app.resolve('agent-action-create', data)
      ]);
      expect(outside?.code).to.equal(403);

      //and so is one made after the store call has finished
      const after = await world.app.resolve('agent-action-create', data);
      expect(after?.code).to.equal(403);
    });

    it('does not let the mark of one create open another event', async () => {
      const world = await createApp();
      const { thread, turn } = await seed(world);

      //a listener hooked on a turn create runs inside the store's create, and
      // cannot use that mark to create an action
      let forged: number | undefined;
      //a listener that takes no argument is read as an import loader
      world.app.on('agent-turn-create', async ({ ctx }) => {
        forged = (await ctx.resolve('agent-action-create', {
          threadId: thread.id, turnId: turn.id, profileId: 'p1', tool: 'x',
          event: 'x', irreversible: false
        }))?.code;
      }, -1);
      await world.store.appendTurn(thread.id, 'p1', { role: 'user', text: 'hook' });
      expect(forged).to.equal(403);
    });
  });

  describe('two loaded copies of the module', () => {
    it('recognises a store from one copy in a guard from the other', async () => {
      const other = await import('../src/scripts/records.js?second-copy') as typeof import('../src/scripts/records.js');
      expect(other.asStore).to.not.equal(asStore);

      //the guard here sees a create that the other copy marked as the store's
      const world = await createApp();
      const { thread, turn } = await seed(world);
      const data = {
        threadId: thread.id, turnId: turn.id, profileId: 'p1', tool: 'x',
        event: 'x', irreversible: false
      };
      const marked = await other.asStore(
        'agent-action-create',
        () => world.app.resolve('agent-action-create', data)
      );
      expect(marked?.code).to.equal(200);
      expect(await count(world, 'agent_action')).to.equal(2);

      //and the mark is for that event only
      const wrong = await other.asStore(
        'agent-turn-create',
        () => world.app.resolve('agent-action-create', data)
      );
      expect(wrong?.code).to.equal(403);
    });
  });
});
