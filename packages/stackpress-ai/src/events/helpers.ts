//modules
import type Response from '@stackpress/ingest/Response';
//client
import type { Refusal } from '../types.js';

//the names of the events the agent answers. A route or a job resolves one of
// these with the request that carries the person's session
export const AGENT_EVENTS = {
  turn: 'ai-turn',
  approve: 'ai-approve',
  decline: 'ai-decline',
  undo: 'ai-undo',
  threads: 'ai-threads',
  thread: 'ai-thread',
  start: 'ai-start',
  create: 'ai-new'
} as const;

//an app may listen for this event to enrich the page context a message
// arrives with. It receives `url` and `items` and may answer with either
export const CONTEXT_EVENT = 'ai-context';

/**
 * Write an agent result to the response. A refusal becomes an error with its
 * status code and reason; anything else is the result.
 */
export function respond(res: Response, result: Refusal | { ok: true }) {
  if (!result.ok) {
    res.setError(
      result.error,
      {
        reason: result.reason,
        ...(result.resetsAt ? { resetsAt: result.resetsAt } : {})
      },
      [],
      result.code
    );
    return;
  }
  res.results(result as never);
}
