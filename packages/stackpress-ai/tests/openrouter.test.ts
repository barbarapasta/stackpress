//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import openrouter from '../src/adapters/openrouter.js';
import { ProviderError } from '../src/adapters/errors.js';
import {
  ANSWER,
  OPENROUTER_REPLIES,
  SHAPE,
  SYSTEM,
  TOOLS,
  canned,
  chatStream,
  json,
  runTurn,
  scenario,
  shape,
  usage
} from './provider.js';

//these tests run the real OpenAI SDK, pointed at OpenRouter, against canned
// replies. The live run through OpenRouter is the smoke script, which is not
// part of this suite.

const hi = [ { role: 'user', text: 'hi' } ] as any[];
const model = 'stub/model';

const completion = (message: Record<string, unknown>, finish: string, extra = {}) => ({
  id: 'gen_x', object: 'chat.completion', model,
  choices: [ { index: 0, finish_reason: finish, message: { role: 'assistant', content: null, ...message } } ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...extra
});

describe('OpenRouter adapter', () => {
  it('should run the two step lookup and report usage', async () => {
    const { fetch } = canned(OPENROUTER_REPLIES);
    const run = scenario();
    const stop = await runTurn({
      adapter: openrouter({ apiKey: 'stub', fetch, model }),
      turns: run.turns,
      execute: run.execute
    });
    expect(stop).to.equal('end');
    expect(shape(run.turns)).to.deep.equal(SHAPE);
    expect(run.calls[0].input).to.deep.equal({ requestId: 'REQ-42' });
    expect(run.turns[3]).to.deep.include({ text: ANSWER });
    expect(usage(run.turns)).to.deep.equal({ input: 250, output: 38 });
  });

  it('should send the tool list on every request, to OpenRouter', async () => {
    const { fetch, requests } = canned(OPENROUTER_REPLIES);
    const run = scenario();
    await runTurn({
      adapter: openrouter({ apiKey: 'stub', fetch, model }),
      turns: run.turns,
      execute: run.execute
    });
    for (const request of requests) {
      expect(request.url).to.equal('https://openrouter.ai/api/v1/chat/completions');
      expect(request.body.model).to.equal(model);
      expect(request.body.max_tokens).to.equal(16000);
      expect(request.body.tool_choice).to.equal('auto');
      expect(request.body.tools).to.deep.equal([ {
        type: 'function',
        function: {
          name: 'request_lookup',
          description: TOOLS[0].description,
          parameters: TOOLS[0].input
        }
      } ]);
    }
    expect(requests[0].headers.authorization).to.equal('Bearer stub');
    const roles = requests[1].body.messages.map((message: any) => message.role);
    expect(roles).to.deep.equal([ 'system', 'user', 'assistant', 'tool' ]);
    expect(requests[1].body.messages[3].tool_call_id).to.equal('call_or_1');
  });

  it('should require a model and a key', () => {
    expect(() => openrouter({ apiKey: 'stub' } as any)).to.throw(ProviderError, /model/);
    try {
      openrouter({ model });
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).to.deep.include({ kind: 'authentication', provider: 'openrouter' });
    }
  });

  it('should replay its own reply as it was returned, extra fields included', async () => {
    const first = completion({
      tool_calls: [ { id: 'call_r', type: 'function', function: { name: 'request_lookup', arguments: '{"requestId":"REQ-42"}' } } ],
      reasoning: 'thinking it over',
      reasoning_details: [ { type: 'reasoning.encrypted', data: 'abc' } ]
    }, 'tool_calls');
    const { fetch, requests } = canned([ first, OPENROUTER_REPLIES[1] ]);
    const run = scenario();
    await runTurn({
      adapter: openrouter({ apiKey: 'stub', fetch, model }),
      turns: run.turns,
      execute: run.execute
    });
    expect(requests[1].body.messages[2]).to.deep.include({
      role: 'assistant',
      reasoning: 'thinking it over',
      reasoning_details: [ { type: 'reasoning.encrypted', data: 'abc' } ]
    });
  });

  it('should stream text to the callback and return the full reply', async () => {
    const { fetch, requests } = canned([ () => chatStream(OPENROUTER_REPLIES[1]) ]);
    const seen: string[] = [];
    const reply = await openrouter({ apiKey: 'stub', fetch, model }).send({
      system: SYSTEM, tools: TOOLS, turns: hi, onText: text => seen.push(text)
    });
    expect(requests[0].body.stream).to.equal(true);
    expect(seen.join('')).to.equal(ANSWER);
    expect(seen.length).to.be.greaterThan(1);
    expect(reply).to.deep.include({ text: ANSWER, stop: 'end', usage: { input: 150, output: 18 } });
  });

  it('should read a streamed call without keeping the SDK parsed fields', async () => {
    const { fetch, requests } = canned([
      () => chatStream(OPENROUTER_REPLIES[0]),
      () => chatStream(OPENROUTER_REPLIES[1])
    ]);
    const run = scenario();
    await runTurn({
      adapter: openrouter({ apiKey: 'stub', fetch, model }),
      turns: run.turns,
      execute: run.execute,
      onText: () => undefined
    });
    expect(run.calls[0].input).to.deep.equal({ requestId: 'REQ-42' });
    const replayed = requests[1].body.messages[2];
    expect(replayed).to.not.have.property('parsed');
    expect(replayed.tool_calls[0].function).to.deep.equal({
      name: 'request_lookup', arguments: '{"requestId":"REQ-42"}'
    });
  });

  it('should report a refusal and drop what it cannot trust', async () => {
    const send = async (body: unknown) => {
      const { fetch } = canned([ body ]);
      return await openrouter({ apiKey: 'stub', fetch, model }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    };
    const refused = await send(completion({ refusal: 'no' }, 'stop'));
    expect(refused).to.deep.include({ stop: 'refusal', raw: null });
    const filtered = await send(completion({}, 'content_filter'));
    expect(filtered.stop).to.equal('refusal');
    const call = (args: string) => ({
      tool_calls: [ { id: 'c', type: 'function', function: { name: 'request_lookup', arguments: args } } ]
    });
    const cut = await send(completion(call('{"requestId":'), 'length'));
    expect(cut).to.deep.include({ stop: 'length', raw: null });
    expect(cut.toolCalls).to.deep.equal([]);
    const truncated = await send(completion(call('{"requestId":"REQ-42"}'), 'length'));
    expect(truncated).to.deep.include({ stop: 'length', raw: null });
    const empty = await send(completion(call(''), 'tool_calls'));
    expect(empty.toolCalls).to.deep.equal([ { id: 'c', name: 'request_lookup', input: {} } ]);
    const plain = await send(completion({ content: 'cut off' }, 'length'));
    expect(plain).to.deep.include({ stop: 'length', text: 'cut off' });
    expect(plain.raw).to.deep.include({ provider: 'openrouter', model });
  });

  it('should read tool calls even when the finish reason says stop', async () => {
    const { fetch } = canned([ completion({
      tool_calls: [ { id: 'c', type: 'function', function: { name: 'request_lookup', arguments: '{}' } } ]
    }, 'stop') ]);
    const reply = await openrouter({ apiKey: 'stub', fetch, model }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    expect(reply.stop).to.equal('tools');
  });

  it('should end when tool calls were announced but none arrived', async () => {
    const { fetch } = canned([ completion({ content: 'nothing to call' }, 'tool_calls') ]);
    const reply = await openrouter({ apiKey: 'stub', fetch, model }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    expect(reply.stop).to.equal('end');
  });

  it('should raise a 200 answer that carries an error body', async () => {
    const bodies = [
      { error: { code: 502, message: 'upstream failed' } },
      { id: 'x', object: 'chat.completion', model, choices: [] },
      completion({}, 'error', { choices: [ {
        index: 0, finish_reason: 'error', message: { role: 'assistant', content: '' },
        error: { code: 500, message: 'choice failed' }
      } ] })
    ];
    const messages = [ 'upstream failed', 'no choices', 'choice failed' ];
    for (const [ index, body ] of bodies.entries()) {
      const { fetch } = canned([ body ]);
      const error = await openrouter({ apiKey: 'stub', fetch, model })
        .send({ system: SYSTEM, tools: TOOLS, turns: hi }).catch(error => error);
      expect(error, messages[index]).to.be.instanceOf(ProviderError);
      expect(error.kind).to.equal('other');
      expect(error.message).to.contain(messages[index]);
    }
  });

  it('should rebuild a reply that another model wrote', async () => {
    const { fetch, requests } = canned([ completion({ content: 'ok' }, 'stop') ]);
    const turns: any[] = [
      { role: 'user', text: 'first' },
      {
        role: 'assistant', text: '', usage: { input: 1, output: 1 },
        toolCalls: [ { id: 'toolu_x', name: 'request_lookup', input: { requestId: 'REQ-9' } } ],
        raw: { provider: 'anthropic', model: 'claude-opus-5-5', content: [ { type: 'thinking', signature: 's' } ] }
      },
      { role: 'tool', results: [ { id: 'toolu_x', name: 'request_lookup', output: '{}' } ] },
      //the same provider with another model is foreign: it is rebuilt too
      {
        role: 'assistant', text: 'Done.', usage: { input: 1, output: 1 }, toolCalls: [],
        raw: { provider: 'openrouter', model: 'other/model', message: { role: 'assistant', content: 'Done.', reasoning: 'x' } }
      },
      { role: 'assistant', text: '', usage: { input: 1, output: 1 }, toolCalls: [], raw: null },
      { role: 'user', text: 'again' }
    ];
    await openrouter({ apiKey: 'stub', fetch, model }).send({ system: SYSTEM, tools: TOOLS, turns });
    const messages = requests[0].body.messages;
    expect(messages.map((message: any) => message.role)).to.deep.equal([
      'system', 'user', 'assistant', 'tool', 'assistant', 'user'
    ]);
    expect(messages[2]).to.deep.equal({
      role: 'assistant',
      content: null,
      tool_calls: [ { id: 'toolu_x', type: 'function', function: { name: 'request_lookup', arguments: '{"requestId":"REQ-9"}' } } ]
    });
    expect(messages[4]).to.deep.equal({ role: 'assistant', content: 'Done.' });
  });

  describe('typed errors', () => {
    const failing = (status: number, error: Record<string, unknown>, headers = {}) => canned([
      () => json({ error: { message: `provider said ${status}`, ...error } }, status, {
        'x-should-retry': 'false', ...headers
      })
    ]).fetch;
    const send = (fetch: any) => openrouter({ apiKey: 'stub', fetch, model })
      .send({ system: SYSTEM, tools: TOOLS, turns: hi });

    it('should name a rate limit', async () => {
      const error = await send(failing(429, { code: 429 }, { 'retry-after': '2' })).catch(error => error);
      expect(error).to.deep.include({ kind: 'rate_limit', provider: 'openrouter', status: 429, retryAfter: 2 });
    });

    it('should name an authentication failure', async () => {
      const error = await send(failing(401, { code: 401 })).catch(error => error);
      expect(error).to.deep.include({ kind: 'authentication', status: 401 });
    });

    it('should name a moderation block as a refusal, not an authentication failure', async () => {
      const error = await send(failing(403, { code: 403, metadata: { reasons: [ 'violence' ], flagged_input: 'x' } }))
        .catch(error => error);
      expect(error).to.deep.include({ kind: 'refusal', status: 403 });
    });

    it('should name any other failure', async () => {
      const error = await send(failing(402, { code: 402 })).catch(error => error);
      expect(error).to.deep.include({ kind: 'other', status: 402 });
    });
  });
});
