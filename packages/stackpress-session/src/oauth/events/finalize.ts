//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-session
import type { OAuthPlugin } from '../types.js';

/**
 * Serving bootstraps call this event explicitly after config/listen/
 * route have all run. It is deliberately not invoked by import order;
 * the app must fail on a non-200 result before it starts handling
 * requests.
 */
export default async function finalize({ ctx }: { ctx: Server }) {
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (!oauth) return;
  await oauth.finalize();
}
