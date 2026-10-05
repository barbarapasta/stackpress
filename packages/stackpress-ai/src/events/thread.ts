//modules
import { action } from '@stackpress/ingest/Server';
//client
import type { ToolRequest, ToolResolverServer } from '../types.js';
import { body, runtimeOf } from '../scripts/agent.js';
import { loadThread } from '../scripts/threads.js';
import { respond } from './helpers.js';

/**
 * Bridge the Stackpress event system into loading one of the person's
 * threads.
 */
export default action(async function AgentThread({ ctx, req, res }) {
  //if another listener already failed, then stop here
  if (res.code && res.code !== 200) {
    return;
  }

  const request = req as unknown as ToolRequest;
  respond(res, await loadThread(
    runtimeOf(ctx as unknown as ToolResolverServer),
    request,
    body(request)
  ));
});
