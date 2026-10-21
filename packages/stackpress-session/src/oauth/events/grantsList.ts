//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { getOAuthContext } from './context.js';
import { toEventErrorResponse } from './errors.js';
import type { OAuthGrantsListInput, OAuthGrantsListItem } from '../types.js';

/**
 * `oauth-grants-list` (events.md): trusted `{ profileId }` from the
 * browser edge. Never returns access IDs, secrets, renewal tokens, code
 * values, hashes or session JWTs - only the safe connection-management
 * summary.
 */
export default action(async function OAuthGrantsList({ req, res, ctx }) {
  try {
    const { store, oauth } = getOAuthContext(ctx);
    const input = req.data() as OAuthGrantsListInput;
    const grants = await store.listGrantsForProfile(input.profileId);
    //safe display labels: reverse-map each stored fingerprint back to
    //the trusted operation ID the registry currently knows it by. A
    //fingerprint that no longer matches any registered operation (the
    //operation changed or was removed) is simply omitted, never shown
    //as a raw fingerprint.
    const fingerprints = new Set(
      Array.from(oauth.apiOperations.values()).map((entry) => entry.fingerprint)
    );
    const idsByFingerprint = new Map<string, string>();
    for (const [id, entry] of oauth.apiOperations) {
      idsByFingerprint.set(entry.fingerprint, id);
    }
    const results: OAuthGrantsListItem[] = grants.map((grant) => ({
      grantId: grant.id,
      client: { id: grant.clientId },
      resource: grant.resource,
      scopes: grant.scopes,
      operations: grant.operationFingerprints
        .filter((fingerprint) => fingerprints.has(fingerprint))
        .map((fingerprint) => idsByFingerprint.get(fingerprint)!),
      issued: grant.approved,
      expires: grant.accessExpires || grant.approved,
      deadline: grant.deadline,
      active: grant.active
    }));
    //the framework's `results()` signature is object-shaped; the
    //actual response body is JSON and an array serializes correctly.
    res.results(results as unknown as Record<string, unknown>);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
