//modules
import { action } from '@stackpress/ingest/Server';
//client
import type { ToolRequest, ToolResolverServer } from '../types.js';
import { body, runtimeOf } from '../scripts/agent.js';
import { listThreads } from '../scripts/threads.js';
import { respond } from './helpers.js';

/**
 * Bridge the Stackpress event system into listing the person's threads.
 */
export default action(async function AgentThreads({ ctx, req, res }) {
  //if another listener already failed, then stop here
  if (res.code && res.code !== 200) {
    return;
  }

  const request = req as unknown as ToolRequest;
  respond(res, await listThreads(
    runtimeOf(ctx as unknown as ToolResolverServer),
    request,
    body(request)
  ));
});
