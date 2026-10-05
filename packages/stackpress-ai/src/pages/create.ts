//modules
import { action } from '@stackpress/ingest/Server';
//client
import { AGENT_EVENTS } from '../events/helpers.js';
import { answer, call, context, guard } from './helpers.js';

/**
 * Start a new chat. The page context it was opened with is resolved the
 * way a message's is and handed back so the panel can show it.
 */
export default action(async function AgentCreate({ ctx, req, res }) {
  if (!await guard(ctx, req, res)) return;
  await context(ctx, req);
  const hints = req.data('context');
  const response = await call(ctx, req, res, AGENT_EVENTS.create);
  if (response === undefined) return;
  const results = response?.results as Record<string, unknown> | undefined;
  if ((response?.code || 200) < 400 && results) {
    results.context = hints || null;
  }
  answer(res, response);
});
