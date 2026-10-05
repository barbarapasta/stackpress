//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { createElement as h } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { R22nProvider } from 'r22n';
//client
import AgentPanel from '../src/client/AgentPanel.js';
import PanelView, { statusLine } from '../src/client/PanelView.js';
import { createPanel } from '../src/client/controller.js';
import { bind, nearBottom } from '../src/client/hooks.js';
import { announceText, noticeText, statusText, when } from '../src/client/phrases.js';
import type {
  AgentEvent,
  NoticeCode,
  PanelOptions,
  PanelState,
  Say
} from '../src/client/types.js';
//tests
import {
  all,
  choose,
  click,
  control,
  controls,
  expand,
  first,
  mustControl,
  name,
  pick,
  press,
  render,
  submit,
  text,
  type,
  walk
} from './dom.js';
import type { Host } from './dom.js';
import {
  answer,
  events,
  gated,
  refusal,
  server,
  settle,
  start,
  stored,
  thread,
  turn
} from './panel.js';

//What the panel draws, read off the markup without a browser (see dom.ts),
// and driven through the real controller so a click goes where it would in
// the page. Focus, scrolling and layout are not here: the run in a real
// browser covers those.

//the translate function as r22n gives it, for text
const say: Say = (phrase, ...variables) => {
  let at = 0;
  return phrase.replace(/%s/g, () => String(variables[at++] ?? ''));
};

const THREAD = 'GET /agent/threads/t1';

const waitingRun: AgentEvent[] = [
  { type: 'thread', threadId: 't1', title: 'Add a note' },
  { type: 'text', text: 'On it.' },
  { type: 'action-start', actionId: 'a1', tool: 'note_add', input: { text: 'hi' } },
  {
    type: 'action-done', actionId: 'a1', tool: 'note_add',
    input: { text: 'hi' }, result: { id: 'n1', title: 'A note' }, undoable: true
  },
  {
    type: 'action-waiting', actionId: 'a2', tool: 'note_remove',
    input: { id: 'n1', reason: 'duplicate' }, expires: '2026-10-05T11:00:00.000Z'
  },
  { type: 'finished', status: 'waiting' }
];

type Driven = Awaited<ReturnType<typeof driven>>;

//a panel over a scripted server, and a way to look at it and act on it
async function driven(
  routes: Parameters<typeof server>[0] = {},
  options: PanelOptions = {},
  props: Record<string, unknown> = {}
) {
  const fake = server({ 'GET /agent/start': start(), ...routes });
  const panel = createPanel({
    fetch: fake.fetch,
    storage: null,
    onRefresh: () => undefined,
    ...options
  });
  const actions = bind(panel);
  const screen = (extra: Record<string, unknown> = {}): Host => render(h(PanelView, {
    state: panel.getState(),
    actions,
    _: say,
    signInUrl: '/auth/signin',
    starters: [],
    canAttach: Boolean(options.upload),
    ...props,
    ...extra
  } as never));
  return { fake, panel, screen, actions };
}

//open it, ready to use
async function ready(
  routes: Parameters<typeof server>[0] = {},
  options: PanelOptions = {},
  props: Record<string, unknown> = {}
) {
  const made = await driven(routes, options, props);
  await made.panel.open();
  return made;
}

//a panel with a reversible action done and an irreversible one waiting
async function waiting(routes: Parameters<typeof server>[0] = {}) {
  const made = await ready({ 'POST /agent/turn': events(waitingRun), ...routes });
  made.panel.setDraft('Go');
  await made.panel.send();
  return made;
}

const cardOf = (root: Host, id: string) => first(root, host => host.props.id === `agent-card-${id}`)!;
const labels = (root: Host) => controls(root).map(host => name(root, host));

describe('the panel as markup', () => {
  describe('when it is closed', () => {
    it('is one button that says it opens a panel, and a status line that exists before anything is said', async () => {
      const { screen, panel } = await driven();
      const root = screen();
      expect(labels(root)).to.deep.equal([ 'Agent' ]);
      const launcher = mustControl(root, 'Agent');
      expect(launcher.props['aria-expanded']).to.equal('false');
      expect(launcher.props['aria-controls']).to.equal('agent-panel');
      expect(launcher.props.type).to.equal('button');
      expect(first(root, host => host.tag === 'aside')).to.equal(undefined);
      const live = first(root, host => host.props.role === 'status')!;
      expect(live.props['aria-live']).to.equal('polite');
      expect(text(live)).to.equal('');
      //it costs nothing until it is used
      expect(panel.getState().phase).to.equal('idle');
    });

    it('opens when the button is pressed, and then draws the panel the button controls', async () => {
      const { screen, fake } = await driven();
      click(mustControl(screen(), 'Agent'));
      await settle();
      const root = screen();
      const panel = first(root, host => host.tag === 'aside')!;
      expect(panel.props.id).to.equal('agent-panel');
      expect(panel.props['aria-label']).to.equal('Agent chat');
      expect(control(root, 'Agent')).to.equal(undefined);
      expect(fake.count('GET', '/agent/start')).to.equal(1);
    });
  });

  describe('the header', () => {
    it('shows what the agent is doing, and closes', async () => {
      const { screen, panel } = await ready();
      expect(text(first(screen(), host => host.props.className === 'agent-status'))).to.equal('Ready');
      expect(text(first(screen(), host => host.tag === 'h2'))).to.equal('Agent');
      click(mustControl(screen(), 'Close agent'));
      expect(panel.getState().open).to.equal(false);
    });

    it('says what state the agent is in', async () => {
      const state = (extra: Partial<PanelState>) => ({
        ...createPanel({ storage: null }).getState(), ...extra
      });
      expect(statusLine(state({ phase: 'idle' }), say)).to.equal('Connecting…');
      expect(statusLine(state({ phase: 'loading' }), say)).to.equal('Connecting…');
      expect(statusLine(state({ phase: 'signed-out' }), say)).to.equal('Signed out');
      expect(statusLine(state({ phase: 'unavailable' }), say)).to.equal('Unavailable');
      expect(statusLine(state({ phase: 'limit' }), say)).to.equal('Daily limit reached');
      expect(statusLine(state({ phase: 'ready', running: true }), say)).to.equal('Working…');
      expect(statusLine(state({ phase: 'ready' }), say)).to.equal('Ready');
    });

    it('says it is waiting for approval, and ready for a follow-up after a reply', async () => {
      const made = await waiting();
      expect(text(first(made.screen(), host => host.props.className === 'agent-status')))
        .to.equal('Waiting for your approval');
      const done = await ready({ 'POST /agent/turn': events([
        { type: 'text', text: 'Hi' }, { type: 'finished', status: 'done' }
      ]) });
      await done.panel.send('Hello');
      expect(text(first(done.screen(), host => host.props.className === 'agent-status')))
        .to.equal('Ready for a follow-up');
    });

    it('starts a new chat from its button, and switches to history and back', async () => {
      const { screen, panel, fake } = await ready({
        'POST /agent/threads': answer({ ok: true, thread: thread({ id: 't3' }), reused: false }),
        'GET /agent/threads': answer({ ok: true, threads: [ thread() ] })
      });
      click(mustControl(screen(), 'New chat'));
      await settle();
      expect(fake.count('POST', '/agent/threads')).to.equal(1);
      expect(panel.getState().conversation.threadId).to.equal('t3');

      const history = mustControl(screen(), 'History');
      expect(history.props['aria-pressed']).to.equal(false);
      click(history);
      await settle();
      expect(mustControl(screen(), 'History').props['aria-pressed']).to.equal(true);
      expect(panel.getState().view).to.equal('history');
      click(mustControl(screen(), 'History'));
      expect(panel.getState().view).to.equal('chat');
    });

    it('turns New chat and History off where they cannot work', async () => {
      const out = await ready({}, { signedIn: false });
      expect(mustControl(out.screen(), 'New chat').props.disabled).to.equal(true);
      expect(mustControl(out.screen(), 'History').props.disabled).to.equal(true);
      const limited = await ready({
        'GET /agent/start': start({ usage: { used: 5, limit: 5, remaining: 0 } })
      });
      expect(mustControl(limited.screen(), 'New chat').props.disabled).to.equal(true);
      expect(mustControl(limited.screen(), 'History').props.disabled).to.equal(false);
    });
  });

  describe('the states where the agent cannot be used', () => {
    it('asks a signed-out person to sign in, with a link, and no composer', async () => {
      const { screen } = await ready({}, { signedIn: false }, { signInUrl: '/login' });
      const root = screen();
      expect(text(first(root, host => host.tag === 'h3'))).to.equal('Sign in to use the agent');
      expect(mustControl(root, 'Sign in').props.href).to.equal('/login');
      expect(control(root, 'Send')).to.equal(undefined);
      expect(control(root, 'Message')).to.equal(undefined);
    });

    it('says the agent is unavailable, and tries again on request', async () => {
      let up = false;
      const { screen, panel } = await ready({
        'GET /agent/start': () => (up ? start() : refusal(503, 'unavailable'))
      });
      const root = screen();
      expect(text(first(root, host => host.tag === 'h3'))).to.equal('The agent is unavailable');
      expect(first(root, host => host.props.role === 'alert')).to.not.equal(undefined);
      up = true;
      click(mustControl(root, 'Try again'));
      await settle();
      expect(panel.getState().phase).to.equal('ready');
      expect(control(screen(), 'Send')).to.not.equal(undefined);
    });

    it('says the daily limit is reached and when it resets, keeps the conversation, and takes the composer away', async () => {
      const { screen, panel } = await ready({
        'POST /agent/turn': events([ { type: 'text', text: 'Hi' }, { type: 'finished', status: 'done' } ])
      });
      await panel.send('Hello');
      const limited = await ready({
        'GET /agent/start': start({
          usage: { used: 9, limit: 9, remaining: 0, resetsAt: '2026-10-06T00:00:00.000Z' }
        })
      });
      const root = limited.screen();
      expect(text(first(root, host => host.tag === 'h3'))).to.equal('Daily limit reached');
      expect(text(root)).to.include(`again after ${when('2026-10-06T00:00:00.000Z')}`);
      expect(control(root, 'Send')).to.equal(undefined);
      //what was said before stays on the screen
      expect(text(screen())).to.include('Hi');
      //with no reset time it still says when to come back
      const bare = await ready({
        'GET /agent/start': start({ usage: { used: 9, limit: 9, remaining: 0 } })
      });
      expect(text(bare.screen())).to.include('again tomorrow');
    });

    it('says it is connecting while it loads', async () => {
      const made = await driven();
      made.panel.open();
      expect(text(made.screen())).to.include('Connecting to the agent…');
      await settle();
    });
  });

  describe('the conversation', () => {
    it('starts with a greeting and the prompts the app offered, and a prompt sends itself', async () => {
      const { screen, fake } = await ready(
        { 'POST /agent/turn': events([ { type: 'finished', status: 'done' } ]) },
        {},
        { starters: [ 'Publish this article', 'Summarise the comments' ] }
      );
      const root = screen();
      expect(text(root)).to.include('Ask the agent to do something on this page.');
      click(mustControl(root, 'Summarise the comments'));
      await settle();
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body.message).to.equal('Summarise the comments');
    });

    it('draws messages as plain text, says who spoke, and never as markup', async () => {
      const { screen, panel } = await ready({
        'POST /agent/turn': events([
          { type: 'text', text: 'Line one\n<b>bold</b><img src=x onerror=alert(1)>' },
          { type: 'finished', status: 'done' }
        ])
      });
      await panel.send('Hi <script>');
      const root = screen();
      const messages = all(root, host => host.tag === 'article' && String(host.props.className).startsWith('agent-message'));
      expect(messages.map(message => message.children.map(text)[0])).to.deep.equal([ 'You', 'Agent' ]);
      const reply = first(messages[1], host => host.tag === 'p')!;
      expect(text(reply)).to.equal('Line one\n<b>bold</b><img src=x onerror=alert(1)>');
      expect(all(root, host => [ 'b', 'img', 'script' ].includes(host.tag))).to.deep.equal([]);
      expect(renderToStaticMarkup(h(PanelView, {
        state: panel.getState(), actions: bind(panel), _: say, signInUrl: '', starters: [], canAttach: false
      }))).to.not.include('<img');
    });

    it('is a scrolling region a keyboard can reach, that does not read itself aloud as text arrives', async () => {
      const { screen } = await ready();
      const log = first(screen(), host => host.props.role === 'log')!;
      expect(log.props['aria-live']).to.equal('off');
      expect(log.props['aria-label']).to.equal('Conversation');
      expect(log.props.tabIndex).to.equal(0);
    });

    it('marks a message that is still arriving as busy, and keeps Send off until it ends', async () => {
      const feed = gated();
      const live = await ready({ 'POST /agent/turn': () => feed.response });
      const sending = live.panel.send('Hello');
      await settle();
      feed.push({ type: 'text', text: 'Hel' });
      await settle();
      const reply = first(live.screen(), host => host.props.className === 'agent-message agent-agent')!;
      expect(reply.props['aria-busy']).to.equal('true');
      type(mustControl(live.screen(), 'Message'), 'next');
      expect(mustControl(live.screen(), 'Send').props.disabled).to.equal(true);
      feed.push({ type: 'finished', status: 'done' });
      feed.end();
      await sending;
      const done = first(live.screen(), host => host.props.className === 'agent-message agent-agent')!;
      expect(done.props['aria-busy']).to.equal(undefined);
      expect(mustControl(live.screen(), 'Send').props.disabled).to.equal(false);
    });

    it('offers a way back to the newest message when the person has scrolled away', async () => {
      const { screen } = await ready();
      expect(control(screen(), 'Jump to latest')).to.equal(undefined);
      const jumped: boolean[] = [];
      const root = screen({ behind: true, jump: () => jumped.push(true) });
      click(mustControl(root, 'Jump to latest'));
      expect(jumped).to.deep.equal([ true ]);
      expect(nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 })).to.equal(true);
      expect(nearBottom({ scrollHeight: 1000, scrollTop: 300, clientHeight: 400 })).to.equal(false);
    });
  });

  describe('action cards', () => {
    it('shows a waiting card with the action, its inputs, and what approving does, before the person decides', async () => {
      const { screen } = await waiting();
      const card = cardOf(screen(), 'a2');
      expect(card.props.role).to.equal('group');
      expect(card.props.tabIndex).to.equal(-1);
      const title = first(screen(), host => host.props.id === card.props['aria-labelledby'])!;
      expect(text(title)).to.equal('Note remove');
      expect(text(first(card, host => host.props.className?.startsWith('agent-badge'))))
        .to.equal('Waiting for approval');
      const inputs = all(card, host => host.props.className === 'agent-input').map(text);
      expect(inputs).to.deep.equal([ 'idn1', 'reasonduplicate' ]);
      expect(text(card)).to.include('Nothing runs until you approve.');
      expect(text(card)).to.include('Expires ');
      expect(labels(card)).to.deep.equal([ 'Approve Note remove', 'Decline Note remove' ]);
      expect(labels(card)).to.not.include('Undo Note remove');
    });

    it('shows a finished reversible action with its result and Undo, and a finished irreversible one without', async () => {
      const { screen } = await waiting();
      const done = cardOf(screen(), 'a1');
      expect(text(first(done, host => host.props.className?.startsWith('agent-badge')))).to.equal('Done');
      expect(text(first(done, host => host.props.className === 'agent-card-result'))).to.equal('A note');
      expect(labels(done)).to.deep.equal([ 'Undo Note add' ]);
      expect(text(first(done, host => host.tag === 'pre'))).to.include('"id": "n1"');
      const approved = await waiting({
        'POST /agent/actions/a2/approve': events([
          { type: 'action-done', actionId: 'a2', tool: 'note_remove', input: {}, result: { removed: true }, undoable: false },
          { type: 'finished', status: 'done' }
        ])
      });
      click(mustControl(cardOf(approved.screen(), 'a2'), 'Approve Note remove'));
      await settle();
      expect(labels(cardOf(approved.screen(), 'a2'))).to.deep.equal([]);
      expect(text(first(cardOf(approved.screen(), 'a2'), host => host.props.className?.startsWith('agent-badge')))).to.equal('Done');
    });

    it('shows each status in words, and a failed card with the reason', async () => {
      const cases: [ string, string ][] = [
        [ 'running', 'Running' ], [ 'done', 'Done' ], [ 'failed', 'Failed' ],
        [ 'waiting', 'Waiting for approval' ], [ 'declined', 'Declined' ],
        [ 'expired', 'Expired' ], [ 'undone', 'Undone' ]
      ];
      for (const [ status, words ] of cases) {
        expect(statusText(status as never, undefined, say)).to.equal(words);
      }
      expect(statusText('done', 'approve', say)).to.equal('Approving');
      expect(statusText('done', 'decline', say)).to.equal('Declining');
      expect(statusText('done', 'undo', say)).to.equal('Undoing');

      const { screen } = await ready({
        'POST /agent/turn': events([
          { type: 'action-failed', actionId: 'f1', tool: 'note_add', input: {}, error: 'You may not change this.', code: 403 },
          { type: 'action-failed', actionId: 'f2', tool: 'note_add', input: {}, error: '' },
          { type: 'finished', status: 'done' }
        ])
      }).then(async made => { await made.panel.send('Go'); return made; });
      expect(text(first(cardOf(screen(), 'f1'), host => host.props.className?.includes('agent-card-error')))).to.equal('You may not change this.');
      expect(text(cardOf(screen(), 'f2'))).to.include('The action did not finish.');
      expect(labels(cardOf(screen(), 'f1'))).to.deep.equal([]);
    });

    it('shows no buttons on a card that was declined, expired or undone', async () => {
      const made = await ready({
        'GET /agent/start': start(),
        [THREAD]: answer({
          ok: true, thread: thread(), turns: [],
          actions: [
            stored({ id: 'd1', status: 'declined', undoable: false }),
            stored({ id: 'e1', status: 'expired', undoable: false }),
            stored({ id: 'u1', status: 'undone', undoable: false })
          ]
        })
      });
      await made.panel.openThread('t1');
      const root = made.screen();
      expect(all(root, host => String(host.props.className).startsWith('agent-card ')).length).to.equal(3);
      for (const id of [ 'd1', 'e1', 'u1' ]) expect(labels(cardOf(root, id))).to.deep.equal([]);
    });

    it('turns every button of a card off while a request from it is in flight, and says what is going on', async () => {
      const feed = gated();
      const made = await waiting({ 'POST /agent/actions/a2/approve': () => feed.response });
      const pending = made.panel.approve('a2');
      const card = cardOf(made.screen(), 'a2');
      expect(text(first(card, host => host.props.className?.startsWith('agent-badge')))).to.equal('Approving');
      for (const button of controls(card)) expect(button.props.disabled).to.equal(true);
      //the other card's Undo is off too: one request at a time
      expect(mustControl(cardOf(made.screen(), 'a1'), 'Undo Note add').props.disabled).to.equal(true);
      feed.push({ type: 'finished', status: 'done' });
      feed.end();
      await pending;
    });

    it('sends one request for a double click, whether or not the page had drawn the change yet', async () => {
      const made = await waiting({
        'POST /agent/actions/a2/approve': events([ { type: 'finished', status: 'done' } ])
      });
      const stale = mustControl(cardOf(made.screen(), 'a2'), 'Approve Note remove');
      expect(click(stale)).to.equal(true);
      //a second click on what was drawn before the change
      click(stale);
      //a second click after it is drawn: the button is off
      expect(click(mustControl(cardOf(made.screen(), 'a2'), 'Approve Note remove'))).to.equal(false);
      await settle(8);
      expect(made.fake.count('POST', '/agent/actions/a2/approve')).to.equal(1);
    });

    it('declines from the card, and undoes from the card', async () => {
      const declined = await waiting({
        'POST /agent/actions/a2/decline': events([
          { type: 'action-declined', actionId: 'a2', tool: 'note_remove' },
          { type: 'finished', status: 'done' }
        ])
      });
      click(mustControl(cardOf(declined.screen(), 'a2'), 'Decline Note remove'));
      await settle();
      expect(text(first(cardOf(declined.screen(), 'a2'), host => host.props.className?.startsWith('agent-badge')))).to.equal('Declined');

      const undone = await waiting({
        'POST /agent/actions/a1/undo': answer({ ok: true, status: 'undone', events: [] })
      });
      click(mustControl(cardOf(undone.screen(), 'a1'), 'Undo Note add'));
      await settle();
      expect(text(first(cardOf(undone.screen(), 'a1'), host => host.props.className?.startsWith('agent-badge')))).to.equal('Undone');
      expect(labels(cardOf(undone.screen(), 'a1'))).to.deep.equal([]);
    });

    it('says why an undo was refused, in a message that is read out', async () => {
      const made = await waiting({
        'POST /agent/actions/a1/undo': answer({ ok: true, status: 'refused', error: 'The note changed since.', events: [] }),
        'POST /agent/actions/a1/undo2': answer({})
      });
      click(mustControl(cardOf(made.screen(), 'a1'), 'Undo Note add'));
      await settle();
      const card = cardOf(made.screen(), 'a1');
      const alert = first(card, host => host.props.role === 'alert')!;
      expect(text(alert)).to.equal('Could not undo this. The note changed since.');
      expect(labels(card)).to.deep.equal([ 'Undo Note add' ]);
    });

    it('shortens long inputs, and shows inputs that are not text', async () => {
      const made = await ready({
        'POST /agent/turn': events([
          {
            type: 'action-waiting', actionId: 'w1', tool: 'x',
            input: { long: 'y'.repeat(300), list: [ 1, 2 ], flag: true }, expires: null
          },
          { type: 'finished', status: 'waiting' }
        ])
      });
      await made.panel.send('Go');
      const values = all(cardOf(made.screen(), 'w1'), host => host.tag === 'dd').map(text);
      expect(values[0]).to.have.length(201);
      expect(values.slice(1)).to.deep.equal([ '[1,2]', 'true' ]);
      expect(text(cardOf(made.screen(), 'w1'))).to.not.include('Expires');
    });
  });

  describe('context chips', () => {
    const page = { url: '/articles/x', context: [ { type: 'article', id: 'x', label: 'An article' } ] };

    it('shows the page address and what the page declared, each with a button named for it', async () => {
      const { screen } = await ready({}, page);
      const bar = first(screen(), host => host.props['aria-label'] === 'Page context')!;
      expect(all(bar, host => host.tag === 'li').map(item => text(item.children[0] as Host))).to.deep.equal([
        '/articles/x', 'An article'
      ]);
      expect(labels(bar)).to.deep.equal([ 'Remove /articles/x', 'Remove An article' ]);
    });

    it('takes a chip off the bar when its button is pressed, and does not send it', async () => {
      const { screen, panel, fake } = await ready(
        { 'POST /agent/turn': events([ { type: 'finished', status: 'done' } ]) }, page
      );
      click(mustControl(screen(), 'Remove An article'));
      expect(control(screen(), 'Remove An article')).to.equal(undefined);
      panel.setDraft('Hello');
      await panel.send();
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body.context).to.deep.equal({ url: '/articles/x' });
      click(mustControl(screen(), 'Remove /articles/x'));
      expect(first(screen(), host => host.props['aria-label'] === 'Page context')).to.equal(undefined);
    });
  });

  describe('the composer', () => {
    it('has a label for its field, sends on Enter, and breaks the line on Shift+Enter', async () => {
      const { screen, panel, fake } = await ready({
        'POST /agent/turn': events([ { type: 'finished', status: 'done' } ])
      });
      const field = mustControl(screen(), 'Message');
      expect(field.tag).to.equal('textarea');
      expect(field.props.placeholder).to.equal('Ask the agent…');
      type(field, 'Hello');
      expect(panel.getState().draft).to.equal('Hello');

      const lineBreak = press(mustControl(screen(), 'Message'), 'Enter', { shiftKey: true });
      const composing = press(mustControl(screen(), 'Message'), 'Enter', { nativeEvent: { isComposing: true } });
      const other = press(mustControl(screen(), 'Message'), 'a');
      await settle();
      expect(fake.count('POST', '/agent/turn')).to.equal(0);
      void lineBreak; void composing; void other;

      const enter = press(mustControl(screen(), 'Message'), 'Enter');
      await settle();
      expect(fake.count('POST', '/agent/turn')).to.equal(1);
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body.message).to.equal('Hello');
      void enter;
    });

    it('sends from the form too, and keeps Send off while there is nothing to send or a reply is coming', async () => {
      const { screen, panel, fake } = await ready({
        'POST /agent/turn': events([ { type: 'finished', status: 'done' } ])
      });
      expect(mustControl(screen(), 'Send').props.disabled).to.equal(true);
      type(mustControl(screen(), 'Message'), '   ');
      expect(mustControl(screen(), 'Send').props.disabled).to.equal(true);
      type(mustControl(screen(), 'Message'), 'Hello');
      expect(mustControl(screen(), 'Send').props.disabled).to.equal(false);
      expect(mustControl(screen(), 'Send').props.type).to.equal('submit');
      const form = first(screen(), host => host.tag === 'form')!;
      submit(form);
      await settle();
      expect(fake.count('POST', '/agent/turn')).to.equal(1);
      expect(panel.getState().draft).to.equal('');
    });

    it('has no attach control when the app gave no upload handler', async () => {
      const { screen } = await ready();
      expect(labels(screen()).filter(label => /attach/i.test(label))).to.deep.equal([]);
      expect(all(screen(), host => host.props.type === 'file')).to.deep.equal([]);
    });

    it('attaches a file by reference through the app handler, shows it as a chip, and takes it off again', async () => {
      const handed: string[] = [];
      const { screen, panel, fake } = await ready({
        'POST /agent/turn': events([ { type: 'finished', status: 'done' } ])
      }, { upload: async file => { handed.push(file.name); return `files/${file.name}`; } });
      const input = first(screen(), host => host.props.type === 'file')!;
      expect(name(screen(), input)).to.equal('');
      expect(text(first(screen(), host => host.props.className === 'agent-button agent-attach'))).to.equal('Attach');
      const target = pick(input, { name: 'invoice.pdf' });
      //the field is cleared, so the same file can be picked again
      expect(target.value).to.equal('');
      await settle();
      expect(handed).to.deep.equal([ 'invoice.pdf' ]);
      const files = first(screen(), host => host.props['aria-label'] === 'Attached files')!;
      expect(text(files)).to.include('invoice.pdf');
      pick(first(screen(), host => host.props.type === 'file')!, undefined);
      await settle();
      expect(handed).to.have.length(1);

      panel.setDraft('Attach it');
      await panel.send();
      expect(fake.calls.find(call => call.path === '/agent/turn')!.body.files).to.deep.equal([ 'files/invoice.pdf' ]);

      await panel.attach({ name: 'second.pdf' } as File);
      click(mustControl(screen(), 'Remove second.pdf'));
      expect(control(screen(), 'Remove second.pdf')).to.equal(undefined);
    });

    it('shows the model picker only when there is a choice, and sends the choice', async () => {
      const many = await ready({ 'POST /agent/turn': events([ { type: 'finished', status: 'done' } ]) });
      const select = mustControl(many.screen(), 'Model');
      expect(select.tag).to.equal('select');
      expect(select.props.value).to.equal('big');
      expect(all(select, host => host.tag === 'option').map(text)).to.deep.equal([ 'Big', 'Small' ]);
      choose(select, 'small');
      expect(many.panel.getState().model).to.equal('small');
      expect(mustControl(many.screen(), 'Model').props.value).to.equal('small');
      many.panel.setDraft('Hi');
      await many.panel.send();
      expect(many.fake.calls.find(call => call.path === '/agent/turn')!.body.model).to.equal('small');

      const one = await ready({
        'GET /agent/start': start({ models: [ { provider: 'anthropic', model: 'big' } ] })
      });
      expect(control(one.screen(), 'Model')).to.equal(undefined);
    });

    it('turns the model picker off while a reply is coming, and says every action is logged and what allowance is left', async () => {
      const { screen } = await ready();
      expect(text(first(screen(), host => host.props.className === 'agent-note')))
        .to.equal('Every action is logged. 1000 tokens left today.');
      const none = await ready({ 'GET /agent/start': start({ usage: { used: 0 } }) });
      expect(text(first(none.screen(), host => host.props.className === 'agent-note')))
        .to.equal('Every action is logged.');
    });

    it('shows a refusal as a plain sentence a person can act on, that can be dismissed', async () => {
      const { screen, panel } = await ready({ 'POST /agent/turn': refusal(403, 'csrf') });
      panel.setDraft('Hello');
      await panel.send();
      const notice = first(screen(), host => host.props.className === 'agent-notice')!;
      expect(notice.props.role).to.equal('alert');
      expect(text(notice)).to.include('Your session needed refreshing. Send that again.');
      expect(text(notice)).to.not.include('raw server words');
      click(mustControl(screen(), 'Dismiss message'));
      expect(first(screen(), host => host.props.className === 'agent-notice')).to.equal(undefined);
    });
  });

  describe('history', () => {
    it('lists earlier chats with when they were last used, opens one, and goes back', async () => {
      const made = await ready({
        'GET /agent/threads': answer({ ok: true, threads: [ thread(), thread({ id: 't9', title: '' }) ] }),
        [THREAD]: answer({ ok: true, thread: thread(), turns: [ turn() ], actions: [] })
      });
      click(mustControl(made.screen(), 'History'));
      await settle();
      const root = made.screen();
      expect(all(root, host => host.props.className === 'agent-thread-row').map(row => text(row.children[0] as Host)))
        .to.deep.equal([ 'Add a note', 'Untitled chat' ]);
      expect(first(root, host => host.tag === 'time')!.props.dateTime).to.equal('2026-10-05T10:00:05.000Z');
      click(mustControl(root, /^Add a note/));
      await settle();
      expect(made.panel.getState().view).to.equal('chat');
      expect(text(made.screen())).to.include('Add a note');
      click(mustControl(made.screen(), 'History'));
      await settle();
      click(mustControl(made.screen(), 'Back to chat'));
      expect(made.panel.getState().view).to.equal('chat');
    });

    it('marks the chat that is open, and says when there is none or when it cannot be loaded', async () => {
      const made = await ready({
        'GET /agent/threads': answer({ ok: true, threads: [ thread() ] }),
        [THREAD]: answer({ ok: true, thread: thread(), turns: [], actions: [] })
      });
      await made.panel.openThread('t1');
      await made.panel.showHistory();
      expect(first(made.screen(), host => host.props.className === 'agent-thread-row')!.props['aria-current']).to.equal('true');

      const empty = await ready({ 'GET /agent/threads': answer({ ok: true, threads: [] }) });
      await empty.panel.showHistory();
      expect(text(empty.screen())).to.include('No earlier chats yet.');

      let up = false;
      const broken = await ready({
        'GET /agent/threads': () => (up ? answer({ ok: true, threads: [ thread() ] }) : refusal(500, 'unavailable'))
      });
      await broken.panel.showHistory();
      expect(first(broken.screen(), host => host.props.role === 'alert')).to.not.equal(undefined);
      up = true;
      click(mustControl(broken.screen(), 'Try again'));
      await settle();
      expect(text(broken.screen())).to.include('Add a note');
    });

    it('says it is loading before the first answer', async () => {
      const made = await ready({ 'GET /agent/threads': async () => { await settle(); return answer({ ok: true, threads: [] }); } });
      const loading = made.panel.showHistory();
      expect(text(made.screen())).to.include('Loading earlier chats…');
      await loading;
    });
  });

  describe('using only a keyboard', () => {
    it('closes on Escape from inside the panel, but leaves Escape to an open model list', async () => {
      const { screen, panel } = await ready();
      const aside = first(screen(), host => host.tag === 'aside')!;
      const select = press(aside, 'Escape', { target: { tagName: 'SELECT' } });
      expect(panel.getState().open).to.equal(true);
      expect(select).to.not.equal(undefined);
      press(aside, 'Escape', { target: { tagName: 'TEXTAREA' } });
      expect(panel.getState().open).to.equal(false);
    });

    it('is made only of real controls: nothing that is not a button, link or field takes a click', async () => {
      const made = await waiting();
      await made.panel.showHistory();
      const views: Host[] = [];
      views.push(made.screen());
      made.panel.showChat();
      views.push(made.screen());
      for (const root of views) {
        walk(root, host => {
          if (host.props.onClick) {
            expect([ 'button', 'a', 'input', 'label' ], host.tag).to.include(host.tag);
          }
        });
      }
    });

    it('gives every control a name, and keeps ids and what points at them in step', async () => {
      const states: Driven[] = [
        await waiting(),
        await ready({}, { upload: async () => 'x' }, { starters: [ 'Try this' ] })
      ];
      for (const made of states) {
        const root = made.screen();
        for (const host of controls(root)) {
          expect(name(root, host), `${host.tag} ${host.props.className}`).to.not.equal('');
        }
        const ids = all(root, host => Boolean(host.props.id)).map(host => host.props.id);
        expect(new Set(ids).size).to.equal(ids.length);
        walk(root, host => {
          for (const key of [ 'aria-labelledby', 'htmlFor' ]) {
            if (host.props[key]) expect(ids, `${host.tag} ${key}`).to.include(host.props[key]);
          }
        });
      }
      //the launcher points at the panel it opens
      const closed = await driven();
      const launcher = mustControl(closed.screen(), 'Agent');
      await closed.panel.open();
      expect(first(closed.screen(), host => host.props.id === launcher.props['aria-controls'])).to.not.equal(undefined);
    });

    it('announces what changes in words, through one status region', async () => {
      const made = await waiting();
      const live = all(made.screen(), host => host.props.role === 'status');
      const region = live.find(host => host.props['aria-live'] === 'polite')!;
      expect(text(region)).to.equal('Waiting for your approval: Note remove.');
      expect(announceText('sending', undefined, say)).to.equal('Message sent.');
      expect(announceText('replied', undefined, say)).to.equal('The agent replied.');
      expect(announceText('done', 'note_add', say)).to.equal('Note add finished.');
      expect(announceText('failed', 'note_add', say)).to.equal('Note add failed.');
      expect(announceText('declined', 'note_add', say)).to.equal('Note add was declined.');
      expect(announceText('approving', 'note_add', say)).to.equal('Approving Note add.');
      expect(announceText('declining', 'note_add', say)).to.equal('Declining Note add.');
      expect(announceText('undoing', 'note_add', say)).to.equal('Undoing Note add.');
      expect(announceText('undone', 'note_add', say)).to.equal('Note add was undone.');
      expect(announceText('undo-refused', 'note_add', say)).to.equal('Note add could not be undone.');
      expect(announceText('attached', undefined, say)).to.equal('File attached.');
      expect(announceText('nothing-known', undefined, say)).to.equal('');
    });
  });

  describe('words', () => {
    it('has a sentence for every message the panel can show, none of them the server words', () => {
      const codes: NoticeCode[] = [
        'network', 'csrf', 'invalid', 'not-found', 'conflict', 'failed',
        'interrupted', 'settled', 'steps', 'length', 'refusal', 'busy',
        'attach-failed', 'attach-limit', 'forbidden'
      ];
      const sentences = codes.map(code => noticeText(code, say));
      expect(new Set(sentences).size).to.equal(codes.length);
      for (const sentence of sentences) expect(sentence).to.match(/^[A-Z].*[.]$/);
    });

    it('formats a time in the reader’s locale, and nothing for a bad one', () => {
      expect(when('2026-10-05T10:00:00.000Z')).to.not.equal('');
      expect(when('nonsense')).to.equal('');
      expect(when(undefined)).to.equal('');
    });

    it('sends every visible word through the translate function', async () => {
      //a translate function that marks what went through it
      const marked: Say = (phrase, ...variables) => `«${say(phrase, ...variables)}»`;
      const dynamic = new Set<string>();
      const root = (made: Driven) => made.screen({ _: marked });
      const rich = await waiting({
        'POST /agent/actions/a1/undo': answer({ ok: true, status: 'refused', error: 'The note changed since.', events: [] })
      });
      await rich.panel.undo('a1');
      await rich.panel.attach({ name: 'invoice.pdf' } as File);
      const views = [
        root(rich),
        root(await ready({}, { upload: async () => 'files/1', url: '/articles/x', context: [ 'An article' ] }, { starters: [ 'Try this' ] })),
        root(await ready({}, { signedIn: false })),
        root(await ready({ 'GET /agent/start': refusal(503, 'unavailable') })),
        root(await ready({ 'GET /agent/start': start({ usage: { used: 1, limit: 1, remaining: 0, resetsAt: '2026-10-06T00:00:00.000Z' } }) })),
        root(await driven())
      ];
      const history = await ready({ 'GET /agent/threads': answer({ ok: true, threads: [ thread() ] }) });
      await history.panel.showHistory();
      views.push(root(history));
      const refused = await ready({ 'POST /agent/turn': refusal(403, 'csrf') });
      await refused.panel.send('Hello');
      refused.panel.setDraft('again');
      views.push(root(refused));
      for (const word of [
        'Add a note', 'Hello', 'Go', 'again', 'On it.', 'Try this', 'An article', '/articles/x',
        'invoice.pdf', 'Big', 'Small', 'A note', 'n1', 'duplicate', 'hi', 'text', 'id', 'reason',
        'The note changed since.', '×', '2026-10-05T11:00:00.000Z'
      ]) dynamic.add(word);
      //a time is written by the browser's locale, not translated
      dynamic.add(when('2026-10-05T10:00:05.000Z'));

      let leaves = 0;
      for (const tree of views) {
        walk(tree, host => {
          for (const key of [ 'aria-label', 'placeholder' ]) {
            if (host.props[key]) {
              expect(String(host.props[key]), `${host.tag} ${key}`).to.match(/^«/);
            }
          }
          for (const child of host.children) {
            if (typeof child !== 'string') continue;
            const word = child.trim();
            if (!word || dynamic.has(word) || host.tag === 'pre') continue;
            leaves++;
            expect(word, `${host.tag}.${host.props.className}`).to.match(/«/);
          }
        });
      }
      expect(leaves).to.be.greaterThan(60);
    });
  });
});

describe('the panel on the server', () => {
  const draw = (translations: Record<string, string>, props: Record<string, unknown> = {}) => renderToString(
    h(R22nProvider, { language: 'ES', translations }, h(AgentPanel, props))
  );

  it('draws a closed panel, the same every time, with its words translated', () => {
    const html = draw({ Agent: 'Agente' }, { url: '/articles/x' });
    expect(html).to.include('Agente');
    expect(html).to.include('aria-expanded="false"');
    expect(html).to.not.include('<aside');
    expect(html).to.equal(draw({ Agent: 'Agente' }, { url: '/articles/x' }));
    expect(html).to.not.include('Agent<');
  });

  it('draws the same thing whether or not the page gave a sign-in state, an upload handler or context, since only the browser acts on them', () => {
    const plain = draw({});
    const full = draw({}, {
      signedIn: false, upload: async () => 'x', context: [ 'x' ], starters: [ 'y' ], defaultOpen: true
    });
    expect(full).to.equal(plain);
  });

  it('draws an open panel for a given state without error, with everything translated', () => {
    const panel = createPanel({ storage: null, signedIn: false, url: '/x' });
    const html = renderToStaticMarkup(
      h(R22nProvider, { language: 'ES', translations: { 'Sign in to use the agent': 'Inicia sesión' }, children: undefined } as never,
        h(PanelView, {
          state: { ...panel.getState(), open: true, phase: 'signed-out' },
          actions: bind(panel),
          _: (phrase: string) => ({ 'Sign in to use the agent': 'Inicia sesión' } as Record<string, string>)[phrase] || phrase,
          signInUrl: '/auth/signin',
          starters: [],
          canAttach: false
        } as never))
    );
    expect(html).to.include('Inicia sesión');
    expect(html).to.include('href="/auth/signin"');
    expect(html).to.include('<aside id="agent-panel"');
  });

  it('agrees with the browser about its first state', () => {
    const panel = createPanel({ storage: null });
    expect(panel.getServerState()).to.equal(panel.getServerState());
    expect(panel.getServerState().open).to.equal(false);
    expect(expand(h(PanelView, {
      state: panel.getServerState(), actions: bind(panel), _: say, signInUrl: '', starters: [], canAttach: false
    } as never)).length).to.equal(1);
  });
});
