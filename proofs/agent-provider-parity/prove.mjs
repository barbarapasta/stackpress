//Spec 00004 P-003 (DEC-004): can one conversation loop drive Anthropic,
//OpenAI, and OpenRouter through adapters, with no provider-specific branch
//in the loop?
//
//Part 1 runs each adapter against canned replies handed to the real SDK, so
//the SDK builds the request and parses the reply. Part 2 runs live through
//OpenRouter when OPENROUTER_API_KEY is set. The Anthropic and OpenAI
//adapters are not run live here: that needs their own keys.

//node
import assert from 'node:assert/strict';
import fs from 'node:fs';
//proof
import { runTurn, shape, usage } from './contract.mjs';
import anthropic from './adapters/anthropic.mjs';
import openai from './adapters/openai.mjs';
import openrouter from './adapters/openrouter.mjs';

//--------------------------------------------------------------------//
// Scenario

const SYSTEM = 'You are the Approvals agent. Answer only from tool results. Never guess.';
const QUESTION = 'What are the title and status of request REQ-42? Use the request_lookup tool.';
const TOOLS = [ {
  name: 'request_lookup',
  description: 'Look up one approval request by its identifier.',
  input: {
    type: 'object',
    properties: {
      requestId: { type: 'string', description: 'The request identifier, for example REQ-42.' }
    },
    required: [ 'requestId' ],
    additionalProperties: false
  }
} ];
const RECORD = { id: 'REQ-42', title: 'Blue heron budget 7731', status: 'SUBMITTED' };
const SHAPE = [ 'user', 'assistant:tools(request_lookup)', 'tool', 'assistant:text' ];
const ANSWER = 'Request REQ-42 is "Blue heron budget 7731" and its status is SUBMITTED.';

function scenario() {
  const calls = [];
  return {
    calls,
    turns: [ { role: 'user', text: QUESTION } ],
    execute: async call => {
      calls.push(call);
      return RECORD;
    }
  };
}

//--------------------------------------------------------------------//
// Canned Replies

function stub(replies) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(init.body)
    });
    return new Response(JSON.stringify(replies[requests.length - 1]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { fetch, requests };
}

const ANTHROPIC_REPLIES = [ {
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-kept-as-is' },
    { type: 'text', text: 'Looking that up.' },
    { type: 'tool_use', id: 'toolu_1', name: 'request_lookup', input: { requestId: 'REQ-42' } }
  ],
  stop_reason: 'tool_use', stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 }
}, {
  id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [ { type: 'text', text: ANSWER } ],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 180, output_tokens: 25 }
} ];

const OPENAI_REPLIES = [ {
  id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'request_lookup',
      arguments: '{"requestId":"REQ-42"}', status: 'completed'
    }
  ],
  usage: { input_tokens: 110, output_tokens: 28, total_tokens: 138 }
}, {
  id: 'resp_2', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
  output: [ {
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [ { type: 'output_text', text: ANSWER, annotations: [] } ]
  } ],
  usage: { input_tokens: 170, output_tokens: 22, total_tokens: 192 }
} ];

const OPENROUTER_REPLIES = [ {
  id: 'gen_1', object: 'chat.completion', model: 'stub/model',
  choices: [ {
    index: 0, finish_reason: 'tool_calls',
    message: {
      role: 'assistant', content: null,
      tool_calls: [ {
        id: 'call_or_1', type: 'function',
        function: { name: 'request_lookup', arguments: '{"requestId":"REQ-42"}' }
      } ]
    }
  } ],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
}, {
  id: 'gen_2', object: 'chat.completion', model: 'stub/model',
  choices: [ {
    index: 0, finish_reason: 'stop',
    message: { role: 'assistant', content: ANSWER }
  } ],
  usage: { prompt_tokens: 150, completion_tokens: 18, total_tokens: 168 }
} ];

//--------------------------------------------------------------------//
// Checks

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push([ 'PASS', name ]);
  } catch (error) {
    checks.push([ 'FAIL', `${name} :: ${String(error.message).split('\n')[0]}` ]);
  }
}

function common(label, run, stop) {
  check(`${label}: the turn ends normally`, () => assert.equal(stop, 'end'));
  check(`${label}: the transcript has the same shape as every other provider`, () => {
    assert.deepEqual(shape(run.turns), SHAPE);
  });
  check(`${label}: the tool ran once with the right input`, () => {
    assert.equal(run.calls.length, 1);
    assert.deepEqual(run.calls[0].input, { requestId: 'REQ-42' });
  });
  check(`${label}: the answer comes from the tool result`, () => {
    const text = run.turns[run.turns.length - 1].text;
    assert.match(text, /7731/);
    assert.match(text, /SUBMITTED/i);
  });
  check(`${label}: usage is reported`, () => {
    const total = usage(run.turns);
    assert.ok(total.input > 0 && total.output > 0, JSON.stringify(total));
  });
}

check('the loop names no provider', () => {
  const source = fs.readFileSync(new URL('./contract.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /anthropic|openai|openrouter|claude|gpt/i);
});

//---- Part 1: canned replies through the real SDKs

const runs = {};
{
  const { fetch, requests } = stub(ANTHROPIC_REPLIES);
  const run = runs.anthropic = scenario();
  const stop = await runTurn({
    adapter: anthropic({ apiKey: 'stub', fetch }),
    system: SYSTEM, tools: TOOLS, turns: run.turns, execute: run.execute
  });
  common('anthropic (canned)', run, stop);
  check('anthropic (canned): the request opts into the default fallback', () => {
    assert.equal(requests[0].body.fallbacks, 'default');
    assert.match(requests[0].headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  });
  check('anthropic (canned): tools are sent strict with their schema', () => {
    assert.equal(requests[0].body.tools[0].strict, true);
    assert.deepEqual(requests[0].body.tools[0].input_schema, TOOLS[0].input);
  });
  check('anthropic (canned): the reply is replayed unchanged, thinking block included', () => {
    assert.deepEqual(requests[1].body.messages[1].content, ANTHROPIC_REPLIES[0].content);
  });
  check('anthropic (canned): tool results go back in one user message', () => {
    const message = requests[1].body.messages[2];
    assert.equal(message.role, 'user');
    assert.deepEqual(message.content.map(block => block.type), [ 'tool_result' ]);
    assert.equal(message.content[0].tool_use_id, 'toolu_1');
  });
}
{
  const { fetch, requests } = stub(OPENAI_REPLIES);
  const run = runs.openai = scenario();
  const stop = await runTurn({
    adapter: openai({ apiKey: 'stub', fetch }),
    system: SYSTEM, tools: TOOLS, turns: run.turns, execute: run.execute
  });
  common('openai (canned)', run, stop);
  check('openai (canned): the request uses the Responses API with strict tools', () => {
    assert.match(requests[0].url, /\/responses$/);
    assert.equal(requests[0].body.tools[0].strict, true);
    assert.deepEqual(requests[0].body.tools[0].parameters, TOOLS[0].input);
  });
  check('openai (canned): reasoning and the call go back before the tool output', () => {
    const kinds = requests[1].body.input.map(item => item.type || item.role);
    assert.deepEqual(kinds, [ 'user', 'reasoning', 'function_call', 'function_call_output' ]);
    assert.equal(requests[1].body.input[3].call_id, 'call_1');
  });
}
{
  const { fetch, requests } = stub(OPENROUTER_REPLIES);
  const run = runs.openrouter = scenario();
  const stop = await runTurn({
    adapter: openrouter({ apiKey: 'stub', fetch, model: 'stub/model' }),
    system: SYSTEM, tools: TOOLS, turns: run.turns, execute: run.execute
  });
  common('openrouter (canned)', run, stop);
  check('openrouter (canned): the request goes to OpenRouter chat completions', () => {
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(requests[0].headers.authorization, 'Bearer stub');
  });
  check('openrouter (canned): the tool list is sent on every request', () => {
    assert.equal(requests[0].body.tools.length, 1);
    assert.equal(requests[1].body.tools.length, 1);
  });
  check('openrouter (canned): the tool result answers the call by id', () => {
    const roles = requests[1].body.messages.map(message => message.role);
    assert.deepEqual(roles, [ 'system', 'user', 'assistant', 'tool' ]);
    assert.equal(requests[1].body.messages[3].tool_call_id, 'call_or_1');
  });
}

//---- switching models mid-conversation: a transcript one provider wrote
//     must be readable by another

{
  const FOLLOW = [ {
    id: 'resp_3', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
    output: [ {
      type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
      content: [ { type: 'output_text', text: 'It is still SUBMITTED.', annotations: [] } ]
    } ],
    usage: { input_tokens: 200, output_tokens: 8, total_tokens: 208 }
  } ];
  const { fetch, requests } = stub(FOLLOW);
  const turns = [ ...runs.anthropic.turns, { role: 'user', text: 'Is it still open?' } ];
  await runTurn({
    adapter: openai({ apiKey: 'stub', fetch }),
    system: SYSTEM, tools: TOOLS, turns, execute: async () => RECORD
  });
  check('switch anthropic -> openai: the earlier turns are rebuilt, nothing foreign is sent', () => {
    const kinds = requests[0].body.input.map(item => item.type || item.role);
    assert.deepEqual(kinds, [
      'user', 'assistant', 'function_call', 'function_call_output', 'assistant', 'user'
    ]);
    assert.doesNotMatch(JSON.stringify(requests[0].body.input), /thinking|tool_use|signature/);
  });
}
{
  const FOLLOW = [ {
    id: 'msg_3', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [ { type: 'text', text: 'It is still SUBMITTED.' } ],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 210, output_tokens: 9 }
  } ];
  const { fetch, requests } = stub(FOLLOW);
  const turns = [ ...runs.openai.turns, { role: 'user', text: 'Is it still open?' } ];
  await runTurn({
    adapter: anthropic({ apiKey: 'stub', fetch }),
    system: SYSTEM, tools: TOOLS, turns, execute: async () => RECORD
  });
  check('switch openai -> anthropic: the earlier turns are rebuilt, nothing foreign is sent', () => {
    const messages = requests[0].body.messages;
    assert.deepEqual(messages.map(message => message.role), [
      'user', 'assistant', 'user', 'assistant', 'user'
    ]);
    assert.deepEqual(messages[1].content.map(block => block.type), [ 'tool_use' ]);
    assert.equal(messages[2].content[0].tool_use_id, 'call_1');
    assert.doesNotMatch(JSON.stringify(messages), /reasoning|function_call/);
  });
}

//---- Part 2: live through OpenRouter

const key = (process.env.OPENROUTER_API_KEY || '').trim();
const live = [];
if (!key) {
  checks.push([ 'SKIP', 'live OpenRouter runs: OPENROUTER_API_KEY is not set' ]);
} else {
  for (const model of [ 'anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol' ]) {
    const run = scenario();
    let stop = 'error';
    try {
      stop = await runTurn({
        //a small cap: this is a two-step lookup on a test key
        adapter: openrouter({ apiKey: key, maxTokens: 2000, model }),
        system: SYSTEM, tools: TOOLS, turns: run.turns, execute: run.execute
      });
    } catch (error) {
      //never print the request: it carries the key
      checks.push([ 'FAIL', `live ${model}: ${error.status || ''} ${String(error.message).slice(0, 160)}` ]);
      continue;
    }
    common(`live ${model}`, run, stop);
    live.push({ model, ...usage(run.turns), answer: run.turns[run.turns.length - 1].text });
  }
}

for (const [ status, name ] of checks) console.log(status, name);
for (const row of live) {
  console.log(`LIVE ${row.model}: ${row.input} tokens in, ${row.output} out`);
  console.log(`     answer: ${row.answer.replace(/\s+/g, ' ').slice(0, 200)}`);
}
const failed = checks.filter(([ status ]) => status === 'FAIL').length;
const passed = checks.filter(([ status ]) => status === 'PASS').length;
console.log(`${passed} passed, ${failed} failed, ${checks.length - passed - failed} skipped`);
process.exit(failed ? 1 : 0);
