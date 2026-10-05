//modules
import { action } from '@stackpress/ingest/Server';
import type Server from '@stackpress/ingest/Server';
//client
import { createEvents, fromStore, refusedEvents } from '../scripts/records.js';

//these listeners run ahead of the generated ones, which have priority 0, so
// a refused request never reaches the generated write
export const GUARD_PRIORITY = 1000;

//the reason a guarded event answers
export const GUARD_MESSAGE =
  'Agent records can only be changed through the agent store.';

/**
 * Build the guard of one generated event. A create guard lets through only
 * the create that the store itself is running.
 */
export function guard(event: string, creation = false) {
  return action(async function AgentRecordGuard({ res }) {
    //if the store is the one calling, then let the generated create run
    if (creation && fromStore(event)) {
      return;
    }

    //otherwise refuse, and stop the listeners that come after this one
    res.setError(GUARD_MESSAGE, { event }, [], 403);
    return false;
  });
}

/**
 * Register the guards of the agent records on a server.
 */
export default function guardRecords(ctx: Pick<Server, 'on'>) {
  for (const event of refusedEvents()) {
    ctx.on(event, guard(event), GUARD_PRIORITY);
  }
  for (const event of createEvents()) {
    ctx.on(event, guard(event, true), GUARD_PRIORITY);
  }
}
