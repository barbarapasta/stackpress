//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import anthropic from '../src/adapters/anthropic.js';
import { ProviderError } from '../src/adapters/errors.js';
import {
  ANSWER,
  ANTHROPIC_REPLIES,
  RECORD,
  SHAPE,
  SYSTEM,
  TOOLS,
  anthropicStream,
  canned,
  json,
  runTurn,
  scenario,
  shape,
  usage
} from './provider.js';

//these tests run the real Anthropic SDK against canned server-sent events, so
// the SDK builds each request and parses each stream as it would live. No
// Anthropic key exists for this suite: this adapter has never run against the
// live provider.

const streamed = () => ANTHROPIC_REPLIES.map(reply => () => anthropicStream(reply));

describe('Anthropic adapter', () => {
  it('should run the two step lookup and report usage', async () => {
    const { fetch, requests } = canned(streamed());
    const run = scenario();
    const stop = await runTurn({
      adapter: anthropic({ apiKey: 'stub', fetch }),
      turns: run.turns,
      execute: run.execute
    });
    expect(stop).to.equal('end');
    expect(shape(run.turns)).to.deep.equal(SHAPE);
    expect(run.calls).to.have.length(1);
    expect(run.calls[0].input).to.deep.equal({ requestId: 'REQ-42' });
    expect(run.turns[3]).to.deep.include({ text: ANSWER });
    expect(usage(run.turns)).to.deep.equal({ input: 300, output: 55 });
    expect(requests).to.have.length(2);
  });

  it('should build a streaming request with the documented options', async () => {
    const { fetch, requests } = canned(streamed());
    const run = scenario();
    await runTurn({
      adapter: anthropic({ apiKey: 'stub', fetch }),
      turns: run.turns,
      execute: run.execute
    });
    const [ request ] = requests;
    expect(request.url).to.match(/\/v1\/messages/);
    expect(request.body.model).to.equal('claude-opus-5-5');
    expect(request.body.stream).to.equal(true);
    expect(request.body.max_tokens).to.equal(16000);
    expect(request.body.system).to.equal(SYSTEM);
    expect(request.body.output_config).to.deep.equal({ effort: 'medium' });
    //a refused request is retried on the recommended model, server side
    expect(request.body.fallbacks).to.equal('default');
    expect(request.headers['anthropic-beta']).to.contain('server-side-fallback-2026-07-01');
    //no state is asked of the provider and thinking is left on its default
    expect(request.body).to.not.have.property('thinking');
    expect(request.body).to.not.have.property('tool_choice');
    expect(request.body.tools[0]).to.deep.equal({
      name: 'request_lookup',
      description: TOOLS[0].description,
      input_schema: TOOLS[0].input,
      strict: true
    });
  });

  it('should take model, effort, and token cap from options', async () => {
    const { fetch, requests } = canned(streamed().slice(1));
    const adapter = anthropic({
      apiKey: 'stub', fetch, model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 900
    });
    expect(adapter.model).to.equal('claude-sonnet-5-5');
    await adapter.send({ system: SYSTEM, tools: TOOLS, turns: [ { role: 'user', text: 'hi' } ] });
    expect(requests[0].body.model).to.equal('claude-sonnet-5-5');
    expect(requests[0].body.output_config).to.deep.equal({ effort: 'low' });
    expect(requests[0].body.max_tokens).to.equal(900);
  });

  it('should send a tool as non-strict when its schema cannot be strict', async () => {
    const { fetch, requests } = canned(streamed().slice(1));
    const adapter = anthropic({ apiKey: 'stub', fetch });
    await adapter.send({
      system: SYSTEM,
      tools: [ { name: 'loose', description: 'x', input: { type: 'object', properties: { a: { type: 'string' } } } } ],
      turns: [ { role: 'user', text: 'hi' } ]
    });
    expect(requests[0].body.tools[0].strict).to.equal(false);
  });

  it('should replay its own reply unchanged with thinking included', async () => {
    const { fetch, requests } = canned(streamed());
    const run = scenario();
    await runTurn({
      adapter: anthropic({ apiKey: 'stub', fetch }),
      turns: run.turns,
      execute: run.execute
    });
    const content = requests[1].body.messages[1].content;
    expect(content[0]).to.deep.include({ type: 'thinking', signature: 'sig-kept-as-is' });
    expect(content.map((block: any) => block.type)).to.deep.equal([ 'thinking', 'text', 'tool_use' ]);
    expect(content[2]).to.deep.include({ id: 'toolu_1', input: { requestId: 'REQ-42' } });
  });

  it('should send every tool result of a step in one user message', async () => {
    const first = {
      ...ANTHROPIC_REPLIES[0],
      content: [
        { type: 'tool_use', id: 'toolu_a', name: 'request_lookup', input: { requestId: 'REQ-1' } },
        { type: 'tool_use', id: 'toolu_b', name: 'request_lookup', input: { requestId: 'REQ-2' } }
      ]
    };
    const { fetch, requests } = canned([
      () => anthropicStream(first),
      () => anthropicStream(ANTHROPIC_REPLIES[1])
    ]);
    const turns = scenario().turns;
    await runTurn({
      adapter: anthropic({ apiKey: 'stub', fetch }),
      turns,
      execute: async call => {
        if (call.id === 'toolu_b') throw new Error('not found');
        return RECORD;
      }
    });
    const messages = requests[1].body.messages;
    expect(messages.map((message: any) => message.role)).to.deep.equal([ 'user', 'assistant', 'user' ]);
    expect(messages[2].content).to.have.length(2);
    expect(messages[2].content[0]).to.deep.include({ type: 'tool_result', tool_use_id: 'toolu_a' });
    expect(messages[2].content[1]).to.deep.include({
      tool_use_id: 'toolu_b', content: 'not found', is_error: true
    });
    expect(messages[2].content[0]).to.not.have.property('is_error');
  });

  it('should pass streamed text to the callback in order', async () => {
    const { fetch } = canned([ () => anthropicStream(ANTHROPIC_REPLIES[1]) ]);
    const seen: string[] = [];
    const reply = await anthropic({ apiKey: 'stub', fetch }).send({
      system: SYSTEM,
      tools: TOOLS,
      turns: [ { role: 'user', text: 'hi' } ],
      onText: text => seen.push(text)
    });
    expect(seen.length).to.be.greaterThan(1);
    expect(seen.join('')).to.equal(ANSWER);
    expect(reply.text).to.equal(ANSWER);
  });

  it('should decide on the stop reason before reading a refusal', async () => {
    //a mid-stream refusal can leave partial thinking, text, and a call
    const refusal = {
      ...ANTHROPIC_REPLIES[0],
      stop_reason: 'refusal',
      content: ANTHROPIC_REPLIES[0].content
    };
    const { fetch, requests } = canned([
      () => anthropicStream(refusal),
      () => anthropicStream(ANTHROPIC_REPLIES[1])
    ]);
    const adapter = anthropic({ apiKey: 'stub', fetch });
    const turns = scenario().turns;
    const reply = await adapter.send({ system: SYSTEM, tools: TOOLS, turns });
    expect(reply.stop).to.equal('refusal');
    expect(reply.text).to.equal('');
    expect(reply.toolCalls).to.deep.equal([]);
    expect(reply.raw).to.equal(null);
    //the next message does not carry the declined turn, which has nothing to say
    turns.push({ role: 'assistant', ...reply, raw: reply.raw }, { role: 'user', text: 'again' });
    await adapter.send({ system: SYSTEM, tools: TOOLS, turns });
    expect(requests[1].body.messages.map((message: any) => message.role)).to.deep.equal([ 'user', 'user' ]);
  });

  it('should drop a call cut off by the length limit', async () => {
    const cut = { ...ANTHROPIC_REPLIES[0], stop_reason: 'max_tokens' };
    const { fetch } = canned([ () => anthropicStream(cut) ]);
    const reply = await anthropic({ apiKey: 'stub', fetch }).send({
      system: SYSTEM, tools: TOOLS, turns: [ { role: 'user', text: 'hi' } ]
    });
    expect(reply.stop).to.equal('length');
    expect(reply.toolCalls).to.deep.equal([]);
    expect(reply.text).to.equal('Looking that up.');
    expect(reply.raw).to.equal(null);
  });

  it('should keep the raw record of a plain reply cut by the length limit', async () => {
    const cut = { ...ANTHROPIC_REPLIES[1], stop_reason: 'max_tokens' };
    const { fetch } = canned([ () => anthropicStream(cut) ]);
    const reply = await anthropic({ apiKey: 'stub', fetch }).send({
      system: SYSTEM, tools: TOOLS, turns: [ { role: 'user', text: 'hi' } ]
    });
    expect(reply.stop).to.equal('length');
    expect(reply.raw).to.deep.include({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('should map the other stop reasons', async () => {
    const stops: [ string, string ][] = [
      [ 'pause_turn', 'pause' ],
      [ 'stop_sequence', 'end' ],
      [ 'model_context_window_exceeded', 'length' ]
    ];
    for (const [ from, to ] of stops) {
      const { fetch } = canned([ () => anthropicStream({ ...ANTHROPIC_REPLIES[1], stop_reason: from }) ]);
      const reply = await anthropic({ apiKey: 'stub', fetch }).send({
        system: SYSTEM, tools: TOOLS, turns: [ { role: 'user', text: 'hi' } ]
      });
      expect(reply.stop, from).to.equal(to);
    }
  });

  it('should add up every attempt of a fallback and echo the turn safely', async () => {
    //the first model wrote thinking and a call, declined, and the fallback
    // model finished the turn after the boundary marker
    const marker = {
      type: 'fallback',
      from: { model: 'claude-opus-5-5' },
      to: { model: 'claude-opus-4-8' },
      trigger: { type: 'refusal', category: 'cyber' }
    };
    const fallen = {
      ...ANTHROPIC_REPLIES[0],
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-declined' },
        { type: 'tool_use', id: 'toolu_old', name: 'request_lookup', input: { requestId: 'OLD' } },
        marker,
        { type: 'text', text: 'Looking that up.' },
        { type: 'tool_use', id: 'toolu_1', name: 'request_lookup', input: { requestId: 'REQ-42' } }
      ],
      usage: {
        input_tokens: 120, output_tokens: 30,
        iterations: [
          { type: 'message', input_tokens: 100, output_tokens: 5 },
          { type: 'fallback_message', input_tokens: 120, output_tokens: 30 }
        ]
      }
    };
    const { fetch, requests } = canned([
      () => anthropicStream(fallen),
      () => anthropicStream(ANTHROPIC_REPLIES[1])
    ]);
    const run = scenario();
    await runTurn({
      adapter: anthropic({ apiKey: 'stub', fetch }),
      turns: run.turns,
      execute: run.execute
    });
    //only the call after the marker is answered
    expect(run.calls.map(call => call.id)).to.deep.equal([ 'toolu_1' ]);
    expect(run.turns[1]).to.deep.include({ usage: { input: 220, output: 35 } });
    const echoed = requests[1].body.messages[1].content;
    expect(echoed.map((block: any) => block.type)).to.deep.equal([ 'fallback', 'text', 'tool_use' ]);
    expect(echoed[2].id).to.equal('toolu_1');
  });

  it('should rebuild a reply that another model wrote', async () => {
    const { fetch, requests } = canned([ () => anthropicStream(ANTHROPIC_REPLIES[1]) ]);
    const turns: any[] = [
      { role: 'user', text: 'first' },
      {
        role: 'assistant', text: 'Checking.', usage: { input: 1, output: 1 },
        toolCalls: [ { id: 'call_x', name: 'request_lookup', input: { requestId: 'REQ-9' } } ],
        raw: { provider: 'openai', model: 'gpt-6.1-sol', output: [ { type: 'reasoning', id: 'rs' } ] }
      },
      { role: 'tool', results: [ { id: 'call_x', name: 'request_lookup', output: '{}' } ] },
      //the same provider but another model is foreign too, because thinking
      // blocks are only valid for the model that wrote them
      {
        role: 'assistant', text: 'Done.', usage: { input: 1, output: 1 }, toolCalls: [],
        raw: { provider: 'anthropic', model: 'claude-sonnet-5-5', content: [
          { type: 'thinking', thinking: '', signature: 'other-model' },
          { type: 'text', text: 'Done.' }
        ] }
      },
      { role: 'user', text: 'again' }
    ];
    await anthropic({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns });
    const messages = requests[0].body.messages;
    expect(messages.map((message: any) => message.role)).to.deep.equal([
      'user', 'assistant', 'user', 'assistant', 'user'
    ]);
    expect(messages[1].content.map((block: any) => block.type)).to.deep.equal([ 'text', 'tool_use' ]);
    expect(messages[3].content).to.deep.equal([ { type: 'text', text: 'Done.' } ]);
    expect(JSON.stringify(messages)).to.not.match(/reasoning|signature|other-model/);
  });

  describe('typed errors', () => {
    const failing = (status: number, headers: Record<string, string> = {}) => canned([
      () => json(
        { type: 'error', error: { type: 'x', message: `provider said ${status}` } },
        status,
        //the SDK retries these on its own unless told not to
        { 'x-should-retry': 'false', ...headers }
      )
    ]).fetch;
    const send = (fetch: any) => anthropic({ apiKey: 'stub', fetch }).send({
      system: SYSTEM, tools: TOOLS, turns: [ { role: 'user', text: 'hi' } ]
    });

    it('should name a rate limit and how long to wait', async () => {
      const error = await send(failing(429, { 'retry-after': '7' })).catch(error => error);
      expect(error).to.be.instanceOf(ProviderError);
      expect(error).to.deep.include({
        kind: 'rate_limit', provider: 'anthropic', status: 429, retryAfter: 7
      });
      expect(error.message).to.contain('provider said 429');
    });

    it('should name an authentication failure', async () => {
      const error = await send(failing(401)).catch(error => error);
      expect(error).to.deep.include({ kind: 'authentication', status: 401 });
    });

    it('should name any other failure', async () => {
      const error = await send(failing(500)).catch(error => error);
      expect(error).to.deep.include({ kind: 'other', status: 500 });
      expect(error.cause).to.be.instanceOf(Error);
    });
  });
});
