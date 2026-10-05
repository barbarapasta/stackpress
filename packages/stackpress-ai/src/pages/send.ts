//modules
import { action } from '@stackpress/ingest/Server';
//client
import { AGENT_EVENTS } from '../events/helpers.js';
import { context, guard, run } from './helpers.js';

/**
 * Send a message: the reply streams when the request asks for it.
 */
export default action(async function AgentSend({ ctx, req, res }) {
  if (!await guard(ctx, req, res)) return;
  await context(ctx, req);
  await run(ctx, req, res, AGENT_EVENTS.turn);
});
