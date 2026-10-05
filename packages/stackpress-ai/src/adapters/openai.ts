//modules
import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
//client
import type {
  Adapter,
  AdapterReply,
  AdapterStop,
  AdapterTurn,
  OpenAIOptions
} from '../types.js';
import { guard, ProviderError } from './errors.js';
import { parseInput, readableCalls, strict } from './helpers.js';

type Item = OpenAI.Responses.ResponseOutputItem;
type Input = OpenAI.Responses.ResponseInputItem;

export const PROVIDER = 'openai';
export const DEFAULT_MODEL = 'gpt-6.1-sol';

/**
 * OpenAI Responses API through the official SDK.
 *
 * Nothing is kept on the provider's side (DEC-015). Every request sets
 * `store: false`, never sends `previous_response_id`, and carries the whole
 * conversation as input, with each earlier output item (reasoning included)
 * passed back as the documentation describes for stateless use.
 */
export default function openai(options: OpenAIOptions = {}): Adapter {
  const { apiKey, fetch, maxTokens = 16000 } = options;
  const model = options.model || DEFAULT_MODEL;
  const client = new OpenAI({
    ...(apiKey ? { apiKey } : {}),
    ...(fetch ? { fetch } : {})
  });

  return {
    provider: PROVIDER,
    model,
    async send({ system, tools, turns, onText }) {
      const body = {
        model,
        store: false,
        instructions: system,
        max_output_tokens: maxTokens,
        tools: tools.map(tool => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.input,
          strict: strict(tool)
        })),
        input: turns.flatMap(turn => toInput(turn, model))
      };
      const response = await guard(PROVIDER, async () => {
        if (!onText) {
          return await client.responses.create(body);
        }
        const stream = client.responses.stream(body);
        stream.on('response.output_text.delta', event => onText(event.delta));
        return await stream.finalResponse();
      });

      if (response.status === 'failed') {
        throw new ProviderError(
          PROVIDER,
          'other',
          response.error?.message || 'The response failed.'
        );
      }
      //a streamed response carries parsed variants of the same items
      const output = response.output as Item[];
      const parts = output
        .filter((item): item is OpenAI.Responses.ResponseOutputMessage => (
          item.type === 'message'
        ))
        .flatMap(item => item.content);
      const { calls, damaged } = readableCalls(output
        .filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => (
          item.type === 'function_call'
        ))
        .map(item => ({
          id: item.call_id,
          name: item.name,
          input: parseInput(item.arguments)
        })));
      const incomplete = response.status === 'incomplete';
      const filtered = response.incomplete_details?.reason === 'content_filter';
      const refused = filtered || parts.some(part => part.type === 'refusal');
      //a call cut off by the length limit has no trustworthy arguments
      const cut = (incomplete || damaged) && !refused && (calls.length > 0 || damaged);

      let stop: AdapterStop = 'end';
      if (refused) {
        stop = 'refusal';
      } else if (cut || incomplete) {
        stop = 'length';
      } else if (calls.length) {
        stop = 'tools';
      }
      return {
        text: parts
          .filter(part => part.type === 'output_text')
          .map(part => part.text)
          .join(''),
        toolCalls: stop === 'tools' ? calls : [],
        stop,
        usage: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        //a reply that was refused or cut off is not replayed as it came back,
        // and an incomplete one can end on a reasoning item with nothing after
        raw: refused || cut || incomplete
          ? null
          : { provider: PROVIDER, model, output }
      } as AdapterReply;
    }
  };
}

/**
 * Translate one neutral turn into Responses API input items.
 */
function toInput(turn: AdapterTurn, model: string): Input[] {
  if (turn.role === 'user') {
    return [ { role: 'user', content: turn.text } ];
  }
  if (turn.role === 'tool') {
    return turn.results.map(result => ({
      type: 'function_call_output' as const,
      call_id: result.id,
      output: result.output
    }));
  }
  //a reply this model produced goes back whole, reasoning items included
  if (turn.raw?.provider === PROVIDER && turn.raw.model === model) {
    return toResponseInputItems(turn.raw.output as Item[]);
  }
  //a reply from another model is rebuilt from the neutral record
  return [
    ...(turn.text ? [ { role: 'assistant' as const, content: turn.text } ] : []),
    ...turn.toolCalls.map(call => ({
      type: 'function_call' as const,
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input)
    }))
  ];
}
