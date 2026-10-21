//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session
import type { AuthExtended } from '../../auth/types.js';
//stackpress-session/oauth
import { loadSafeProfile, invokeApprovalPolicy } from '../policy.js';
import { verifyFactorReceipt } from '../factor.js';
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import type { OAuthAuthorizeInput, OAuthAuthorizeResult } from '../types.js';

function isSubset(subset: string[], superset: string[]): boolean {
  const allowed = new Set(superset);
  return subset.every((value) => allowed.has(value));
}

function buildRedirect(
  redirectUri: string,
  issuer: string,
  state: string | null,
  params: Record<string, string>
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  if (state !== null) {
    url.searchParams.set('state', state);
  }
  url.searchParams.set('iss', issuer);
  return url.toString();
}

/**
 * `oauth-authorize` (events.md): pending reference, trusted browser
 * profile, selected scope/operation subsets, verified server-side
 * factor receipt, approve/deny -> `{ redirect }` built only from the
 * saved checked request. Hidden inputs can select a subset of the
 * saved pending request; they never redefine its authority.
 */
export default action(async function OAuthAuthorize({ req, res, ctx }) {
  try {
    const { store, config, oauth } = getOAuthContext(ctx);
    const input = req.data() as OAuthAuthorizeInput;
    const now = new Date();

    const pending = await store.getPendingById(input.pending);
    if (!pending) {
      throw oauthError('invalid_request', 'Pending authorization request not found');
    }
    if (pending.status !== 'pending') {
      throw oauthError('conflict', 'This authorization request was already resolved');
    }
    if (pending.expires.getTime() <= now.getTime()) {
      throw oauthError('invalid_request', 'Pending authorization request expired');
    }

    if (!input.approve) {
      await store.denyPending(pending.id, now);
      const redirect = buildRedirect(
        pending.redirectUri,
        config.issuer,
        pending.state,
        { error: 'access_denied' }
      );
      const result: OAuthAuthorizeResult = { redirect };
      res.results(result);
      return;
    }

    if (
      !isSubset(input.scopes, pending.scopes) ||
      !isSubset(input.operations, pending.operations)
    ) {
      throw oauthError(
        'invalid_request',
        'Selected scopes/operations are not a subset of the saved request'
      );
    }

    const profile = await loadSafeProfile(ctx, input.profileId);
    if (!profile) {
      throw oauthError('access_denied', 'Account is not active');
    }

    const client = await store.getClientByClientId(pending.clientId);
    const clientName = client && typeof client.metadata.client_name === 'string' ?
      client.metadata.client_name : undefined;

    //factor availability only reports whether a verified factor exists,
    //never its secret (events.md); a failed lookup is treated as "no
    //factor available" rather than failing the whole approval.
    const twoFA = await ctx.resolve<AuthExtended[]>('auth-search', {
      eq: { type: '2fa', profileId: profile.id }
    });
    const factorAvailable = twoFA.code === 200 && Array.isArray(twoFA.results) &&
      twoFA.results.length > 0;

    const decision = await invokeApprovalPolicy(ctx, config, {
      phase: 'approval',
      profile,
      client: { id: pending.clientId, name: clientName },
      resource: pending.resource,
      scopes: input.scopes,
      operations: input.operations,
      factor: { available: factorAvailable }
    });
    if (!decision) {
      throw oauthError('access_denied', 'Approval policy denied this request');
    }

    if (decision.requireFactor) {
      const seed = ctx.config.path<string>('session.seed', '');
      const valid = typeof input.factorReceipt === 'string' && verifyFactorReceipt(
        seed,
        input.factorReceipt,
        {
          profileId: profile.id,
          pendingId: pending.id,
          scopes: decision.scopes,
          operations: decision.operations
        },
        pending.expires,
        now
      );
      if (!valid) {
        throw oauthError('access_denied', 'A fresh verified factor check is required');
      }
    }

    const operationFingerprints: string[] = [];
    for (const operationId of decision.operations) {
      const entry = oauth.apiOperations.get(operationId);
      if (!entry) {
        throw oauthError('access_denied', `Unknown API operation: ${operationId}`);
      }
      operationFingerprints.push(entry.fingerprint);
    }

    const { code } = await store.approvePending({
      pendingId: pending.id,
      profileId: profile.id,
      approvedScopes: decision.scopes,
      approvedOperations: decision.operations,
      operationFingerprints,
      accessSeconds: decision.accessSeconds,
      renewalSeconds: decision.renewalSeconds,
      codeSeconds: config.codeSeconds,
      now
    });

    const redirect = buildRedirect(
      pending.redirectUri,
      config.issuer,
      pending.state,
      { code }
    );
    const result: OAuthAuthorizeResult = { redirect };
    res.results(result);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
