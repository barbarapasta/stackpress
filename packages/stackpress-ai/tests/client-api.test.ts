//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import {
  createClient,
  failure,
  parseEvents,
  reasonOf
} from '../src/client/api.js';
import type { AgentEvent } from '../src/client/types.js';
//tests
import {
  answer,
  events,
  refusal,
  server,
  start,
  stored,
  stream,
  thread,
  turn
} from './panel.js';

describe('the route client', () => {
  describe('reading an event stream', () => {
    const one = 'data: {"type":"text","text":"Hi"}\n\n';

    it('takes whole events out of what has arrived', () => {
      const { events: found, rest } = parseEvents(one + one);
      expect(found).to.deep.equal([
        { type: 'text', text: 'Hi' }, { type: 'text', text: 'Hi' }
      ]);
      expect(rest).to.equal('');
    });

    it('hands back an event that has only half arrived, to be finished by the next piece', () => {
      const first = parseEvents(`${one}data: {"type":"te`);
      expect(first.events).to.have.length(1);
      expect(first.rest).to.equal('data: {"type":"te');
      const second = parseEvents(`${first.rest}xt","text":"x"}\n\n`);
      expect(second.events).to.deep.equal([ { type: 'text', text: 'x' } ]);
    });

    it('reads windows line endings, a missing space and several data lines', () => {
      const { events: found } = parseEvents(
        'data:{"type":"a"}\r\n\r\ndata: {"type":\ndata: "b"}\r\n\r\n'
      );
      expect(found.map(event => event.type)).to.deep.equal([ 'a', 'b' ]);
    });

    it('skips what is not an event: comments, broken JSON, no type, not an object', () => {
      const { events: found } = parseEvents(
        ': keep-alive\n\ndata: {oops\n\ndata: {"no":"type"}\n\ndata: 5\n\ndata: null\n\nevent: x\n\ndata: {"type":"ok"}\n\n'
      );
      expect(found).to.deep.equal([ { type: 'ok' } ]);
    });
  });

  describe('why a request failed', () => {
    it('reads the reason the routes name', () => {
      for (const reason of [ 'unauthorized', 'invalid', 'not_found', 'conflict', 'busy', 'limit', 'csrf', 'unavailable' ]) {
        expect(reasonOf(400, { errors: { reason } })).to.equal(reason);
      }
    });

    it('reads the status when the answer is not the routes own, such as an error page', () => {
      expect(reasonOf(401, null)).to.equal('unauthorized');
      expect(reasonOf(403, '<html>')).to.equal('forbidden');
      expect(reasonOf(429, {})).to.equal('limit');
      expect(reasonOf(400, {})).to.equal('invalid');
      expect(reasonOf(409, {})).to.equal('conflict');
      expect(reasonOf(404, {})).to.equal('unavailable');
      expect(reasonOf(500, { errors: { reason: 'made-up' } })).to.equal('unavailable');
      expect(reasonOf(200, {})).to.equal('unknown');
    });

    it('tells a busy chat from a conflict, though both are a 409', () => {
      expect(reasonOf(409, { errors: { reason: 'busy' } })).to.equal('busy');
      expect(reasonOf(409, { errors: { reason: 'conflict' } })).to.equal('conflict');
      expect(reasonOf(409, {})).to.equal('conflict');
      expect(failure(409, { error: 'raw words', errors: { reason: 'busy' } }))
        .to.deep.equal({ ok: false, status: 409, reason: 'busy' });
    });

    it('keeps the status, the reason and the reset time, and none of the words', () => {
      const failed = failure(429, {
        error: 'raw words', errors: { reason: 'limit', resetsAt: '2026-10-06T00:00:00.000Z' }
      });
      expect(failed).to.deep.equal({
        ok: false, status: 429, reason: 'limit', resetsAt: '2026-10-06T00:00:00.000Z'
      });
      expect(JSON.stringify(failed)).to.not.include('raw words');
      expect(failure(500, { errors: { resetsAt: 5 } })).to.not.have.property('resetsAt');
    });
  });

  describe('start', () => {
    it('keeps the token and answers with the models and the allowance', async () => {
      const fake = server({ 'GET /agent/start': start() });
      const client = createClient({ fetch: fake.fetch });
      const result = await client.start();
      expect(result).to.deep.include({ ok: true, model: 'big' });
      expect(client.csrf()).to.deep.equal({ name: 'csrf', token: 'token-1' });
      expect(fake.calls[0].headers.Accept).to.equal('application/json');
    });

    it('answers a server with no anti-forgery plugin, and then refuses to write', async () => {
      const fake = server({ 'GET /agent/start': start({ csrf: null }) });
      const client = createClient({ fetch: fake.fetch });
      expect((await client.start()).ok).to.equal(true);
      expect(client.csrf()).to.equal(null);
      const sent = await client.send({ message: 'Hi' });
      expect(sent).to.deep.include({ ok: false, reason: 'unavailable' });
      expect(fake.count('POST', '/agent/turn')).to.equal(0);
    });

    it('fails on a refusal, an answer that is not the start answer, and a request that never arrived', async () => {
      const client = (routes: Parameters<typeof server>[0]) => createClient({
        fetch: server(routes).fetch
      });
      expect(await client({ 'GET /agent/start': refusal(401, 'unauthorized') }).start())
        .to.deep.equal({ ok: false, status: 401, reason: 'unauthorized' });
      expect(await client({}).start()).to.deep.include({ ok: false, reason: 'unavailable' });
      expect(await client({ 'GET /agent/start': answer({ nothing: true }) }).start())
        .to.deep.include({ ok: false, reason: 'unknown' });
      expect(await client({ 'GET /agent/start': new Response('not json', { status: 200 }) }).start())
        .to.deep.include({ ok: false, reason: 'unknown' });
      const down = createClient({ fetch: async () => { throw new TypeError('fetch failed'); } });
      expect(await down.start()).to.deep.equal({ ok: false, status: 0, reason: 'network' });
    });

    it('works from a base path with or without slashes', async () => {
      const fake = server({ 'GET /ai/chat/start': start() });
      expect((await createClient({ base: 'ai/chat/', fetch: fake.fetch }).start()).ok).to.equal(true);
    });
  });

  describe('a write', () => {
    const routes = () => server({
      'GET /agent/start': start({ csrf: { name: 'token', token: 'abc' } }),
      'POST /agent/turn': events([ { type: 'finished', status: 'done' } ]),
      'POST /agent/actions/a%2F1/approve': events([ { type: 'finished', status: 'done' } ]),
      'POST /agent/actions/a1/decline': events([ { type: 'finished', status: 'done' } ]),
      'POST /agent/actions/a1/undo': answer({ ok: true, status: 'undone', events: [] }),
      'POST /agent/threads': answer({ ok: true, thread: thread(), reused: false })
    });

    it('starts the panel on its own when it has no token yet, and sends the token the start route gave in the body, under that name', async () => {
      const fake = routes();
      const client = createClient({ fetch: fake.fetch });
      await client.send({ message: 'Hi', threadId: 't1' });
      expect(fake.paths()).to.deep.equal([ 'GET /agent/start', 'POST /agent/turn' ]);
      expect(fake.calls[1].body).to.deep.equal({ message: 'Hi', threadId: 't1', token: 'abc' });
      expect(fake.calls[1].headers['Content-Type']).to.equal('application/json');
    });

    it('asks for a stream on a message, an approval and a decline, and for one answer on an undo and a new chat', async () => {
      const fake = routes();
      const client = createClient({ fetch: fake.fetch });
      await client.send({ message: 'Hi' });
      await client.approve('a/1');
      await client.decline('a1');
      await client.undo('a1');
      await client.create({ url: '/x' });
      const accept = (path: string) => fake.calls.find(call => call.path === path)!.headers.Accept;
      expect(accept('/agent/turn')).to.include('text/event-stream');
      expect(accept('/agent/actions/a%2F1/approve')).to.include('text/event-stream');
      expect(accept('/agent/actions/a1/decline')).to.include('text/event-stream');
      expect(accept('/agent/actions/a1/undo')).to.equal('application/json');
      expect(accept('/agent/threads')).to.equal('application/json');
      expect(fake.calls.find(call => call.path === '/agent/threads')!.body)
        .to.deep.equal({ context: { url: '/x' }, token: 'abc' });
    });

    it('does not ask for a stream when told not to', async () => {
      const fake = server({
        'GET /agent/start': start(),
        'POST /agent/turn': answer({ ok: true, events: [ { type: 'finished', status: 'done' } ] })
      });
      const client = createClient({ fetch: fake.fetch, stream: false });
      await client.send({ message: 'Hi' });
      expect(fake.calls[1].headers.Accept).to.equal('application/json');
    });

    it('hands over events in order as pieces arrive, even when a piece ends inside an event', async () => {
      const text = (value: string) => `data: ${JSON.stringify({ type: 'text', text: value })}\n\n`;
      const whole = text('one') + text('two') + 'data: {"type":"finished","status":"done"}\n\n';
      const cut = [ whole.slice(0, 20), whole.slice(20, 61), whole.slice(61) ];
      const fake = server({ 'GET /agent/start': start(), 'POST /agent/turn': stream(cut) });
      const seen: AgentEvent[] = [];
      const result = await createClient({ fetch: fake.fetch })
        .send({ message: 'Hi' }, event => seen.push(event));
      expect(result).to.deep.equal({ ok: true, finished: true });
      expect(seen).to.deep.equal([
        { type: 'text', text: 'one' }, { type: 'text', text: 'two' },
        { type: 'finished', status: 'done' }
      ]);
    });

    it('says a stream did not finish when it ends early or breaks', async () => {
      for (const failing of [ false, true ]) {
        const fake = server({
          'GET /agent/start': start(),
          'POST /agent/turn': events([ { type: 'text', text: 'Hi' } ], { fail: failing })
        });
        const seen: AgentEvent[] = [];
        const result = await createClient({ fetch: fake.fetch })
          .send({ message: 'Hi' }, event => seen.push(event));
        expect(result).to.deep.equal({ ok: true, finished: false });
        expect(seen).to.have.length(1);
      }
    });

    it('reports a stream the person walked away from as aborted', async () => {
      const abort = new AbortController();
      const fake = server({
        'GET /agent/start': start(),
        'POST /agent/turn': () => {
          abort.abort();
          return events([ { type: 'text', text: 'Hi' } ], { fail: true });
        }
      });
      const result = await createClient({ fetch: fake.fetch })
        .send({ message: 'Hi' }, undefined, abort.signal);
      expect(result).to.deep.equal({ ok: false, status: 0, reason: 'aborted' });
    });

    it('reads a stream whole when the browser cannot read it piece by piece', async () => {
      const bodyless = {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        body: null,
        text: async () => 'data: {"type":"text","text":"Hi"}\n\ndata: {"type":"finished","status":"done"}\n\n'
      } as unknown as Response;
      const fake = server({ 'GET /agent/start': start(), 'POST /agent/turn': () => bodyless });
      const seen: AgentEvent[] = [];
      const result = await createClient({ fetch: fake.fetch })
        .send({ message: 'Hi' }, event => seen.push(event));
      expect(result).to.deep.equal({ ok: true, finished: true });
      expect(seen.map(event => event.type)).to.deep.equal([ 'text', 'finished' ]);
    });

    it('falls back to the single answer, giving the same events', async () => {
      const list: AgentEvent[] = [
        { type: 'text', text: 'Hi' }, { type: 'finished', status: 'done' }
      ];
      const streamed = server({ 'GET /agent/start': start(), 'POST /agent/turn': events(list) });
      const single = server({ 'GET /agent/start': start(), 'POST /agent/turn': answer({ ok: true, events: [ ...list, 5, null ] }) });
      const a: AgentEvent[] = [];
      const b: AgentEvent[] = [];
      await createClient({ fetch: streamed.fetch }).send({ message: 'Hi' }, event => a.push(event));
      const result = await createClient({ fetch: single.fetch }).send({ message: 'Hi' }, event => b.push(event));
      expect(b).to.deep.equal(a);
      expect(result).to.deep.include({ ok: true, finished: true });
      expect((result as { results: { ok: boolean } }).results.ok).to.equal(true);
    });

    it('takes a fresh token and tries once more when the token is refused, then stops', async () => {
      let sent = 0;
      let started = 0;
      const fake = server({
        'GET /agent/start': () => start({ csrf: { name: 'csrf', token: `token-${++started}` } }),
        'POST /agent/turn': call => {
          sent++;
          return call.body.csrf === 'token-2'
            ? events([ { type: 'finished', status: 'done' } ])
            : refusal(403, 'csrf');
        }
      });
      const client = createClient({ fetch: fake.fetch });
      expect(await client.send({ message: 'Hi' })).to.deep.include({ ok: true, finished: true });
      expect(sent).to.equal(2);

      const stuck = server({
        'GET /agent/start': start(),
        'POST /agent/turn': refusal(403, 'csrf')
      });
      const result = await createClient({ fetch: stuck.fetch }).send({ message: 'Hi' });
      expect(result).to.deep.equal({ ok: false, status: 403, reason: 'csrf' });
      expect(stuck.count('POST', '/agent/turn')).to.equal(2);
    });

    it('does not retry any other refusal, and never keeps the server words', async () => {
      for (const [ status, reason ] of [
        [ 401, 'unauthorized' ], [ 400, 'invalid' ], [ 404, 'not_found' ],
        [ 429, 'limit' ], [ 503, 'unavailable' ]
      ] as [ number, string ][]) {
        const fake = server({
          'GET /agent/start': start(),
          'POST /agent/turn': refusal(status, reason, reason === 'limit' ? { resetsAt: 'later' } : {})
        });
        const result = await createClient({ fetch: fake.fetch }).send({ message: 'Hi' });
        expect(result).to.include({ ok: false, status, reason });
        expect(JSON.stringify(result)).to.not.include('raw server words');
        expect(fake.count('POST', '/agent/turn')).to.equal(1);
      }
    });

    it('fails with the start failure when the token cannot be had, and when the network is down', async () => {
      const refused = server({ 'GET /agent/start': refusal(401, 'unauthorized') });
      expect(await createClient({ fetch: refused.fetch }).send({ message: 'Hi' }))
        .to.deep.equal({ ok: false, status: 401, reason: 'unauthorized' });
      let calls = 0;
      const flaky = createClient({
        fetch: async input => {
          if (input.endsWith('/start')) return start();
          calls++;
          throw new TypeError('fetch failed');
        }
      });
      expect(await flaky.send({ message: 'Hi' })).to.deep.equal({ ok: false, status: 0, reason: 'network' });
      expect(calls).to.equal(1);
    });
  });

  describe('reading', () => {
    it('lists threads and loads one, with its id encoded', async () => {
      const fake = server({
        'GET /agent/threads': answer({ ok: true, threads: [ thread() ] }),
        'GET /agent/threads/t%201': answer({
          ok: true, thread: thread({ id: 't 1' }), turns: [ turn() ], actions: [ stored() ]
        }),
        'GET /agent/threads/none': answer({ ok: true }),
        'GET /agent/threads/gone': refusal(404, 'not_found'),
        'GET /agent/threads/odd': answer({ ok: true, thread: { id: 'odd' } })
      });
      const client = createClient({ fetch: fake.fetch });
      expect(await client.threads()).to.deep.equal({ ok: true, threads: [ thread() ] });
      const loaded = await client.thread('t 1');
      expect(loaded).to.deep.include({ ok: true });
      expect((loaded as { turns: unknown[] }).turns).to.have.length(1);
      expect((loaded as { actions: unknown[] }).actions).to.have.length(1);
      expect(await client.thread('none')).to.deep.include({ ok: false, reason: 'unknown' });
      expect(await client.thread('gone')).to.deep.include({ ok: false, reason: 'not_found' });
      const odd = await client.thread('odd') as { turns: unknown[], actions: unknown[] };
      expect(odd.turns).to.deep.equal([]);
      expect(odd.actions).to.deep.equal([]);
    });

    it('treats a threads answer with no list as an empty one, and a refusal as a failure', async () => {
      const fake = server({ 'GET /agent/threads': answer({ ok: true }) });
      expect(await createClient({ fetch: fake.fetch }).threads()).to.deep.equal({ ok: true, threads: [] });
      const refused = server({ 'GET /agent/threads': refusal(401, 'unauthorized') });
      expect(await createClient({ fetch: refused.fetch }).threads()).to.deep.include({ ok: false, reason: 'unauthorized' });
    });
  });
});
