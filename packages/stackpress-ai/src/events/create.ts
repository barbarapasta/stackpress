//modules
import { action } from '@stackpress/ingest/Server';
//client
import type { ToolRequest, ToolResolverServer } from '../types.js';
import { body, runtimeOf } from '../scripts/agent.js';
import { newThread } from '../scripts/threads.js';
import { respond } from './helpers.js';

/**
 * Bridge the Stackpress event system into starting a new chat.
 */
export default action(async function AgentNew({ ctx, req, res }) {
  //if another listener already failed, then stop here
  if (res.code && res.code !== 200) {
    return;
  }

  const request = req as unknown as ToolRequest;
  respond(res, await newThread(
    runtimeOf(ctx as unknown as ToolResolverServer),
    request,
    body(request)
  ));
});
