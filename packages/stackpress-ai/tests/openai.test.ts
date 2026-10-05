//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import openai from '../src/adapters/openai.js';
import { ProviderError } from '../src/adapters/errors.js';
import {
  ANSWER,
  OPENAI_REPLIES,
  SHAPE,
  SYSTEM,
  TOOLS,
  canned,
  json,
  openaiStream,
  runTurn,
  scenario,
  shape,
  usage
} from './provider.js';

//these tests run the real OpenAI SDK against canned replies, so the SDK builds
// each request and parses each reply as it would live. No OpenAI key exists
// for this suite: this adapter has never run against the live provider.

const hi = [ { role: 'user', text: 'hi' } ] as any[];
const kinds = (input: any[]) => input.map(item => item.type || item.role);

//one response with a single output item list
const response = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'resp_x', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
  output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  ...extra
});
const message = (text: string) => ({
  type: 'message', id: 'msg_x', role: 'assistant', status: 'completed',
  content: [ { type: 'output_text', text, annotations: [] } ]
});

describe('OpenAI adapter', () => {
  it('should run the two step lookup and report usage', async () => {
    const { fetch } = canned(OPENAI_REPLIES);
    const run = scenario();
    const stop = await runTurn({
      adapter: openai({ apiKey: 'stub', fetch }),
      turns: run.turns,
      execute: run.execute
    });
    expect(stop).to.equal('end');
    expect(shape(run.turns)).to.deep.equal(SHAPE);
    expect(run.calls[0].input).to.deep.equal({ requestId: 'REQ-42' });
    expect(run.turns[3]).to.deep.include({ text: ANSWER });
    expect(usage(run.turns)).to.deep.equal({ input: 280, output: 50 });
  });

  it('should run without provider side state and with strict tools', async () => {
    const { fetch, requests } = canned(OPENAI_REPLIES);
    const run = scenario();
    const adapter = openai({ apiKey: 'stub', fetch });
    expect(adapter.model).to.equal('gpt-6.1-sol');
    await runTurn({ adapter, turns: run.turns, execute: run.execute });
    for (const request of requests) {
      expect(request.url).to.match(/\/responses$/);
      //DEC-015: nothing is stored or chained on the provider's side
      expect(request.body.store).to.equal(false);
      expect(request.body).to.not.have.property('previous_response_id');
      expect(request.body).to.not.have.property('conversation');
      expect(request.body.model).to.equal('gpt-6.1-sol');
      expect(request.body.instructions).to.equal(SYSTEM);
      expect(request.body.max_output_tokens).to.equal(16000);
      expect(request.body.tools[0]).to.deep.equal({
        type: 'function',
        name: 'request_lookup',
        description: TOOLS[0].description,
        parameters: TOOLS[0].input,
        strict: true
      });
    }
  });

  it('should pass reasoning and the call back before the tool output', async () => {
    const { fetch, requests } = canned(OPENAI_REPLIES);
    const run = scenario();
    await runTurn({
      adapter: openai({ apiKey: 'stub', fetch }),
      turns: run.turns,
      execute: run.execute
    });
    //the full conversation is sent again, because nothing is kept remotely
    const input = requests[1].body.input;
    expect(kinds(input)).to.deep.equal([ 'user', 'reasoning', 'function_call', 'function_call_output' ]);
    expect(input[1].encrypted_content).to.equal('enc-kept-as-is');
    expect(input[3]).to.deep.include({ call_id: 'call_1' });
    expect(JSON.parse(input[3].output)).to.deep.equal({
      id: 'REQ-42', title: 'Blue heron budget 7731', status: 'SUBMITTED'
    });
  });

  it('should stream text to the callback and still return the full reply', async () => {
    const { fetch, requests } = canned([ () => openaiStream(OPENAI_REPLIES[1]) ]);
    const seen: string[] = [];
    const reply = await openai({ apiKey: 'stub', fetch }).send({
      system: SYSTEM, tools: TOOLS, turns: hi, onText: text => seen.push(text)
    });
    expect(requests[0].body.stream).to.equal(true);
    expect(requests[0].body.store).to.equal(false);
    expect(seen.length).to.be.greaterThan(1);
    expect(seen.join('')).to.equal(ANSWER);
    expect(reply).to.deep.include({ text: ANSWER, stop: 'end', usage: { input: 170, output: 22 } });
  });

  it('should send a tool as non-strict when its schema cannot be strict', async () => {
    const { fetch, requests } = canned([ response([ message('ok') ]) ]);
    await openai({ apiKey: 'stub', fetch }).send({
      system: SYSTEM,
      turns: hi,
      tools: [ {
        name: 'optional',
        description: 'x',
        input: {
          type: 'object',
          properties: { a: { type: 'string' }, b: { type: 'string' } },
          required: [ 'a' ],
          additionalProperties: false
        }
      }, {
        name: 'nested',
        description: 'x',
        input: {
          type: 'object',
          properties: { list: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } } },
          required: [ 'list' ],
          additionalProperties: false
        }
      } ]
    });
    expect(requests[0].body.tools.map((tool: any) => tool.strict)).to.deep.equal([ false, false ]);
  });

  it('should report a refusal part as a refusal', async () => {
    const refused = response([ {
      type: 'message', id: 'msg_r', role: 'assistant', status: 'completed',
      content: [ { type: 'refusal', refusal: 'I cannot help with that.' } ]
    } ]);
    const { fetch } = canned([ refused ]);
    const reply = await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    expect(reply).to.deep.include({ stop: 'refusal', text: '', raw: null });
    expect(reply.toolCalls).to.deep.equal([]);
  });

  it('should report a content filter stop as a refusal', async () => {
    const { fetch } = canned([ response([], {
      status: 'incomplete', incomplete_details: { reason: 'content_filter' }
    }) ]);
    const reply = await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    expect(reply.stop).to.equal('refusal');
  });

  it('should drop a call cut off by the output limit', async () => {
    const call = {
      type: 'function_call', id: 'fc_c', call_id: 'call_c', name: 'request_lookup',
      arguments: '{"requestId":"REQ-', status: 'incomplete'
    };
    const { fetch } = canned([ response([ call ], {
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }
    }) ]);
    const reply = await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    expect(reply).to.deep.include({ stop: 'length', raw: null });
    expect(reply.toolCalls).to.deep.equal([]);
  });

  it('should not trust arguments that are not an object', async () => {
    const call = (id: string, args: string) => ({
      type: 'function_call', id: `fc_${id}`, call_id: id, name: 'request_lookup',
      arguments: args, status: 'completed'
    });
    for (const args of [ '{"requestId":', '[1]', 'null' ]) {
      const { fetch } = canned([ response([ call('call_d', args) ]) ]);
      const reply = await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
      expect(reply, args).to.deep.include({ stop: 'length', raw: null });
      expect(reply.toolCalls, args).to.deep.equal([]);
    }
  });

  it('should treat a call with empty arguments as no arguments', async () => {
    const { fetch } = canned([ response([ {
      type: 'function_call', id: 'fc_e', call_id: 'call_e', name: 'ping',
      arguments: '', status: 'completed'
    } ]) ]);
    const reply = await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    expect(reply.stop).to.equal('tools');
    expect(reply.toolCalls).to.deep.equal([ { id: 'call_e', name: 'ping', input: {} } ]);
  });

  it('should not replay an incomplete reply as it came back', async () => {
    const { fetch } = canned([ response([
      { type: 'reasoning', id: 'rs_i', summary: [] },
      message('partial')
    ], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) ]);
    const reply = await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns: hi });
    expect(reply).to.deep.include({ stop: 'length', text: 'partial', raw: null });
  });

  it('should raise a failed response as a provider error', async () => {
    const { fetch } = canned([ response([], { status: 'failed', error: { code: 'server_error', message: 'it broke' } }) ]);
    const error = await openai({ apiKey: 'stub', fetch })
      .send({ system: SYSTEM, tools: TOOLS, turns: hi }).catch(error => error);
    expect(error).to.be.instanceOf(ProviderError);
    expect(error).to.deep.include({ kind: 'other', provider: 'openai', message: 'it broke' });
  });

  it('should rebuild a reply that another model wrote', async () => {
    const { fetch, requests } = canned([ response([ message('ok') ]) ]);
    const turns: any[] = [
      { role: 'user', text: 'first' },
      {
        role: 'assistant', text: 'Checking.', usage: { input: 1, output: 1 },
        toolCalls: [ { id: 'toolu_x', name: 'request_lookup', input: { requestId: 'REQ-9' } } ],
        raw: { provider: 'anthropic', model: 'claude-opus-5-5', content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_x', name: 'request_lookup', input: {} }
        ] }
      },
      { role: 'tool', results: [ { id: 'toolu_x', name: 'request_lookup', output: '{}' } ] },
      //a reply with nothing in it cannot be sent, so it is left out
      { role: 'assistant', text: '', usage: { input: 1, output: 1 }, toolCalls: [], raw: null },
      { role: 'user', text: 'again' }
    ];
    await openai({ apiKey: 'stub', fetch }).send({ system: SYSTEM, tools: TOOLS, turns });
    const input = requests[0].body.input;
    expect(kinds(input)).to.deep.equal([
      'user', 'assistant', 'function_call', 'function_call_output', 'user'
    ]);
    expect(input[2]).to.deep.include({ call_id: 'toolu_x', arguments: '{"requestId":"REQ-9"}' });
    expect(JSON.stringify(input)).to.not.match(/thinking|tool_use|signature/);
  });

  describe('typed errors', () => {
    const failing = (status: number, error: Record<string, unknown>, headers = {}) => canned([
      () => json({ error: { message: `provider said ${status}`, type: 'x', ...error } }, status, {
        //the SDK retries these on its own unless told not to
        'x-should-retry': 'false', ...headers
      })
    ]).fetch;
    const send = (fetch: any) => openai({ apiKey: 'stub', fetch })
      .send({ system: SYSTEM, tools: TOOLS, turns: hi });

    it('should name a rate limit and how long to wait', async () => {
      const error = await send(failing(429, { code: 'rate_limit_exceeded' }, { 'retry-after': '3' }))
        .catch(error => error);
      expect(error).to.be.instanceOf(ProviderError);
      expect(error).to.deep.include({ kind: 'rate_limit', provider: 'openai', status: 429, retryAfter: 3 });
    });

    it('should not call an exhausted quota a rate limit', async () => {
      const error = await send(failing(429, { code: 'insufficient_quota' })).catch(error => error);
      expect(error).to.deep.include({ kind: 'other', status: 429 });
    });

    it('should name an authentication failure', async () => {
      const error = await send(failing(401, { code: 'invalid_api_key' })).catch(error => error);
      expect(error).to.deep.include({ kind: 'authentication', status: 401 });
    });

    it('should name a request the provider declined on policy grounds', async () => {
      const error = await send(failing(400, { code: 'invalid_prompt' })).catch(error => error);
      expect(error).to.deep.include({ kind: 'refusal', status: 400 });
    });

    it('should name any other failure', async () => {
      const error = await send(failing(400, { code: 'bad_request' })).catch(error => error);
      expect(error).to.deep.include({ kind: 'other', status: 400 });
    });
  });
});
