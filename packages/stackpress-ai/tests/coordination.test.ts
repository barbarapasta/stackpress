//modules
import type { Value } from '@stackpress/inquire/types';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';
//client
import type { Adapter, AdapterReply, ToolConfig } from '../src/types.js';
import { approve, undo } from '../src/scripts/approval.js';
import { runTurn } from '../src/scripts/turn.js';
//tests
import type { Engine } from './flow.js';
import type { World, WorldOptions } from './harness.js';
import {
  accepted,
  asks,
  refused,
  says,
  setup as setupWith,
  turnsOf
} from './flow.js';
import {
  LEDGER,
  TOOLS,
  createEngine,
  createHarness,
  createWorld
} from './harness.js';

//These tests run separate runtimes, as separate servers are, over one
// database and one clock that never moves. What one runtime does is seen by
// the other only through the database, so every guarantee here is a stored
// one. Nothing waits for time to pass: provider and tool latency are held
// open by hand and released when the test says.

let engine: Engine;

before(async function () {
  this.timeout(60000);
  engine = await createEngine();
});

const setup = (options: WorldOptions = {}) => setupWith(engine, options);

/**
 * A promise a test settles by hand.
 */
function latch() {
  let open!: () => void;
  const closed = new Promise<void>(resolve => { open = resolve; });
  return { closed, open };
}

/**
 * A second server for the same person over the same database and clock.
 */
async function sibling(
  first: Awaited<ReturnType<typeof setup>>,
  options: WorldOptions = {}
) {
  const world = createWorld(engine, {
    ...options,
    config: { approvalTtl: 30 * 60 * 1000, ...options.config }
  });
  const token = await world.token(first.profileId);
  return {
    world,
    token,
    say: (message: string, extra: Record<string, unknown> = {}) => {
      const data = { message, ...extra };
      return runTurn(world.rt, world.request(token, data), data);
    }
  };
}

/**
 * Make the model of a world answer from a function, one call at a time.
 */
function answers(
  world: World,
  reply: (call: number) => Promise<AdapterReply> | AdapterReply
) {
  let calls = 0;
  world.rt.connect = async model => ({
    provider: 'stub',
    model: model.model,
    send: async () => reply(++calls)
  }) as Adapter;
  return { calls: () => calls };
}

const end = (text = 'Done.', input = 1, output = 1): AdapterReply => ({
  text, toolCalls: [], stop: 'end', usage: { input, output }, raw: null
});

const call = (
  id: string,
  name: string,
  input: Record<string, unknown> = {}
): AdapterReply => ({
  text: '',
  toolCalls: [ { id, name, input } ],
  stop: 'tools',
  usage: { input: 1, output: 1 },
  raw: null
});

//--------------------------------------------------------------------//
// Tests

describe('thread coordination', () => {
  describe('a newer message replaces an older run', () => {
    it('makes no approval card for a reply that arrives after it', async () => {
      const first = await setup();
      const other = await sibling(first);
      const thread = await first.world.rt.store.createThread({
        profileId: first.profileId, title: 'race', model: 'model-a'
      });
      const held = latch();
      const arrived = latch();
      answers(first.world, async () => {
        arrived.open();
        await held.closed;
        return call('old', 'request_cancel', { id: 'REQ-1' });
      });
      answers(other.world, () => end('Understood.'));

      const old = first.say('Cancel REQ-1', { threadId: thread.id });
      await arrived.closed;
      accepted(await other.say('Do not cancel it', { threadId: thread.id }));
      held.open();
      const result = accepted(await old);

      //the older run goes no further, and nothing is waiting for approval
      expect(result.status).to.equal('settled');
      const store = other.world.rt.store;
      const actions = await store.listActions(thread.id, first.profileId);
      expect(actions.filter(action => action.status === 'pending')).to.deep.equal([]);
      expect(first.world.ran.concat(other.world.ran)).to.deep.equal([]);
      //its reply was not stored beside the newer message, but was paid for
      const roles = (await turnsOf(first.world, thread.id)).map(turn => turn.role);
      expect(roles).to.deep.equal([ 'user', 'user', 'assistant' ]);
      expect((await store.getUsage(first.profileId)).turns).to.equal(2);
    });

    it('does not start a reversible write a newer message has replaced', async () => {
      const first = await setup();
      const other = await sibling(first);
      const thread = await first.world.rt.store.createThread({
        profileId: first.profileId, title: 'race', model: 'model-a'
      });
      const held = latch();
      const arrived = latch();
      answers(first.world, async () => {
        arrived.open();
        await held.closed;
        return call('old', 'note_add', { text: 'stale' });
      });
      answers(other.world, () => end('Understood.'));

      const old = first.say('Add a note', { threadId: thread.id });
      await arrived.closed;
      accepted(await other.say('Never mind', { threadId: thread.id }));
      held.open();
      expect(accepted(await old).status).to.equal('settled');

      expect(first.world.ran).to.deep.equal([]);
      const actions = await first.world.rt.store.listActions(
        thread.id, first.profileId
      );
      expect(actions.map(action => action.status)).to.deep.equal([]);
    });

    it('cannot approve a card a message replaced, even if it still looks pending', async () => {
      const first = await setup({
        replies: [ asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), says('Ok.') ]
      });
      const waiting = accepted(await first.say('Cancel REQ-1'));
      const store = first.world.rt.store;
      const [ card ] = await store.listActions(waiting.threadId, first.profileId);
      expect(card.status).to.equal('pending');

      //a message from a second server, then the card put back as it was seen
      // before the message ended it: the window between a click's read and
      // its claim
      const other = await sibling(first, { replies: [ says('Fine.') ] });
      accepted(await other.say('Stop', { threadId: waiting.threadId }));
      await engine.query(
        "UPDATE agent_action SET status = 'pending' WHERE id = ?", [ card.id ]
      );

      const data = { actionId: card.id };
      const result = accepted(await approve(
        first.world.rt, first.world.request(first.token, data), data
      ));
      expect(result.status).to.equal('settled');
      expect(result.action?.status).to.equal('expired');
      expect(first.world.ran).to.deep.equal([]);
    });

    it('stores no message while an approved action is running, and acknowledges none', async () => {
      const slow = latch();
      const started = latch();
      const tools: ToolConfig[] = [
        ...TOOLS,
        { name: 'slow_cancel', event: 'slow-cancel', method: 'POST', agent: true, irreversible: true }
      ];
      const extra: NonNullable<WorldOptions['extra']> = app => {
        app.on('slow-cancel', async ({ res }) => {
          started.open();
          await slow.closed;
          res.results({ cancelled: true });
        });
      };
      const first = await setup({
        tools,
        extra,
        replies: [ asks([ 'c1', 'slow_cancel' ]), says('Cancelled.') ]
      });
      const waiting = accepted(await first.say('Cancel it'));
      const [ card ] = await first.world.rt.store.listActions(
        waiting.threadId, first.profileId
      );
      const other = await sibling(first, { tools, replies: [ says('Hi.') ] });

      const data = { actionId: card.id };
      const running = approve(
        first.world.rt, first.world.request(first.token, data), data
      );
      await started.closed;

      //a message from another server is turned away and stores nothing
      const turns = (await turnsOf(first.world, waiting.threadId)).length;
      const turned = refused(await other.say('Wait', { threadId: waiting.threadId }));
      expect(turned).to.include({ code: 409, reason: 'busy' });
      expect((await turnsOf(first.world, waiting.threadId)).length).to.equal(turns);
      //and a second click is answered with the stored record, not run again
      const again = accepted(await approve(
        other.world.rt, other.world.request(other.token, data), data
      ));
      expect(again.replayed).to.equal(true);

      slow.open();
      accepted(await running);
      //the gate is free again
      accepted(await other.say('Thanks', { threadId: waiting.threadId }));
    });
  });

  describe('the proposal an approval runs', () => {
    const cancel = (change: Partial<ToolConfig>) => TOOLS.map(tool => (
      tool.name === 'request_cancel' ? { ...tool, ...change } : tool
    ));

    async function proposed() {
      const first = await setup({
        replies: [ asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), says('Ok.') ]
      });
      const waiting = accepted(await first.say('Cancel REQ-1'));
      const [ card ] = await first.world.rt.store.listActions(
        waiting.threadId, first.profileId
      );
      const click = () => {
        const data = { actionId: card.id };
        return approve(
          first.world.rt, first.world.request(first.token, data), data
        );
      };
      return { first, card, click };
    }

    it('runs the tool that was proposed when nothing changed', async () => {
      const { first, click } = await proposed();
      accepted(await click());
      expect(first.world.ran.map(r => r.event)).to.deep.equal([ 'request-cancel' ]);
    });

    for (const [ label, change ] of [
      [ 'its event', { event: 'request-poke' } ],
      [ 'its method', { method: 'DELETE' as const } ],
      [ 'its static data', { data: { force: true } } ],
      [ 'its input rules', { input: { type: 'object', properties: {} } } ],
      [ 'how it is reversed', { inverse: 'note_remove', irreversible: true } ]
    ] as const) {
      it(`refuses to run it after ${label} changed, and says to ask again`, async () => {
        const { first, card, click } = await proposed();
        first.world.app.config.set({ mcp: { tools: cancel(change) } });
        const result = accepted(await click());

        expect(first.world.ran).to.deep.equal([]);
        expect(result.action?.status).to.equal('failed');
        expect(result.action?.error).to.include('Ask again to get a new approval');
        expect(result.action?.event).to.equal(card.event);
      });
    }

    it('still runs it after only a description changed', async () => {
      const { first, click } = await proposed();
      first.world.app.config.set({
        mcp: { tools: cancel({ description: 'A better description.' }) }
      });
      accepted(await click());
      expect(first.world.ran.map(r => r.event)).to.deep.equal([ 'request-cancel' ]);
    });

    it('refuses a pending action that has no digest to check against', async () => {
      const { first, card, click } = await proposed();
      await engine.query('UPDATE agent_action SET contract = NULL WHERE id = ?', [ card.id ]);
      const result = accepted(await click());

      expect(first.world.ran).to.deep.equal([]);
      expect(result.action?.status).to.equal('failed');
      expect(result.action?.error).to.include('cannot be checked');
    });
  });

  describe('undo, as the next model call sees it', () => {
    const ledger: ToolConfig[] = [
      ...TOOLS,
      ...LEDGER,
      //reversible, but approved by the person first
      {
        name: 'ledger_add_gated',
        event: 'ledger-add',
        method: 'POST',
        agent: true,
        irreversible: true,
        inverse: 'ledger_void',
        input: LEDGER[0].input
      }
    ];

    for (const [ label, name ] of [
      [ 'an action that ran at once', 'ledger_add' ],
      [ 'an action the person approved', 'ledger_add_gated' ]
    ]) {
      it(`tells the model the entry of ${label} was undone`, async () => {
        const first = await setup({
          tools: ledger,
          replies: [
            asks([ 'c1', name, { text: 'receipt' } ]),
            says('Created.'),
            says('Noted.')
          ]
        });
        const { threadId } = accepted(await first.say('Create a receipt'));
        const store = first.world.rt.store;
        let [ original ] = await store.listActions(threadId, first.profileId);
        if (original.status === 'pending') {
          const data = { actionId: original.id };
          accepted(await approve(
            first.world.rt, first.world.request(first.token, data), data
          ));
          [ original ] = await store.listActions(threadId, first.profileId);
        }
        expect(original.status).to.equal('done');

        const data = { actionId: original.id };
        const undone = await undo(
          first.world.rt, first.world.request(first.token, data), data
        );
        expect(accepted(undone).status).to.equal('undone');

        accepted(await first.say('What happened?', { threadId }));
        const requests = first.world.stub().requests;
        const seen = requests[requests.length - 1].turns;
        const results = seen.flatMap(turn => (
          turn.role === 'tool' ? turn.results : []
        ));
        const entry = results.find(result => result.name === name);
        expect(entry?.output).to.include('entry-7');
        expect(entry?.output).to.include('later undid this action');
        expect(entry?.output).to.include('ledger_void');
        //every call still has exactly one result, in order
        const calls = seen.flatMap(turn => (
          turn.role === 'assistant' ? turn.toolCalls : []
        ));
        expect(results.map(result => result.id)).to.deep.equal(
          calls.map(item => item.id)
        );
      });
    }

    it('says an undo is in progress while the original is held for it', async () => {
      const first = await setup({
        tools: ledger,
        replies: [ asks([ 'c1', 'ledger_add', { text: 'receipt' } ]), says('Created.'), says('Ok.') ]
      });
      const { threadId } = accepted(await first.say('Create a receipt'));
      const store = first.world.rt.store;
      const [ original ] = await store.listActions(threadId, first.profileId);
      //claimed, but the inverse has not finished
      await store.claimUndo(original.id, first.profileId);

      accepted(await first.say('Status?', { threadId }));
      const requests = first.world.stub().requests;
      const output = requests[requests.length - 1].turns.flatMap(turn => (
        turn.role === 'tool' ? turn.results : []
      )).find(result => result.name === 'ledger_add')?.output;
      expect(output).to.include('undo is in progress');
    });
  });

  describe('a long conversation', () => {
    it('sends the newest message to the model after more than 1000 turns', async () => {
      const first = await setup({ replies: [ says('Reply.') ] });
      const thread = await first.world.rt.store.createThread({
        profileId: first.profileId, title: 'long', model: 'model-a'
      });
      await engine.query(
        "INSERT INTO agent_turn(id, thread_id, role, text, input_tokens, output_tokens, created) "
        + "SELECT lpad(i::text, 24, '0'), ?, 'user', 'old message ' || i, 0, 0, ? "
        + 'FROM generate_series(1, 1200) AS i',
        [ thread.id, new Date('2026-10-04T00:00:00Z') ]
      );

      accepted(await first.say('NEWEST MESSAGE', { threadId: thread.id }));
      const turns = first.world.stub().requests[0].turns;
      expect(turns.length).to.equal(1201);
      expect(turns[0]).to.include({ text: 'old message 1' });
      expect(turns[turns.length - 1]).to.include({ text: 'NEWEST MESSAGE' });
      //the stored reply follows it, and the panel history is whole too
      const stored = await first.world.rt.store.listTurns(thread.id, first.profileId);
      expect(stored.length).to.equal(1202);
      expect(stored[1200].text).to.equal('NEWEST MESSAGE');
      expect(stored[1201].role).to.equal('assistant');
    });

    it('lists every action of a thread past one page', async () => {
      const first = await setup();
      const store = first.world.rt.store;
      const thread = await store.createThread({ profileId: first.profileId, title: 'many' });
      await engine.query(
        'INSERT INTO agent_action(id, thread_id, turn_id, profile_id, tool, event, status, irreversible) '
        + "SELECT lpad(i::text, 24, '0'), ?, 't', ?, 'note_add', 'note-add', 'done', FALSE "
        + 'FROM generate_series(1, 1100) AS i',
        [ thread.id, first.profileId ]
      );
      const actions = await store.listActions(thread.id, first.profileId);
      expect(actions.length).to.equal(1100);
      expect(actions[1099].id).to.equal('1100'.padStart(24, '0'));
    });

    it('keeps turns in the order they happened when a server clock is behind', async () => {
      const first = await setup({ replies: [ says('a1'), says('a2'), says('a3') ] });
      const other = await sibling(first, { replies: [ says('b1'), says('b2') ] });
      //the second server's clock is hours behind the first's
      other.world.clock.at = new Date(first.world.clock.at.getTime() - 6 * 60 * 60 * 1000);

      let threadId: string | undefined;
      for (const [ speaker, text ] of [
        [ first, 'one' ], [ other, 'two' ], [ first, 'three' ], [ other, 'four' ]
      ] as const) {
        threadId = accepted(await speaker.say(text, { threadId })).threadId;
      }

      const turns = await first.world.rt.store.listTurns(
        threadId as string, first.profileId
      );
      expect(turns.map(turn => turn.role)).to.deep.equal([
        'user', 'assistant', 'user', 'assistant',
        'user', 'assistant', 'user', 'assistant'
      ]);
      expect(turns.filter(turn => turn.role === 'user').map(turn => turn.text))
        .to.deep.equal([ 'one', 'two', 'three', 'four' ]);
    });

    it('keeps turns in the order they happened across servers on one frozen clock', async () => {
      const first = await setup({
        replies: [ asks([ 'a0', 'who_am_i' ]), says('a1'), says('a2'), says('a3') ]
      });
      const other = await sibling(first, {
        replies: [ asks([ 'b0', 'who_am_i' ]), says('b1'), says('b2'), says('b3') ]
      });
      //the same exact moment for both, which no id of either store can order
      expect(first.world.clock.at.getTime()).to.equal(other.world.clock.at.getTime());

      let threadId: string | undefined;
      for (let round = 0; round < 6; round++) {
        const speaker = round % 2 ? other : first;
        const sent = accepted(await speaker.say(`message ${round}`, { threadId }));
        threadId = sent.threadId;
      }

      const store = first.world.rt.store;
      const turns = await store.listTurns(threadId as string, first.profileId);
      const ids = turns.map(turn => turn.id);
      expect(ids).to.deep.equal([ ...ids ].sort());
      expect(new Set(ids).size).to.equal(ids.length);
      //each message is followed by its own answer, and calls by their results
      const roles = turns.map(turn => turn.role);
      for (let at = 0; at < turns.length; at++) {
        if (turns[at].role === 'user') {
          expect(turns[at].text).to.equal(`message ${turns.slice(0, at).filter(t => t.role === 'user').length}`);
        }
        if (turns[at].role === 'tool') {
          expect(roles[at - 1]).to.equal('assistant');
        }
      }
      //what the next call is sent is the same order
      const next = accepted(await first.say('last', { threadId }));
      expect(next.ok).to.equal(true);
      const sent = first.world.stub().requests.pop()!.turns;
      expect(sent.filter(turn => turn.role === 'user').map(turn => turn.text))
        .to.deep.equal([
          'message 0', 'message 1', 'message 2', 'message 3',
          'message 4', 'message 5', 'last'
        ]);
      expect(sent[sent.length - 1]).to.include({ role: 'user', text: 'last' });
    });
  });
});

describe('the cards a message ends', () => {
  it('never ends a card of a newer message, however late the ending runs', async () => {
    const harness = await createHarness();
    const one = harness.store();
    const two = harness.store();
    const thread = await one.createThread({ profileId: 'p1', title: 't' });
    const first = await one.appendMessage(thread.id, 'p1', { role: 'user', text: 'one' });

    //hold the statement that ends the waiting cards of the second message
    const reached = latch();
    const proceed = latch();
    const real = harness.engine.query.bind(harness.engine) as (
      sql: string,
      values?: Value[]
    ) => Promise<unknown[]>;
    let held = false;
    harness.engine.query = (async (sql: string, values?: Value[]) => {
      if (!held && values?.[0] === 'expired' && sql.includes('agent_action')) {
        held = true;
        reached.open();
        await proceed.closed;
      }
      return real(sql, values);
    }) as typeof harness.engine.query;

    const second = one.appendMessage(thread.id, 'p1', { role: 'user', text: 'two' });
    await reached.closed;

    //a run of the first message, or of the second, cannot make a card now
    const proposal = (epoch: string) => ({
      threadId: thread.id,
      turnId: first.turn.id,
      profileId: 'p1',
      tool: 'request_cancel',
      event: 'request-cancel',
      irreversible: true,
      epoch
    });
    expect(await two.propose(proposal(first.epoch))).to.equal(null);

    proceed.open();
    const { epoch } = await second;
    //the card of the newest message is made after the ending and stays
    const card = await two.propose(proposal(epoch));
    expect(card?.status).to.equal('pending');
    await one.expirePending();
    expect((await two.getAction(card!.id, 'p1'))?.status).to.equal('pending');
    expect(await two.propose(proposal(first.epoch))).to.equal(null);
  });
});

describe('the daily allowance across servers', () => {
  it('admits one provider call at a time for a person, and checks the limit again at the claim', async () => {
    const harness = await createHarness();
    const one = harness.store();
    const two = harness.store();

    const first = await one.admit('p1', 10);
    expect(first.ok).to.equal(true);
    //a second server, a second thread: the same person is refused
    expect(await two.admit('p1', 10)).to.deep.equal({ ok: false, reason: 'busy' });
    expect(await two.busy('p1')).to.equal(true);
    //another person is not affected
    expect((await two.admit('p2', 10)).ok).to.equal(true);

    //its tokens are counted before the slot is free, and then the limit holds
    if (first.ok) await first.settle({ inputTokens: 10, outputTokens: 0 });
    expect(await two.admit('p1', 10)).to.deep.equal({ ok: false, reason: 'limit' });
  });

  it('lets one call overshoot what is left, and no second call start behind it', async () => {
    const harness = await createHarness();
    const store = harness.store();
    await store.addUsage('p1', { inputTokens: 9, outputTokens: 0 });

    const call = await store.admit('p1', 10);
    expect(call.ok).to.equal(true);
    expect((await harness.store().admit('p1', 10)).ok).to.equal(false);
    if (call.ok) await call.settle({ inputTokens: 500, outputTokens: 500 });
    expect((await store.getUsage('p1')).inputTokens).to.equal(509);
    expect(await harness.store().admit('p1', 10)).to.deep.equal({ ok: false, reason: 'limit' });
  });

  it('is not released by time, however long the call takes', async () => {
    const harness = await createHarness();
    const slow = harness.store();
    const call = await slow.admit('p1', 100);
    expect(call.ok).to.equal(true);

    //a day and a half of provider latency, across midnight
    harness.advance(36 * 60 * 60 * 1000);
    expect(await harness.store().admit('p1', 100)).to.deep.equal({ ok: false, reason: 'busy' });

    //the tokens are counted against the day the call was admitted on
    if (call.ok) await call.settle({ inputTokens: 7, outputTokens: 0 });
    expect((await harness.store().getUsage('p1')).inputTokens).to.equal(0);
    const days = await harness.engine.query<{ day: string, input_tokens: number }>(
      'SELECT day, input_tokens FROM agent_usage WHERE profile_id = ?', [ 'p1' ]
    );
    expect(days.find(row => row.input_tokens === 7)?.day).to.equal('2026-10-05');
    expect((await harness.store().admit('p1', 100)).ok).to.equal(true);
  });

  it('keeps the slot held when its tokens could not be counted', async () => {
    const harness = await createHarness();
    const store = harness.store();
    const call = await store.admit('p1', 100);
    expect(call.ok).to.equal(true);

    harness.failing['agent-usage-detail'] = { code: 500, error: 'database down' };
    let failure: unknown;
    try {
      if (call.ok) await call.settle({ inputTokens: 50, outputTokens: 0 });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    delete harness.failing['agent-usage-detail'];

    //nothing admits the next call against the allowance as it stood before
    expect(await harness.store().admit('p1', 100)).to.deep.equal({ ok: false, reason: 'busy' });
  });

  it('starts one of two simultaneous chats and turns the other away', async () => {
    const first = await setup({ config: { limit: 10 } });
    const other = await sibling(first, { config: { limit: 10 } });
    const held = latch();
    const arrived = latch();
    const one = answers(first.world, async () => {
      arrived.open();
      await held.closed;
      return end('Done.', 10, 0);
    });
    const two = answers(other.world, () => end('Done.', 10, 0));

    const running = first.say('one');
    await arrived.closed;
    //turned away before it is stored, so it costs nothing
    const turned = refused(await other.say('two'));
    expect(turned.reason).to.equal('busy');
    held.open();
    accepted(await running);

    expect(one.calls() + two.calls()).to.equal(1);
    expect((await first.world.rt.store.getUsage(first.profileId)).inputTokens).to.equal(10);
    //the allowance is spent now, so the next message is refused for that
    expect(refused(await other.say('three')).reason).to.equal('limit');
  });

  it('turns a run away as busy when another call holds the slot and ends it without a provider call', async () => {
    const first = await setup({ config: { limit: 100 }, replies: [ says('Never.') ] });
    const store = first.world.rt.store;
    const thread = await store.createThread({
      profileId: first.profileId, title: 't', model: 'model-a'
    });
    //another server's call holds the slot after this run passed its look
    const holding = await (await sibling(first)).world.rt.store.admit(first.profileId, 100);
    expect(holding.ok).to.equal(true);
    const rt = first.world.rt;
    const real = rt.store.busy;
    rt.store.busy = async () => false;
    try {
      const result = accepted(await first.say('hello', { threadId: thread.id }));
      expect(result.status).to.equal('busy');
      expect(result.events.some(event => (
        event.type === 'error' && event.status === 'busy'
      ))).to.equal(true);
    } finally {
      rt.store.busy = real;
    }
    expect(first.world.stub()?.requests ?? []).to.deep.equal([]);
  });

  it('holds the slot and reports failure when the usage of a reply cannot be recorded', async () => {
    const first = await setup({ config: { limit: 100 }, replies: [ says('Fine.') ] });
    const store = first.world.rt.store;
    const real = store.addUsage;
    store.addUsage = async () => { throw new Error('database down'); };
    try {
      const result = accepted(await first.say('hello'));
      expect(result.status).to.equal('failed');
    } finally {
      store.addUsage = real;
    }
    //the next message is turned away rather than admitted unchecked
    expect(refused(await first.say('again')).reason).to.equal('busy');
    expect(await store.busy(first.profileId)).to.equal(true);
  });
});
