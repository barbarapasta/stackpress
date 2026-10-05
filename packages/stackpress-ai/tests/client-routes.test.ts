//modules
import { expect } from 'chai';
import { after, before, describe, it } from 'mocha';
//client
import { createClient } from '../src/client/api.js';
import { chips, createPanel } from '../src/client/controller.js';
import type {
  ActionItem,
  AgentEvent,
  Fetch,
  PanelOptions,
  PanelState
} from '../src/client/types.js';
import type { StubReply } from '../src/types.js';
//tests
import { asks, says, setup as setupWith } from './flow.js';
import type { Engine } from './flow.js';
import { createEngine } from './harness.js';
import type { WorldOptions } from './harness.js';
import { browser, plain, serve } from './site.js';
import type { Browser, HostKind } from './site.js';

//The panel's route client and controller against the real chat routes: the
// real plugin, the real anti-forgery plugin and a real signed session over a
// real HTTP listener, with only the model a stub. This is what the panel does
// in the blog, minus the browser. Each journey is tried on a server that
// lives as long as the process and on one built again for every request.

let engine: Engine;
const closers: (() => Promise<void>)[] = [];

before(async function () {
  this.timeout(60000);
  engine = await createEngine();
});

after(async () => {
  for (const close of closers) await close();
});

//a stub reply with text and a call, as a model that says what it will do
const both = (
  text: string, id: string, name: string, input: Record<string, unknown> = {}
): StubReply => ({
  text, toolCalls: [ { id, name, input } ], usage: { input: 10, output: 5 }
});

//what a browser's fetch does for a page of the same origin: sends the
// cookies it holds, keeps the ones it is given
function sameOrigin(me: Browser): Fetch {
  return async (input, init = {}) => {
    const response = await fetch(`${me.base}${input}`, {
      method: init.method,
      body: init.body,
      signal: init.signal,
      headers: {
        ...init.headers,
        ...(me.jar.size ? { cookie: me.cookie() } : {})
      }
    });
    for (const line of response.headers.getSetCookie()) {
      const [ pair ] = line.split(';');
      const at = pair.indexOf('=');
      me.jar.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)));
    }
    return response;
  };
}

async function open(kind: HostKind, options: WorldOptions = {}, panel: PanelOptions = {}) {
  const ready = await setupWith(engine, options);
  const site = await serve(ready.world, kind);
  closers.push(site.close);
  const me = browser(site.base, ready.token);
  const refreshed: number[] = [];
  const person = createPanel({
    fetch: sameOrigin(me),
    storage: null,
    onRefresh: () => { refreshed.push(refreshed.length + 1); },
    ...panel
  });
  return { ...ready, site, me, panel: person, refreshed, state: () => person.getState() };
}

const cards = (state: PanelState) => state.conversation.items.filter(
  (item): item is ActionItem => item.kind === 'action'
);
const kinds = (state: PanelState) => state.conversation.items.map(item => (
  item.kind === 'action' ? `${item.tool}:${item.status}` : item.kind
));

for (const kind of [ 'long-lived', 'per-request' ] as HostKind[]) {
  describe(`the panel against the chat routes on a ${kind} server`, function () {
    this.timeout(30000);

    it('opens, takes the token, and shows the models and the allowance', async () => {
      const { panel, state } = await open(kind, { config: { limit: 5000 } });
      await panel.open();
      expect(state()).to.deep.include({ phase: 'ready', model: 'model-a' });
      expect(state().models.map(model => model.title)).to.deep.equal([ 'Model A', 'Model B' ]);
      expect(state().usage).to.deep.include({ used: 0, limit: 5000, remaining: 5000 });
      expect(panel.client.csrf()).to.deep.include({ name: 'csrf' });
    });

    it('does a reversible action at once, waits on the irreversible one, then approves, and undoes the first', async () => {
      const { panel, state, refreshed, world } = await open(kind, {
        replies: [
          asks([ 'c1', 'note_add', { text: 'hi' } ]),
          both('Added. Now cancelling.', 'c2', 'request_cancel', { id: 'r1' }),
          says('All done.')
        ]
      }, { url: '/articles/x', context: [ { type: 'article', id: 'x', label: 'An article' } ] });
      await panel.open();

      //J-001: the reversible action ran, shows Done with Undo, the page refreshed
      await panel.send('Add a note and cancel r1');
      expect(kinds(state())).to.deep.equal([
        'user', 'note_add:done', 'agent', 'request_cancel:waiting'
      ]);
      const [ added, cancel ] = cards(state());
      expect(added).to.include({ undoable: true });
      expect(cancel).to.include({ undoable: false });
      expect(cancel.input).to.deep.equal({ id: 'r1' });
      expect(cancel.expires).to.be.a('string');
      expect(state().focus!.id).to.equal(cancel.id);
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-add' ]);
      expect(refreshed).to.have.length(1);
      //the page address and the item reached the model as hints, through the routes
      expect(chips(state()).map(chip => chip.label)).to.deep.equal([ '/articles/x', 'An article' ]);

      //J-002: nothing ran until approved; then it runs once, with no Undo
      await panel.approve(cancel.id);
      expect(cards(state()).map(item => [ item.tool, item.status, item.undoable ])).to.deep.equal([
        [ 'note_add', 'done', true ], [ 'request_cancel', 'done', false ]
      ]);
      expect(state().conversation.items.slice(-1)[0]).to.deep.include({ kind: 'agent', text: 'All done.' });
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-add', 'request-cancel' ]);
      expect(refreshed).to.have.length(2);

      //a repeated approval from a stale page runs nothing: the card is not offered it
      await panel.approve(cancel.id);
      expect(world.ran).to.have.length(2);

      //J-003: undo, through the same routes, with no second approval
      await panel.undo(added.id);
      expect(cards(state())[0]).to.include({ status: 'undone', undoable: false });
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'note-add', 'request-cancel', 'note-remove' ]);
      expect(refreshed).to.have.length(3);

      //J-007: history lists it, and opening it again rebuilds the same page
      const before = kinds(state());
      await panel.showHistory();
      expect(state().threads.rows).to.have.length(1);
      expect(state().threads.rows[0].id).to.equal(state().conversation.threadId);
      await panel.newChat();
      expect(state().conversation.items).to.deep.equal([]);
      await panel.openThread(state().threads.rows[0].id);
      //A per-request host built over a frozen test clock writes rows from
      // several servers in the same millisecond, so the order the server
      // lists them in is not fixed there. Everything is on the page either way.
      expect(kind === 'long-lived' ? kinds(state()) : kinds(state()).slice().sort())
        .to.deep.equal(kind === 'long-lived' ? before : before.slice().sort());
      expect(cards(state()).map(item => item.status)).to.deep.equal([ 'undone', 'done' ]);
    });

    it('declines, and the agent goes on with no action', async () => {
      const { panel, state, world } = await open(kind, {
        replies: [ asks([ 'c1', 'request_cancel', { id: 'r1' } ]), says('Understood, left it alone.') ]
      });
      await panel.open();
      await panel.send('Cancel r1');
      const [ cancel ] = cards(state());
      expect(cancel.status).to.equal('waiting');
      await panel.decline(cancel.id);
      expect(cards(state())[0]).to.include({ status: 'declined' });
      expect(state().conversation.items.slice(-1)[0]).to.deep.include({ text: 'Understood, left it alone.' });
      expect(world.ran).to.have.length(0);
    });

    it('shows a waiting card again after a reload, and approval still works from the stored turn', async () => {
      const { me, world } = await open(kind, {
        replies: [ asks([ 'c1', 'request_cancel', { id: 'r1' } ]), says('Cancelled it.') ]
      });
      const memory: Record<string, string> = {};
      const keep = {
        getItem: (key: string) => memory[key] ?? null,
        setItem: (key: string, value: string) => { memory[key] = value; },
        removeItem: (key: string) => { delete memory[key]; }
      };
      const first = createPanel({ fetch: sameOrigin(me), storage: keep, url: '/x', onRefresh: () => undefined });
      await first.open();
      await first.send('Cancel r1');
      first.setDraft('half typed');
      first.destroy();

      //a new page, a new panel, the same storage
      const second = createPanel({ fetch: sameOrigin(me), storage: keep, url: '/x', onRefresh: () => undefined });
      await second.mount();
      expect(second.getState()).to.deep.include({ open: true, phase: 'ready', draft: 'half typed' });
      const [ cancel ] = cards(second.getState());
      expect(cancel).to.include({ status: 'waiting' });
      expect(second.getState().focus!.id).to.equal(cancel.id);
      await second.approve(cancel.id);
      expect(cards(second.getState())[0].status).to.equal('done');
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-cancel' ]);
    });

    it('shows the app refusing an undo as its own reason, and leaves the card as it was', async () => {
      const { panel, state, world } = await open(kind, {
        replies: [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Added.') ]
      });
      await panel.open();
      await panel.send('Add a note');
      world.behave.noteRemove = 'conflict';
      await panel.undo(cards(state())[0].id);
      expect(cards(state())[0]).to.include({ status: 'done', undoable: true });
      //the app's own reason, as the server records it
      expect(cards(state())[0].undoError).to.include('The note changed since.');
    });

    it('shows a failed action with the app’s refusal', async () => {
      const { panel, state } = await open(kind, {
        replies: [ asks([ 'c1', 'forbidden_thing' ]), says('I could not do that.') ]
      });
      await panel.open();
      await panel.send('Do the forbidden thing');
      expect(cards(state())[0].status).to.equal('failed');
      expect(cards(state())[0].error).to.include('You may not change this.');
    });

    it('streams and answers once with the same events, as far as the panel is concerned', async () => {
      const script = [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Added.') ];
      const run = async (stream: boolean) => {
        const made = await open(kind, { replies: script }, { stream });
        await made.panel.open();
        const seen: AgentEvent[] = [];
        const client = createClient({ fetch: sameOrigin(made.me), stream });
        await client.send({ message: 'Add a note' }, event => seen.push(event));
        return seen.map(plain);
      };
      const streamed = await run(true);
      const single = await run(false);
      expect(streamed.map(event => event.type)).to.include.members([ 'thread', 'action-done', 'text', 'finished' ]);
      expect(single).to.deep.equal(streamed);
    });

    it('shows a reply that comes in pieces, as it comes', async () => {
      const { panel, state } = await open(kind, {
        pause: 30, replies: [ says('A reply in one piece.') ]
      });
      await panel.open();
      const sending = panel.send('Hello');
      await new Promise(resolve => setTimeout(resolve, 5));
      //the person's message is on the page, and the reply is on its way
      expect(state().running).to.equal(true);
      expect(kinds(state())).to.deep.equal([ 'user' ]);
      await sending;
      expect(kinds(state())).to.deep.equal([ 'user', 'agent' ]);
      expect(state().running).to.equal(false);
    });

    it('shows signed out for a visitor, and again when the sign-in is tampered with', async () => {
      const { site } = await open(kind);
      const visitor = browser(site.base, null);
      const out = createPanel({ fetch: sameOrigin(visitor), storage: null });
      await out.open();
      expect(out.getState().phase).to.equal('signed-out');

      const ready = await setupWith(engine, {});
      const served = await serve(ready.world, kind);
      closers.push(served.close);
      const forged = browser(served.base, `${ready.token}x`);
      const bad = createPanel({ fetch: sameOrigin(forged), storage: null });
      await bad.open();
      expect(bad.getState().phase).to.equal('signed-out');
    });

    it('shows the daily limit once it is reached, with when it resets, and sends nothing more', async () => {
      const { panel, state, world } = await open(kind, {
        config: { limit: 10 }, replies: [ says('Used.', 8, 5), says('Never.') ]
      });
      await panel.open();
      await panel.send('First');
      expect(state().phase).to.equal('ready');
      await panel.send('Second');
      expect(state().phase).to.equal('limit');
      expect(state().resetsAt).to.match(/T00:00:00\.000Z$/);
      //what was typed is still there, and nothing was stored or called
      expect(state().draft).to.equal('Second');
      expect(world.stub().requests.length).to.equal(1);
    });

    it('shows the agent as unavailable when no provider key is set', async () => {
      const { panel, state } = await open(kind, { env: {}, replies: [ says('Never.') ] });
      await panel.open();
      expect(state().phase).to.equal('ready');
      await panel.send('Hello');
      expect(state().phase).to.equal('unavailable');
      expect(JSON.stringify(state())).to.not.match(/API_KEY|sk-test/);
    });

    it('never lets a tampered page context change what the person may do', async () => {
      const { panel, state, world } = await open(kind, {
        replies: [ asks([ 'c1', 'request_cancel', { id: 'r1' } ]), says('Cancelled it.') ]
      }, {
        url: '/x',
        context: [ { label: 'x', role: 'ADMIN', profileId: 'someone-else', caller: { kind: 'app' } } ]
      });
      await panel.open();
      await panel.send('Cancel r1');
      const [ cancel ] = cards(state());
      //nothing ran, whatever the context claimed
      expect(cancel.status).to.equal('waiting');
      expect(world.ran).to.have.length(0);
      await panel.approve(cancel.id);
      expect(world.ran[0].caller).to.include({ kind: 'person' });
      expect(world.ran[0].caller).to.not.include({ profileId: 'someone-else' });
    });

    it('lets one person’s panel see nothing of another person’s chat', async () => {
      const { panel, state, site, world } = await open(kind, { replies: [ says('Mine.') ] });
      await panel.open();
      await panel.send('Hello');
      const id = state().conversation.threadId!;
      const other = browser(site.base, await world.token('someone_else'));
      const theirs = createPanel({ fetch: sameOrigin(other), storage: null });
      await theirs.open();
      await theirs.showHistory();
      expect(theirs.getState().threads.rows).to.deep.equal([]);
      await theirs.openThread(id);
      expect(theirs.getState().notice).to.deep.equal({ code: 'not-found' });
      expect(theirs.getState().conversation.items).to.deep.equal([]);
    });
  });
}
