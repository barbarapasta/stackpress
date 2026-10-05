//modules
import { action } from '@stackpress/ingest/Server';
//client
import { AGENT_EVENTS } from '../events/helpers.js';
import { guard, run } from './helpers.js';

/**
 * Undo an action of the person's own: the rest of the turn streams when
 * the request asks for it.
 */
export default action(async function AgentUndo({ ctx, req, res }) {
  if (!await guard(ctx, req, res)) return;
  await run(ctx, req, res, AGENT_EVENTS.undo);
});
