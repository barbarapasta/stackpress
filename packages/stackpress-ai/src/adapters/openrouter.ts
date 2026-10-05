//modules
import OpenAI from 'openai';
//client
import type {
  Adapter,
  AdapterReply,
  AdapterStop,
  AdapterTurn,
  OpenRouterOptions
} from '../types.js';
import { guard, ProviderError } from './errors.js';
import { parseInput, readableCalls } from './helpers.js';

type Message = OpenAI.Chat.ChatCompletionMessage;

export const PROVIDER = 'openrouter';
export const BASE_URL = 'https://openrouter.ai/api/v1';

const STOPS: Record<string, AdapterStop> = {
  content_filter: 'refusal',
  length: 'length',
  stop: 'end',
  tool_calls: 'tools'
};

/**
 * OpenRouter chat completions. OpenRouter documents the OpenAI SDK pointed
 * at its own address, so one key reaches models from several providers.
 * The model has no default because it names a provider and a model.
 */
export default function openrouter(options: OpenRouterOptions): Adapter {
  const { apiKey, fetch, maxTokens = 16000, model } = options;
  if (!model) {
    throw new ProviderError(PROVIDER, 'other', 'OpenRouter needs a model identifier.');
  }
  if (!apiKey) {
    throw new ProviderError(PROVIDER, 'authentication', 'OpenRouter needs an API key.');
  }
  const client = new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    ...(fetch ? { fetch } : {})
  });

  return {
    provider: PROVIDER,
    model,
    async send({ system, tools, turns, onText }) {
      const body = {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system' as const, content: system },
          ...turns.flatMap(turn => toMessages(turn, model))
        ] as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        //OpenRouter validates the tool list on every request, so it is
        // sent on each one even when the reply is plain text
        tools: tools.map(tool => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input
          }
        })),
        tool_choice: 'auto' as const
      };
      const completion = await guard(PROVIDER, async () => {
        if (!onText) {
          return await client.chat.completions.create(body);
        }
        const stream = client.chat.completions.stream({
          ...body,
          stream_options: { include_usage: true }
        });
        stream.on('content', delta => onText(delta));
        return await stream.finalChatCompletion();
      });

      //OpenRouter can answer 200 with an error body and no choices
      const choice = completion.choices?.[0];
      const failure = (completion as { error?: { message?: string } }).error
        || (choice as { error?: { message?: string } } | undefined)?.error;
      if (!choice || failure) {
        throw new ProviderError(
          PROVIDER,
          'other',
          failure?.message || 'OpenRouter returned no choices.'
        );
      }
      const message = clean(choice.message);
      const { calls, damaged } = readableCalls((message.tool_calls || [])
        .filter(call => call.type === 'function')
        .map(call => ({
          id: call.id,
          name: call.function.name,
          input: parseInput(call.function.arguments)
        })));
      const refused = Boolean(message.refusal)
        || choice.finish_reason === 'content_filter';
      //a call cut off by the length limit has no trustworthy arguments
      const cut = !refused && (damaged || (
        choice.finish_reason === 'length' && calls.length > 0
      ));

      let stop: AdapterStop = STOPS[choice.finish_reason] || 'end';
      if (refused) {
        stop = 'refusal';
      } else if (cut) {
        stop = 'length';
      } else if (calls.length) {
        stop = 'tools';
      } else if (stop === 'tools') {
        stop = 'end';
      }
      return {
        text: message.content || '',
        toolCalls: stop === 'tools' ? calls : [],
        stop,
        usage: {
          input: completion.usage?.prompt_tokens || 0,
          output: completion.usage?.completion_tokens || 0
        },
        //a reply that was refused or cut off is not replayed as it came back
        raw: refused || cut ? null : { provider: PROVIDER, model, message }
      } as AdapterReply;
    }
  };
}

//the streaming helper adds parsed fields of its own to the message, and they
// are not part of what the provider returned, so they are not sent back
function clean(message: Message): Message {
  const copy = JSON.parse(JSON.stringify(message));
  delete copy.parsed;
  for (const call of copy.tool_calls || []) {
    delete call.function?.parsed_arguments;
  }
  return copy;
}

/**
 * Translate one neutral turn into chat completion messages.
 */
function toMessages(turn: AdapterTurn, model: string): Record<string, unknown>[] {
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
    return [ turn.raw.message as Record<string, unknown> ];
  }
  //the provider refuses an assistant message with nothing in it
  if (!turn.text && !turn.toolCalls.length) {
    return [];
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
