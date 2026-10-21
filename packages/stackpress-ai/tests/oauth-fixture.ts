//Shared real-store fixture for 00009's MCP OAuth transport tests. Not a
//*.test.ts file - the package's unquoted `tests/**/*.test.ts` glob never
//picks this up. Wires stackpress-ai's production oauth.ts/scripts against
//a REAL PGlite-backed session OAuthStore through the REAL fixed event
//handlers (authorize/exchange/refresh/token-verify/revoke/grants-list,
//plus the task-00008-owned legacy bind/verify events), the same pattern
//`stackpress-api/tests/oauth-legacy-real-store.test.ts` already uses for
//cross-package real-store integration - a plain relative filesystem
//import into `stackpress-session`'s private `src/`, not a
//`stackpress-session/...` package-specifier import, so it never touches
//that package's public `exports` map.
import type { StatusResponse } from '@stackpress/lib/types';
import type Engine from '@stackpress/inquire/Engine';

import { createAllOAuthTables } from '../../stackpress-session/src/oauth/storage/tables.js';
import OAuthStore from '../../stackpress-session/src/oauth/storage/OAuthStore.js';
import {
  hashWithDomain,
  newPendingBinding
} from '../../stackpress-session/src/oauth/storage/ids.js';
import { computeS256Challenge } from '../../stackpress-session/src/oauth/pkce.js';
import normalizeOAuthConfig from '../../stackpress-session/src/oauth/config.js';

import codeExchange from '../../stackpress-session/src/oauth/events/codeExchange.js';
import refresh from '../../stackpress-session/src/oauth/events/refresh.js';
import tokenVerify from '../../stackpress-session/src/oauth/events/tokenVerify.js';
import revoke from '../../stackpress-session/src/oauth/events/revoke.js';
import grantsList from '../../stackpress-session/src/oauth/events/grantsList.js';
import grantRevoke from '../../stackpress-session/src/oauth/events/grantRevoke.js';
import legacyBind from '../../stackpress-session/src/oauth/events/legacyBind.js';
import legacyVerify from '../../stackpress-session/src/oauth/events/legacyVerify.js';

import type { ToolConfig, ToolResolverServer } from '../src/types.js';

export const RESOURCE = 'https://example.com/mcp';
export const SSE_RESOURCE = 'https://example.com/sse';
export const CODE_VERIFIER = 'a-real-verifier-with-enough-entropy-0123456789';
export const CODE_CHALLENGE = computeS256Challenge(CODE_VERIFIER);
export const PROFILE_ID = 'profile-1';
export const CLIENT_ID = 'client-1';

type LegacyAppRecord = {
  id: string, secret: string, scopes: string[], active: boolean,
  expires: Date, created: Date
};

type LegacySessionRecord = {
  id: string, secret: string, scopes: string[], active: boolean,
  expires: Date, created: Date, applicationId: string, profileId: string
};

function pathGet(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function makeReq(input: unknown) {
  return { data: () => input } as any;
}

function makeRes() {
  const res: any = {
    code: undefined,
    body: undefined,
    results(body: unknown, code = 200) { res.body = body; res.code = code; return res; },
    setError(response: Partial<StatusResponse>) {
      res.body = response; res.code = response.code; return res;
    }
  };
  return res;
}

export type OAuthFixture = {
  ctx: ToolResolverServer,
  store: OAuthStore,
  close: () => Promise<void>,
  applications: Record<string, LegacyAppRecord>,
  sessions: Record<string, LegacySessionRecord>,
  profiles: Record<string, { id: string, roles: string[], active: boolean }>,
  /** Create+approve a pending request directly, bypassing the browser flow
   * (mirrors stackpress-session/tests/oauth/events.test.ts's own helper). */
  createApprovedGrant: (opts?: {
    resource?: string, scopes?: string[], clientId?: string
  }) => Promise<{ grantId: string, code: string, clientId: string }>,
  /** Full approve -> exchange round trip, returning a usable access key. */
  issueGrant: (opts?: {
    resource?: string, scopes?: string[], clientId?: string
  }) => Promise<{ accessToken: string, refreshToken: string, grantId: string }>,
  revokeToken: (clientId: string, token: string) => Promise<void>,
  /** storage.md's legacy upgrade path: bind a real app-identity legacy
   * key, returning its full `id:secret` credential. */
  bindLegacyApp: (opts?: {
    id?: string, secret?: string, scopes?: string[], resource?: string
  }) => Promise<{ token: string, id: string }>,
  /** Same, for a session (user) identity legacy key. */
  bindLegacySession: (opts?: {
    id?: string, secret?: string, scopes?: string[], applicationId?: string,
    profileId?: string, resource?: string
  }) => Promise<{ token: string, id: string }>
};

/**
 * Build one real PGlite-backed OAuth fixture: a real `OAuthStore`, a real
 * normalized config declaring both the HTTP and SSE resources, and a
 * `ToolResolverServer` double whose `resolve()` dispatches every OAuth
 * event this task's production code calls to the real session event
 * handlers - not a hand-rolled fake of token verification itself.
 */
export async function createOAuthFixture(
  tools: ToolConfig[] = []
): Promise<OAuthFixture> {
  const { PGlite } = await import('@electric-sql/pglite');
  const Connection = (await import('@stackpress/inquire-pglite/Connection')).default;
  const EngineImpl = (await import('@stackpress/inquire/Engine')).default;
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine: Engine = new EngineImpl(connection);
  const store = new OAuthStore(engine);

  for (const create of createAllOAuthTables()) {
    create.engine = engine;
    await create;
  }

  const config = normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: [
      {
        resource: RESOURCE, name: 'Example', description: 'desc',
        scopes: [ 'articles:read', 'articles:write' ]
      },
      {
        resource: SSE_RESOURCE, name: 'Example SSE', description: 'desc',
        scopes: [ 'articles:read', 'articles:write' ]
      }
    ],
    scopes: {
      'articles:read': { name: 'Read', description: 'Read' },
      'articles:write': { name: 'Write', description: 'Write' }
    },
    policy: { approval: 'approval-event', access: 'access-event', timeoutMs: 1000 },
    accessSeconds: 900,
    renewalSeconds: 604_800,
    codeSeconds: 60
  });

  const apiOperations = new Map<string, { descriptor: unknown, fingerprint: string }>();
  const oauthPlugin = {
    config,
    finalized: true,
    apiOperations,
    registerApiOperation() { /* unused by these tests */ },
    registerMcpResource() { /* unused by these tests */ },
    isNativeRoute() { return false; },
    finalize: async () => undefined,
    assertFinalized() { /* always finalized in this fixture */ }
  };

  const applications: Record<string, LegacyAppRecord> = {};
  const sessions: Record<string, LegacySessionRecord> = {};
  const profiles: Record<string, { id: string, roles: string[], active: boolean }> = {
    [PROFILE_ID]: { id: PROFILE_ID, roles: [], active: true }
  };

  const toolResolvers: Record<string, (data: unknown) => unknown> = {
    ping: () => ({ ok: true }),
    'articles-read': (data: unknown) => ({ ok: true, echo: data }),
    'articles-write': (data: unknown) => ({ ok: true, echo: data }),
    'app-ping': (data: unknown) => ({ ok: true, echo: data })
  };

  //the real session event handlers (codeExchange/refresh/tokenVerify/...)
  //call ctx.plugin('database') to build their own OAuthStore and
  //ctx.resolve('profile-detail'/policy events) for fresh account/policy
  //checks - this inner ctx is what they receive, distinct from the outer
  //`ctx` this fixture hands to stackpress-ai's production code.
  const innerCtx = {
    plugin(name: string) {
      if (name === 'oauth') return oauthPlugin;
      if (name === 'database') return engine;
      return undefined;
    },
    resolve: async (event: string, data?: unknown) => ctx.resolve(event, data)
  };

  async function runHandler(handler: Function, data: unknown) {
    const req = makeReq(data);
    const res = makeRes();
    await handler({ req, res, ctx: innerCtx });
    return { code: res.code, results: res.body };
  }

  const ctx: ToolResolverServer = {
    config: {
      has(key: string) { return pathGet({ mcp: { tools } }, key) !== undefined; },
      get<T = unknown>(key: string) {
        return pathGet({ mcp: { tools } }, key) as T;
      },
      path<T>(key: string, fallback?: T) {
        const value = pathGet({ mcp: { tools } }, key);
        return (value === undefined ? fallback : value) as T;
      }
    },
    on() { /* not used by these tests */ },
    plugin<T = unknown>(name: string): T {
      if (name === 'oauth') return oauthPlugin as unknown as T;
      return undefined as unknown as T;
    },
    register() { /* not used by these tests */ },
    async resolve<T = unknown>(
      event: string, data?: unknown
    ): Promise<{ code?: number, results?: T } | null> {
      if (event === 'profile-detail') {
        const id = (data as { id: string }).id;
        const profile = profiles[id];
        return profile
          ? { code: 200, results: profile as unknown as T }
          : { code: 404, results: undefined };
      }
      if (event === 'access-event' || event === 'approval-event') {
        const input = data as { scopes?: string[], operations?: string[] };
        return {
          code: 200,
          results: {
            allowed: true,
            scopes: input.scopes,
            operations: input.operations
          } as unknown as T
        };
      }
      if (event === 'application-detail') {
        const record = applications[(data as { id: string }).id];
        return record
          ? { code: 200, results: record as unknown as T }
          : { code: 404, results: undefined };
      }
      if (event === 'session-detail') {
        const record = sessions[(data as { id: string }).id];
        return record
          ? { code: 200, results: record as unknown as T }
          : { code: 404, results: undefined };
      }
      if (event === 'oauth-code-exchange') {
        return (await runHandler(codeExchange, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-refresh') {
        return (await runHandler(refresh, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-token-verify') {
        return (await runHandler(tokenVerify, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-revoke') {
        return (await runHandler(revoke, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-grants-list') {
        return (await runHandler(grantsList, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-grant-revoke') {
        return (await runHandler(grantRevoke, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-legacy-bind') {
        return (await runHandler(legacyBind, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-legacy-verify') {
        return (await runHandler(legacyVerify, data)) as { code?: number, results?: T };
      }
      const resolver = toolResolvers[event];
      if (resolver) {
        return { code: 200, results: resolver(data) as T };
      }
      return { code: 404, results: undefined };
    }
  } as unknown as ToolResolverServer;

  async function createApprovedGrant(opts: {
    resource?: string, scopes?: string[], clientId?: string
  } = {}) {
    const clientId = opts.clientId || CLIENT_ID;
    const scopes = opts.scopes || [ 'articles:read' ];
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: CODE_CHALLENGE,
      resource: opts.resource || RESOURCE,
      scopes,
      operations: [],
      expires: new Date(Date.now() + 600_000)
    });
    const { grant, code } = await store.approvePending({
      pendingId: pending.id,
      profileId: PROFILE_ID,
      approvedScopes: scopes,
      approvedOperations: [],
      operationFingerprints: [],
      accessSeconds: config.accessSeconds,
      renewalSeconds: config.renewalSeconds,
      codeSeconds: config.codeSeconds
    });
    return { grantId: grant.id, code, clientId };
  }

  async function issueGrant(opts: {
    resource?: string, scopes?: string[], clientId?: string
  } = {}) {
    const { grantId, code, clientId } = await createApprovedGrant(opts);
    const exchanged = await runHandler(codeExchange, {
      client_id: clientId, code, redirect_uri: 'https://client.example/callback',
      code_verifier: CODE_VERIFIER, resource: opts.resource || RESOURCE
    });
    if (exchanged.code !== 200) {
      throw new Error(`Fixture token exchange failed: ${JSON.stringify(exchanged.results)}`);
    }
    const body = exchanged.results as { access_token: string, refresh_token: string };
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      grantId
    };
  }

  async function revokeToken(clientId: string, token: string) {
    const revoked = await runHandler(revoke, { client_id: clientId, token });
    if (revoked.code !== 200) {
      throw new Error(`Fixture revoke failed: ${JSON.stringify(revoked.results)}`);
    }
  }

  async function bindLegacyApp(opts: {
    id?: string, secret?: string, scopes?: string[], resource?: string
  } = {}) {
    const id = opts.id || `legacy-app-${Math.random().toString(36).slice(2)}`;
    const created = new Date('2026-01-01T00:00:00.000Z');
    applications[id] = {
      id, secret: opts.secret || 'legacy-secret', scopes: opts.scopes || [ 'articles:read' ],
      active: true, expires: new Date(Date.now() + 1_000_000), created
    };
    const bound = await runHandler(legacyBind, {
      kind: 'app', legacyId: id, incarnation: created.toISOString(),
      resource: opts.resource || RESOURCE
    });
    if (bound.code !== 200) {
      throw new Error(`Fixture legacy app bind failed: ${JSON.stringify(bound.results)}`);
    }
    return { token: `${id}:${applications[id].secret}`, id };
  }

  async function bindLegacySession(opts: {
    id?: string, secret?: string, scopes?: string[], applicationId?: string,
    profileId?: string, resource?: string
  } = {}) {
    const id = opts.id || `legacy-session-${Math.random().toString(36).slice(2)}`;
    const created = new Date('2026-01-01T00:00:00.000Z');
    sessions[id] = {
      id, secret: opts.secret || 'legacy-secret', scopes: opts.scopes || [ 'articles:read' ],
      active: true, expires: new Date(Date.now() + 1_000_000), created,
      applicationId: opts.applicationId || 'legacy-app-for-session',
      profileId: opts.profileId || PROFILE_ID
    };
    const bound = await runHandler(legacyBind, {
      kind: 'session', legacyId: id, incarnation: created.toISOString(),
      resource: opts.resource || RESOURCE
    });
    if (bound.code !== 200) {
      throw new Error(`Fixture legacy session bind failed: ${JSON.stringify(bound.results)}`);
    }
    return { token: `${id}:${sessions[id].secret}`, id };
  }

  return {
    ctx, store,
    close: async () => { await resource.close(); },
    applications, sessions, profiles,
    createApprovedGrant, issueGrant, revokeToken,
    bindLegacyApp, bindLegacySession
  };
}
