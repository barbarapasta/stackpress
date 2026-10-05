//modules
import { action } from '@stackpress/ingest/Server';
//client
import type { ToolRequest, ToolResolverServer } from '../types.js';
import { runtimeOf } from '../scripts/agent.js';
import { startInfo } from '../scripts/threads.js';
import { respond } from './helpers.js';

/**
 * Bridge the Stackpress event system into what the panel needs to start.
 */
export default action(async function AgentStart({ ctx, req, res }) {
  //if another listener already failed, then stop here
  if (res.code && res.code !== 200) {
    return;
  }

  respond(res, await startInfo(
    runtimeOf(ctx as unknown as ToolResolverServer),
    req as unknown as ToolRequest
  ));
});
