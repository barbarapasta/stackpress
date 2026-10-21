//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import type { OAuthGrantRevokeInput, OAuthGrantRevokeResult } from '../types.js';

/**
 * `oauth-grant-revoke` (events.md): trusted `{ profileId, grantId }`.
 * `{ revoked: true }` for an owned active or already-cancelled approval;
 * another person's grant (or a missing one) reports the same
 * `not_found` outcome as `invalid_grant` so its owner is never revealed.
 */
export default action(async function OAuthGrantRevoke({ req, res, ctx }) {
  try {
    const { store } = getOAuthContext(ctx);
    const input = req.data() as OAuthGrantRevokeInput;
    const outcome = await store.disconnectGrant(input.profileId, input.grantId);
    if (outcome === 'not_found') {
      res.setError(oauthError('invalid_grant', 'Grant not found').toResponse());
      return;
    }
    const result: OAuthGrantRevokeResult = { revoked: true };
    res.results(result);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
