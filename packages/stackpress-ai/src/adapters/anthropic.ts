//modules
import Anthropic from '@anthropic-ai/sdk';
//client
import type {
  Adapter,
  AdapterReply,
  AdapterStop,
  AdapterToolCall,
  AdapterTurn,
  AnthropicOptions
} from '../types.js';
import { guard } from './errors.js';
import { strict } from './helpers.js';

type Block = Anthropic.Beta.BetaContentBlock;

export const PROVIDER = 'anthropic';
export const DEFAULT_MODEL = 'claude-opus-5-5';

//this beta header and body field opt a request into the server-side
// fallback: a request the provider declines is retried on the model it
// recommends, inside the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const STOPS: Record<string, AdapterStop> = {
  end_turn: 'end',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  pause_turn: 'pause',
  refusal: 'refusal',
  stop_sequence: 'end',
  tool_use: 'tools'
};

//these blocks cannot be echoed from before a fallback boundary
const BEFORE_FALLBACK = [ 'thinking', 'redacted_thinking', 'tool_use' ];

/**
 * Anthropic Messages API through the official SDK.
 *
 * The loop is owned by the runtime, not the SDK tool runner, because a turn
 * can pause for a person's approval and resume in another process.
 */
export default function anthropic(options: AnthropicOptions = {}): Adapter {
  const { apiKey, effort = 'medium', fetch, maxTokens = 16000 } = options;
  const model = options.model || DEFAULT_MODEL;
  //with no key the SDK resolves credentials from its own environment
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(fetch ? { fetch } : {})
  });

  return {
    provider: PROVIDER,
    model,
    async send({ system, tools, turns, onText }) {
      const response = await guard(PROVIDER, async () => {
        //a long reply is streamed so no request times out waiting on it
        const stream = client.beta.messages.stream({
          model,
          max_tokens: maxTokens,
          betas: [ FALLBACK_BETA ],
          fallbacks: 'default',
          output_config: { effort },
          system,
          tools: tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input as Anthropic.Beta.BetaTool['input_schema'],
            strict: strict(tool)
          })),
          messages: turns.flatMap(turn => toMessages(turn, model))
        });
        if (onText) {
          stream.on('text', text => onText(text));
        }
        return await stream.finalMessage();
      });

      //a refusal carries no usable content, so decide on the stop reason first
      let stop = STOPS[response.stop_reason || ''] || 'end';
      const content = stop === 'refusal' ? [] : response.content;
      //a call after the last fallback marker is the one that will be answered
      const boundary = lastFallback(content);
      let toolCalls: AdapterToolCall[] = content
        .filter((block, index) => block.type === 'tool_use' && index > boundary)
        .map(block => block as Anthropic.Beta.BetaToolUseBlock)
        .map(block => ({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>
        }));
      //a call cut off by the length limit has no trustworthy input
      const cut = stop === 'length' && toolCalls.length > 0;
      if (cut) {
        toolCalls = [];
      }
      if (stop === 'tools' && toolCalls.length === 0) {
        stop = 'end';
      }
      return {
        text: content
          .filter(block => block.type === 'text')
          .map(block => (block as Anthropic.Beta.BetaTextBlock).text)
          .join(''),
        toolCalls,
        stop,
        usage: usageOf(response),
        //a reply that was refused or cut off is not replayed as it came back
        raw: stop === 'refusal' || cut
          ? null
          : { provider: PROVIDER, model, content: response.content }
      } as AdapterReply;
    }
  };
}

//the index of the last fallback marker, or -1
function lastFallback(content: Block[]) {
  return content.map(block => block.type).lastIndexOf('fallback');
}

//when a fallback ran, the declined attempt's tokens were spent too, and the
// provider reports each attempt under usage.iterations
function usageOf(response: Anthropic.Beta.BetaMessage) {
  const attempts = (response.usage.iterations || []).filter(
    attempt => attempt.type === 'message' || attempt.type === 'fallback_message'
  ) as { input_tokens: number, output_tokens: number }[];
  const rows = attempts.length ? attempts : [ response.usage ];
  return rows.reduce((sum, row) => ({
    input: sum.input
      + row.input_tokens
      + ((row as { cache_creation_input_tokens?: number | null })
        .cache_creation_input_tokens || 0)
      + ((row as { cache_read_input_tokens?: number | null })
        .cache_read_input_tokens || 0),
    output: sum.output + row.output_tokens
  }), { input: 0, output: 0 });
}

/**
 * Translate one neutral turn into Messages API messages.
 */
function toMessages(turn: AdapterTurn, model: string): Anthropic.Beta.BetaMessageParam[] {
  if (turn.role === 'user') {
    return [ { role: 'user', content: turn.text } ];
  }
  if (turn.role === 'tool') {
    //every result of one step goes back in a single user message
    return [ {
      role: 'user',
      content: turn.results.map(result => ({
        type: 'tool_result' as const,
        tool_use_id: result.id,
        content: result.output,
        ...(result.isError ? { is_error: true } : {})
      }))
    } ];
  }
  //a reply this model produced is replayed unchanged, thinking blocks included
  let content: unknown[];
  if (turn.raw?.provider === PROVIDER && turn.raw.model === model) {
    const blocks = turn.raw.content as Block[];
    const boundary = lastFallback(blocks);
    //after a fallback, thinking and calls the declined attempt wrote before
    // the last marker are not echoed. The marker stays where it was, because
    // the provider uses it as the boundary when it checks the turn
    content = boundary < 0 ? blocks : blocks.filter((block, index) => (
      index > boundary || !BEFORE_FALLBACK.includes(block.type)
    ));
  } else {
    //a reply from another model is rebuilt from the neutral record
    content = [
      ...(turn.text ? [ { type: 'text', text: turn.text } ] : []),
      ...turn.toolCalls.map(call => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input
      }))
    ];
  }
  //the provider refuses an assistant message with nothing in it
  return content.length
    ? [ { role: 'assistant', content } as Anthropic.Beta.BetaMessageParam ]
    : [];
}
