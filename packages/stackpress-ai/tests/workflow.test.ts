//modules
import { expect } from 'chai';
import { before, describe, it } from 'mocha';
//client
import { approve, decline, undo } from '../src/scripts/approval.js';
import { listThreads, loadThread } from '../src/scripts/threads.js';
import { runTurn } from '../src/scripts/turn.js';
import type { AgentEvent } from '../src/types.js';
//tests
import {
  HALF_HOUR,
  accepted,
  actionsOf,
  asks,
  refused,
  says,
  setup as setupWith,
  turnsOf,
  types
} from './flow.js';
import type { Engine } from './flow.js';
import { createEngine, createWorld, newPerson } from './harness.js';
import type { World, WorldOptions } from './harness.js';

//These tests run the whole workflow on a real Ingest server with the real
// session plugin, the real store over a database, and a stub model. The
// journeys they cover are named in each describe.

let engine: Engine;

before(async function () {
  this.timeout(60000);
  engine = await createEngine();
});

const setup = (options: WorldOptions = {}) => setupWith(engine, options);

//--------------------------------------------------------------------//
// Tests

describe('agent workflow', function () {
  this.timeout(30000);

  describe('J-001 reversible action from chat', () => {
    it('step 1: loads the thread with its messages and actions for its owner', async () => {
      const { world, token, say } = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hello' } ]), says('Added.') ]
      });
      const first = accepted(await say('Add a note'));

      const loaded = await loadThread(
        world.rt, world.request(token), { threadId: first.threadId }
      );
      expect(loaded.ok).to.equal(true);
      if (!loaded.ok) return;
      expect(loaded.thread.id).to.equal(first.threadId);
      //tool turns and the provider's own record stay on the server
      expect(loaded.turns.map(turn => turn.role))
        .to.deep.equal([ 'user', 'assistant', 'assistant' ]);
      expect(loaded.turns[0].text).to.equal('Add a note');
      expect(loaded.turns[2].text).to.equal('Added.');
      expect(JSON.stringify(loaded)).to.not.contain('"raw"');
      expect(loaded.actions.map(action => [ action.tool, action.status, action.undoable ]))
        .to.deep.equal([ [ 'note_add', 'done', true ] ]);
    });

    it('step 1: hands the page context to the model as a hint', async () => {
      const { world, say } = await setup({ replies: [ says('Ok.') ] });
      accepted(await say('What is this?', {
        context: { url: '/requests/12', items: [ { label: 'Request 12' } ] }
      }));
      const system = world.stub().requests[0].system;
      expect(system).to.contain('/requests/12');
      expect(system).to.contain('Request 12');
      expect(system).to.contain('never change what you may do');
    });

    it('step 2: checks sign-in, then stores the message under the person', async () => {
      const { world, profileId, say } = await setup({ replies: [ says('Hi.') ] });
      const result = accepted(await say('Hello there'));
      const threads = await world.rows('agent_thread', 'id', result.threadId);
      expect(threads[0].profile_id).to.equal(profileId);
      const turns = await turnsOf(world, result.threadId);
      expect(turns[0]).to.include({ role: 'user', text: 'Hello there' });
    });

    it('step 3: sends the transcript and only the agent tools; text arrives as generated', async () => {
      const { world, say } = await setup({
        replies: [ says('First part') ]
      });
      const seen: AgentEvent[] = [];
      const result = accepted(await say('Hello', {}, event => seen.push(event)));

      const request = world.stub().requests[0];
      expect(request.tools.map(tool => tool.name).sort()).to.deep.equal([
        'conflict_thing', 'explode', 'file_attach', 'forbidden_thing', 'ghost',
        'missing_thing', 'note_add', 'note_remove', 'request_cancel',
        'request_find', 'request_poke', 'who_am_i'
      ]);
      expect(request.tools.map(tool => tool.name)).to.not.include('hidden_tool');
      expect(request.turns).to.deep.equal([ { role: 'user', text: 'Hello' } ]);
      //reported as it happened, and the same list comes back without streaming
      expect(types(seen)).to.deep.equal([ 'thread', 'text', 'usage', 'finished' ]);
      expect(result.events).to.deep.equal(seen);
      expect(seen[1]).to.deep.equal({ type: 'text', text: 'First part' });
    });

    it('step 4: runs the tool on a new request with the person\'s session and only the tool arguments', async () => {
      const { world, profileId, token, say } = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hello' } ]), says('Done.') ]
      });
      accepted(await say('Add a note', { leak: 'body-field', secret: 'chat-only' }));

      expect(world.ran.length).to.equal(1);
      const seen = world.ran[0];
      expect(seen.event).to.equal('note-add');
      //only the arguments: not the chat body, and not the query
      expect(seen.input).to.deep.equal({ text: 'hello' });
      expect(seen.session.session).to.equal(token);
      expect(seen.caller).to.deep.equal({
        kind: 'person', profileId, roles: [ 'USER' ], scopes: []
      });
      expect(seen.url).to.equal('http://example.test/agent/turn');
      expect(seen.method).to.equal('POST');
    });

    it('step 5: commits as the person and logs the action with the app\'s operation identifier', async () => {
      const { world, profileId, say } = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hello' } ]), says('Done.') ]
      });
      const result = accepted(await say('Add a note'));

      expect(types(result.events)).to.deep.equal([
        'thread', 'usage', 'action-start', 'action-done', 'text', 'usage', 'finished'
      ]);
      const done = result.events.find(event => event.type === 'action-done')!;
      expect(done).to.include({
        tool: 'note_add', operation: 'op-note-1', undoable: true
      });

      const [ stored ] = await actionsOf(world, result.threadId);
      expect(stored).to.include({
        profile_id: profileId,
        tool: 'note_add',
        event: 'note-add',
        status: 'done',
        operation: 'op-note-1',
        irreversible: false
      });
      expect(stored.result).to.deep.equal({ value: { id: 'note-1', operation: 'op-note-1' } });
      expect(stored.input).to.deep.equal({ text: 'hello' });
    });

    it('step 5: reads the identifier from the path a tool names', async () => {
      const { world, say } = await setup({
        tools: [
          { name: 'who', event: 'who-am-i', method: 'GET', agent: true, operation: 'caller.profileId' }
        ],
        replies: [ asks([ 'c1', 'who' ]), says('Ok.') ]
      });
      const result = accepted(await say('Who am I?'));
      const [ stored ] = await actionsOf(world, result.threadId);
      expect(stored.operation).to.equal(stored.profile_id);
    });

    it('step 6: the reloaded thread shows the finished action the panel refreshes from', async () => {
      const { world, token, say } = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hello' } ]), says('Done.') ]
      });
      const result = accepted(await say('Add a note'));
      const loaded = await loadThread(
        world.rt, world.request(token), { threadId: result.threadId }
      );
      if (!loaded.ok) throw new Error('not loaded');
      expect(loaded.actions[0]).to.include({
        status: 'done', operation: 'op-note-1', undoable: true
      });
      expect(loaded.actions[0].result).to.deep.equal({ id: 'note-1', operation: 'op-note-1' });
    });

    it('logs a read-only tool without an undo', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'request_find' ]), says('Two.') ]
      });
      const result = accepted(await say('List requests'));
      const done = result.events.find(event => event.type === 'action-done')!;
      expect(done).to.include({ tool: 'request_find', undoable: false });
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-find' ]);
    });
  });

  describe('J-002 irreversible action with approval', () => {
    async function paused(options: WorldOptions = {}) {
      const set = await setup({
        replies: [
          { ...asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), text: 'Cancelling.' },
          says('Cancelled.')
        ],
        ...options
      });
      const first = accepted(await set.say('Cancel request 1'));
      const [ action ] = await actionsOf(set.world, first.threadId);
      return { ...set, first, action };
    }

    it('step 1: stores the turn as waiting with the action name and inputs, and runs nothing', async () => {
      const { world, first, action } = await paused();
      expect(first.status).to.equal('waiting');
      const waiting = first.events.find(event => event.type === 'action-waiting')!;
      expect(waiting).to.include({ tool: 'request_cancel', actionId: action.id });
      expect((waiting as { input: unknown }).input).to.deep.equal({ id: 'REQ-1' });
      expect((waiting as { expires: string }).expires).to.equal('2026-10-05T10:30:00.000Z');
      expect(types(first.events)).to.not.include('action-start');
      expect(types(first.events)).to.include('text');

      expect(action).to.include({ status: 'pending', irreversible: true });
      expect(world.ran).to.deep.equal([]);
      //the turn stopped: one model call, and the whole state is stored
      expect(world.stub().requests.length).to.equal(1);
      const turns = await turnsOf(world, first.threadId);
      expect(turns.map(turn => turn.role)).to.deep.equal([ 'user', 'assistant', 'tool' ]);
    });

    it('step 1: treats a write with no inverse and no irreversible mark the same way', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'request_poke' ]), says('Poked.') ]
      });
      const result = accepted(await say('Poke it'));
      expect(result.status).to.equal('waiting');
      expect(world.ran).to.deep.equal([]);
      const [ action ] = await actionsOf(world, result.threadId);
      expect(action).to.include({ status: 'pending', tool: 'request_poke', irreversible: true });
    });

    it('step 2: approval reruns the sign-in check, runs the tool once as the person, shows Done with no Undo, and continues', async () => {
      const { world, token, profileId, first, action } = await paused();
      const data = { actionId: action.id };
      const done = accepted(await approve(world.rt, world.request(token, data), data));

      expect(done.status).to.equal('done');
      expect(types(done.events)).to.deep.equal([
        'action-start', 'action-done', 'text', 'usage', 'finished'
      ]);
      expect(done.events[1]).to.include({ tool: 'request_cancel', undoable: false });
      expect(world.ran.length).to.equal(1);
      expect(world.ran[0].caller).to.include({ kind: 'person', profileId });
      expect(world.ran[0].session.session).to.equal(token);
      expect(world.ran[0].input).to.deep.equal({ id: 'REQ-1' });
      expect(done.action).to.include({ status: 'done', irreversible: true });

      //the model was told the result and answered
      const [ , second ] = world.stub().requests;
      const last = second.turns[second.turns.length - 1];
      expect(last).to.deep.equal({
        role: 'tool',
        results: [ { id: 'c1', name: 'request_cancel', output: '{"cancelled":true}' } ]
      });
      expect(first.threadId).to.equal(done.threadId);
    });

    it('step 3: a decline records the refusal, tells the model, and continues with no action', async () => {
      const { world, token, action } = await paused();
      const data = { actionId: action.id, reason: 'Not that one' };
      const result = accepted(await decline(world.rt, world.request(token, data), data));

      expect(result.status).to.equal('done');
      expect(types(result.events)).to.deep.equal([
        'action-declined', 'text', 'usage', 'finished'
      ]);
      expect(world.ran).to.deep.equal([]);
      expect(result.action).to.include({ status: 'declined', error: 'Not that one' });

      const [ , second ] = world.stub().requests;
      const last = second.turns[second.turns.length - 1];
      if (last.role !== 'tool') throw new Error('expected a tool turn');
      expect(last.results[0].isError).to.equal(true);
      expect(last.results[0].output).to.contain('declined');
      expect(last.results[0].output).to.contain('Not that one');
    });

    it('step 4: another server finds the stored turn, and a repeated approval runs nothing', async () => {
      const { world, token, action } = await paused();
      const data = { actionId: action.id };

      //a different server over the same database: nothing is held in memory
      const other = world.another();
      const first = accepted(await approve(
        other.rt, world.request(token, data, other.app), data
      ));
      expect(first.status).to.equal('done');
      expect(world.ran.length).to.equal(1);
      const calls = world.stub().requests.length;

      //the same approval again, on both servers, answers from the record
      for (const [ rt, app ] of [ [ other.rt, other.app ], [ world.rt, world.app ] ] as const) {
        const again = accepted(await approve(rt, world.request(token, data, app), data));
        expect(again.status).to.equal('settled');
        expect(again.replayed).to.equal(true);
        expect(again.action).to.include({ id: action.id, status: 'done' });
        expect(types(again.events)).to.deep.equal([ 'finished' ]);
      }
      expect(world.ran.length).to.equal(1);
      expect(world.stub().requests.length).to.equal(calls);
    });

    it('step 4: simultaneous approvals run the tool once and continue the turn once', async () => {
      const { world, token, action } = await paused();
      const data = { actionId: action.id };
      const servers = [ world, world.another(), world.another(), world.another() ];
      const results = await Promise.all(servers.flatMap(server => [ 1, 2 ].map(() =>
        approve(server.rt, world.request(token, data, server.app), data)
      )));
      const ok = results.map(accepted);
      expect(ok.filter(result => result.status === 'done').length).to.equal(1);
      expect(ok.filter(result => result.status === 'settled').length).to.equal(7);
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-cancel' ]);
      expect(world.stub().requests.length).to.equal(2);
    });

    it('step 4: simultaneous declines continue the turn once', async () => {
      const { world, token, action } = await paused();
      const data = { actionId: action.id };
      const results = (await Promise.all([ 1, 2, 3 ].map(() =>
        decline(world.rt, world.request(token, data), data)
      ))).map(accepted);
      expect(results.filter(result => result.status === 'done').length).to.equal(1);
      expect(world.stub().requests.length).to.equal(2);
      expect(world.ran).to.deep.equal([]);
    });

    it('step 5: a new message expires the pending approval, and approving it later runs nothing', async () => {
      const { world, token, say, first, action } = await paused({
        replies: [
          asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]),
          says('Never mind, then.'),
          says('Unused.')
        ]
      });
      accepted(await say('Actually, leave it', { threadId: first.threadId }));

      //the model was told the approval expired
      const second = world.stub().requests[1];
      const results = second.turns.find(turn => turn.role === 'tool');
      if (results?.role !== 'tool') throw new Error('expected a tool turn');
      expect(results.results[0].isError).to.equal(true);
      expect(results.results[0].output).to.contain('expired');

      const data = { actionId: action.id };
      const late = accepted(await approve(world.rt, world.request(token, data), data));
      expect(late.status).to.equal('settled');
      expect(late.action).to.include({ status: 'expired' });
      expect(world.ran).to.deep.equal([]);
      expect(world.stub().requests.length).to.equal(2);
    });

    it('step 5: an approval expires when the configured time passes', async () => {
      const { world, token, action } = await paused();
      world.advance(HALF_HOUR + 1000);
      const data = { actionId: action.id };
      const late = accepted(await approve(world.rt, world.request(token, data), data));
      expect(late.status).to.equal('settled');
      expect(late.action).to.include({ status: 'expired' });
      expect(world.ran).to.deep.equal([]);
      expect(world.stub().requests.length).to.equal(1);
    });

    it('step 5: loading a thread shows an overdue approval as expired', async () => {
      const { world, token, first } = await paused();
      world.advance(HALF_HOUR + 1000);
      const loaded = await loadThread(
        world.rt, world.request(token), { threadId: first.threadId }
      );
      if (!loaded.ok) throw new Error('not loaded');
      expect(loaded.actions[0].status).to.equal('expired');
    });

    it('step 5: an approval that never expires by time still expires on a new message', async () => {
      const { world, say, first, action } = await paused({
        config: { approvalTtl: undefined }
      });
      expect(action.expires).to.equal(null);
      accepted(await say('Hello again', { threadId: first.threadId }));
      const [ stored ] = await actionsOf(world, first.threadId);
      expect(stored.status).to.equal('expired');
    });

    it('stops at an approval when several tools are requested, and answers every call', async () => {
      const { world, token, say } = await setup({
        replies: [
          asks(
            [ 'c1', 'note_add', { text: 'one' } ],
            [ 'c2', 'request_cancel', { id: 'REQ-1' } ],
            [ 'c3', 'note_add', { text: 'two' } ],
            [ 'c4', 'request_poke' ]
          ),
          says('Resumed.')
        ]
      });
      const first = accepted(await say('Do all of it'));
      expect(first.status).to.equal('waiting');

      //the call before the gate ran; the gate waits; the rest did not run
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-add' ]);
      const actions = await actionsOf(world, first.threadId);
      expect(actions.map(action => [ action.tool, action.status ])).to.deep.equal([
        [ 'note_add', 'done' ],
        [ 'request_cancel', 'pending' ]
      ]);

      //every call has a result in the stored tool turn
      const turns = await turnsOf(world, first.threadId);
      const stored = (turns[2].tool_results as { value: { id: string, isError?: boolean, action?: string }[] }).value;
      expect(stored.map(result => result.id)).to.deep.equal([ 'c1', 'c2', 'c3', 'c4' ]);
      expect(stored[1].action).to.equal(actions[1].id);
      expect(stored[2].isError).to.equal(true);
      expect(stored[3].isError).to.equal(true);

      //so approving continues with a request the provider would accept
      const data = { actionId: actions[1].id };
      accepted(await approve(world.rt, world.request(token, data), data));
      const second = world.stub().requests[1];
      const answered = second.turns[second.turns.length - 1];
      if (answered.role !== 'tool') throw new Error('expected a tool turn');
      expect(answered.results.map(result => result.id)).to.deep.equal([ 'c1', 'c2', 'c3', 'c4' ]);
      expect(answered.results[1].output).to.equal('{"cancelled":true}');
      expect(answered.results[2].output).to.contain('Not run');
      expect(answered.results[3].output).to.contain('Not run');
      //the calls after the gate never ran
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-add', 'request-cancel' ]);
    });

    it('answers every call too when the person declines the one that waited', async () => {
      const { world, token, say } = await setup({
        replies: [
          asks([ 'c1', 'request_poke' ], [ 'c2', 'request_find' ]),
          says('Ok.')
        ]
      });
      const first = accepted(await say('Poke then find'));
      const [ action ] = await actionsOf(world, first.threadId);
      const data = { actionId: action.id };
      accepted(await decline(world.rt, world.request(token, data), data));
      const second = world.stub().requests[1];
      const answered = second.turns[second.turns.length - 1];
      if (answered.role !== 'tool') throw new Error('expected a tool turn');
      expect(answered.results.map(result => result.id)).to.deep.equal([ 'c1', 'c2' ]);
      expect(world.ran).to.deep.equal([]);
    });

    it('settles an action as failed when its tool has left the registry', async () => {
      const { world, token, first, action } = await paused();
      //a new server whose registry no longer has the tool
      const gone = createWorld(engine, {
        tools: [ { name: 'other', event: 'who-am-i', method: 'GET', agent: true } ],
        replies: [ says('It is gone.') ],
        config: { approvalTtl: HALF_HOUR }
      });
      const data = { actionId: action.id };
      const result = accepted(await approve(gone.rt, gone.request(token, data), data));
      expect(result.status).to.equal('done');
      expect(result.events[0]).to.include({ type: 'action-failed' });
      const [ stored ] = await actionsOf(world, first.threadId);
      expect(stored).to.include({ status: 'failed', error: 'This action is no longer available.' });
    });
  });

  describe('J-003 undo an agent action', () => {
    async function added(options: WorldOptions = {}) {
      const set = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hello' } ]), says('Added.') ],
        ...options
      });
      const first = accepted(await set.say('Add a note'));
      const [ action ] = await actionsOf(set.world, first.threadId);
      set.world.ran.length = 0;
      return { ...set, first, action };
    }

    it('step 1: runs the inverse with the stored inputs through the person\'s session, with no second approval', async () => {
      const { world, token, profileId, action } = await added();
      const data = { actionId: action.id };
      const result = await undo(world.rt, world.request(token, data), data);
      expect(result.ok).to.equal(true);

      expect(world.ran.length).to.equal(1);
      expect(world.ran[0].event).to.equal('note-remove');
      expect(world.ran[0].input).to.deep.equal({ text: 'hello' });
      expect(world.ran[0].session.session).to.equal(token);
      expect(world.ran[0].caller).to.include({ kind: 'person', profileId });
      //no approval was asked for, and the model was not called again
      expect(world.stub().requests.length).to.equal(2);
    });

    it('step 2: the card shows Undone when the event commits', async () => {
      const { world, token, action } = await added();
      const data = { actionId: action.id };
      const result = await undo(world.rt, world.request(token, data), data);
      if (!result.ok) throw new Error('refused');
      expect(result.status).to.equal('undone');
      expect(result.action.status).to.equal('undone');
      expect(types(result.events)).to.deep.equal([
        'action-start', 'action-done', 'action-undone', 'finished'
      ]);
    });

    it('step 2: shows the reason when the app refuses because the record changed', async () => {
      const { world, token, action } = await added();
      world.behave.noteRemove = 'conflict';
      const data = { actionId: action.id };
      const result = await undo(world.rt, world.request(token, data), data);
      if (!result.ok) throw new Error('refused');
      expect(result.status).to.equal('refused');
      expect(result.error).to.contain('The note changed since.');
      //the original action stands, so the person can try again
      expect(result.action.status).to.equal('done');
      expect(result.undo).to.include({ status: 'failed' });
      expect(types(result.events)).to.include('action-failed');

      world.behave.noteRemove = 'ok';
      const retry = await undo(world.rt, world.request(token, data), data);
      if (!retry.ok) throw new Error('refused');
      expect(retry.status).to.equal('undone');
    });

    it('step 3: the log links the undo to the original action', async () => {
      const { world, token, first, action } = await added();
      const data = { actionId: action.id };
      const result = await undo(world.rt, world.request(token, data), data);
      if (!result.ok || result.status !== 'undone') throw new Error('not undone');
      expect(result.undo).to.include({ tool: 'note_remove', reverses: action.id, status: 'done' });

      const actions = await actionsOf(world, first.threadId);
      expect(actions.map(row => [ row.tool, row.status, row.reverses ])).to.deep.equal([
        [ 'note_add', 'undone', null ],
        [ 'note_remove', 'done', action.id ]
      ]);
      expect(actions[1].irreversible).to.equal(false);
    });

    it('runs the inverse once when Undo is clicked many times at once', async () => {
      const { world, token, action } = await added();
      const data = { actionId: action.id };
      const servers = [ world, world.another(), world.another() ];
      const results = await Promise.all(servers.flatMap(server => [ 1, 2 ].map(() =>
        undo(server.rt, world.request(token, data, server.app), data)
      )));
      const ok = results.map(result => {
        if (!result.ok) throw new Error('refused');
        return result;
      });
      expect(ok.filter(result => result.status === 'undone').length).to.equal(1);
      expect(ok.filter(result => result.status === 'settled').length).to.equal(5);
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-remove' ]);
    });

    it('refuses to undo an action that has no inverse, or is not done', async () => {
      const { world, token, say } = await setup({
        replies: [ asks([ 'c1', 'request_poke' ]), says('Ok.') ]
      });
      const first = accepted(await say('Poke it'));
      const [ pending ] = await actionsOf(world, first.threadId);
      const data = { actionId: pending.id };

      //pending is not done
      const early = refused(await undo(world.rt, world.request(token, data), data));
      expect(early).to.include({ code: 409, reason: 'conflict' });

      //approved and done, but irreversible: no inverse
      accepted(await approve(world.rt, world.request(token, data), data));
      const late = refused(await undo(world.rt, world.request(token, data), data));
      expect(late).to.include({ code: 409, error: 'This action cannot be undone.' });
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-poke' ]);
    });

    it('refuses an undo with no action', async () => {
      const { world, token } = await setup();
      const none = refused(await undo(world.rt, world.request(token, {}), {}));
      expect(none).to.include({ code: 400, reason: 'invalid' });
      const missing = { actionId: 'nope' };
      const result = refused(await undo(world.rt, world.request(token, missing), missing));
      expect(result).to.include({ code: 404, reason: 'not_found' });
    });
  });

  describe('J-004 the app refuses the action', () => {
    for (const [ tool, message, code ] of [
      [ 'forbidden_thing', 'You may not change this.', 403 ],
      [ 'missing_thing', 'That record does not exist.', 404 ],
      [ 'conflict_thing', 'The record changed since.', 409 ]
    ] as const) {
      it(`step 1: logs a ${code} and returns it to the model as a failed tool result`, async () => {
        const { world, say } = await setup({
          replies: [ asks([ 'c1', tool ]), says('I could not do that.') ]
        });
        const result = accepted(await say('Try it'));

        const failed = result.events.find(event => event.type === 'action-failed')!;
        expect(failed).to.include({ tool, code });
        expect((failed as { error: string }).error).to.contain(message);

        const [ stored ] = await actionsOf(world, result.threadId);
        expect(stored.status).to.equal('failed');
        expect(stored.error).to.contain(message);

        const second = world.stub().requests[1];
        const last = second.turns[second.turns.length - 1];
        if (last.role !== 'tool') throw new Error('expected a tool turn');
        expect(last.results[0].isError).to.equal(true);
        expect(last.results[0].output).to.contain(message);
      });
    }

    it('step 2: the agent explains the refusal and the turn ends', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'forbidden_thing' ]), says('You may not change that.') ]
      });
      const result = accepted(await say('Try it'));
      expect(result.status).to.equal('done');
      expect(result.events.filter(event => event.type === 'text')).to.deep.equal([
        { type: 'text', text: 'You may not change that.' }
      ]);
      expect(world.stub().requests.length).to.equal(2);
    });

    it('step 2: the step limit stops a model that keeps retrying', async () => {
      const { world, say } = await setup({
        config: { steps: 3 },
        replies: [ asks([ 'c1', 'forbidden_thing' ]) ]
      });
      const result = accepted(await say('Keep trying'));
      expect(result.status).to.equal('steps');
      expect(world.stub().requests.length).to.equal(3);
      const actions = await actionsOf(world, result.threadId);
      expect(actions.map(action => action.status)).to.deep.equal([ 'failed', 'failed', 'failed' ]);
    });

    it('logs an event that threw as a plain failure and keeps its detail from the person', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'explode' ]), says('That failed.') ]
      });
      const result = accepted(await say('Explode'));
      const failed = result.events.find(event => event.type === 'action-failed') as { error: string };
      expect(failed.error).to.contain('The action failed unexpectedly.');
      expect(JSON.stringify(result)).to.not.contain('secret internal detail');
      expect(world.logs.some(log => log.message.includes('"explode" tool threw'))).to.equal(true);
    });

    it('treats an event nobody answered as not done', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'ghost' ]), says('Nothing happened.') ]
      });
      const result = accepted(await say('Call the ghost'));
      const [ stored ] = await actionsOf(world, result.threadId);
      expect(stored.status).to.equal('failed');
      expect(stored.error).to.contain('Nothing answered');
    });

    it('hands a bad input back to the model before any approval is asked for', async () => {
      const { world, say } = await setup({
        replies: [
          asks([ 'c1', 'request_cancel', { id: 5 } ]),
          says('I will fix the input.')
        ]
      });
      const result = accepted(await say('Cancel it'));
      expect(result.status).to.equal('done');
      expect(await actionsOf(world, result.threadId)).to.deep.equal([]);
      const second = world.stub().requests[1];
      const last = second.turns[second.turns.length - 1];
      if (last.role !== 'tool') throw new Error('expected a tool turn');
      expect(last.results[0].isError).to.equal(true);
      expect(last.results[0].output).to.contain('The input was not valid');
    });
  });

  describe('J-005 a personal security step is requested', () => {
    it('step 2: offers no sign-in, password, verification, or guest tool, and says so', async () => {
      const { world, say } = await setup({ replies: [ says('Use your account page.') ] });
      const result = accepted(await say('Reset my password'));
      const request = world.stub().requests[0];
      expect(request.tools.map(tool => tool.name).join(' '))
        .to.not.match(/sign|password|verif|guest|login/i);
      expect(request.system).to.contain('signing in, resetting a password');
      expect(request.system).to.contain('account page');
      expect(result.events.find(event => event.type === 'text'))
        .to.deep.equal({ type: 'text', text: 'Use your account page.' });
    });

    it('step 2: a tool the model makes up never runs and is not logged', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'reset_password', { email: 'x@y.z' } ]), says('I cannot do that.') ]
      });
      const result = accepted(await say('Reset my password'));
      expect(world.ran).to.deep.equal([]);
      expect(await actionsOf(world, result.threadId)).to.deep.equal([]);
      const second = world.stub().requests[1];
      const last = second.turns[second.turns.length - 1];
      if (last.role !== 'tool') throw new Error('expected a tool turn');
      expect(last.results[0].output).to.contain('There is no tool named "reset_password"');
    });

    it('does not run a tool that is registered but not marked for the agent', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'hidden_tool' ]), says('Ok.') ]
      });
      accepted(await say('Use the hidden tool'));
      expect(world.ran).to.deep.equal([]);
    });
  });

  describe('J-008 usage limit reached', () => {
    it('step 1: refuses before any provider call, says when the limit resets, and costs nothing', async () => {
      const { world, profileId, say } = await setup({
        config: { limit: 100 },
        replies: [ says('A reply.', 80, 30), says('Not reached.') ]
      });
      accepted(await say('First message'));
      const used = await world.rt.store.getUsage(profileId);
      expect(used.inputTokens + used.outputTokens).to.equal(110);
      const before = await world.rows('agent_turn', 'thread_id', (
        await world.rows('agent_thread', 'profile_id', profileId)
      )[0].id);

      const result = refused(await say('Second message'));
      expect(result).to.include({
        code: 429, reason: 'limit', resetsAt: '2026-10-06T00:00:00.000Z'
      });
      expect(result.error).to.contain('2026-10-06T00:00:00.000Z');

      //nothing was called, stored, or counted
      expect(world.stub().requests.length).to.equal(1);
      const after = await world.rt.store.getUsage(profileId);
      expect(after.inputTokens + after.outputTokens).to.equal(110);
      expect(after.turns).to.equal(1);
      expect(await world.rows('agent_thread', 'profile_id', profileId)).to.have.length(1);
      expect(await world.rows('agent_turn', 'thread_id', (
        await world.rows('agent_thread', 'profile_id', profileId)
      )[0].id)).to.have.length(before.length);
    });

    it('step 1: a refused message does not start a thread', async () => {
      const { world, profileId, say } = await setup({
        config: { limit: 1 },
        replies: [ says('Reply.', 1, 1), says('Not reached.') ]
      });
      accepted(await say('One'));
      refused(await say('Two'));
      refused(await say('Three'));
      expect(await world.rows('agent_thread', 'profile_id', profileId)).to.have.length(1);
    });

    it('step 1: counts usage per person and resets the next day', async () => {
      const { world, say } = await setup({
        config: { limit: 100 },
        replies: [ says('A.', 60, 40), says('B.', 1, 1) ]
      });
      accepted(await say('One'));
      refused(await say('Two'));
      world.advance(14 * 60 * 60 * 1000);
      const next = accepted(await say('Three'));
      expect(next.status).to.equal('done');

      //another person is not affected by this one's usage
      const other = await setup({ config: { limit: 100 }, replies: [ says('C.', 1, 1) ] });
      accepted(await other.say('Hello'));
    });

    it('step 1: lets a person use the agent when no limit is configured', async () => {
      const { say } = await setup({ replies: [ says('A.', 1000000, 1000000) ] });
      accepted(await say('One'));
      accepted(await say('Two'));
    });

    it('stops a turn between steps when the limit is crossed, and still runs no more calls', async () => {
      const { world, say } = await setup({
        config: { limit: 100 },
        replies: [
          { ...asks([ 'c1', 'note_add', { text: 'hello' } ]), usage: { input: 90, output: 20 } },
          says('Not reached.')
        ]
      });
      const result = accepted(await say('Add a note'));
      expect(result.status).to.equal('limit');
      expect(result.events.find(event => event.type === 'error')).to.include({
        status: 'limit', resetsAt: '2026-10-06T00:00:00.000Z'
      });
      expect(world.stub().requests.length).to.equal(1);
      //the tool the model had already asked for ran, and its result is stored
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-add' ]);
    });

    it('does not continue an approved turn past the limit, but still runs the approved tool', async () => {
      const { world, token, say } = await setup({
        config: { limit: 100 },
        replies: [
          { ...asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), usage: { input: 90, output: 20 } },
          says('Not reached.')
        ]
      });
      const first = accepted(await say('Cancel it'));
      expect(first.status).to.equal('waiting');
      const [ action ] = await actionsOf(world, first.threadId);
      const data = { actionId: action.id };
      const result = accepted(await approve(world.rt, world.request(token, data), data));
      expect(result.status).to.equal('limit');
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-cancel' ]);
      expect(world.stub().requests.length).to.equal(1);
    });
  });

  describe('J-009 sign-in expired or wrong person', () => {
    //a token that does not verify, one that has expired, and nothing
    async function strangers(world: World) {
      const tampered = `${await world.token('someone')}x`;
      const { Session } = await import('stackpress-session');
      Session.expires = 1;
      const expired = await world.token('someone');
      Session.expires = 0;
      return [
        [ 'signed out', null ],
        [ 'a token that does not verify', tampered ],
        [ 'an expired sign-in', expired ],
        [ 'another person', await world.token(newPerson('other')) ]
      ] as const;
    }

    it('step 1: refuses a message, an approval, a decline, and an undo, with no provider call and no tool run', async () => {
      const { world, say } = await setup({
        replies: [
          asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ], [ 'c2', 'note_add', { text: 'hi' } ]),
          says('Unused.')
        ]
      });
      const first = accepted(await say('Cancel it and add a note'));
      const actions = await actionsOf(world, first.threadId);
      const pending = actions.find(action => action.status === 'pending')!;
      //the gate came first, so the reversible call after it did not run
      expect(actions.map(action => action.status)).to.deep.equal([ 'pending' ]);
      const calls = world.stub().requests.length;
      const ran = world.ran.length;
      const turns = (await turnsOf(world, first.threadId)).length;

      for (const [ label, stranger ] of await strangers(world)) {
        const message = { threadId: first.threadId, message: 'Hello' };
        const target = { actionId: pending.id };
        const results = [
          await runTurn(world.rt, world.request(stranger, message), message),
          await approve(world.rt, world.request(stranger, target), target),
          await decline(world.rt, world.request(stranger, target), target),
          await undo(world.rt, world.request(stranger, target), target)
        ];
        for (const result of results) {
          expect(result.ok, label).to.equal(false);
          //no verified person is 401; a verified stranger gets what a
          // missing thread or action would get
          expect((result as { code: number }).code, label)
            .to.equal(label === 'another person' ? 404 : 401);
        }
      }

      expect(world.stub().requests.length).to.equal(calls);
      expect(world.ran.length).to.equal(ran);
      expect((await turnsOf(world, first.threadId)).length).to.equal(turns);

      //step 2: the pending approval is still stored, and only its owner can
      // run it after signing in again
      const [ still ] = await world.rows('agent_action', 'id', pending.id);
      expect(still.status).to.equal('pending');
      const fresh = await world.token((await world.rows('agent_thread', 'id', first.threadId))[0].profile_id as string);
      const data = { actionId: pending.id };
      const approved = accepted(await approve(world.rt, world.request(fresh, data), data));
      expect(approved.status).to.equal('done');
      expect(world.ran.map(entry => entry.event)).to.include('request-cancel');
    });

    it('step 1: an approval sent by another person is refused and leaves the action pending', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), says('Unused.') ]
      });
      const first = accepted(await say('Cancel it'));
      const [ action ] = await actionsOf(world, first.threadId);
      const intruder = await world.token(newPerson('intruder'));
      const data = { actionId: action.id };

      const result = refused(await approve(world.rt, world.request(intruder, data), data));
      expect(result).to.include({ code: 404, reason: 'not_found' });
      expect((await actionsOf(world, first.threadId))[0].status).to.equal('pending');
      expect(world.ran).to.deep.equal([]);
    });

    it('step 1: writing to someone else\'s thread is refused like a thread that does not exist', async () => {
      const { world, say } = await setup({ replies: [ says('Hi.'), says('Unused.') ] });
      const first = accepted(await say('Mine'));
      const intruder = await world.token(newPerson('intruder'));
      const data = { threadId: first.threadId, message: 'Let me in' };

      const result = refused(await runTurn(world.rt, world.request(intruder, data), data));
      const missing = { threadId: 'no-such-thread', message: 'Hi' };
      const absent = refused(await runTurn(world.rt, world.request(intruder, missing), missing));
      expect(result).to.deep.equal(absent);
      expect(result.code).to.equal(404);
      expect(await turnsOf(world, first.threadId)).to.have.length(2);
    });

    it('step 1: a thread listing and a thread load are for the owner only', async () => {
      const { world, token, profileId, say } = await setup({ replies: [ says('Hi.') ] });
      const first = accepted(await say('Mine'));
      const intruder = await world.token(newPerson('intruder'));

      const listed = await listThreads(world.rt, world.request(intruder), {});
      if (!listed.ok) throw new Error('refused');
      expect(listed.threads).to.deep.equal([]);
      const loaded = await loadThread(world.rt, world.request(intruder), { threadId: first.threadId });
      expect(loaded).to.include({ ok: false, code: 404 });
      expect(await listThreads(world.rt, world.request(null), {})).to.include({ ok: false, code: 401 });
      expect(await loadThread(world.rt, world.request(null), {})).to.include({ ok: false, code: 401 });
      expect(await loadThread(world.rt, world.request(token), {})).to.include({ ok: false, code: 400 });

      const mine = await listThreads(world.rt, world.request(token), { take: 5, skip: 'x' });
      if (!mine.ok) throw new Error('refused');
      expect(mine.threads.map(thread => thread.profileId)).to.deep.equal([ profileId ]);
    });
  });

  describe('J-010 attach a file', () => {
    it('step 2: carries file references on the turn and passes them to the tool unchanged', async () => {
      const { world, say } = await setup({
        replies: [
          asks([ 'c1', 'file_attach', { file: 'upload:7e2lig3iuej3' } ]),
          says('Attached.')
        ]
      });
      const result = accepted(await say('Attach this', {
        files: [ 'upload:7e2lig3iuej3', 'upload:second' ]
      }));

      //the model was told the references, and the tool received one unchanged
      const first = world.stub().requests[0].turns[0];
      if (first.role !== 'user') throw new Error('expected a user turn');
      expect(first.text).to.contain('upload:7e2lig3iuej3');
      expect(first.text).to.contain('upload:second');
      expect(world.ran[0].input).to.deep.equal({ file: 'upload:7e2lig3iuej3' });

      //only the references are stored
      const [ user ] = await turnsOf(world, result.threadId);
      expect(user.files).to.deep.equal([ 'upload:7e2lig3iuej3', 'upload:second' ]);
      expect(Object.keys(user).join(' ')).to.not.match(/content|data|blob/);
      const [ action ] = await actionsOf(world, result.threadId);
      expect(action.input).to.deep.equal({ file: 'upload:7e2lig3iuej3' });
    });

    it('step 2: refuses files that are not plain references', async () => {
      const { world, say } = await setup({ replies: [ says('Unused.') ] });
      for (const files of [
        'upload:one',
        [ 5 ],
        [ { name: 'a.pdf', content: 'JVBERi0=' } ],
        [ '' ],
        [ 'x'.repeat(501) ],
        Array.from({ length: 21 }, (_, i) => `upload:${i}`)
      ]) {
        expect(refused(await say('Attach', { files })).code).to.equal(400);
      }
      expect(world.stub()).to.equal(undefined);
    });
  });
});
