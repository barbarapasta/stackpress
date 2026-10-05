//modules
import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';

export const PROVIDER = 'openai';

/**
 * OpenAI Responses API through the official SDK.
 */
export default function openai({ apiKey, fetch, model = 'gpt-6.1-sol' } = {}) {
  const client = new OpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(fetch ? { fetch } : {})
  });

  return {
    provider: PROVIDER,
    model,
    async send({ system, tools, turns }) {
      const response = await client.responses.create({
        model,
        instructions: system,
        max_output_tokens: 16000,
        tools: tools.map(tool => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.input,
          strict: true
        })),
        input: turns.flatMap(turn => toInput(turn, model))
      });

      const calls = response.output.filter(item => item.type === 'function_call');
      const parts = response.output
        .filter(item => item.type === 'message')
        .flatMap(item => item.content);
      const refused = parts.some(part => part.type === 'refusal');
      return {
        text: parts.filter(part => part.type === 'output_text').map(part => part.text).join(''),
        toolCalls: calls.map(item => ({
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments || '{}')
        })),
        stop: refused ? 'refusal'
          : calls.length ? 'tools'
          : response.status === 'incomplete' ? 'length'
          : 'end',
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens
        },
        raw: { provider: PROVIDER, model, output: response.output }
      };
    }
  };
}

/**
 * Translate one neutral turn into Responses API input items.
 */
function toInput(turn, model) {
  if (turn.role === 'user') {
    return [ { role: 'user', content: turn.text } ];
  }
  if (turn.role === 'tool') {
    return turn.results.map(result => ({
      type: 'function_call_output',
      call_id: result.id,
      output: result.output
    }));
  }
  //a reply this model produced goes back whole, reasoning items included
  if (turn.raw?.provider === PROVIDER && turn.raw.model === model) {
    return toResponseInputItems(turn.raw.output);
  }
  //a reply from another model is rebuilt from the neutral record
  return [
    ...(turn.text ? [ { role: 'assistant', content: turn.text } ] : []),
    ...turn.toolCalls.map(call => ({
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input)
    }))
  ];
}
