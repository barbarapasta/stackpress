//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-api
import type { Application, Session, SessionExtended } from './types.js';

export type LegacyMcpKind = 'app' | 'session';

/**
 * storage.md "Upgrade Existing MCP Keys Explicitly": the trusted result
 * of a hardened legacy check, for task 00009's MCP identity layer to
 * consume. Never fabricates an API Session/Application object - just the
 * safe fields a caller needs to build its own request-scoped identity.
 */
export type LegacyMcpIdentity = {
  kind: LegacyMcpKind,
  legacyId: string,
  applicationId: string,
  profileId?: string,
  scopes: string[],
  resource: string
};

/**
 * storage.md: "Add a hardened legacy validation path in API for
 * OAuth-enabled MCP: check the real record's secret, active state,
 * expiry, current person/application and scopes, then ask session to
 * verify its exact active binding." API owns the Application/Session
 * record checks (it already owns those models); the last step delegates
 * to session's `oauth-legacy-verify` event so the hashing/storage of the
 * binding itself stays private to session ("session never imports
 * API").
 *
 * Always requires the full `id:secret` legacy key - unlike the new
 * `oauth_` keys, legacy API/MCP keys have no read-ID-only concept this
 * validator can safely extend to MCP. Returns `null` (never throws) for
 * every failure reason, matching the rest of this upgrade path's
 * "unknown token does not reveal account/client existence" posture.
 */
export async function verifyLegacyMcpKey(
  ctx: Server,
  params: { kind: LegacyMcpKind, token: string, resource: string }
): Promise<LegacyMcpIdentity | null> {
  const { kind, token, resource } = params;
  if (typeof token !== 'string' || !token.length) {
    return null;
  }
  const index = token.indexOf(':');
  if (index <= 0 || index !== token.lastIndexOf(':')) {
    return null;
  }
  const id = token.substring(0, index).trim();
  const secret = token.substring(index + 1).trim();
  if (!id || !secret) {
    return null;
  }
  const now = Date.now();

  if (kind === 'app') {
    const response = await ctx.resolve('application-detail', { id });
    const application = response?.results as Application | undefined;
    if (!application || application.secret !== secret) {
      return null;
    }
    if (!application.active) {
      return null;
    }
    if (application.expires && application.expires.getTime() <= now) {
      return null;
    }
    const verified = await verifyBinding(ctx, {
      kind: 'app', legacyId: id, incarnation: toIncarnation(application.created), resource
    });
    if (!verified) {
      return null;
    }
    return {
      kind: 'app', legacyId: id, applicationId: application.id,
      scopes: application.scopes, resource
    };
  }

  const response = await ctx.resolve('session-detail', { id });
  const session = response?.results as SessionExtended | Session | undefined;
  if (!session || session.secret !== secret) {
    return null;
  }
  if (!session.active) {
    return null;
  }
  if (session.expires && session.expires.getTime() <= now) {
    return null;
  }
  const verified = await verifyBinding(ctx, {
    kind: 'session', legacyId: id, incarnation: toIncarnation(session.created), resource
  });
  if (!verified) {
    return null;
  }
  return {
    kind: 'session', legacyId: id, applicationId: session.applicationId,
    profileId: session.profileId, scopes: session.scopes, resource
  };
}

function toIncarnation(created: unknown): string {
  return created instanceof Date ? created.toISOString() : String(created);
}

async function verifyBinding(
  ctx: Server,
  input: { kind: LegacyMcpKind, legacyId: string, incarnation: string, resource: string }
): Promise<boolean> {
  const response = await ctx.resolve<{ active: boolean }>('oauth-legacy-verify', input);
  return response?.code === 200 && response?.results?.active === true;
}
