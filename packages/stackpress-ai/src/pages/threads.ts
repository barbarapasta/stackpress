//modules
import { action } from '@stackpress/ingest/Server';
//client
import { AGENT_EVENTS } from '../events/helpers.js';
import { answer, call } from './helpers.js';

/**
 * List the person's own threads.
 */
export default action(async function AgentThreads({ ctx, req, res }) {
  const response = await call(ctx, req, res, AGENT_EVENTS.threads);
  if (response !== undefined) answer(res, response);
});
