//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import type { OAuthLegacyVerifyInput, OAuthLegacyVerifyResult } from '../types.js';

/**
 * `oauth-legacy-verify`: the "ask session to verify its exact active
 * binding" step of API's hardened legacy validation path (storage.md).
 * Returns `{ active: false }` rather than throwing for every failure
 * reason (missing/inactive/expired/incarnation-mismatch/namespace-
 * collision) so an unbound key cannot be used to probe which case
 * applies.
 */
export default action(async function OAuthLegacyVerify({ req, res, ctx }) {
  try {
    const { store } = getOAuthContext(ctx);
    const input = req.data() as OAuthLegacyVerifyInput;
    if (
      (input.kind !== 'app' && input.kind !== 'session') ||
      typeof input.legacyId !== 'string' || !input.legacyId.length ||
      typeof input.incarnation !== 'string' || !input.incarnation.length ||
      typeof input.resource !== 'string' || !input.resource.length
    ) {
      throw oauthError('invalid_request', 'Malformed legacy verify request');
    }
    const active = await store.verifyLegacyBinding({
      kind: input.kind,
      legacyId: input.legacyId,
      incarnation: input.incarnation,
      resource: input.resource
    });
    const result: OAuthLegacyVerifyResult = { active };
    res.results(result);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
