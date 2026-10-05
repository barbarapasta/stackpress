//modules
import { action } from '@stackpress/ingest/Server';
//client
import type { ToolRequest, ToolResolverServer } from '../types.js';
import { body, runtimeOf, watcher } from '../scripts/agent.js';
import { runTurn } from '../scripts/turn.js';
import { respond } from './helpers.js';

/**
 * Bridge the Stackpress event system into one agent turn. A callback
 * attached to the request with watch() receives each report as it
 * happens.
 */
export default action(async function AgentTurn({ ctx, req, res }) {
  //if another listener already failed, then stop here
  if (res.code && res.code !== 200) {
    return;
  }

  const request = req as unknown as ToolRequest;
  respond(res, await runTurn(
    runtimeOf(ctx as unknown as ToolResolverServer),
    request,
    body(request),
    watcher(request)
  ));
});
