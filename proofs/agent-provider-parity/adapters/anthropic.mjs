//modules
import Anthropic from '@anthropic-ai/sdk';

export const PROVIDER = 'anthropic';

const STOPS = {
  end_turn: 'end',
  max_tokens: 'length',
  pause_turn: 'pause',
  refusal: 'refusal',
  stop_sequence: 'end',
  tool_use: 'tools'
};

/**
 * Anthropic Messages API through the official SDK.
 *
 * The loop is owned by the caller, not the SDK tool runner, because a turn
 * here can pause for a person's approval and resume in another process.
 */
export default function anthropic({ apiKey, effort = 'medium', fetch, model = 'claude-opus-5-5' } = {}) {
  //with no options the SDK resolves credentials from the environment
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(fetch ? { fetch } : {})
  });

  return {
    provider: PROVIDER,
    model,
    async send({ system, tools, turns }) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        //a declined request is retried server-side on the recommended model
        betas: [ 'server-side-fallback-2026-07-01' ],
        fallbacks: 'default',
        output_config: { effort },
        system,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input,
          strict: true
        })),
        messages: turns.map(turn => toMessage(turn, model))
      });

      //a refusal carries no usable content, so decide on the stop reason first
      const stop = STOPS[response.stop_reason] || 'end';
      const content = stop === 'refusal' ? [] : response.content;
      return {
        text: content.filter(block => block.type === 'text').map(block => block.text).join(''),
        toolCalls: content.filter(block => block.type === 'tool_use').map(block => ({
          id: block.id,
          name: block.name,
          input: block.input
        })),
        stop,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens
        },
        raw: { provider: PROVIDER, model, content: response.content }
      };
    }
  };
}

/**
 * Translate one neutral turn into a Messages API message.
 */
function toMessage(turn, model) {
  if (turn.role === 'user') {
    return { role: 'user', content: turn.text };
  }
  if (turn.role === 'tool') {
    //every result of one step goes back in a single user message
    return {
      role: 'user',
      content: turn.results.map(result => ({
        type: 'tool_result',
        tool_use_id: result.id,
        content: result.output,
        ...(result.isError ? { is_error: true } : {})
      }))
    };
  }
  //a reply this model produced is replayed unchanged, thinking blocks included
  if (turn.raw?.provider === PROVIDER && turn.raw.model === model) {
    return { role: 'assistant', content: turn.raw.content };
  }
  //a reply from another model is rebuilt from the neutral record
  return {
    role: 'assistant',
    content: [
      ...(turn.text ? [ { type: 'text', text: turn.text } ] : []),
      ...turn.toolCalls.map(call => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input
      }))
    ]
  };
}
