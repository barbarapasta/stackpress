//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { loadSafeProfile, invokeAccessPolicy } from '../policy.js';
import type { OAuthAccessDeps } from '../storage/OAuthStore.js';
import type { NormalizedOAuthSessionConfig, OAuthAccessPhase } from '../types.js';

/**
 * Builds the `OAuthAccessDeps` `OAuthStore.exchangeCode`/`refreshGrant`
 * thread through the grant lock, so storage.md's "current account...and
 * current app access policy" is checked against the exact fresh grant
 * row the transaction already holds, not a stale pre-check made before
 * the lock was acquired.
 */
export function buildAccessDeps(
  ctx: Server,
  config: NormalizedOAuthSessionConfig,
  phase: OAuthAccessPhase
): OAuthAccessDeps {
  return {
    checkAccount: async (profileId) => Boolean(await loadSafeProfile(ctx, profileId)),
    checkAccess: async (grant) => {
      const profile = await loadSafeProfile(ctx, grant.profileId);
      if (!profile) {
        return null;
      }
      const decision = await invokeAccessPolicy(ctx, config, {
        phase,
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
      if (!decision) {
        return null;
      }
      return { allowed: true, scopes: decision.scopes };
    }
  };
}
