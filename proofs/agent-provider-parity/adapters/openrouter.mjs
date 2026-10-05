//modules
import OpenAI from 'openai';

export const PROVIDER = 'openrouter';

const STOPS = {
  content_filter: 'refusal',
  length: 'length',
  stop: 'end',
  tool_calls: 'tools'
};

/**
 * OpenRouter chat completions. OpenRouter documents the OpenAI SDK pointed
 * at its own address, so one key reaches models from several providers.
 */
export default function openrouter({ apiKey, fetch, maxTokens = 16000, model } = {}) {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    ...(fetch ? { fetch } : {})
  });

  return {
    provider: PROVIDER,
    model,
    async send({ system, tools, turns }) {
      const completion = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          ...turns.flatMap(turn => toMessages(turn, model))
        ],
        //OpenRouter validates the tool list on every request
        tools: tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input
          }
        })),
        tool_choice: 'auto'
      });

      const choice = completion.choices[0];
      const calls = choice.message.tool_calls || [];
      return {
        text: choice.message.content || '',
        toolCalls: calls.map(call => ({
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || '{}')
        })),
        stop: calls.length ? 'tools' : STOPS[choice.finish_reason] || 'end',
        usage: {
          input: completion.usage?.prompt_tokens || 0,
          output: completion.usage?.completion_tokens || 0
        },
        raw: { provider: PROVIDER, model, message: choice.message }
      };
    }
  };
}

/**
 * Translate one neutral turn into chat completion messages.
 */
function toMessages(turn, model) {
  if (turn.role === 'user') {
    return [ { role: 'user', content: turn.text } ];
  }
  if (turn.role === 'tool') {
    return turn.results.map(result => ({
      role: 'tool',
      tool_call_id: result.id,
      content: result.output
    }));
  }
  //a reply this model produced is replayed as it was returned
  if (turn.raw?.provider === PROVIDER && turn.raw.model === model) {
    return [ turn.raw.message ];
  }
  //a reply from another model is rebuilt from the neutral record
  return [ {
    role: 'assistant',
    content: turn.text || null,
    ...(turn.toolCalls.length ? {
      tool_calls: turn.toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) }
      }))
    } : {})
  } ];
}
