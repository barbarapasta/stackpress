//client
import type {
  Adapter,
  AdapterStop,
  AdapterTool,
  AdapterToolCall,
  AdapterTurn
} from '../src/types.js';

//these helpers hand the real provider SDKs canned replies through the custom
// fetch each SDK accepts, so the SDK builds the request and parses the reply
// exactly as it would live. The loop here is test code: the conversation
// loop itself belongs to a later task.

export const SYSTEM = 'You are the Approvals agent. Answer only from tool results. Never guess.';
export const QUESTION = 'What are the title and status of request REQ-42? Use the request_lookup tool.';
export const TOOLS: AdapterTool[] = [ {
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
export const RECORD = { id: 'REQ-42', title: 'Blue heron budget 7731', status: 'SUBMITTED' };
export const SHAPE = [ 'user', 'assistant:tools(request_lookup)', 'tool', 'assistant:text' ];
export const ANSWER = 'Request REQ-42 is "Blue heron budget 7731" and its status is SUBMITTED.';

//--------------------------------------------------------------------//
// Loop

//run one conversation until the model stops asking for tools
export async function runTurn(options: {
  adapter: Adapter,
  turns: AdapterTurn[],
  execute: (call: AdapterToolCall) => Promise<unknown>,
  tools?: AdapterTool[],
  onText?: (text: string) => void,
  maxSteps?: number
}) {
  const { adapter, turns, execute, tools = TOOLS, onText, maxSteps = 6 } = options;
  for (let step = 0; step < maxSteps; step++) {
    const reply = await adapter.send({ system: SYSTEM, tools, turns, onText });
    turns.push({
      role: 'assistant',
      text: reply.text,
      toolCalls: reply.toolCalls,
      usage: reply.usage,
      raw: reply.raw
    });
    if (reply.stop !== 'tools') {
      return reply.stop;
    }
    const results = await Promise.all(reply.toolCalls.map(async call => {
      try {
        return { id: call.id, name: call.name, output: JSON.stringify(await execute(call)) };
      } catch (error) {
        return {
          id: call.id,
          name: call.name,
          output: String((error as Error).message),
          isError: true
        };
      }
    }));
    turns.push({ role: 'tool', results });
  }
  return 'steps' as AdapterStop | 'steps';
}

//describe a transcript by turn kind so two runs can be compared
export function shape(turns: AdapterTurn[]) {
  return turns.map(turn => {
    if (turn.role !== 'assistant') return turn.role;
    return turn.toolCalls.length
      ? `assistant:tools(${turn.toolCalls.map(call => call.name).join(',')})`
      : 'assistant:text';
  });
}

//add up the usage the adapters reported across a transcript
export function usage(turns: AdapterTurn[]) {
  return turns.reduce((sum, turn) => turn.role === 'assistant'
    ? { input: sum.input + turn.usage.input, output: sum.output + turn.usage.output }
    : sum, { input: 0, output: 0 });
}

export function scenario() {
  const calls: AdapterToolCall[] = [];
  return {
    calls,
    turns: [ { role: 'user', text: QUESTION } ] as AdapterTurn[],
    execute: async (call: AdapterToolCall) => {
      calls.push(call);
      return RECORD;
    }
  };
}

//--------------------------------------------------------------------//
// Canned fetch

export type Recorded = {
  url: string,
  headers: Record<string, string>,
  body: any
};

//a reply is a JSON body (answered 200), or a ready Response, or a function
// that builds one
export type Canned = unknown | Response | (() => Response);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

export function sse(events: { event?: string, data: unknown }[] | string[]) {
  const text = (events as ({ event?: string, data: unknown } | string)[]).map(item => {
    if (typeof item === 'string') return `data: ${item}\n\n`;
    return `${item.event ? `event: ${item.event}\n` : ''}data: ${JSON.stringify(item.data)}\n\n`;
  }).join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

//answer each request from the next canned reply and record what was sent
export function canned(replies: Canned[]) {
  const requests: Recorded[] = [];
  const fetch = async (url: any, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body))
    });
    const reply = replies[requests.length - 1];
    if (reply instanceof Response) return reply;
    if (typeof reply === 'function') return (reply as () => Response)();
    return json(reply);
  };
  return { fetch: fetch as (url: any, init?: any) => Promise<Response>, requests };
}

//--------------------------------------------------------------------//
// Anthropic

export const ANTHROPIC_REPLIES = [ {
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

//turn one message into the server-sent events the Messages API streams
export function anthropicStream(message: any, chunk = 8) {
  const events: { event: string, data: unknown }[] = [];
  const add = (data: any) => events.push({ event: data.type, data });
  add({
    type: 'message_start',
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { ...message.usage, output_tokens: 1, iterations: undefined }
    }
  });
  message.content.forEach((block: any, index: number) => {
    if (block.type === 'text') {
      add({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (let at = 0; at < block.text.length; at += chunk) {
        add({
          type: 'content_block_delta', index,
          delta: { type: 'text_delta', text: block.text.slice(at, at + chunk) }
        });
      }
    } else if (block.type === 'tool_use') {
      add({
        type: 'content_block_start', index,
        content_block: { ...block, input: {} }
      });
      add({
        type: 'content_block_delta', index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      });
    } else if (block.type === 'thinking') {
      add({
        type: 'content_block_start', index,
        content_block: { type: 'thinking', thinking: '', signature: '' }
      });
      add({
        type: 'content_block_delta', index,
        delta: { type: 'signature_delta', signature: block.signature }
      });
    } else {
      add({ type: 'content_block_start', index, content_block: block });
    }
    add({ type: 'content_block_stop', index });
  });
  add({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: {
      output_tokens: message.usage.output_tokens,
      ...(message.usage.iterations ? { iterations: message.usage.iterations } : {})
    }
  });
  add({ type: 'message_stop' });
  return sse(events);
}

//--------------------------------------------------------------------//
// OpenAI Responses

export const OPENAI_REPLIES = [ {
  id: 'resp_1', object: 'response', status: 'completed', model: 'gpt-6.1-sol',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-kept-as-is' },
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

//turn one response into the server-sent events the Responses API streams
export function openaiStream(response: any, chunk = 8) {
  let sequence = 0;
  const events: { event: string, data: unknown }[] = [];
  const add = (data: any) => events.push({
    event: data.type,
    data: { ...data, sequence_number: sequence++ }
  });
  add({ type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } });
  response.output.forEach((item: any, index: number) => {
    add({ type: 'response.output_item.added', output_index: index, item });
    if (item.type === 'message') {
      item.content.forEach((part: any, at: number) => {
        for (let from = 0; from < part.text.length; from += chunk) {
          add({
            type: 'response.output_text.delta',
            item_id: item.id, output_index: index, content_index: at,
            delta: part.text.slice(from, from + chunk), logprobs: []
          });
        }
      });
    }
    add({ type: 'response.output_item.done', output_index: index, item });
  });
  add({
    type: response.status === 'incomplete' ? 'response.incomplete' : 'response.completed',
    response
  });
  return sse(events);
}

//--------------------------------------------------------------------//
// OpenRouter chat completions

export const OPENROUTER_REPLIES = [ {
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

//turn one completion into the chunks a streamed chat completion sends
export function chatStream(completion: any, chunk = 8) {
  const choice = completion.choices[0];
  const base = { id: completion.id, object: 'chat.completion.chunk', model: completion.model };
  const chunks: unknown[] = [ {
    ...base,
    choices: [ { index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null } ]
  } ];
  const text: string = choice.message.content || '';
  for (let at = 0; at < text.length; at += chunk) {
    chunks.push({
      ...base,
      choices: [ { index: 0, delta: { content: text.slice(at, at + chunk) }, finish_reason: null } ]
    });
  }
  (choice.message.tool_calls || []).forEach((call: any, index: number) => {
    chunks.push({
      ...base,
      choices: [ {
        index: 0, finish_reason: null,
        delta: { tool_calls: [ { index, ...call } ] }
      } ]
    });
  });
  chunks.push({
    ...base,
    choices: [ { index: 0, delta: {}, finish_reason: choice.finish_reason } ]
  });
  chunks.push({ ...base, choices: [], usage: completion.usage });
  return sse([ ...chunks.map(data => JSON.stringify(data)), '[DONE]' ]);
}
