//modules
import { action } from '@stackpress/ingest/Server';
//client
import type { ToolRequest, ToolResolverServer } from '../types.js';
import { body, runtimeOf, watcher } from '../scripts/agent.js';
import { approve } from '../scripts/approval.js';
import { respond } from './helpers.js';

/**
 * Bridge the Stackpress event system into approving a pending action.
 */
export default action(async function AgentApprove({ ctx, req, res }) {
  //if another listener already failed, then stop here
  if (res.code && res.code !== 200) {
    return;
  }

  const request = req as unknown as ToolRequest;
  respond(res, await approve(
    runtimeOf(ctx as unknown as ToolResolverServer),
    request,
    body(request),
    watcher(request)
  ));
});
