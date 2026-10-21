//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { isOAuthNamespace, hashWithDomain, hashesEqual, splitFullKey } from '../storage/ids.js';
import { isClientAllowed } from '../clients/policy.js';
import { loadSafeProfile, invokeAccessPolicy } from '../policy.js';
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import type { OAuthTokenVerifyInput, OAuthIdentity } from '../types.js';

/**
 * `oauth-token-verify` (events.md): checks credential syntax/strength,
 * current active profile, client admission, expiry, grant cancellation,
 * exact resource, current app access policy and API membership - never
 * trusting a previously-verified positive result (storage.md: "not a
 * positive cache that survives disconnect").
 */
export default action(async function OAuthTokenVerify({ req, res, ctx }) {
  try {
    const { store, config, oauth } = getOAuthContext(ctx);
    const input = req.data() as OAuthTokenVerifyInput;
    const now = new Date();

    if (typeof input.token !== 'string' || input.token.length === 0) {
      throw oauthError('invalid_token', 'Missing token');
    }

    //storage.md: "the oauth_ namespace selects the OAuth verifier...a
    //supplied bad secret never becomes an ID-only read" - a malformed
    //full key (anything other than exactly one ':' separating two
    //non-empty parts) is rejected outright, never silently treated as
    //an ID-only value.
    let accessId: string;
    let secret: string | null = null;
    if (input.token.includes(':')) {
      const split = splitFullKey(input.token);
      if (!split) {
        throw oauthError('invalid_token', 'Malformed access key');
      }
      accessId = split.id;
      secret = split.secret;
    } else {
      accessId = input.token;
    }
    if (!isOAuthNamespace(accessId)) {
      throw oauthError('invalid_token', 'Unknown token namespace');
    }

    const grant = await store.getGrantByAccessId(accessId);
    if (!grant || !grant.readIdHash) {
      throw oauthError('invalid_token', 'Unknown token');
    }
    if (!hashesEqual(grant.readIdHash, hashWithDomain('access-read', accessId))) {
      throw oauthError('invalid_token', 'Unknown token');
    }

    if (secret !== null) {
      if (!grant.fullKeyHash || !hashesEqual(grant.fullKeyHash, hashWithDomain('access-full', secret))) {
        //a wrong secret never "downgrades" to an ID-only read
        throw oauthError('invalid_token', 'Invalid credential');
      }
    } else if (input.requiredCredential === 'full') {
      throw oauthError('invalid_token', 'A full access key is required for this operation');
    }

    if (!grant.active) {
      throw oauthError('invalid_token', 'Grant has been cancelled');
    }
    if (!grant.accessExpires || grant.accessExpires.getTime() <= now.getTime()) {
      throw oauthError('invalid_token', 'Access key has expired');
    }
    if (grant.resource !== input.resource) {
      throw oauthError('invalid_token', 'Token is not bound to this resource');
    }
    if (!isClientAllowed(grant.clientId, config.clients)) {
      throw oauthError('invalid_token', 'Client is no longer admitted');
    }

    const profile = await loadSafeProfile(ctx, grant.profileId);
    if (!profile) {
      throw oauthError('invalid_token', 'Account is not active');
    }

    if (input.operation) {
      const entry = oauth.apiOperations.get(input.operation);
      if (!entry || !grant.operationFingerprints.includes(entry.fingerprint)) {
        throw oauthError(
          'access_denied',
          'Approved API membership is absent or has changed'
        );
      }
    }

    const access = await invokeAccessPolicy(ctx, config, {
      phase: 'verify',
      profile,
      client: { id: grant.clientId },
      grant: {
        grantId: grant.id,
        clientId: grant.clientId,
        resource: grant.resource,
        scopes: grant.scopes,
        operations: [],
        deadline: grant.deadline
      }
    });
    if (!access) {
      throw oauthError('access_denied', 'Access policy denied this request');
    }

    const identity: OAuthIdentity = {
      profileId: grant.profileId,
      clientId: grant.clientId,
      grantId: grant.id,
      resource: grant.resource,
      //verification uses the intersection now; it is not persisted
      //(storage.md "Atomic Operations" #3's narrowing rule only applies
      //to exchange/refresh).
      scopes: access.scopes,
      expires: grant.accessExpires,
      deadline: grant.deadline,
      credential: secret !== null ? 'full' : 'read'
    };
    res.results(identity);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
