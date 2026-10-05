//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import { STORAGE_KEY, chips, createPanel, wire } from '../src/client/controller.js';
import type {
  ActionItem,
  AgentEvent,
  PanelOptions,
  PanelState
} from '../src/client/types.js';
//tests
import {
  answer,
  events,
  gated,
  refusal,
  server,
  settle,
  start,
  storage,
  stored,
  thread,
  turn
} from './panel.js';

//The panel's controller, driven through a scripted server so each answer the
// routes can give is tried. The same journeys over the real routes are in
// `client-routes.test.ts`.

const THREAD = [ 'GET', '/agent/threads/t1' ].join(' ');
const TURN = 'POST /agent/turn';

//a run that does a reversible action, says so, then waits for approval
const waitingRun: AgentEvent[] = [
  { type: 'thread', threadId: 't1', title: 'Add a note' },
  { type: 'usage', input: 20, output: 10 },
  { type: 'action-start', actionId: 'a1', tool: 'note_add', input: { text: 'hi' } },
  {
    type: 'action-done', actionId: 'a1', tool: 'note_add',
    input: { text: 'hi' }, result: { id: 'n1' }, undoable: true
  },
  { type: 'text', text: 'Added. Now removing it.' },
  {
    type: 'action-waiting', actionId: 'a2', tool: 'note_remove',
    input: { id: 'n1' }, expires: '2026-10-05T11:00:00.000Z'
  },
  { type: 'finished', status: 'waiting' }
];

const textRun = (text: string): AgentEvent[] => [
  { type: 'thread', threadId: 't1', title: 'Hello' },
  { type: 'text', text },
  { type: 'finished', status: 'done' }
];

const cards = (state: PanelState) => state.conversation.items.filter(
  (item): item is ActionItem => item.kind === 'action'
);
const card = (state: PanelState, id: string) => cards(state).find(item => item.id === id)!;
const last = (state: PanelState) => state.conversation.items[state.conversation.items.length - 1];

//a panel, opened, over a server that answers the routes it is given
async function opened(
  routes: Parameters<typeof server>[0] = {},
  options: PanelOptions = {}
) {
  const fake = server({ 'GET /agent/start': start(), ...routes });
  const refreshed: boolean[] = [];
  const panel = createPanel({
    fetch: fake.fetch,
    storage: null,
    onRefresh: () => { refreshed.push(panel.getState().running); },
    ...options
  });
  await panel.open();
  return { panel, fake, refreshed, state: () => panel.getState() };
}

//a panel that has sent a message and is waiting for approval
async function waiting(extra: Parameters<typeof server>[0] = {}, options: PanelOptions = {}) {
  const made = await opened({ [TURN]: events(waitingRun), ...extra }, options);
  await made.panel.send('Add a note and remove it');
  return made;
}

describe('the panel controller', () => {
  describe('opening', () => {
    it('asks nothing of the server until it is opened, and only once', async () => {
      const fake = server({ 'GET /agent/start': start() });
      const panel = createPanel({ fetch: fake.fetch, storage: null });
      expect(fake.calls).to.have.length(0);
      expect(panel.getServerState().open).to.equal(false);
      expect(panel.getState().phase).to.equal('idle');
      await panel.open();
      await panel.open();
      await panel.toggle();
      await panel.toggle();
      expect(fake.count('GET', '/agent/start')).to.equal(1);
      expect(panel.getState()).to.deep.include({ open: true, phase: 'ready', model: 'big' });
      expect(panel.getState().models.map(model => model.model)).to.deep.equal([ 'big', 'small' ]);
      expect(panel.getState().usage).to.deep.include({ remaining: 1000 });
    });

    it('makes no request at all when the page says nobody is signed in', async () => {
      const fake = server({});
      const panel = createPanel({ fetch: fake.fetch, storage: null, signedIn: false });
      await panel.open();
      expect(panel.getState().phase).to.equal('signed-out');
      await panel.send('Hello');
      await panel.newChat();
      await panel.showHistory();
      expect(fake.calls).to.have.length(0);
    });

    it('shows the signed-out state when the server says so', async () => {
      const { state } = await opened({ 'GET /agent/start': refusal(401, 'unauthorized') });
      expect(state().phase).to.equal('signed-out');
    });

    it('shows the unavailable state when the agent is off, missing, or unreachable, and recovers on retry', async () => {
      for (const route of [
        refusal(503, 'unavailable'),
        new Response('<html>no</html>', { status: 404 }),
        refusal(500, 'unavailable')
      ]) {
        const { state } = await opened({ 'GET /agent/start': route });
        expect(state().phase).to.equal('unavailable');
      }
      let working = false;
      const { panel, state } = await opened({
        'GET /agent/start': () => (working ? start() : refusal(503, 'unavailable'))
      });
      expect(state().phase).to.equal('unavailable');
      working = true;
      await panel.retry();
      expect(state().phase).to.equal('ready');
    });

    it('shows the daily limit state, with when it resets, and sends nothing', async () => {
      const { panel, fake, state } = await opened({
        'GET /agent/start': start({
          usage: { used: 1000, limit: 1000, remaining: 0, resetsAt: '2026-10-06T00:00:00.000Z' }
        })
      });
      expect(state()).to.deep.include({ phase: 'limit', resetsAt: '2026-10-06T00:00:00.000Z' });
      await panel.send('Hello');
      expect(fake.count('POST', '/agent/turn')).to.equal(0);
    });
  });

  describe('sending a message', () => {
    it('sends the token, the model, the thread and the page context, and shows the streamed reply', async () => {
      const { panel, fake, state } = await opened(
        { [TURN]: events(textRun('Hi there')) },
        { url: '/articles/x', context: [ { type: 'article', id: 'x', label: 'An article' } ] }
      );
      panel.setDraft('Hello');
      await panel.send();
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body).to.deep.equal({
        message: 'Hello',
        model: 'big',
        csrf: 'token-1',
        context: {
          url: '/articles/x',
          items: [ { type: 'article', id: 'x', label: 'An article' } ]
        }
      });
      expect(state().draft).to.equal('');
      expect(state().running).to.equal(false);
      expect(state().conversation.threadId).to.equal('t1');
      expect(state().conversation.items.map(item => [ item.kind, (item as { text: string }).text ]))
        .to.deep.equal([ [ 'user', 'Hello' ], [ 'agent', 'Hi there' ] ]);
      expect(state().announce).to.deep.include({ code: 'replied' });
    });

    it('sends a follow-up on the same thread', async () => {
      const { panel, fake } = await opened({ [TURN]: events(textRun('Hi')) });
      await panel.send('One');
      await panel.send('Two');
      const bodies = fake.calls.filter(call => call.path === '/agent/turn').map(call => call.body);
      expect(bodies[0]).to.not.have.property('threadId');
      expect(bodies[1].threadId).to.equal('t1');
    });

    it('lets the reply arrive in pieces without rebuilding what was already there, and ends it when the run finishes', async () => {
      const feed = gated();
      const { panel, state } = await opened({ [TURN]: () => feed.response });
      const sending = panel.send('Hello');
      await settle();
      expect(state().running).to.equal(true);
      const user = state().conversation.items[0];
      feed.push({ type: 'text', text: 'Hel' });
      await settle();
      expect(last(state())).to.deep.include({ text: 'Hel', streaming: true });
      const reply = last(state());
      feed.push({ type: 'text', text: 'lo' });
      await settle();
      expect(last(state())).to.deep.include({ text: 'Hello', streaming: true });
      expect(last(state()).id).to.equal(reply.id);
      expect(state().conversation.items[0]).to.equal(user);
      feed.push({ type: 'finished', status: 'done' });
      feed.end();
      await sending;
      expect(last(state())).to.deep.include({ text: 'Hello', streaming: false });
      expect(state().running).to.equal(false);
    });

    it('tells a subscriber about each change, and stops when it unsubscribes', async () => {
      const { panel } = await opened({ [TURN]: events(textRun('Hi')) });
      let seen = 0;
      const stop = panel.subscribe(() => { seen++; });
      await panel.send('Hello');
      const during = seen;
      expect(during).to.be.greaterThan(2);
      stop();
      panel.setDraft('x');
      expect(seen).to.equal(during);
    });

    it('sends nothing for an empty message, twice, or while it is busy', async () => {
      const feed = gated();
      const { panel, fake } = await opened({ [TURN]: () => feed.response });
      await panel.send('   ');
      expect(fake.count('POST', '/agent/turn')).to.equal(0);
      const first = panel.send('One');
      const second = panel.send('One');
      await settle();
      expect(fake.count('POST', '/agent/turn')).to.equal(1);
      feed.push({ type: 'finished', status: 'done' });
      feed.end();
      await Promise.all([ first, second ]);
    });

    it('gives the person their words back when the message is refused, and says what to do', async () => {
      const cases: [ Response, string | undefined, string | undefined ][] = [
        [ refusal(403, 'csrf'), 'csrf', undefined ],
        [ refusal(400, 'invalid'), 'invalid', undefined ],
        [ refusal(404, 'not_found'), 'not-found', undefined ],
        [ refusal(409, 'conflict'), 'conflict', undefined ],
        [ refusal(409, 'busy'), 'busy', undefined ],
        [ new Response('<html/>', { status: 403 }), 'forbidden', undefined ],
        [ refusal(500, 'unavailable'), 'failed', undefined ],
        [ new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } }), 'failed', undefined ]
      ];
      for (const [ route, code ] of cases) {
        const { panel, state } = await opened({ [TURN]: route });
        panel.setDraft('Please help');
        await panel.send();
        expect(state().notice, code).to.deep.equal({ code });
        expect(state().draft).to.equal('Please help');
        expect(state().conversation.items).to.deep.equal([]);
        expect(state().running).to.equal(false);
        expect(state().phase).to.equal('ready');
        //the server's own words are nowhere in what the page holds
        expect(JSON.stringify(state())).to.not.include('raw server words');
      }
    });

    it('keeps the words and lets the person send them again when the chat is busy', async () => {
      let tries = 0;
      const { panel, state, fake } = await opened({
        [TURN]: () => ++tries === 1
          ? refusal(409, 'busy')
          : events(textRun('Hello back.'))
      });
      panel.setDraft('Please help');
      await panel.send();

      //busy is its own message, not the one for a request already handled
      expect(state().notice).to.deep.equal({ code: 'busy' });
      expect(state().draft).to.equal('Please help');
      expect(state().conversation.items).to.deep.equal([]);
      expect(state().running).to.equal(false);
      expect(state().phase).to.equal('ready');

      //the same words go again, and this time they are answered
      await panel.send();
      expect(fake.count('POST', '/agent/turn')).to.equal(2);
      expect(state().notice).to.equal(undefined);
      expect(state().draft).to.equal('');
      expect(state().conversation.items.map(item => item.kind))
        .to.deep.equal([ 'user', 'agent' ]);
    });

    it('moves to the daily limit state, with when it resets, when the message is refused for the limit', async () => {
      const { panel, state } = await opened({
        [TURN]: refusal(429, 'limit', { resetsAt: '2026-10-06T00:00:00.000Z' })
      });
      await panel.send('Hello');
      expect(state()).to.deep.include({
        phase: 'limit', resetsAt: '2026-10-06T00:00:00.000Z', draft: 'Hello'
      });
      expect(state().conversation.items).to.deep.equal([]);
    });

    it('moves to the signed-out state when the sign in has ended, and to unavailable when the agent has no key', async () => {
      const out = await opened({ [TURN]: refusal(401, 'unauthorized') });
      await out.panel.send('Hello');
      expect(out.state().phase).to.equal('signed-out');
      const off = await opened({ [TURN]: refusal(503, 'unavailable') });
      await off.panel.send('Hello');
      expect(off.state().phase).to.equal('unavailable');
    });

    it('says the network is down, and keeps what was typed', async () => {
      const down = server({ 'GET /agent/start': start() });
      const panel = createPanel({
        storage: null,
        fetch: (input, init) => (
          init?.method === 'POST'
            ? Promise.reject(new TypeError('fetch failed'))
            : down.fetch(input, init)
        )
      });
      await panel.open();
      await panel.send('Hello');
      expect(panel.getState().notice).to.deep.equal({ code: 'network' });
      expect(panel.getState().draft).to.equal('Hello');
    });

    it('lets a person dismiss a message, and clears it on the next send', async () => {
      const { panel, state } = await opened({ [TURN]: refusal(400, 'invalid') });
      await panel.send('Hello');
      expect(state().notice).to.not.equal(undefined);
      panel.dismiss();
      expect(state().notice).to.equal(undefined);
    });

    it('reports how a run that ended badly ended', async () => {
      for (const [ status, code ] of [
        [ 'steps', 'steps' ], [ 'length', 'length' ], [ 'refusal', 'refusal' ],
        [ 'busy', 'busy' ], [ 'failed', 'failed' ]
      ] as const) {
        const { panel, state } = await opened({
          [TURN]: events([ { type: 'finished', status } ])
        });
        await panel.send('Hello');
        expect(state().notice, status).to.deep.equal({ code });
      }
      const limit = await opened({
        [TURN]: events([
          { type: 'error', status: 'limit', message: 'x', resetsAt: '2026-10-06T00:00:00.000Z' },
          { type: 'finished', status: 'limit' }
        ])
      });
      await limit.panel.send('Hello');
      expect(limit.state()).to.deep.include({
        phase: 'limit', resetsAt: '2026-10-06T00:00:00.000Z'
      });
      const off = await opened({ [TURN]: events([ { type: 'finished', status: 'unavailable' } ]) });
      await off.panel.send('Hello');
      expect(off.state().phase).to.equal('unavailable');
    });

    it('loads what the server stored when the stream breaks before the end, and says so', async () => {
      const { panel, state } = await opened({
        [TURN]: events([
          { type: 'thread', threadId: 't1', title: 'Hello' },
          { type: 'text', text: 'Half a rep' }
        ], { fail: true }),
        [THREAD]: answer({
          ok: true,
          thread: thread(),
          turns: [ turn(), turn({ id: 'x2', role: 'assistant', text: 'The whole reply', created: '2026-10-05T10:00:02.000Z' }) ],
          actions: []
        })
      });
      await panel.send('Hello');
      expect(state().notice).to.deep.equal({ code: 'interrupted' });
      expect(state().conversation.items.map(item => (item as { text: string }).text))
        .to.deep.equal([ 'Add a note', 'The whole reply' ]);
      expect(state().running).to.equal(false);
    });

    it('keeps the allowance honest as the run reports usage', async () => {
      const { panel, state } = await opened({ [TURN]: events(waitingRun) });
      await panel.send('Hello');
      expect(state().usage).to.deep.include({ used: 30, remaining: 970 });
    });

    it('works against a server that answers once instead of streaming', async () => {
      const { panel, state } = await opened({
        [TURN]: answer({ ok: true, threadId: 't1', status: 'done', events: textRun('Hi there') })
      }, { stream: false });
      await panel.send('Hello');
      expect(last(state())).to.deep.include({ text: 'Hi there', streaming: false });
      expect(state().conversation.threadId).to.equal('t1');
    });
  });

  describe('action cards', () => {
    it('shows a reversible action done with Undo, and an irreversible one waiting with its inputs, and focuses the waiting card', async () => {
      const { state } = await waiting();
      expect(cards(state()).map(item => [ item.id, item.status, item.undoable ])).to.deep.equal([
        [ 'a1', 'done', true ], [ 'a2', 'waiting', false ]
      ]);
      expect(card(state(), 'a2').input).to.deep.equal({ id: 'n1' });
      expect(card(state(), 'a2').expires).to.equal('2026-10-05T11:00:00.000Z');
      expect(state().focus).to.deep.include({ id: 'a2' });
      expect(state().announce).to.deep.include({ code: 'waiting', tool: 'note_remove' });
      expect(state().running).to.equal(false);
    });

    it('approves: the card finishes, with no Undo, and the reply goes on', async () => {
      const { panel, fake, state } = await waiting({
        'POST /agent/actions/a2/approve': events([
          { type: 'action-start', actionId: 'a2', tool: 'note_remove', input: { id: 'n1' } },
          {
            type: 'action-done', actionId: 'a2', tool: 'note_remove',
            input: { id: 'n1' }, result: { removed: true }, undoable: false
          },
          { type: 'text', text: 'All done.' },
          { type: 'finished', status: 'done' }
        ])
      });
      await panel.approve('a2');
      expect(card(state(), 'a2')).to.include({ status: 'done', undoable: false });
      expect(card(state(), 'a2').busy).to.equal(undefined);
      expect(last(state())).to.deep.include({ kind: 'agent', text: 'All done.' });
      expect(fake.calls.find(call => call.path.endsWith('/approve'))!.body).to.deep.equal({ csrf: 'token-1' });
      expect(state().focus).to.deep.include({ id: 'a2' });
      expect(state().running).to.equal(false);
    });

    it('declines: the card says declined, and the reply goes on with no action', async () => {
      const { panel, state } = await waiting({
        'POST /agent/actions/a2/decline': events([
          { type: 'action-declined', actionId: 'a2', tool: 'note_remove' },
          { type: 'text', text: 'Understood.' },
          { type: 'finished', status: 'done' }
        ])
      });
      await panel.decline('a2');
      expect(card(state(), 'a2').status).to.equal('declined');
      expect(last(state())).to.deep.include({ text: 'Understood.' });
      expect(state().announce).to.deep.include({ code: 'declined' });
    });

    it('leaves the card waiting, with the busy message, when the chat is busy, and approves on a retry', async () => {
      let tries = 0;
      const { panel, state, fake } = await waiting({
        'POST /agent/actions/a2/approve': () => ++tries === 1
          ? refusal(409, 'busy')
          : events([
            { type: 'action-done', actionId: 'a2', tool: 'note_remove', input: { id: 'n1' }, result: {} },
            { type: 'finished', status: 'done' }
          ])
      });
      await panel.approve('a2');

      //the action did not run, so it can still be answered
      expect(card(state(), 'a2')).to.deep.include({ status: 'waiting', busy: undefined });
      expect(state().notice).to.deep.equal({ code: 'busy' });
      expect(state().running).to.equal(false);

      await panel.approve('a2');
      expect(fake.count('POST', '/agent/actions/a2/approve')).to.equal(2);
      expect(card(state(), 'a2').status).to.equal('done');
    });

    it('sends one request however many times Approve, Decline or Undo is clicked', async () => {
      const feed = gated();
      const { panel, fake, state } = await waiting({
        'POST /agent/actions/a2/approve': () => feed.response,
        'POST /agent/actions/a2/decline': events([ { type: 'finished', status: 'done' } ]),
        'POST /agent/actions/a1/undo': answer({ ok: true, status: 'undone', events: [] })
      });
      const first = panel.approve('a2');
      expect(card(state(), 'a2').busy).to.equal('approve');
      const again = [ panel.approve('a2'), panel.decline('a2'), panel.undo('a1') ];
      await settle();
      expect(fake.count('POST', '/agent/actions/a2/approve')).to.equal(1);
      expect(fake.count('POST', '/agent/actions/a2/decline')).to.equal(0);
      expect(fake.count('POST', '/agent/actions/a1/undo')).to.equal(0);
      feed.push({ type: 'finished', status: 'done' });
      feed.end();
      await Promise.all([ first, ...again ]);

      //an undo clicked twice runs once as well
      const undone = await opened({
        [TURN]: events(waitingRun),
        'POST /agent/actions/a1/undo': async () => {
          await settle();
          return answer({ ok: true, status: 'undone', events: [] });
        }
      });
      await undone.panel.send('Go');
      await Promise.all([ undone.panel.undo('a1'), undone.panel.undo('a1') ]);
      expect(undone.fake.count('POST', '/agent/actions/a1/undo')).to.equal(1);
    });

    it('only approves or declines what is waiting, and only undoes what the server said can be undone', async () => {
      const { panel, fake } = await waiting();
      await panel.approve('a1');
      await panel.decline('a1');
      await panel.undo('a2');
      await panel.approve('nothing');
      expect(fake.calls.filter(call => call.method === 'POST' && call.path !== '/agent/turn')).to.deep.equal([]);
    });

    it('shows a refused approval as a message, frees the card, and decides nothing itself', async () => {
      for (const [ route, code ] of [
        [ refusal(404, 'not_found'), 'not-found' ],
        [ refusal(403, 'csrf'), 'csrf' ],
        [ refusal(500, 'unavailable'), 'failed' ]
      ] as [ Response, string ][]) {
        const { panel, state } = await waiting({ 'POST /agent/actions/a2/approve': route });
        await panel.approve('a2');
        expect(state().notice).to.deep.equal({ code });
        expect(card(state(), 'a2')).to.include({ status: 'waiting' });
        expect(card(state(), 'a2').busy).to.equal(undefined);
        expect(state().running).to.equal(false);
      }
      const out = await waiting({ 'POST /agent/actions/a2/approve': refusal(401, 'unauthorized') });
      await out.panel.approve('a2');
      expect(out.state().phase).to.equal('signed-out');
      //the pending card is still on the page for when the owner signs in
      expect(card(out.state(), 'a2').status).to.equal('waiting');
    });

    it('shows where the card stands when the approval finds it already answered', async () => {
      const { panel, state } = await waiting({
        'POST /agent/actions/a2/approve': events([ { type: 'finished', status: 'settled' } ]),
        [THREAD]: answer({
          ok: true, thread: thread(), turns: [],
          actions: [
            stored({ id: 'a1', undoable: true }),
            stored({ id: 'a2', tool: 'note_remove', status: 'done', undoable: false })
          ]
        })
      });
      await panel.approve('a2');
      expect(state().notice).to.deep.equal({ code: 'settled' });
      expect(card(state(), 'a2').status).to.equal('done');
    });

    it('lets the server say a waiting card expired when the person sends a new message', async () => {
      const { panel, state } = await waiting({
        [THREAD]: answer({
          ok: true, thread: thread(), turns: [],
          actions: [
            stored({ id: 'a1', undoable: true }),
            stored({ id: 'a2', tool: 'note_remove', status: 'expired', undoable: false })
          ]
        })
      });
      //it does not guess: until the server says so the card still waits
      expect(card(state(), 'a2').status).to.equal('waiting');
      await panel.send('Never mind');
      expect(card(state(), 'a2').status).to.equal('expired');
    });
  });

  describe('undo', () => {
    it('undoes a finished action: the card says undone and the page is refreshed', async () => {
      const { panel, fake, state, refreshed } = await waiting({
        'POST /agent/actions/a1/undo': answer({ ok: true, status: 'undone', events: [] })
      });
      refreshed.length = 0;
      await panel.undo('a1');
      expect(card(state(), 'a1')).to.include({ status: 'undone', undoable: false });
      expect(card(state(), 'a1').busy).to.equal(undefined);
      expect(fake.calls.find(call => call.path.endsWith('/undo'))!.body).to.deep.equal({ csrf: 'token-1' });
      expect(fake.calls.find(call => call.path.endsWith('/undo'))!.headers.Accept).to.equal('application/json');
      expect(refreshed).to.have.length(1);
      expect(state().announce).to.deep.include({ code: 'undone', tool: 'note_add' });
      expect(state().focus).to.deep.include({ id: 'a1' });
    });

    it('shows the reason when the app will not undo it, and leaves the card as it was', async () => {
      const { panel, state, refreshed } = await waiting({
        'POST /agent/actions/a1/undo': answer({
          ok: true, status: 'refused', error: 'The note changed since.', events: []
        })
      });
      refreshed.length = 0;
      await panel.undo('a1');
      expect(card(state(), 'a1')).to.include({
        status: 'done', undoable: true, undoError: 'The note changed since.'
      });
      expect(refreshed).to.have.length(0);
      expect(state().announce).to.deep.include({ code: 'undo-refused' });
    });

    it('shows a plain message when the undo is refused outright', async () => {
      const { panel, state } = await waiting({
        'POST /agent/actions/a1/undo': refusal(403, 'csrf')
      });
      await panel.undo('a1');
      expect(state().notice).to.deep.equal({ code: 'csrf' });
      expect(card(state(), 'a1').status).to.equal('done');
    });

    it('reads what the server settled when the undo finds nothing to do', async () => {
      const { panel, state } = await waiting({
        'POST /agent/actions/a1/undo': answer({ ok: true, status: 'settled', events: [] }),
        [THREAD]: answer({
          ok: true, thread: thread(), turns: [],
          actions: [ stored({ id: 'a1', status: 'undone', undoable: false }) ]
        })
      });
      await panel.undo('a1');
      expect(state().notice).to.deep.equal({ code: 'settled' });
      expect(card(state(), 'a1').status).to.equal('undone');
    });
  });

  describe('refreshing the page', () => {
    it('refreshes once, after the run has ended, when an action finished', async () => {
      const { panel, refreshed } = await opened({ [TURN]: events(waitingRun) });
      await panel.send('Go');
      expect(refreshed).to.deep.equal([ false ]);
    });

    it('does not refresh for a reply that changed nothing', async () => {
      const { panel, refreshed } = await opened({ [TURN]: events(textRun('Hi')) });
      await panel.send('Go');
      expect(refreshed).to.deep.equal([]);
    });

    it('refreshes after an approval finishes the action', async () => {
      const { panel, refreshed } = await waiting({
        'POST /agent/actions/a2/approve': events([
          {
            type: 'action-done', actionId: 'a2', tool: 'note_remove',
            input: {}, result: null, undoable: false
          },
          { type: 'finished', status: 'done' }
        ])
      });
      refreshed.length = 0;
      await panel.approve('a2');
      expect(refreshed).to.deep.equal([ false ]);
    });

    it('does not refresh when the action was declined or failed', async () => {
      const { panel, refreshed } = await waiting({
        'POST /agent/actions/a2/decline': events([
          { type: 'action-declined', actionId: 'a2', tool: 'note_remove' },
          { type: 'finished', status: 'done' }
        ])
      });
      refreshed.length = 0;
      await panel.decline('a2');
      expect(refreshed).to.deep.equal([]);
    });

    it('survives a page that cannot refresh itself', async () => {
      const { panel, state } = await opened({ [TURN]: events(waitingRun) }, {
        onRefresh: () => { throw new Error('nope'); }
      });
      await panel.send('Go');
      expect(state().running).to.equal(false);
    });

    it('reloads the page by default, and does nothing outside a browser', async () => {
      const made = await opened({ [TURN]: events(waitingRun) }, { onRefresh: undefined });
      await made.panel.send('Go');
      let reloads = 0;
      (globalThis as any).window = { location: { reload: () => { reloads++; }, pathname: '/', search: '' } };
      try {
        const again = await opened({ [TURN]: events(waitingRun) }, { onRefresh: undefined });
        await again.panel.send('Go');
      } finally {
        delete (globalThis as any).window;
      }
      expect(reloads).to.equal(1);
    });
  });

  describe('context chips', () => {
    const page = { url: '/articles/x', context: [ { type: 'article', id: 'x', label: 'An article' }, 'a plain string', { type: 'comment', id: 'c1' } ] };

    it('shows the page address and what the page declared, named as a person would', async () => {
      const { state } = await opened({}, page);
      expect(chips(state()).map(chip => chip.label)).to.deep.equal([
        '/articles/x', 'An article', 'a plain string', 'comment c1'
      ]);
      expect(new Set(chips(state()).map(chip => chip.key)).size).to.equal(4);
    });

    it('does not send a chip that was removed', async () => {
      const { panel, fake, state } = await opened({ [TURN]: events(textRun('Hi')) }, page);
      const [ , article ] = chips(state());
      panel.removeContext(article.key);
      panel.removeContext(article.key);
      expect(chips(state()).map(chip => chip.label)).to.deep.equal([
        '/articles/x', 'a plain string', 'comment c1'
      ]);
      await panel.send('Hello');
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body.context).to.deep.equal({
        url: '/articles/x', items: [ 'a plain string', { type: 'comment', id: 'c1' } ]
      });
    });

    it('sends no page address when that chip was removed, and no context at all when every chip was', async () => {
      const { panel, fake, state } = await opened({ [TURN]: events(textRun('Hi')) }, page);
      for (const chip of chips(state())) panel.removeContext(chip.key);
      expect(chips(state())).to.deep.equal([]);
      await panel.send('Hello');
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body).to.not.have.property('context');

      const some = await opened({ [TURN]: events(textRun('Hi')) }, page);
      some.panel.removeContext('url');
      await some.panel.send('Hello');
      const sent = some.fake.calls.find(call => call.path === '/agent/turn')!.body.context;
      expect(sent).to.not.have.property('url');
      expect(sent.items).to.have.length(3);
    });

    it('follows what the page says now, and offers removed chips again on a new chat', async () => {
      const { panel, state } = await opened({
        'POST /agent/threads': answer({ ok: true, thread: thread({ id: 't2' }), reused: false })
      }, page);
      panel.removeContext('url');
      panel.setContext('/articles/y', [ 'another' ]);
      expect(chips(state()).map(chip => chip.label)).to.deep.equal([ 'another' ]);
      panel.setContext('/articles/y', [ 'another' ]);
      panel.setContext(undefined, [ 'another', 'more' ]);
      await panel.newChat();
      expect(chips(state()).map(chip => chip.label)).to.deep.equal([ '/articles/y', 'another', 'more' ]);
    });

    it('shows one chip for items that are the same thing, and removes them together', async () => {
      const { panel, state } = await opened({}, { context: [ 'same', 'same', 'other' ] });
      expect(chips(state()).map(chip => chip.label)).to.deep.equal([ 'same', 'other' ]);
      panel.removeContext(chips(state())[0].key);
      expect(chips(state()).map(chip => chip.label)).to.deep.equal([ 'other' ]);
      expect(wire(state())).to.deep.equal({ items: [ 'other' ] });
    });

    it('keeps a removed chip off the bar across a reload of the same page, and not on another page', async () => {
      const memory = storage();
      const first = createPanel({
        fetch: server({ 'GET /agent/start': start() }).fetch, storage: memory,
        url: '/articles/x', context: [ 'one', 'two' ]
      });
      await first.mount();
      await first.open();
      first.removeContext('item:two');
      const same = createPanel({
        fetch: server({ 'GET /agent/start': start() }).fetch, storage: memory,
        url: '/articles/x', context: [ 'one', 'two' ]
      });
      await same.mount();
      expect(chips(same.getState()).map(chip => chip.label)).to.deep.equal([ '/articles/x', 'one' ]);
      const elsewhere = createPanel({
        fetch: server({ 'GET /agent/start': start() }).fetch, storage: memory,
        url: '/articles/y', context: [ 'one', 'two' ]
      });
      await elsewhere.mount();
      expect(chips(elsewhere.getState()).map(chip => chip.label)).to.deep.equal([ '/articles/y', 'one', 'two' ]);
      //what is kept that is not a list of keys is ignored
      memory.setItem(STORAGE_KEY, JSON.stringify({ removed: [ 5, 'item:one' ], page: '/z' }));
      const odd = createPanel({ fetch: server({}).fetch, storage: memory, url: '/z', context: [ 'one', 'two' ] });
      await odd.mount();
      expect(odd.getState().removed).to.deep.equal([ 'item:one' ]);
    });

    it('builds the wire form without touching what was given', () => {
      const state = { url: '/x', context: [ 'a', 'b' ], removed: [ 'item:b' ] };
      expect(wire(state)).to.deep.equal({ url: '/x', items: [ 'a' ] });
      expect(wire({ ...state, url: undefined, context: [] })).to.equal(undefined);
    });
  });

  describe('history and new chat', () => {
    it('lists earlier chats, and opens one with its messages and cards', async () => {
      const { panel, state } = await opened({
        'GET /agent/threads': answer({ ok: true, threads: [ thread(), thread({ id: 't9', title: 'Older' }) ] }),
        [THREAD]: answer({
          ok: true,
          thread: thread({ model: 'small' }),
          turns: [
            turn(),
            turn({ id: 'x1', role: 'assistant', text: null, created: '2026-10-05T10:00:01.000Z' }),
            turn({ id: 'x2', role: 'assistant', text: 'Added.', created: '2026-10-05T10:00:02.000Z' })
          ],
          actions: [ stored({ turnId: 'x1' }) ]
        })
      });
      await panel.showHistory();
      expect(state()).to.deep.include({ view: 'history' });
      expect(state().threads.status).to.equal('ready');
      expect(state().threads.rows.map(row => row.title)).to.deep.equal([ 'Add a note', 'Older' ]);
      await panel.openThread('t1');
      expect(state().view).to.equal('chat');
      expect(state().conversation.items.map(item => item.id)).to.deep.equal([ 'u1', 'a1', 'x2' ]);
      expect(card(state(), 'a1')).to.include({ status: 'done', undoable: true });
      //the model the chat used is picked again when it is still offered
      expect(state().model).to.equal('small');
    });

    it('keeps the model on one no longer offered, and says so when a chat cannot be opened', async () => {
      const { panel, state } = await opened({
        [THREAD]: answer({ ok: true, thread: thread({ model: 'gone' }), turns: [], actions: [] }),
        'GET /agent/threads/lost': refusal(404, 'not_found')
      });
      await panel.openThread('t1');
      expect(state().model).to.equal('big');
      await panel.openThread('lost');
      expect(state().notice).to.deep.equal({ code: 'not-found' });
    });

    it('goes back to the chat, and says when history cannot be loaded', async () => {
      const { panel, state } = await opened({ 'GET /agent/threads': refusal(500, 'unavailable') });
      await panel.showHistory();
      expect(state().threads.status).to.equal('error');
      panel.showChat();
      expect(state().view).to.equal('chat');
      const out = await opened({ 'GET /agent/threads': refusal(401, 'unauthorized') });
      await out.panel.showHistory();
      expect(out.state().phase).to.equal('signed-out');
    });

    it('lets history be read at the daily limit, but not before the agent is ready', async () => {
      const limited = await opened({
        'GET /agent/start': start({ usage: { used: 5, limit: 5, remaining: 0 } }),
        'GET /agent/threads': answer({ ok: true, threads: [ thread() ] })
      });
      await limited.panel.showHistory();
      expect(limited.state().threads.rows).to.have.length(1);
      const idle = createPanel({ fetch: server({}).fetch, storage: null });
      await idle.showHistory();
      expect(idle.getState().view).to.equal('chat');
    });

    it('starts a new chat with the page context, and sends the next message on it', async () => {
      const { panel, fake, state } = await opened({
        [TURN]: events(textRun('Hi')),
        'POST /agent/threads': answer({ ok: true, thread: thread({ id: 't7' }), reused: false })
      }, { url: '/articles/x' });
      await panel.send('First');
      await panel.newChat();
      expect(state().conversation.items).to.deep.equal([]);
      expect(state().conversation.threadId).to.equal('t7');
      expect(fake.calls.find(call => call.path === '/agent/threads')!.body).to.deep.equal({
        context: { url: '/articles/x' }, csrf: 'token-1'
      });
      await panel.send('Second');
      const bodies = fake.calls.filter(call => call.path === '/agent/turn').map(call => call.body);
      expect(bodies[1].threadId).to.equal('t7');
    });

    it('starts only one new chat for a double click, and stops a reply that was still coming', async () => {
      const feed = gated();
      const { panel, fake, state } = await opened({
        [TURN]: call => feed.abortable(call.signal),
        'POST /agent/threads': answer({ ok: true, thread: thread({ id: 't7' }), reused: true })
      });
      const sending = panel.send('Hello');
      await settle();
      await Promise.all([ panel.newChat(), panel.newChat() ]);
      expect(fake.count('POST', '/agent/threads')).to.equal(1);
      expect(state().running).to.equal(false);
      expect(state().conversation.threadId).to.equal('t7');
      await sending;
      //what the old reply was still saying does not land in the new chat
      expect(state().conversation.items).to.deep.equal([]);
    });

    it('says why a new chat could not be started', async () => {
      const { panel, state } = await opened({ 'POST /agent/threads': refusal(403, 'csrf') });
      await panel.newChat();
      expect(state().notice).to.deep.equal({ code: 'csrf' });
      expect(state().conversation.items).to.deep.equal([]);
    });
  });

  describe('the model picker', () => {
    it('sends the model the person picked, and ignores one that is not offered', async () => {
      const { panel, fake, state } = await opened({ [TURN]: events(textRun('Hi')) });
      panel.setModel('small');
      panel.setModel('made-up');
      expect(state().model).to.equal('small');
      await panel.send('Hello');
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body.model).to.equal('small');
    });
  });

  describe('file attach', () => {
    const file = (name: string) => ({ name } as unknown as File);

    it('keeps the reference the app gave, shows its name, sends only the reference, and uploads nothing itself', async () => {
      const handed: unknown[] = [];
      const { panel, fake, state } = await opened({ [TURN]: events(textRun('Hi')) }, {
        upload: async given => { handed.push(given); return `stored/${given.name}`; }
      });
      await panel.attach(file('invoice.pdf'));
      await panel.attach({ name: 'photo.png' } as File);
      expect(handed).to.have.length(2);
      expect(state().files).to.deep.equal([
        { ref: 'stored/invoice.pdf', name: 'invoice.pdf' },
        { ref: 'stored/photo.png', name: 'photo.png' }
      ]);
      panel.removeFile('stored/photo.png');
      await panel.send('Attach it');
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body.files).to.deep.equal([ 'stored/invoice.pdf' ]);
      expect(state().files).to.deep.equal([]);
      expect(state().conversation.items[0]).to.deep.include({ files: [ 'invoice.pdf' ] });
      //nothing but the chat routes was ever called
      expect(fake.paths().every(path => path.includes(' /agent/'))).to.equal(true);
    });

    it('takes a reference with a display name, and the same reference only once', async () => {
      const { panel, state } = await opened({}, {
        upload: async () => ({ ref: 'files/1', name: 'Quarterly report' })
      });
      await panel.attach(file('x'));
      await panel.attach(file('x'));
      expect(state().files).to.deep.equal([ { ref: 'files/1', name: 'Quarterly report' } ]);
    });

    it('does nothing without an upload handler', async () => {
      const { panel, state } = await opened();
      await panel.attach(file('x'));
      expect(state().files).to.deep.equal([]);
      expect(state().uploading).to.equal(false);
    });

    it('says so when the handler fails or answers with something that is not a reference', async () => {
      for (const upload of [
        async () => { throw new Error('disk full'); },
        async () => '',
        async () => 'x'.repeat(501),
        async () => ({ name: 'no ref' } as never)
      ]) {
        const { panel, state } = await opened({}, { upload });
        await panel.attach(file('x'));
        expect(state().notice).to.deep.equal({ code: 'attach-failed' });
        expect(state().files).to.deep.equal([]);
        expect(state().uploading).to.equal(false);
      }
    });

    it('allows no more than twenty references on one message, and one upload at a time', async () => {
      let n = 0;
      const { panel, state } = await opened({}, { upload: async () => `ref/${n++}` });
      for (let index = 0; index < 20; index++) await panel.attach(file('x'));
      expect(state().files).to.have.length(20);
      await panel.attach(file('x'));
      expect(state().notice).to.deep.equal({ code: 'attach-limit' });
      expect(n).to.equal(20);

      let calls = 0;
      const slow = await opened({}, { upload: async () => { calls++; await settle(); return 'ref/1'; } });
      await Promise.all([ slow.panel.attach(file('x')), slow.panel.attach(file('y')) ]);
      expect(calls).to.equal(1);
    });

    it('gives a refused message its files back', async () => {
      const { panel, state } = await opened({ [TURN]: refusal(400, 'invalid') }, {
        upload: async () => 'ref/1'
      });
      await panel.attach(file('a.pdf'));
      await panel.send('Please');
      expect(state().files).to.deep.equal([ { ref: 'ref/1', name: 'a.pdf' } ]);
      expect(state().draft).to.equal('Please');
    });
  });

  describe('keeping its place across a reload', () => {
    it('opens again, loads the same thread and brings back the draft', async () => {
      const memory = storage({
        [STORAGE_KEY]: JSON.stringify({ open: true, threadId: 't1', draft: 'half a thought' })
      });
      const fake = server({
        'GET /agent/start': start(),
        [THREAD]: answer({
          ok: true, thread: thread(),
          turns: [ turn() ],
          actions: [ stored({ id: 'a2', tool: 'note_remove', status: 'pending', undoable: false, expires: '2026-10-05T11:00:00.000Z' }) ]
        })
      });
      const panel = createPanel({ fetch: fake.fetch, storage: memory, url: '/x' });
      await panel.mount();
      const state = panel.getState();
      expect(state).to.deep.include({ open: true, phase: 'ready', draft: 'half a thought' });
      expect(state.conversation.threadId).to.equal('t1');
      //a card still waiting for the person is where focus goes
      expect(state.focus).to.deep.include({ id: 'a2' });
      expect(JSON.parse(memory.data[STORAGE_KEY])).to.deep.equal({
        open: true, threadId: 't1', draft: 'half a thought'
      });
    });

    it('stays closed, and does not lose the thread it remembers, until it is opened', async () => {
      const memory = storage({ [STORAGE_KEY]: JSON.stringify({ open: false, threadId: 't1', draft: '' }) });
      const fake = server({
        'GET /agent/start': start(),
        [THREAD]: answer({ ok: true, thread: thread(), turns: [ turn() ], actions: [] })
      });
      const panel = createPanel({ fetch: fake.fetch, storage: memory, url: '/x' });
      await panel.mount();
      expect(panel.getState().open).to.equal(false);
      expect(fake.calls).to.have.length(0);
      expect(JSON.parse(memory.data[STORAGE_KEY]).threadId).to.equal('t1');
      await panel.open();
      expect(panel.getState().conversation.threadId).to.equal('t1');
    });

    it('starts empty when the remembered thread is gone, and remembers what the person does next', async () => {
      const memory = storage({ [STORAGE_KEY]: JSON.stringify({ open: true, threadId: 'gone' }) });
      const fake = server({
        'GET /agent/start': start(),
        'GET /agent/threads/gone': refusal(404, 'not_found'),
        [TURN]: events(textRun('Hi'))
      });
      const panel = createPanel({ fetch: fake.fetch, storage: memory, url: '/x' });
      await panel.mount();
      expect(panel.getState().conversation).to.deep.include({ items: [] });
      expect(panel.getState().notice).to.equal(undefined);
      await panel.send('Hello');
      expect(JSON.parse(memory.data[STORAGE_KEY])).to.deep.include({ open: true, threadId: 't1' });
      panel.close();
      expect(JSON.parse(memory.data[STORAGE_KEY]).open).to.equal(false);
    });

    it('opens at once when the page asks it to, and copes with nothing, bad or blocked storage', async () => {
      const fake = server({ 'GET /agent/start': start() });
      const eager = createPanel({ fetch: fake.fetch, storage: storage(), defaultOpen: true, url: '/x' });
      await eager.mount();
      expect(eager.getState().open).to.equal(true);
      for (const memory of [
        storage({ [STORAGE_KEY]: 'not json' }),
        storage({ [STORAGE_KEY]: '5' }),
        {
          getItem: () => { throw new Error('blocked'); },
          setItem: () => { throw new Error('blocked'); },
          removeItem: () => undefined
        }
      ]) {
        const panel = createPanel({ fetch: fake.fetch, storage: memory, url: '/x' });
        await panel.mount();
        panel.setDraft('still works');
        expect(panel.getState().draft).to.equal('still works');
        expect(panel.getState().open).to.equal(false);
      }
    });

    it('takes the page address from the browser when the page did not give one', async () => {
      (globalThis as any).window = { location: { pathname: '/articles/z', search: '?a=1' } };
      try {
        const panel = createPanel({ fetch: server({}).fetch, storage: null });
        await panel.mount();
        expect(panel.getState().url).to.equal('/articles/z?a=1');
        panel.destroy();
      } finally {
        delete (globalThis as any).window;
      }
    });
  });
});
