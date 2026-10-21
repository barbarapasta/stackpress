//modules
import type Server from '@stackpress/ingest/Server';
import type Response from '@stackpress/ingest/Response';
import Exception from '@stackpress/lib/Exception';
//stackpress-session
import type { OAuthPlugin } from '../types.js';

/**
 * Serving bootstraps call this event explicitly after config/listen/
 * route have all run. It is deliberately not invoked by import order;
 * the app must fail on a non-200 result before it starts handling
 * requests. `ctx.plugin('oauth').finalize()` is also exposed directly
 * for callers that already hold the typed service; this handler is the
 * `resolve('oauth-finalize')` entrypoint configuration.md documents, so
 * it must set a real response status for both outcomes - a caller
 * checking `(await server.resolve('oauth-finalize')).code` otherwise
 * never observes success or the 503 finalize() already describes.
 */
export default async function finalize(
  { ctx, res }: { ctx: Server, res: Response }
) {
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (!oauth) {
    res.results({ finalized: false });
    return;
  }
  try {
    await oauth.finalize();
    res.results({ finalized: true });
  } catch (e) {
    res.setError(Exception.upgrade(e as Error).toResponse());
  }
}
