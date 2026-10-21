//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { getOAuthContext } from './context.js';
import { toEventErrorResponse } from './errors.js';
import type { OAuthRevokeInput } from '../types.js';

/**
 * `oauth-revoke` (events.md): requires a full access key or refresh
 * token plus its bound public client ID, never a read ID or grant ID. A
 * wrong secret never revokes; an unknown token is also "successful" so
 * it never reveals whether an account/client exists - both `OAuthStore`
 * methods this calls already encode that by silently doing nothing
 * rather than throwing.
 */
export default action(async function OAuthRevoke({ req, res, ctx }) {
  try {
    const { store } = getOAuthContext(ctx);
    const input = req.data() as OAuthRevokeInput;
    if (input.token_type_hint === 'refresh_token') {
      await store.revokeByRefreshToken(input.token, input.client_id);
    } else if (input.token.includes(':')) {
      await store.revokeByFullKey(input.token, input.client_id);
    } else {
      await store.revokeByRefreshToken(input.token, input.client_id);
    }
    res.results({});
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
