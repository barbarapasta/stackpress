//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import type { OAuthLegacyBindInput, OAuthLegacyBindResult } from '../types.js';

/**
 * `oauth-legacy-bind` (storage.md "Upgrade Existing MCP Keys Explicitly"):
 * the operator-only half of API's migration adapter. In-process trusted
 * callers only - this is not one of events.md's nine fixed protocol
 * events and carries no HTTP route of its own ("no public migration
 * route"). Binds (or idempotently re-binds, for a repeatable migration
 * run) one legacy record's raw ID to a resource; the raw ID is hashed
 * here, never by the caller, so the hashing algorithm has one owner.
 */
export default action(async function OAuthLegacyBind({ req, res, ctx }) {
  try {
    const { store } = getOAuthContext(ctx);
    const input = req.data() as OAuthLegacyBindInput;
    if (
      (input.kind !== 'app' && input.kind !== 'session') ||
      typeof input.legacyId !== 'string' || !input.legacyId.length ||
      typeof input.incarnation !== 'string' || !input.incarnation.length ||
      typeof input.resource !== 'string' || !input.resource.length
    ) {
      throw oauthError('invalid_request', 'Malformed legacy binding request');
    }
    const result: OAuthLegacyBindResult = await store.createLegacyBinding({
      kind: input.kind,
      legacyId: input.legacyId,
      incarnation: input.incarnation,
      resource: input.resource,
      expires: input.expires ?? null
    });
    res.results(result);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
