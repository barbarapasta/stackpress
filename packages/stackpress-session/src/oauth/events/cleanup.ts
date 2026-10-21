//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { getOAuthContext } from './context.js';
import { toEventErrorResponse } from './errors.js';
import type { OAuthCleanupInput, OAuthCleanupResult } from '../types.js';

/**
 * `oauth-cleanup` (events.md): trusted bounded batch size and clock;
 * returns counts of removed expired records, never raw keys.
 */
export default action(async function OAuthCleanup({ req, res, ctx }) {
  try {
    const { store } = getOAuthContext(ctx);
    const input = req.data() as Partial<OAuthCleanupInput>;
    const batchSize = typeof input.batchSize === 'number' ? input.batchSize : 500;
    const now = input.now instanceof Date ? input.now : new Date();
    const counts = await store.cleanup(batchSize, now);
    const removed = counts.pending + counts.codes + counts.refreshTokens +
      counts.grants + counts.rateBuckets + counts.legacyBindings + counts.clients;
    const result: OAuthCleanupResult = { removed };
    res.results(result);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
