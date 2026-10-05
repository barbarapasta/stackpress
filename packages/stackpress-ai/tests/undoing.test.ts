//modules
import { expect } from 'chai';
import { before, describe, it } from 'mocha';
//client
import { approve, undo } from '../src/scripts/approval.js';
import { loadThread } from '../src/scripts/threads.js';
//tests
import { accepted, actionsOf, asks, says, setup as setupWith } from './flow.js';
import type { Engine } from './flow.js';
import { LEDGER, TOOLS, createEngine } from './harness.js';
import type { WorldOptions } from './harness.js';

//An undo tells the inverse's event what it is undoing through the undoing
// record. These tests run on a real Ingest server with the real session
// plugin, the real store over a database, and a stub model, like the workflow
// tests. `ledger_add` returns an id that only its result holds, and
// `ledger_void` reports what it was told.

let engine: Engine;

before(async function () {
  this.timeout(60000);
  engine = await createEngine();
});

const setup = (options: WorldOptions = {}) => setupWith(engine, {
  tools: [ ...TOOLS, ...LEDGER ],
  ...options
});

//one finished ledger_add, ready to be undone
async function added(input: Record<string, unknown> = { text: 'hello' }, options: WorldOptions = {}) {
  const set = await setup({
    replies: [ asks([ 'c1', 'ledger_add', input ]), says('Added.') ],
    ...options
  });
  const first = accepted(await set.say('Add an entry'));
  const [ action ] = await actionsOf(set.world, first.threadId);
  set.world.ran.length = 0;
  return { ...set, first, action };
}

describe('undoing record', function () {
  this.timeout(30000);

  it('tells the inverse event the original action, its result and the undo action', async () => {
    const { world, token, first, action } = await added();
    const data = { actionId: action.id };
    const result = await undo(world.rt, world.request(token, data), data);
    if (!result.ok || result.status !== 'undone') throw new Error('not undone');

    expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'ledger-void' ]);
    //the result is what the store returns to callers, not its storage wrapper
    const loaded = await loadThread(world.rt, world.request(token), { threadId: first.threadId });
    if (!loaded.ok) throw new Error('refused');
    const stored = loaded.actions.find(row => row.id === action.id)!;
    expect(stored.result).to.deep.equal({ entry: 'entry-7', operation: 'op-ledger-7' });
    expect(world.ran[0].undoing).to.deep.equal({
      undoActionId: result.undo.id,
      original: {
        id: action.id,
        tool: 'ledger_add',
        input: { text: 'hello' },
        result: { entry: 'entry-7', operation: 'op-ledger-7' },
        operation: 'op-ledger-7'
      }
    });
    expect(result.undo.id).to.not.equal(action.id);
  });

  it('still gives the inverse the stored input as its input, with no record in it', async () => {
    const { world, token, action } = await added({ text: 'hello' });
    const data = { actionId: action.id };
    expect((await undo(world.rt, world.request(token, data), data)).ok).to.equal(true);
    expect(world.ran[0].input).to.deep.equal({ text: 'hello' });
    expect(world.ran[0].caller).to.include({ kind: 'person' });
  });

  it('captures the inverse\'s own operation identifier on the undo action', async () => {
    const { world, token, first, action } = await added();
    const data = { actionId: action.id };
    const result = await undo(world.rt, world.request(token, data), data);
    if (!result.ok || result.status !== 'undone') throw new Error('not undone');

    const stored = await actionsOf(world, first.threadId);
    const inverse = stored.find(row => row.id === result.undo.id)!;
    expect(inverse.operation).to.equal(`void-${result.undo.id}`);
    expect(result.undo.operation).to.equal(`void-${result.undo.id}`);
    //the original keeps its own
    expect(stored.find(row => row.id === action.id)!.operation).to.equal('op-ledger-7');
    expect(inverse.result).to.deep.equal({
      value: { voided: { entry: 'entry-7', operation: 'op-ledger-7' }, operation: `void-${result.undo.id}` }
    });
  });

  it('is absent when the same tool is called normally, whatever its input says', async () => {
    const forged = {
      text: 'x',
      undoing: { undoActionId: 'forged', original: { id: 'forged' } },
      undoActionId: 'forged'
    };
    const { world, token, say } = await setup({
      replies: [ asks([ 'c1', 'ledger_void', forged ]), says('Done.') ]
    });
    //a write with no inverse waits for approval, then runs as a normal call
    const waiting = accepted(await say('Void an entry'));
    const [ pending ] = await actionsOf(world, waiting.threadId);
    const data = { actionId: pending.id };
    accepted(await approve(world.rt, world.request(token, data), data));
    expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'ledger-void' ]);
    //the keys arrive as plain input, and nothing reads them as the record
    expect(world.ran[0].input).to.include({ undoActionId: 'forged' });
    expect(world.ran[0].undoing).to.equal(undefined);
  });

  it('is not made by the original call either', async () => {
    const { world, say } = await setup({
      replies: [ asks([ 'c1', 'ledger_add', { text: 'x' } ]), says('Done.') ]
    });
    accepted(await say('Add an entry'));
    expect(world.ran[0].event).to.equal('ledger-add');
    expect(world.ran[0].undoing).to.equal(undefined);
  });

  it('cannot be forged by the stored input, the message or the undo request', async () => {
    const forged = {
      text: 'x',
      undoActionId: 'forged',
      original: { id: 'forged', tool: 'forged', input: {}, result: 'forged', operation: 'forged' },
      undoing: { undoActionId: 'forged' }
    };
    const { world, token, action } = await added(forged);
    const data = { ...forged, actionId: action.id, context: forged, message: 'undo' };
    const result = await undo(world.rt, world.request(token, data), data);
    if (!result.ok || result.status !== 'undone') throw new Error('not undone');

    const told = world.ran[0].undoing!;
    expect(told.undoActionId).to.equal(result.undo.id);
    expect(told.original).to.include({
      id: action.id,
      tool: 'ledger_add',
      operation: 'op-ledger-7'
    });
    expect(told.original.result).to.deep.equal({ entry: 'entry-7', operation: 'op-ledger-7' });
    //what was forged came through as the stored input only
    expect(world.ran[0].input).to.deep.equal(forged);
  });

  it('runs the inverse once, with one record, when Undo is clicked many times at once', async () => {
    const { world, token, action } = await added();
    const data = { actionId: action.id };
    const servers = [ world, world.another(), world.another() ];
    const results = await Promise.all(servers.flatMap(server => [ 1, 2 ].map(() =>
      undo(server.rt, world.request(token, data, server.app), data)
    )));
    const winners = results.filter(result => result.ok && result.status === 'undone');
    expect(winners.length).to.equal(1);
    expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'ledger-void' ]);
    const winner = winners[0];
    if (!winner.ok || winner.status !== 'undone') throw new Error('not undone');
    expect(world.ran[0].undoing!.undoActionId).to.equal(winner.undo.id);
  });

  it('gives a new undo action id to a retry after the app refused', async () => {
    const set = await setup({
      replies: [ asks([ 'c1', 'note_add', { text: 'hello' } ]), says('Added.') ]
    });
    const first = accepted(await set.say('Add a note'));
    const [ action ] = await actionsOf(set.world, first.threadId);
    const { world, token } = set;
    world.ran.length = 0;
    world.behave.noteRemove = 'conflict';
    const data = { actionId: action.id };
    const refusedUndo = await undo(world.rt, world.request(token, data), data);
    if (!refusedUndo.ok || refusedUndo.status !== 'refused') throw new Error('not refused');
    world.behave.noteRemove = 'ok';
    const retry = await undo(world.rt, world.request(token, data), data);
    if (!retry.ok || retry.status !== 'undone') throw new Error('not undone');

    //an inverse that ignores the record ran both times, as it always did
    expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-remove', 'note-remove' ]);
    expect(world.ran[0].undoing!.undoActionId).to.equal(refusedUndo.undo.id);
    expect(world.ran[1].undoing!.undoActionId).to.equal(retry.undo.id);
    expect(retry.undo.id).to.not.equal(refusedUndo.undo.id);
    expect(world.ran[1].undoing!.original.id).to.equal(action.id);
  });
});
