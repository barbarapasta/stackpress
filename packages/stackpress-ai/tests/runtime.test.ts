//modules
import { expect } from 'chai';
import { before, describe, it } from 'mocha';
//client
import { ProviderError } from '../src/adapters/index.js';
import {
  MAX_OUTPUT,
  UNAVAILABLE,
  body,
  buildTranscript,
  createRuntime,
  describeHints,
  inverseOf,
  needsApproval,
  operationOf,
  parseInput,
  person,
  render,
  resetsAt,
  watch,
  watcher
} from '../src/scripts/agent.js';
import { approve, decline, undo } from '../src/scripts/approval.js';
import { listThreads } from '../src/scripts/threads.js';
import { runTurn } from '../src/scripts/turn.js';
import { normalizeTool } from '../src/helpers.js';
import type {
  AgentAction,
  AgentEvent,
  AgentTurn,
  NormalizedToolConfig
} from '../src/types.js';
//tests
import {
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
import { createEngine, createWorld } from './harness.js';
import type { WorldOptions } from './harness.js';

//These tests cover what the journeys do not name: who the person is, how a
// provider failure is reported, model choice, the rebuilt transcript, and the
// small pure helpers.

let engine: Engine;

before(async function () {
  this.timeout(60000);
  engine = await createEngine();
});

const setup = (options: WorldOptions = {}) => setupWith(engine, options);

describe('agent runtime', function () {
  this.timeout(30000);

  describe('J-013 an operator turns the agent on', () => {
    it('step 3: reports itself unavailable without a key, before storing anything or calling a provider', async () => {
      const env = {};
      const { world, profileId, say } = await setup({ env, replies: [ says('Hi.') ] });
      const result = refused(await say('Hello'));
      expect(result).to.include({ code: 503, reason: 'unavailable', error: UNAVAILABLE });
      //the variable's name is the operator's business, not the person's
      expect(JSON.stringify(result)).to.not.contain('API_KEY');

      expect(world.stub()).to.equal(undefined);
      expect(await world.rows('agent_thread', 'profile_id', profileId)).to.deep.equal([]);
      expect(world.logs.map(log => log.message)).to.deep.equal([
        'No key is set for the "openrouter" provider.'
      ]);

      //the server went on running, and answers once a key is set
      (env as Record<string, string>).OPENROUTER_API_KEY = 'sk-now-set';
      expect(accepted(await say('Hello again')).status).to.equal('done');
    });

    it('step 3: an empty key, or a provider with no key configured, is also unavailable', async () => {
      const empty = await setup({ env: { OPENROUTER_API_KEY: '' } });
      expect(refused(await empty.say('Hello')).code).to.equal(503);

      const none = await setup({ config: { providers: {} } });
      expect(refused(await none.say('Hello')).code).to.equal(503);
    });

    it('step 3: a provider that cannot be opened is unavailable', async () => {
      const set = await setup();
      set.world.rt.connect = async () => { throw new Error('Cannot find package'); };
      expect(refused(await set.say('Hello')).code).to.equal(503);
      expect(set.world.logs[0].message).to.contain('could not be opened');
    });

    it('step 3: a default model that is not offered is unavailable', async () => {
      const { say } = await setup({ config: { model: 'model-z' } });
      expect(refused(await say('Hello')).error).to.equal(UNAVAILABLE);
    });

    it('step 3: a key the provider rejects is reported as unavailable without the provider\'s text', async () => {
      const { world, say } = await setup({
        replies: [ new ProviderError('openrouter', 'authentication', 'Invalid API key sk-live-abc123', { status: 401 }) ]
      });
      const result = accepted(await say('Hello'));
      expect(result.status).to.equal('unavailable');
      const error = result.events.find(event => event.type === 'error');
      expect(error).to.deep.equal({ type: 'error', status: 'unavailable', message: UNAVAILABLE });
      expect(JSON.stringify(result)).to.not.contain('sk-live-abc123');
      //the operator can still see it
      expect((world.logs[0].error as Error).message).to.contain('sk-live-abc123');
      expect(types(result.events).slice(-1)).to.deep.equal([ 'finished' ]);
    });

    it('builds the runtime from config, and tolerates missing sections', async () => {
      const ctx = createWorld(engine, { config: { model: 'model-b' } });
      expect(createRuntime(ctx.app).config).to.include({ model: 'model-b' });

      //no agent section reads as an empty one
      const bare = createRuntime({
        config: { path: <T>(_: string, fallback?: T) => fallback as T },
        register() {},
        plugin() {}
      } as never);
      expect(bare.config).to.deep.equal({ providers: {}, model: '', models: [] });
      expect(bare.env).to.equal(process.env);
      //the default adapter opener names the provider it was asked for
      let seen: unknown;
      const custom = createRuntime(ctx.app, {
        connect: async (model, key) => { seen = [ model.model, key ]; return {} as never; }
      });
      await custom.connect({ provider: 'openai', model: 'm' }, 'k');
      expect(seen).to.deep.equal([ 'm', 'k' ]);
    });
  });

  describe('J-014 a background run with no person', () => {
    it('refuses a call from a job that has no session, and runs nothing', async () => {
      const { world, profileId } = await setup({ replies: [ says('Unused.') ] });
      const data = { message: 'Run the nightly report' };
      const result = refused(await runTurn(world.rt, world.request(null, data), data));
      expect(result).to.include({ code: 401, reason: 'unauthorized' });
      expect(world.stub()).to.equal(undefined);
      expect(await world.rows('agent_thread', 'profile_id', profileId)).to.deep.equal([]);
    });

    it('refuses a request with no session at all, and one when no session plugin exists', async () => {
      const { world } = await setup({ replies: [ says('Unused.') ] });
      const bare = { data: () => ({}), url: new URL('http://x.test/') } as never;
      expect(refused(await runTurn(world.rt, bare, { message: 'Hi' })).code).to.equal(401);
      expect(await person(world.app, bare)).to.equal(null);

      const token = await world.token('someone');
      const request = world.request(token, { message: 'Hi' });
      const rt = createRuntime(createWorld(engine).app);
      rt.ctx.plugin = (() => undefined) as never;
      expect(refused(await runTurn(rt, request, { message: 'Hi' })).code).to.equal(401);
    });

    it('does not take a person from a session whose token has no id', async () => {
      const { world } = await setup();
      const { Session } = await import('stackpress-session');
      const token = await Session.create({ name: 'No Id', roles: [ 'USER' ] } as never);
      expect(await person(world.app, world.request(token))).to.equal(null);
    });
  });

  describe('who the person is', () => {
    it('comes only from the verified session, never from the body, the context, or a tool input', async () => {
      const { world, profileId, token, say } = await setup({
        replies: [
          asks([ 'c1', 'note_add', { text: 'hi', profileId: 'victim', sessionId: 'victim', applicationId: 'victim' } ]),
          says('Done.')
        ]
      });
      const result = accepted(await say('Add a note as someone else', {
        profileId: 'victim',
        sessionId: 'victim',
        applicationId: 'victim',
        context: { url: '/x', profileId: 'victim', items: [ { profileId: 'victim' } ] }
      }));

      //the thread, the action, and the app event all belong to the signed-in person
      expect((await world.rows('agent_thread', 'id', result.threadId))[0].profile_id).to.equal(profileId);
      expect((await actionsOf(world, result.threadId))[0].profile_id).to.equal(profileId);
      expect(world.ran[0].caller).to.include({ kind: 'person', profileId });
      expect(world.ran[0].session.session).to.equal(token);
      //identity fields in a tool input are stripped before the event sees it
      expect(world.ran[0].input).to.deep.equal({ text: 'hi' });
      expect(await world.rows('agent_thread', 'profile_id', 'victim')).to.deep.equal([]);
    });

    it('is read as a number or text id, and roles are kept', async () => {
      const { world } = await setup();
      const { Session } = await import('stackpress-session');
      const numeric = await Session.create({ id: 42, name: 'N', roles: [ 'ADMIN', 'USER' ] } as never);
      expect(await person(world.app, world.request(numeric))).to.deep.equal({
        kind: 'person', profileId: '42', roles: [ 'ADMIN', 'USER' ], scopes: []
      });
      const plain = await Session.create({ id: 'p', name: 'P' } as never);
      expect((await person(world.app, world.request(plain)))?.roles).to.deep.equal([]);
    });
  });

  describe('provider failures', () => {
    it('reports a rate limit as busy, with the wait the provider asked for', async () => {
      const { say } = await setup({
        replies: [ new ProviderError('stub', 'rate_limit', 'slow down', { retryAfter: 7 }) ]
      });
      const result = accepted(await say('Hello'));
      expect(result.status).to.equal('busy');
      expect(result.events.find(event => event.type === 'error')).to.deep.equal({
        type: 'error', status: 'busy', message: 'The model is busy. Try again in a moment.', retryAfter: 7
      });
    });

    it('reports a rate limit with no stated wait', async () => {
      const { say } = await setup({
        replies: [ new ProviderError('stub', 'rate_limit', 'slow down') ]
      });
      const error = accepted(await say('Hello')).events.find(event => event.type === 'error') as AgentEvent & { retryAfter?: number };
      expect(error.retryAfter).to.equal(undefined);
    });

    it('reports a provider refusal, whether thrown or returned', async () => {
      const thrown = await setup({
        replies: [ new ProviderError('stub', 'refusal', 'policy text') ]
      });
      const first = accepted(await thrown.say('Hello'));
      expect(first.status).to.equal('refusal');
      expect(JSON.stringify(first)).to.not.contain('policy text');

      const returned = await setup({ replies: [ { stop: 'refusal', usage: { input: 3, output: 0 } } ] });
      const second = accepted(await returned.say('Hello'));
      expect(second.status).to.equal('refusal');
      expect(second.events.find(event => event.type === 'error')).to.include({ status: 'refusal' });
    });

    it('reports any other failure plainly, and logs the detail', async () => {
      for (const error of [
        new ProviderError('stub', 'other', 'upstream said: key sk-1'),
        new Error('socket hang up')
      ]) {
        const { world, say } = await setup({ replies: [ error ] });
        const result = accepted(await say('Hello'));
        expect(result.status).to.equal('failed');
        expect(JSON.stringify(result)).to.not.contain('sk-1');
        expect(JSON.stringify(result)).to.not.contain('socket');
        expect(world.logs[0].error).to.equal(error);
      }
    });

    it('stops a reply that was cut off, and still stores it and counts it', async () => {
      const { world, profileId, say } = await setup({
        replies: [ { text: 'Partial', stop: 'length', usage: { input: 4, output: 9 } } ]
      });
      const result = accepted(await say('Write a lot'));
      expect(result.status).to.equal('length');
      expect(result.events.find(event => event.type === 'error')).to.include({ status: 'length' });
      expect((await world.rt.store.getUsage(profileId)).outputTokens).to.equal(9);
    });

    it('sends a paused provider turn again', async () => {
      const { world, say } = await setup({
        replies: [ { text: 'Thinking...', stop: 'pause' }, says('Finished.') ]
      });
      const result = accepted(await say('Hello'));
      expect(result.status).to.equal('done');
      expect(world.stub().requests.length).to.equal(2);
    });

    it('still ends the run when a provider fails after tools ran, and leaves a usable transcript', async () => {
      const { world, say } = await setup({
        replies: [
          asks([ 'c1', 'note_add', { text: 'hi' } ]),
          new ProviderError('stub', 'other', 'boom'),
          says('Back again.')
        ]
      });
      const first = accepted(await say('Add a note'));
      expect(first.status).to.equal('failed');
      //the next message continues from a transcript every call of which was answered
      accepted(await say('Try again', { threadId: first.threadId }));
      const request = world.stub().requests[2];
      expect(request.turns.map(turn => turn.role)).to.deep.equal([ 'user', 'assistant', 'tool', 'user' ]);
    });
  });

  describe('model choice', () => {
    it('uses the default, then the model the person picks, and keeps that choice', async () => {
      const { world, token, say } = await setup({
        replies: { 'model-a': [ says('From A.') ], 'model-b': [ says('From B.'), says('B again.') ] }
      });
      const first = accepted(await say('Hello', { model: 'model-b' }));
      expect((await world.rows('agent_thread', 'id', first.threadId))[0].model).to.equal('model-b');
      expect(world.stub('model-b').requests.length).to.equal(1);

      //no model named: the thread stays on the last one
      accepted(await say('Again', { threadId: first.threadId }));
      expect(world.stub('model-b').requests.length).to.equal(2);
      expect(world.stub('model-a')).to.equal(undefined);

      //a new model applies from the next reply, and earlier turns are rebuilt for it
      accepted(await say('Switch', { threadId: first.threadId, model: 'model-a' }));
      const request = world.stub('model-a').requests[0];
      const assistants = request.turns.filter(turn => turn.role === 'assistant');
      expect(assistants.length).to.equal(2);
      expect(assistants[0]).to.deep.include({ text: 'From B.' });
      //a reply is handed back exactly as stored, for its adapter to replay or rebuild
      expect((assistants[0] as { raw: unknown }).raw).to.deep.equal({ provider: 'stub', model: 'model-b' });

      //an unchanged default for a new thread
      const fresh = accepted(await runTurn(world.rt, world.request(token, { message: 'New' }), { message: 'New' }));
      expect((await world.rows('agent_thread', 'id', fresh.threadId))[0].model).to.equal('model-a');
    });

    it('refuses a model that is not in the configured list', async () => {
      const { world, say } = await setup({ replies: [ says('Unused.') ] });
      const result = refused(await say('Hello', { model: 'gpt-anything' }));
      expect(result).to.include({ code: 400, reason: 'invalid' });
      expect(world.stub()).to.equal(undefined);
    });

    it('falls back to the default when the thread\'s model is no longer offered', async () => {
      const { world, say } = await setup({
        replies: { 'model-a': [ says('From A.') ], 'model-b': [ says('From B.') ] }
      });
      const first = accepted(await say('Hello', { model: 'model-b' }));
      //a server whose list no longer has that model
      const later = createWorld(engine, {
        config: { models: [ { provider: 'openrouter', model: 'model-a' } ] },
        replies: [ says('From A.') ]
      });
      const token = await world.token((await world.rows('agent_thread', 'id', first.threadId))[0].profile_id as string);
      const data = { threadId: first.threadId, message: 'Again' };
      accepted(await runTurn(later.rt, later.request(token, data), data));
      expect(later.stub('model-a').requests.length).to.equal(1);
    });

    it('continues an approved turn on the model that was answering', async () => {
      const { world, token, say } = await setup({
        replies: {
          'model-b': [ asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), says('Cancelled.') ]
        }
      });
      const first = accepted(await say('Cancel it', { model: 'model-b' }));
      const [ action ] = await actionsOf(world, first.threadId);
      const data = { actionId: action.id };
      accepted(await approve(world.rt, world.request(token, data), data));
      expect(world.stub('model-b').requests.length).to.equal(2);
      expect(world.stub('model-a')).to.equal(undefined);
    });

    it('reports itself unavailable when an approved turn cannot reach its provider, after settling the action', async () => {
      const env: Record<string, string> = { OPENROUTER_API_KEY: 'sk-a', ANTHROPIC_API_KEY: 'sk-b' };
      const { world, token, say } = await setup({
        env,
        replies: [ asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), says('Cancelled.') ]
      });
      const first = accepted(await say('Cancel it'));
      const [ action ] = await actionsOf(world, first.threadId);
      delete env.OPENROUTER_API_KEY;
      const data = { actionId: action.id };
      const result = accepted(await approve(world.rt, world.request(token, data), data));
      expect(result.status).to.equal('unavailable');
      //the person's approval was honoured
      expect(world.ran.map(ran => ran.event)).to.deep.equal([ 'request-cancel' ]);
      expect(result.action).to.include({ status: 'done' });
    });
  });

  describe('the transcript', () => {
    it('is rebuilt from stored turns, with the provider\'s record handed back unchanged', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Added.'), says('Anything else?') ]
      });
      const first = accepted(await say('Add a note'));
      accepted(await say('Thanks', { threadId: first.threadId }));

      const request = world.stub().requests[2];
      expect(request.turns.map(turn => turn.role)).to.deep.equal([
        'user', 'assistant', 'tool', 'assistant', 'user'
      ]);
      const assistant = request.turns[1];
      if (assistant.role !== 'assistant') throw new Error('expected an assistant turn');
      expect(assistant.toolCalls).to.deep.equal([ { id: 'c1', name: 'note_add', input: { text: 'hi' } } ]);
      expect(assistant.usage).to.deep.equal({ input: 10, output: 5 });
      expect(assistant.raw).to.deep.equal({ provider: 'stub', model: 'model-a' });
    });

    it('stores every reply with its usage and adds it to the person\'s day', async () => {
      const { world, profileId, say } = await setup({
        replies: [ { ...asks([ 'c1', 'request_find' ]), usage: { input: 100, output: 20 } }, says('Two.', 30, 4) ]
      });
      const result = accepted(await say('Find'));
      const turns = await turnsOf(world, result.threadId);
      expect(turns.map(turn => [ turn.role, turn.input_tokens, turn.output_tokens ])).to.deep.equal([
        [ 'user', 0, 0 ], [ 'assistant', 100, 20 ], [ 'tool', 0, 0 ], [ 'assistant', 30, 4 ]
      ]);
      expect(turns[1]).to.include({ provider: 'stub', model: 'model-a' });
      expect(JSON.parse(turns[1].raw as string)).to.deep.equal({ provider: 'stub', model: 'model-a' });
      const usage = await world.rt.store.getUsage(profileId);
      expect(usage).to.include({ inputTokens: 130, outputTokens: 24, turns: 2 });
    });

    it('answers a call whose result was lost, so the provider never sees a call without one', async () => {
      const { world, profileId, say } = await setup({ replies: [ says('Fine.') ] });
      //a thread whose last step stopped before its tool turn was stored
      const store = world.rt.store;
      const thread = await store.createThread({ profileId, title: 'Interrupted' });
      await store.appendTurn(thread.id, profileId, { role: 'user', text: 'Add' });
      await store.appendTurn(thread.id, profileId, {
        role: 'assistant', toolCalls: [ { id: 'lost', name: 'note_add', input: {} } ]
      });
      accepted(await say('Hello?', { threadId: thread.id }));

      const turns = world.stub().requests[0].turns;
      expect(turns.map(turn => turn.role)).to.deep.equal([ 'user', 'assistant', 'tool', 'user' ]);
      const results = turns[2];
      if (results.role !== 'tool') throw new Error('expected a tool turn');
      expect(results.results).to.deep.equal([
        { id: 'lost', name: 'note_add', output: 'This action did not finish and its result was lost.', isError: true }
      ]);
      //the stored turns were not changed
      expect(await turnsOf(world, thread.id)).to.have.length(3 + 1);
    });

    it('survives a stored reply it cannot read, and answers every call of a short tool turn', () => {
      const turn = (extra: Partial<AgentTurn>) => ({
        id: 't', threadId: 'x', role: 'user', inputTokens: 0, outputTokens: 0, created: '', ...extra
      }) as AgentTurn;
      const transcript = buildTranscript([
        turn({ role: 'assistant', text: 'x', raw: '{not json', toolCalls: [
          { id: 'a', name: 'one' }, { id: 'b', name: 'two', input: 'not an object' }, { nope: true }
        ] }),
        turn({ role: 'tool', toolResults: [
          { id: 'a', name: 'one', output: 'ok' },
          { id: 'stray', name: 'x', output: 'unasked' },
          { nope: 1 }
        ] }),
        //a tool turn with nothing to answer is left out
        turn({ role: 'tool', toolResults: [ { id: 'q', name: 'x', output: 'late' } ] }),
        turn({ role: 'assistant', text: 'y', raw: JSON.stringify({ provider: 5 }) }),
        turn({ role: 'assistant', text: 'z', raw: JSON.stringify([ 1 ]) })
      ], []);

      expect(transcript.map(entry => entry.role)).to.deep.equal([ 'assistant', 'tool', 'assistant', 'assistant' ]);
      const [ first, results, second, third ] = transcript;
      if (first.role !== 'assistant' || results.role !== 'tool') throw new Error('shape');
      expect(first.raw).to.equal(null);
      expect(first.toolCalls).to.deep.equal([
        { id: 'a', name: 'one', input: {} }, { id: 'b', name: 'two', input: {} }
      ]);
      expect(results.results.map(result => [ result.id, result.output ])).to.deep.equal([
        [ 'a', 'ok' ],
        [ 'b', 'This action did not finish and its result was lost.' ]
      ]);
      expect((second as { raw: unknown }).raw).to.equal(null);
      expect((third as { raw: unknown }).raw).to.equal(null);
    });

    it('reads each state of an action that waited from the action itself', () => {
      const waiting = (status: string, extra: Partial<AgentAction> = {}) => buildTranscript([
        { id: 'a1', threadId: 't', role: 'assistant', toolCalls: [ { id: 'c', name: 'tool', input: {} } ], inputTokens: 0, outputTokens: 0, created: '' },
        { id: 't2', threadId: 't', role: 'tool', toolResults: [ { id: 'c', name: 'tool', output: 'stored', action: 'act' } ], inputTokens: 0, outputTokens: 0, created: '' }
      ] as AgentTurn[], [ { id: 'act', status, ...extra } as AgentAction ]);
      const output = (status: string, extra: Partial<AgentAction> = {}) => {
        const result = waiting(status, extra)[1];
        if (result.role !== 'tool') throw new Error('shape');
        return result.results[0];
      };

      expect(output('pending').output).to.contain('Waiting for the person');
      expect(output('approved').output).to.contain('running');
      expect(output('done', { result: { ok: 1 } })).to.deep.equal({ id: 'c', name: 'tool', output: '{"ok":1}' });
      expect(output('undone', { result: 'text' }).output).to.equal('text');
      expect(output('failed', { error: 'It broke.' })).to.include({ output: 'It broke.', isError: true });
      expect(output('failed').output).to.equal('The action failed.');
      expect(output('declined').output).to.not.contain('They said');
      expect(output('declined', { error: 'No' }).output).to.contain('They said: No');
      expect(output('expired').isError).to.equal(true);
      //an action that cannot be found leaves the stored result alone
      const orphan = buildTranscript([
        { id: 'a1', role: 'assistant', toolCalls: [ { id: 'c', name: 'tool' } ] },
        { id: 't2', role: 'tool', toolResults: [ { id: 'c', name: 'tool', output: 'stored', action: 'gone' } ] }
      ] as AgentTurn[], []);
      expect((orphan[1] as { results: unknown[] }).results[0]).to.deep.equal({ id: 'c', name: 'tool', output: 'stored' });
    });

    it('names attached files for the model without changing the stored message', () => {
      const [ turn ] = buildTranscript([
        { id: 'u', role: 'user', text: 'Attach', files: [ 'upload:a' ] },
        { id: 'v', role: 'user', text: 'Plain' }
      ] as AgentTurn[], []);
      expect(turn).to.deep.equal({ role: 'user', text: 'Attach\n\n[Attached files: upload:a]' });
    });
  });

  describe('running a turn', () => {
    it('keeps going when the callback that receives the reports throws', async () => {
      const { say } = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Done.') ]
      });
      let calls = 0;
      const result = accepted(await say('Add a note', {}, () => {
        calls += 1;
        throw new Error('the stream closed');
      }));
      expect(result.status).to.equal('done');
      expect(calls).to.equal(result.events.length);
    });

    it('titles a thread from the start of its first message', async () => {
      const long = await setup({ replies: [ says('A.') ] });
      const first = accepted(await long.say(`${'word '.repeat(30)}\nsecond line`));
      const [ thread ] = await long.world.rows('agent_thread', 'id', first.threadId);
      expect(thread.title).to.have.length(60);
      expect(thread.title).to.match(/\.\.\.$/);
      expect(thread.title).to.not.contain('second');

      const short = await setup({ replies: [ says('A.') ] });
      const second = accepted(await short.say('  Close approvals  '));
      expect((await short.world.rows('agent_thread', 'id', second.threadId))[0].title).to.equal('Close approvals');
    });

    it('refuses a message that is empty, too long, or malformed, before anything is stored', async () => {
      const { world, profileId, token, say } = await setup({ replies: [ says('Unused.') ] });
      for (const extra of [ {}, { message: '   ' }, { message: 'x'.repeat(20001) } ]) {
        const data = extra;
        expect(refused(await runTurn(world.rt, world.request(token, data), data)).code).to.equal(400);
      }
      for (const extra of [ { threadId: 5 }, { threadId: '' }, { model: 5 } ]) {
        expect(refused(await say('Hello', extra)).code).to.equal(400);
      }
      expect(refused(await runTurn(world.rt, world.request(token, {}), null)).code).to.equal(400);
      expect(await world.rows('agent_thread', 'profile_id', profileId)).to.deep.equal([]);
    });

    it('stops at the configured step limit, and at eight by default', async () => {
      const set = await setup({ replies: [ asks([ 'c1', 'request_find' ]) ] });
      expect(accepted(await set.say('Loop')).status).to.equal('steps');
      expect(set.world.stub().requests.length).to.equal(8);

      const odd = await setup({ config: { steps: 0 }, replies: [ asks([ 'c1', 'request_find' ]) ] });
      accepted(await odd.say('Loop'));
      expect(odd.world.stub().requests.length).to.equal(8);
    });

    it('treats a stop for tools with no calls as the end of the turn', async () => {
      const { say } = await setup({ replies: [ { text: 'Odd.', stop: 'tools' } ] });
      expect(accepted(await say('Hello')).status).to.equal('done');
    });

    it('keeps two runtimes in one process apart', async () => {
      const a = await setup({ replies: [ says('From a.') ], config: { limit: 1 } });
      const b = await setup({ replies: [ says('From b.') ] });
      accepted(await a.say('Hello'));
      refused(await a.say('Hello again'));
      accepted(await b.say('Hello'));
      accepted(await b.say('Hello again'));
      expect(a.world.rt.config.limit).to.equal(1);
      expect(b.world.rt.config.limit).to.equal(undefined);
    });
  });

  describe('when the store changes under a call', () => {
    //these paths need a row to vanish or be taken between two reads, which a
    // test makes happen by answering for the store
    async function pendingAction() {
      const set = await setup({
        replies: [ asks([ 'c1', 'request_cancel', { id: 'REQ-1' } ]), says('Unused.') ]
      });
      const first = accepted(await set.say('Cancel it'));
      const [ action ] = await actionsOf(set.world, first.threadId);
      return { ...set, action, data: { actionId: action.id as string } };
    }

    it('answers not found when an approval or decline finds the action gone', async () => {
      const { world, token, data } = await pendingAction();
      world.rt.store.approveAction = async () => null;
      world.rt.store.claimDecline = async () => null;
      expect(refused(await approve(world.rt, world.request(token, data), data)).code).to.equal(404);
      expect(refused(await decline(world.rt, world.request(token, data), data)).code).to.equal(404);
      expect(world.ran).to.deep.equal([]);
    });

    it('answers from the record when an undo is taken by another call first', async () => {
      const set = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Added.') ]
      });
      const first = accepted(await set.say('Add a note'));
      const [ action ] = await actionsOf(set.world, first.threadId);
      const data = { actionId: action.id as string };
      const { world, token } = set;
      world.ran.length = 0;

      const real = world.rt.store.claimUndo;
      world.rt.store.claimUndo = async () => null;
      expect(refused(await undo(world.rt, world.request(token, data), data)).code).to.equal(404);

      world.rt.store.claimUndo = async (id, profileId) => {
        const claimed = await real(id, profileId);
        return { action: claimed!.action, claimed: false };
      };
      const result = await undo(world.rt, world.request(token, data), data);
      if (!result.ok) throw new Error('refused');
      expect(result.status).to.equal('settled');
      expect(world.ran).to.deep.equal([]);
    });

    it('does not run an undo that could not be claimed for its own action', async () => {
      const set = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Added.') ]
      });
      const first = accepted(await set.say('Add a note'));
      const [ action ] = await actionsOf(set.world, first.threadId);
      const { world, token } = set;
      world.ran.length = 0;
      world.rt.store.approveAction = async () => ({ action: action as never, claimed: false });
      const data = { actionId: action.id as string };
      const result = await undo(world.rt, world.request(token, data), data);
      if (!result.ok) throw new Error('refused');
      //the undo failed to start, so the original stands and nothing ran
      expect(result).to.include({ status: 'refused', error: 'The undo could not be started.' });
      expect(world.ran).to.deep.equal([]);
      expect((await actionsOf(world, first.threadId))[0].status).to.equal('done');
    });

    it('tells the model a call could not start when its claim fails', async () => {
      const { world, say } = await setup({
        replies: [ asks([ 'c1', 'note_add', { text: 'hi' } ]), says('Sorry.') ]
      });
      world.rt.store.approveAction = async () => null;
      const result = accepted(await say('Add a note'));
      expect(result.status).to.equal('done');
      expect(world.ran).to.deep.equal([]);
      const last = world.stub().requests[1].turns.slice(-1)[0];
      if (last.role !== 'tool') throw new Error('expected a tool turn');
      expect(last.results[0]).to.include({ output: 'The action could not be started.', isError: true });
    });
  });

  describe('defaults', () => {
    it('lists threads with no input, and refuses input that is not an object', async () => {
      const { world, token, say } = await setup({ replies: [ says('Hi.') ] });
      accepted(await say('Hello'));
      const none = await listThreads(world.rt, world.request(token));
      expect(none.ok).to.equal(true);
      const odd = await listThreads(world.rt, world.request(token), 'text');
      expect(odd.ok).to.equal(true);
    });

    it('reads a request body as an object, whatever the request holds', () => {
      expect(body({ data: () => ({ a: 1 }) })).to.deep.equal({ a: 1 });
      expect(body({ data: { a: 2 } })).to.deep.equal({ a: 2 });
      expect(body({ data: () => 'text' })).to.deep.equal({});
      expect(body({ data: () => { throw new Error('unreadable'); } })).to.deep.equal({});
      expect(body({})).to.deep.equal({});
    });

    it('opens the provider the config names, and logs to the console when given no logger', async () => {
      const { world } = await setup();
      const rt = createRuntime(world.app);
      const adapter = await rt.connect({ provider: 'openai', model: 'gpt-test' }, 'sk-test');
      expect(adapter).to.include({ provider: 'openai', model: 'gpt-test' });

      const seen: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => { seen.push(args); };
      try {
        rt.log('Something failed.', new Error('detail'));
        rt.log('Nothing more.');
      } finally {
        console.error = original;
      }
      expect(seen[0][0]).to.equal('[stackpress-ai] Something failed.');
      expect(seen[1]).to.deep.equal([ '[stackpress-ai] Nothing more.', '' ]);
    });
  });

  describe('watching a request', () => {
    it('shares the callback between two loaded copies of the module', async () => {
      const copy = await import('../src/scripts/agent.js?second-copy') as typeof import('../src/scripts/agent.js');
      const request = {};
      const sink = () => undefined;
      watch(request, sink);
      expect(copy.watcher).to.not.equal(watcher);
      expect(copy.watcher(request)).to.equal(sink);
      expect(watcher({})).to.equal(undefined);
    });
  });

  describe('helpers', () => {
    const tool = (extra: Record<string, unknown> = {}) => normalizeTool({
      name: 't', event: 'e', method: 'POST', ...extra
    })!;

    it('decides which tools need an approval', () => {
      expect(needsApproval(tool({ irreversible: true }))).to.equal(true);
      expect(needsApproval(tool({ irreversible: true, inverse: 'undo_t' }))).to.equal(true);
      expect(needsApproval(tool())).to.equal(true);
      expect(needsApproval(tool({ method: 'DELETE' }))).to.equal(true);
      expect(needsApproval(tool({ inverse: 'undo_t' }))).to.equal(false);
      expect(needsApproval(tool({ method: 'GET' }))).to.equal(false);
    });

    it('finds the inverse only when it is registered', () => {
      const tools = [ tool({ name: 'a', inverse: 'b' }), tool({ name: 'b' }), tool({ name: 'c', inverse: 'gone' }) ];
      expect(inverseOf(tools, 'a')?.name).to.equal('b');
      expect(inverseOf(tools, 'b')).to.equal(undefined);
      expect(inverseOf(tools, 'c')).to.equal(undefined);
      expect(inverseOf(tools, 'missing')).to.equal(undefined);
    });

    it('reads the app\'s operation identifier from a result', () => {
      const t = tool() as NormalizedToolConfig;
      expect(operationOf(t, { operation: 'op-1' })).to.equal('op-1');
      expect(operationOf(t, { operation: 77 })).to.equal('77');
      expect(operationOf(t, { operation: '  ' })).to.equal(undefined);
      expect(operationOf(t, { operation: { id: 1 } })).to.equal(undefined);
      expect(operationOf(t, { other: 'x' })).to.equal(undefined);
      expect(operationOf(t, 'text')).to.equal(undefined);
      expect(operationOf(t, null)).to.equal(undefined);
      expect(operationOf(t, { operation: 'x'.repeat(400) })).to.have.length(255);
      const nested = tool({ operation: 'approval.id' }) as NormalizedToolConfig;
      expect(operationOf(nested, { approval: { id: 'AP-9' } })).to.equal('AP-9');
      expect(operationOf(nested, { approval: 'AP-9' })).to.equal(undefined);
    });

    it('cuts a long result and shows an unreadable one safely', () => {
      expect(render('plain')).to.equal('plain');
      expect(render({ a: 1 })).to.equal('{"a":1}');
      expect(render(undefined)).to.equal('null');
      const long = render('x'.repeat(MAX_OUTPUT + 50));
      expect(long.length).to.be.lessThan(MAX_OUTPUT + 50);
      expect(long).to.match(/\(shortened\)$/);
      const loop: Record<string, unknown> = {};
      loop.self = loop;
      expect(render(loop)).to.equal('The result could not be shown.');
    });

    it('describes page hints as hints, within a fixed size', () => {
      expect(describeHints(undefined)).to.equal('');
      expect(describeHints('text')).to.equal('');
      expect(describeHints({})).to.equal('');
      expect(describeHints({ url: 5 })).to.equal('');
      const text = describeHints({ url: '/a'.repeat(400), items: Array.from({ length: 50 }, (_, i) => ({ i })) });
      expect(text).to.contain('never change what you may do');
      expect(text.split('\n')[1].length).to.be.at.most(4000);
      expect(text).to.not.contain('"i":20');
      const loop: Record<string, unknown> = {};
      loop.self = loop;
      expect(describeHints({ items: [ loop ] })).to.equal('');
    });

    it('computes when the day resets in UTC', () => {
      expect(resetsAt(new Date('2026-10-05T23:59:59.999Z'))).to.equal('2026-10-06T00:00:00.000Z');
      expect(resetsAt(new Date('2026-12-31T12:00:00Z'))).to.equal('2027-01-01T00:00:00.000Z');
    });

    it('checks input shape', () => {
      expect(parseInput({ message: ' hi ' })).to.include({ message: 'hi' });
      expect(parseInput({ message: 'hi', files: null })).to.deep.include({ files: [] });
      expect(parseInput({ message: 'hi', threadId: null, model: null })).to.include({ threadId: undefined, model: undefined });
      expect(parseInput('text')).to.have.property('error');
    });
  });
});
