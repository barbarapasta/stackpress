//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import {
  addUser,
  applyEvent,
  cardStatus,
  dropLast,
  emptyConversation,
  fromThread,
  patchAction,
  resultLine,
  settle,
  syncActions,
  toolLabel
} from '../src/client/state.js';
import type {
  ActionItem,
  AgentEvent,
  Conversation
} from '../src/client/types.js';
//tests
import { stored, thread, turn } from './panel.js';

//The reducer: how what a run reports becomes the conversation on the page.

const run = (events: AgentEvent[], from = emptyConversation(), mode?: 'turn' | 'undo') => (
  events.reduce((conversation, event) => applyEvent(conversation, event, mode), from)
);
const cards = (conversation: Conversation) => (
  conversation.items.filter((item): item is ActionItem => item.kind === 'action')
);

describe('the conversation reducer', () => {
  describe('text', () => {
    it('grows one message in place as pieces arrive, and keeps the earlier items as they were', () => {
      let conversation = addUser(emptyConversation(), 'Hello');
      const user = conversation.items[0];
      conversation = applyEvent(conversation, { type: 'text', text: 'Hel' });
      const first = conversation.items[1];
      conversation = applyEvent(conversation, { type: 'text', text: 'lo, ' });
      conversation = applyEvent(conversation, { type: 'text', text: 'there' });
      expect(conversation.items).to.have.length(2);
      expect(conversation.items[0]).to.equal(user);
      expect(conversation.items[1]).to.include({
        kind: 'agent', text: 'Hello, there', streaming: true
      });
      //the message keeps its identity, so it keeps its place on the page
      expect(conversation.items[1].id).to.equal(first.id);
    });

    it('starts a new message after an action, and ends the one before it', () => {
      const conversation = run([
        { type: 'text', text: 'Working' },
        { type: 'action-start', actionId: 'a1', tool: 'note_add', input: {} },
        { type: 'text', text: 'Done' }
      ]);
      expect(conversation.items.map(item => item.kind)).to.deep.equal([
        'agent', 'action', 'agent'
      ]);
      expect(conversation.items[0]).to.include({ text: 'Working', streaming: false });
      expect(conversation.items[2]).to.include({ text: 'Done', streaming: true });
    });

    it('ignores an empty or malformed piece', () => {
      const before = emptyConversation();
      expect(applyEvent(before, { type: 'text', text: '' })).to.equal(before);
      expect(applyEvent(before, { type: 'text' } as never)).to.equal(before);
      expect(applyEvent(before, { type: 'surprise' } as never)).to.equal(before);
    });

    it('ends a message that was still arriving when the run finishes', () => {
      const conversation = run([
        { type: 'text', text: 'Hi' },
        { type: 'finished', status: 'done' }
      ]);
      expect(conversation.items[0]).to.include({ streaming: false });
      expect(conversation.ended).to.equal('done');
      expect(settle(conversation)).to.equal(conversation);
    });
  });

  describe('action cards', () => {
    it('follows a reversible action from running to done, with Undo only as the server said', () => {
      let conversation = run([
        { type: 'action-start', actionId: 'a1', tool: 'note_add', input: { text: 'hi' } }
      ]);
      expect(cards(conversation)[0]).to.include({
        status: 'running', tool: 'note_add', undoable: false
      });
      conversation = applyEvent(conversation, {
        type: 'action-done', actionId: 'a1', tool: 'note_add',
        input: { text: 'hi' }, result: { id: 'n1' }, undoable: true
      });
      expect(cards(conversation)).to.have.length(1);
      expect(cards(conversation)[0]).to.include({ status: 'done', undoable: true });
      expect(cards(conversation)[0].result).to.deep.equal({ id: 'n1' });
      expect(conversation.finished).to.equal(1);
    });

    it('shows no Undo when the server did not say the action can be undone', () => {
      const conversation = run([
        {
          type: 'action-done', actionId: 'a1', tool: 'note_remove',
          input: {}, result: null, undoable: false
        },
        {
          type: 'action-done', actionId: 'a2', tool: 'odd',
          input: {}, result: null
        } as never
      ]);
      expect(cards(conversation).map(card => card.undoable)).to.deep.equal([
        false, false
      ]);
    });

    it('waits for approval with the inputs and the expiry on the card', () => {
      const conversation = run([
        {
          type: 'action-waiting', actionId: 'a1', tool: 'note_remove',
          input: { id: 'c9' }, expires: '2026-10-05T11:00:00.000Z'
        }
      ]);
      expect(cards(conversation)[0]).to.include({
        status: 'waiting', expires: '2026-10-05T11:00:00.000Z'
      });
      expect(cards(conversation)[0].input).to.deep.equal({ id: 'c9' });
      expect(conversation.finished).to.equal(0);
    });

    it('moves a waiting card on when it is approved, declined, or fails', () => {
      const waiting: AgentEvent = {
        type: 'action-waiting', actionId: 'a1', tool: 'note_remove',
        input: { id: 'c9' }, expires: null
      };
      const approved = run([
        waiting,
        { type: 'action-start', actionId: 'a1', tool: 'note_remove', input: { id: 'c9' } },
        {
          type: 'action-done', actionId: 'a1', tool: 'note_remove',
          input: { id: 'c9' }, result: { removed: true }, undoable: false
        }
      ]);
      expect(cards(approved)).to.have.length(1);
      expect(cards(approved)[0]).to.include({ status: 'done', undoable: false });

      const declined = run([ waiting, {
        type: 'action-declined', actionId: 'a1', tool: 'note_remove'
      } ]);
      expect(cards(declined)[0]).to.include({ status: 'declined' });

      const failed = run([ waiting, {
        type: 'action-failed', actionId: 'a1', tool: 'note_remove',
        input: { id: 'c9' }, error: 'You may not change this.', code: 403
      } ]);
      expect(cards(failed)[0]).to.include({
        status: 'failed', error: 'You may not change this.', undoable: false
      });
    });

    it('marks the action undone, and keeps the actions of the inverse off the page', () => {
      const done = run([ {
        type: 'action-done', actionId: 'a1', tool: 'note_add',
        input: {}, result: null, undoable: true
      } ]);
      const undone = run([
        { type: 'action-start', actionId: 'a2', tool: 'note_remove', input: {} },
        {
          type: 'action-done', actionId: 'a2', tool: 'note_remove',
          input: {}, result: null, undoable: false
        },
        { type: 'action-undone', actionId: 'a1', tool: 'note_add', undoActionId: 'a2' }
      ], done, 'undo');
      expect(cards(undone)).to.have.length(1);
      expect(cards(undone)[0]).to.include({ id: 'a1', status: 'undone', undoable: false });
      //an undo does not count as another finished action in the run
      expect(undone.finished).to.equal(done.finished);
    });

    it('adds a card it has not seen in a run, which a continued turn does when it calls a new tool', () => {
      const conversation = run([ {
        type: 'action-start', actionId: 'b1', tool: 'note_add', input: {}
      } ], run([ {
        type: 'action-waiting', actionId: 'a1', tool: 'note_remove', input: {}, expires: null
      } ]));
      expect(cards(conversation).map(card => card.id)).to.deep.equal([ 'a1', 'b1' ]);
    });

    it('does nothing for a card report with no id', () => {
      const before = emptyConversation();
      expect(applyEvent(before, { type: 'action-start', tool: 'x', input: {} } as never)).to.equal(before);
    });

    it('patches one card, and nothing when it is not there', () => {
      const conversation = run([
        { type: 'action-start', actionId: 'a1', tool: 'note_add', input: {} }
      ]);
      expect(patchAction(conversation, 'a1', { busy: 'undo' }).items[0]).to.include({ busy: 'undo' });
      expect(patchAction(conversation, 'zz', { busy: 'undo' })).to.equal(conversation);
    });
  });

  describe('thread, usage and endings', () => {
    it('takes the thread, adds up usage, and remembers how the run ended', () => {
      const conversation = run([
        { type: 'thread', threadId: 't1', title: 'Add a note' },
        { type: 'usage', input: 20, output: 10 },
        { type: 'usage', input: 5, output: 5 },
        { type: 'error', status: 'limit', message: 'x', resetsAt: '2026-10-06T00:00:00.000Z' },
        { type: 'finished', status: 'limit' }
      ]);
      expect(conversation).to.include({
        threadId: 't1', title: 'Add a note', used: 40, ended: 'limit'
      });
      expect(conversation.failure).to.deep.equal({
        status: 'limit', resetsAt: '2026-10-06T00:00:00.000Z'
      });
    });

    it('adds what the person typed, with the names of attached files, and takes it back', () => {
      let conversation = addUser(emptyConversation(), 'See this', [ 'invoice.pdf' ]);
      expect(conversation.items[0]).to.deep.include({
        kind: 'user', text: 'See this', files: [ 'invoice.pdf' ]
      });
      conversation = dropLast(conversation);
      expect(conversation.items).to.deep.equal([]);
      //only the person's own words can be taken back
      const agent = run([ { type: 'text', text: 'Hi' } ]);
      expect(dropLast(agent).items).to.have.length(1);
    });
  });
});

describe('a stored thread as a conversation', () => {
  it('puts messages and cards back in the order they happened, and shows the right status on each', () => {
    const conversation = fromThread(thread(), [
      turn({ id: 'u1', text: 'Add a note and remove it' }),
      //a tool call turn has no text and does not show, but its cards do
      turn({ id: 'x1', role: 'assistant', text: null }),
      turn({ id: 'x3', role: 'assistant', text: 'Added. Now removing it.' }),
      turn({ id: 'x5', role: 'assistant', text: 'All done.' })
    ], [
      stored({ id: 'a2', turnId: 'x3', tool: 'note_remove', status: 'done', undoable: false }),
      stored({ id: 'a1', turnId: 'x1', status: 'undone', undoable: false }),
      //the inverse an undo ran is not a card of its own
      stored({ id: 'a3', turnId: 'x5', tool: 'note_remove', reverses: 'a1' })
    ]);
    expect(conversation.threadId).to.equal('t1');
    expect(conversation.title).to.equal('Add a note');
    expect(conversation.items.map(item => item.id)).to.deep.equal([
      'u1', 'a1', 'x3', 'a2', 'x5'
    ]);
    expect(cards(conversation).map(card => [ card.id, card.status ])).to.deep.equal([
      [ 'a1', 'undone' ], [ 'a2', 'done' ]
    ]);
  });

  it('does not depend on clocks: a card follows the turn that asked for it even when every time is the same, and one with no turn goes last', () => {
    const same = '2026-10-05T10:00:01.000Z';
    const conversation = fromThread(thread(), [
      turn({ id: 'm9', role: 'assistant', text: 'first', created: same }),
      turn({ id: 'm1', role: 'assistant', text: 'second', created: same })
    ], [
      stored({ id: 'z1', turnId: 'gone', created: same }),
      stored({ id: 'b1', turnId: 'm1', created: same }),
      stored({ id: 'b2', turnId: 'm9', created: same }),
      stored({ id: 'b3', turnId: 'm9', created: same })
    ]);
    expect(conversation.items.map(item => item.id)).to.deep.equal([
      'm9', 'b2', 'b3', 'm1', 'b1', 'z1'
    ]);
  });

  it('maps every stored status to a card status, and shows Undo only on a done action the server says can be undone', () => {
    expect([ 'pending', 'approved', 'declined', 'done', 'failed', 'undone', 'expired', 'mystery' ].map(cardStatus))
      .to.deep.equal([ 'waiting', 'running', 'declined', 'done', 'failed', 'undone', 'expired', 'failed' ]);
    const conversation = fromThread(thread(), [], [
      stored({ id: 'a1', status: 'done', undoable: true }),
      stored({ id: 'a2', status: 'pending', undoable: true, expires: '2026-10-05T11:00:00.000Z' }),
      stored({ id: 'a3', status: 'failed', error: 'Nope', undoable: true, result: null }),
      stored({ id: 'a4', status: 'done', undoable: false, input: 'not an object' })
    ]);
    const [ a1, a2, a3, a4 ] = cards(conversation);
    expect(a1.undoable).to.equal(true);
    expect(a2).to.include({ status: 'waiting', undoable: false, expires: '2026-10-05T11:00:00.000Z' });
    expect(a3).to.include({ status: 'failed', error: 'Nope', undoable: false });
    expect(a3).to.not.have.property('result');
    expect(a4.input).to.deep.equal({});
    expect(a4.undoable).to.equal(false);
  });

  it('keeps the file names the person attached', () => {
    const conversation = fromThread(thread(), [
      turn({ files: [ 'a.pdf' ] }), turn({ id: 'u2', files: [], created: '2026-10-05T10:00:09.000Z' })
    ], []);
    expect(conversation.items[0]).to.deep.include({ files: [ 'a.pdf' ] });
    expect(conversation.items[1]).to.not.have.property('files');
  });

  it('brings the cards in line with the server and leaves every message alone', () => {
    let conversation = run([
      { type: 'text', text: 'Hi' },
      {
        type: 'action-waiting', actionId: 'a1', tool: 'note_remove',
        input: {}, expires: null
      }
    ]);
    conversation = patchAction(conversation, 'a1', { busy: 'approve' });
    const message = conversation.items[0];
    const synced = syncActions(conversation, [
      stored({ id: 'a1', status: 'expired', undoable: false }),
      //an action the page never showed is not added
      stored({ id: 'a9' })
    ]);
    expect(synced.items[0]).to.equal(message);
    expect(cards(synced)).to.have.length(1);
    expect(cards(synced)[0]).to.include({ status: 'expired' });
    expect(cards(synced)[0].busy).to.equal(undefined);
  });
});

describe('words for tools and results', () => {
  it('reads a tool name as a person would', () => {
    expect(toolLabel('article_publish')).to.equal('Article publish');
    expect(toolLabel('comment-delete')).to.equal('Comment delete');
  });

  it('finds one line to say what a result is, and none when nothing fits', () => {
    expect(resultLine({ title: 'A post', id: 'x' })).to.equal('A post');
    expect(resultLine({ name: 'Ann' })).to.equal('Ann');
    expect(resultLine({ id: 7 })).to.equal('7');
    expect(resultLine('plain')).to.equal('plain');
    expect(resultLine({ title: 'x'.repeat(500) })).to.have.length(160);
    expect(resultLine({ removed: true })).to.equal(undefined);
    expect(resultLine(null)).to.equal(undefined);
    expect(resultLine(5)).to.equal(undefined);
  });
});
