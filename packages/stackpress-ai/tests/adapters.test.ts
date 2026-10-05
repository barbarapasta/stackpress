//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import createAdapter, { loaders } from '../src/adapters/index.js';
import anthropic from '../src/adapters/anthropic.js';
import openai from '../src/adapters/openai.js';
import openrouter from '../src/adapters/openrouter.js';
import stub, { UNCONFIGURED } from '../src/adapters/stub.js';
import { ProviderError, guard, toProviderError } from '../src/adapters/errors.js';
import { isStrict, parseInput } from '../src/adapters/helpers.js';
import {
  ANSWER,
  ANTHROPIC_REPLIES,
  OPENAI_REPLIES,
  OPENROUTER_REPLIES,
  SHAPE,
  SYSTEM,
  TOOLS,
  anthropicStream,
  canned,
  runTurn,
  scenario,
  shape
} from './provider.js';

const hi = [ { role: 'user', text: 'hi' } ] as any[];
const kinds = (list: any[]) => list.map(item => item.type || item.role);

//one conversation per provider, run through the one loop with the real SDK
async function transcript(which: 'anthropic' | 'openai' | 'openrouter') {
  const run = scenario();
  const adapter = which === 'anthropic'
    ? anthropic({ apiKey: 'stub', fetch: canned(ANTHROPIC_REPLIES.map(reply => () => anthropicStream(reply))).fetch })
    : which === 'openai'
      ? openai({ apiKey: 'stub', fetch: canned(OPENAI_REPLIES).fetch })
      : openrouter({ apiKey: 'stub', fetch: canned(OPENROUTER_REPLIES).fetch, model: 'stub/model' });
  await runTurn({ adapter, turns: run.turns, execute: run.execute });
  return run.turns;
}

describe('Provider adapters', () => {
  it('should give every provider the same transcript shape through one loop', async () => {
    for (const which of [ 'anthropic', 'openai', 'openrouter' ] as const) {
      const turns = await transcript(which);
      expect(shape(turns), which).to.deep.equal(SHAPE);
      const last = turns[turns.length - 1] as any;
      expect(last.text, which).to.match(/7731/).and.match(/SUBMITTED/);
      //the neutral fields exist next to the raw record on every provider
      expect((turns[1] as any).raw.provider, which).to.equal(which);
    }
  });

  describe('switching models in the middle of a conversation', () => {
    const follow = { role: 'user', text: 'Is it still open?' } as const;

    it('should rebuild an Anthropic transcript for OpenAI', async () => {
      const turns = [ ...await transcript('anthropic'), follow ];
      const { fetch, requests } = canned([ OPENAI_REPLIES[1] ]);
      await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns });
      const input = requests[0].body.input;
      expect(kinds(input)).to.deep.equal([
        'user', 'assistant', 'function_call', 'function_call_output', 'assistant', 'user'
      ]);
      expect(JSON.stringify(input)).to.not.match(/thinking|tool_use|signature/);
    });

    it('should rebuild an OpenAI transcript for Anthropic', async () => {
      const turns = [ ...await transcript('openai'), follow ];
      const { fetch, requests } = canned([ () => anthropicStream(ANTHROPIC_REPLIES[1]) ]);
      await anthropic({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns });
      const messages = requests[0].body.messages;
      expect(messages.map((message: any) => message.role)).to.deep.equal([
        'user', 'assistant', 'user', 'assistant', 'user'
      ]);
      expect(messages[1].content.map((block: any) => block.type)).to.deep.equal([ 'tool_use' ]);
      expect(messages[2].content[0].tool_use_id).to.equal('call_1');
      expect(JSON.stringify(messages)).to.not.match(/reasoning|function_call|encrypted/);
    });

    it('should rebuild an OpenRouter transcript for Anthropic and OpenAI', async () => {
      const turns = [ ...await transcript('openrouter'), follow ];
      const a = canned([ () => anthropicStream(ANTHROPIC_REPLIES[1]) ]);
      await anthropic({ apiKey: 'stub', fetch: a.fetch }).send({ system: SYSTEM, tools: TOOLS, turns });
      expect(a.requests[0].body.messages[1].content[0]).to.deep.include({
        type: 'tool_use', id: 'call_or_1'
      });
      const o = canned([ OPENAI_REPLIES[1] ]);
      await openai({ apiKey: 'stub', fetch: o.fetch }).send({ system: SYSTEM, tools: TOOLS, turns });
      expect(kinds(o.requests[0].body.input)).to.deep.equal([
        'user', 'function_call', 'function_call_output', 'assistant', 'user'
      ]);
    });

    it('should rebuild OpenAI and Anthropic transcripts for OpenRouter', async () => {
      for (const from of [ 'openai', 'anthropic' ] as const) {
        const turns = [ ...await transcript(from), follow ];
        const { fetch, requests } = canned([ OPENROUTER_REPLIES[1] ]);
        await openrouter({ apiKey: 'stub', fetch, model: 'stub/model' })
          .send({ system: SYSTEM, tools: TOOLS, turns });
        const messages = requests[0].body.messages;
        expect(messages.map((message: any) => message.role), from).to.deep.equal([
          'system', 'user', 'assistant', 'tool', 'assistant', 'user'
        ]);
        expect(messages[2].tool_calls[0].function.arguments, from).to.equal('{"requestId":"REQ-42"}');
        expect(JSON.stringify(messages), from).to.not.match(/reasoning|thinking|signature/);
      }
    });

    it('should rebuild a reply for a different model of the same provider', async () => {
      const turns = [ ...await transcript('openai'), follow ];
      const { fetch, requests } = canned([ OPENAI_REPLIES[1] ]);
      await openai({ apiKey: 'stub', fetch, model: 'gpt-6-astra' })
        .send({ system: SYSTEM, tools: TOOLS, turns });
      //the reasoning item belongs to the model that wrote it
      expect(kinds(requests[0].body.input)).to.not.include('reasoning');
      expect(requests[0].body.model).to.equal('gpt-6-astra');
    });
  });

  describe('stub', () => {
    it('should answer from its script and keep the requests', async () => {
      const adapter = stub({ model: 'scripted', replies: [
        { toolCalls: [ { id: 't1', name: 'request_lookup', input: { requestId: 'REQ-42' } } ], usage: { input: 3, output: 4 } },
        { text: ANSWER }
      ] });
      expect(adapter).to.deep.include({ provider: 'stub', model: 'scripted' });
      const run = scenario();
      const seen: string[] = [];
      const stop = await runTurn({ adapter, turns: run.turns, execute: run.execute, onText: text => seen.push(text) });
      expect(stop).to.equal('end');
      expect(shape(run.turns)).to.deep.equal(SHAPE);
      expect(run.calls[0].id).to.equal('t1');
      expect(seen).to.deep.equal([ ANSWER ]);
      expect(adapter.requests).to.have.length(2);
      expect(adapter.requests[1].turns).to.have.length(3);
      expect(run.turns[1]).to.deep.include({ usage: { input: 3, output: 4 } });
    });

    it('should repeat its last reply and say it is unconfigured by default', async () => {
      const adapter = stub();
      const first = await adapter.send({ system: SYSTEM, tools: [], turns: hi });
      const second = await adapter.send({ system: SYSTEM, tools: [], turns: hi });
      expect(first).to.deep.include({ text: UNCONFIGURED, stop: 'end', toolCalls: [] });
      expect(second.text).to.equal(UNCONFIGURED);
      const scripted = stub({ replies: [ { text: 'a', stop: 'refusal' } ] });
      expect((await scripted.send({ system: SYSTEM, tools: [], turns: hi })).stop).to.equal('refusal');
      expect((await scripted.send({ system: SYSTEM, tools: [], turns: hi })).stop).to.equal('refusal');
    });

    it('should throw a scripted error', async () => {
      const failure = new ProviderError('stub', 'rate_limit', 'slow down', { retryAfter: 1 });
      const adapter = stub({ replies: [ failure, { text: 'back' } ] });
      const error = await adapter.send({ system: SYSTEM, tools: [], turns: hi }).catch(error => error);
      expect(error).to.equal(failure);
      expect((await adapter.send({ system: SYSTEM, tools: [], turns: hi })).text).to.equal('back');
    });
  });

  describe('chooser', () => {
    it('should load only the module of the provider it chose', async () => {
      const loaded: string[] = [];
      const spy = Object.fromEntries(Object.entries(loaders).map(([ name, load ]) => [
        name, () => { loaded.push(name); return load(); }
      ])) as typeof loaders;
      const adapter = await createAdapter({ provider: 'stub', model: 'x' }, spy);
      expect(adapter.provider).to.equal('stub');
      expect(loaded).to.deep.equal([ 'stub' ]);
    });

    it('should build each adapter from its own options', async () => {
      const a = await createAdapter({ provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5-5' });
      expect(a).to.deep.include({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
      const defaults = await createAdapter({ provider: 'anthropic', apiKey: 'k' });
      expect(defaults.model).to.equal('claude-opus-5-5');
      const o = await createAdapter({ provider: 'openai', apiKey: 'k' });
      expect(o).to.deep.include({ provider: 'openai', model: 'gpt-6.1-sol' });
      const r = await createAdapter({ provider: 'openrouter', apiKey: 'k', model: 'openai/gpt-6.1-sol' });
      expect(r).to.deep.include({ provider: 'openrouter', model: 'openai/gpt-6.1-sol' });
    });

    it('should refuse an unknown provider', async () => {
      const error = await createAdapter({ provider: 'nope' } as any).catch(error => error);
      expect(error).to.be.instanceOf(ProviderError);
      expect(error.message).to.contain('"nope"').and.contain('anthropic');
      //names that exist on every object are not providers
      const proto = await createAdapter({ provider: 'toString' } as any).catch(error => error);
      expect(proto).to.be.instanceOf(ProviderError);
    });

    it('should say which package to install when an SDK is missing', async () => {
      const missing = Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
      const load = { ...loaders, openai: async () => { throw missing; } } as any;
      const error = await createAdapter({ provider: 'openai', apiKey: 'k' }, load).catch(error => error);
      expect(error).to.be.instanceOf(ProviderError);
      expect(error.message).to.contain('npm install openai');
      expect(error.cause).to.equal(missing);
      const rest = await createAdapter({ provider: 'anthropic' }, {
        ...loaders, anthropic: async () => { throw missing; }
      } as any).catch(error => error);
      expect(rest.message).to.contain('@anthropic-ai/sdk');
    });

    it('should not hide other loading failures', async () => {
      const broken = new SyntaxError('bad module');
      const error = await createAdapter({ provider: 'openai' }, {
        ...loaders, openai: async () => { throw broken; }
      } as any).catch(error => error);
      expect(error).to.equal(broken);
      const stubBroken = await createAdapter({ provider: 'stub' }, {
        ...loaders, stub: async () => { throw Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }); }
      } as any).catch(error => error);
      //the stub needs no package, so there is nothing to tell the user to install
      expect(stubBroken).to.not.be.instanceOf(ProviderError);
    });
  });

  describe('error mapping', () => {
    it('should pass a provider error through and wrap anything else', async () => {
      const own = new ProviderError('x', 'refusal', 'declined');
      expect(toProviderError('y', own)).to.equal(own);
      const plain = toProviderError('y', new Error('socket hang up'));
      expect(plain).to.deep.include({ kind: 'other', provider: 'y', message: 'socket hang up' });
      expect(plain.status).to.equal(undefined);
      for (const odd of [ null, undefined, 'text', {}, { message: '' } ]) {
        const error = toProviderError('y', odd);
        expect(error.kind).to.equal('other');
        expect(error.message).to.equal('The provider request failed.');
      }
    });

    it('should read a retry delay only when it is a number of seconds', () => {
      const withHeader = (value: string) => toProviderError('y', {
        status: 429, message: 'm', headers: new Headers({ 'retry-after': value })
      });
      expect(withHeader('4').retryAfter).to.equal(4);
      expect(withHeader('Wed, 21 Oct 2026 07:28:00 GMT').retryAfter).to.equal(undefined);
      expect(withHeader('-1').retryAfter).to.equal(undefined);
      expect(toProviderError('y', { status: 429, message: 'm' }).retryAfter).to.equal(undefined);
      expect(toProviderError('y', { status: 429, message: 'm', headers: {} }).kind).to.equal('rate_limit');
    });

    it('should map each status to one kind', () => {
      const kind = (status: number, extra = {}) => toProviderError('y', { status, message: 'm', ...extra }).kind;
      expect(kind(401)).to.equal('authentication');
      expect(kind(403)).to.equal('authentication');
      expect(kind(403, { error: { metadata: { reasons: [] } } })).to.equal('authentication');
      expect(kind(403, { error: { metadata: { reasons: [ 'x' ] } } })).to.equal('refusal');
      expect(kind(429)).to.equal('rate_limit');
      expect(kind(429, { code: 'insufficient_quota' })).to.equal('other');
      expect(kind(400, { code: 'content_policy_violation' })).to.equal('refusal');
      expect(kind(400)).to.equal('other');
      expect(kind(404)).to.equal('other');
      expect(kind(500)).to.equal('other');
    });
  });

  describe('helpers', () => {
    it('should tell a strict schema from one that cannot be strict', () => {
      const closed = (properties: any, required = Object.keys(properties)) => ({
        type: 'object', properties, required, additionalProperties: false
      });
      expect(isStrict(TOOLS[0].input)).to.equal(true);
      expect(isStrict(closed({}))).to.equal(true);
      expect(isStrict({ type: 'object' })).to.equal(false);
      expect(isStrict({ type: 'object', properties: {}, additionalProperties: false })).to.equal(true);
      expect(isStrict(closed({ a: { type: 'string' }, b: { type: 'string' } }, [ 'a' ]))).to.equal(false);
      expect(isStrict(closed({ a: closed({ b: { type: 'string' } }) }))).to.equal(true);
      expect(isStrict(closed({ a: { type: 'object', properties: { b: { type: 'string' } } } }))).to.equal(false);
      expect(isStrict(closed({ list: { type: 'array', items: closed({ a: { type: 'string' } }) } }))).to.equal(true);
      expect(isStrict(closed({ list: { type: 'array', items: { type: 'object' } } }))).to.equal(false);
      expect(isStrict(closed({ list: { type: 'array' } }))).to.equal(true);
    });

    it('should parse model arguments to an object or nothing', () => {
      expect(parseInput('{"a":1}')).to.deep.equal({ a: 1 });
      expect(parseInput('')).to.deep.equal({});
      expect(parseInput(null)).to.deep.equal({});
      expect(parseInput(undefined)).to.deep.equal({});
      expect(parseInput('{"a":')).to.equal(null);
      expect(parseInput('[1]')).to.equal(null);
      expect(parseInput('"x"')).to.equal(null);
      expect(parseInput('null')).to.equal(null);
    });
  });
});
