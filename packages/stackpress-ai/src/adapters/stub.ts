//client
import type {
  Adapter,
  AdapterReply,
  AdapterRequest,
  StubOptions,
  StubReply
} from '../types.js';

export const PROVIDER = 'stub';

//what the stub says when nobody scripted it, as the reference app uses it
// when no provider key is set
export const UNCONFIGURED = 'No model provider is configured. '
  + 'Set a provider key to talk to a real model.';

//the stub keeps what it was asked, so a test can read the requests back
export type StubAdapter = Adapter & { requests: AdapterRequest[] };

/**
 * Scripted replies. Each call answers from the next script entry and repeats
 * the last one when the script runs out.
 */
export default function stub(options: StubOptions = {}): StubAdapter {
  const model = options.model || 'stub';
  const script = options.replies?.length ? options.replies : [ { text: UNCONFIGURED } ];
  const requests: AdapterRequest[] = [];

  return {
    provider: PROVIDER,
    model,
    requests,
    async send(request) {
      const entry = script[Math.min(requests.length, script.length - 1)];
      //the caller keeps appending to its turns, so the stub keeps a copy
      requests.push({ ...request, turns: [ ...request.turns ] });
      if (entry instanceof Error) {
        throw entry;
      }
      const reply: StubReply = entry;
      const toolCalls = reply.toolCalls || [];
      const text = reply.text || '';
      if (text) {
        request.onText?.(text);
      }
      return {
        text,
        toolCalls,
        stop: reply.stop || (toolCalls.length ? 'tools' : 'end'),
        usage: reply.usage || { input: 0, output: 0 },
        raw: { provider: PROVIDER, model }
      } as AdapterReply;
    }
  };
}
