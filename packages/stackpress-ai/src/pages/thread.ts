//modules
import { action } from '@stackpress/ingest/Server';
//client
import { AGENT_EVENTS } from '../events/helpers.js';
import { answer, call } from './helpers.js';

/**
 * Load one of the person's own threads.
 */
export default action(async function AgentThread({ ctx, req, res }) {
  const response = await call(ctx, req, res, AGENT_EVENTS.thread);
  if (response !== undefined) answer(res, response);
});
