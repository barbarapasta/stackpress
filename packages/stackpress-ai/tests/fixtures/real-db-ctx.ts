//Shared real-database dispatch ctx for 00009's cross-process notification
//test. Not a *.test.ts file - the package's unquoted `tests/**/*.test.ts`
//glob never picks this up. Unlike `../oauth-fixture.ts` (one in-process
//PGlite instance shared by every assertion in the same Node process),
//this module is deliberately engine-agnostic: the real test and the
//worker script (`cross-process-worker.ts`) each call `buildRealDbCtx()`
//with their *own* separately-opened `Engine` connection to the *same*
//external PostgreSQL/MySQL server, so two Node processes built from this
//file never share any in-memory state - only the real database row data
//they both read/write through their own connection proves coordination.
import type Engine from '@stackpress/inquire/Engine';
import type { StatusResponse } from '@stackpress/lib/types';

import normalizeOAuthConfig from '../../../stackpress-session/src/oauth/config.js';
import OAuthStore from '../../../stackpress-session/src/oauth/storage/OAuthStore.js';
import grantsList from '../../../stackpress-session/src/oauth/events/grantsList.js';
import tokenVerify from '../../../stackpress-session/src/oauth/events/tokenVerify.js';
import revoke from '../../../stackpress-session/src/oauth/events/revoke.js';

import type { ToolResolverServer } from '../../src/types.js';

export const RESOURCE = 'https://example.com/mcp';
export const PROFILE_ID = 'profile-1';
export const CLIENT_ID = 'client-1';

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

/**
 * Build one dispatch `ctx` backed directly by the given real database
 * `Engine` connection. Only wires the three events this task's
 * production code actually calls against a live store during the
 * cross-process scenario (`oauth-grants-list`/`oauth-token-verify`/
 * `oauth-revoke`) through their *real* session event handlers - every
 * other event this fixture does not need (approval/exchange/etc.) is
 * deliberately left unwired here; grant setup in the test itself goes
 * straight through `OAuthStore`, matching `store-adapters.test.ts`'s own
 * convention for assertions that do not need the full event layer.
 */
export function buildRealDbCtx(engine: Engine): {
  ctx: ToolResolverServer,
  store: OAuthStore
} {
  const store = new OAuthStore(engine);
  const config = normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: [{
      resource: RESOURCE, name: 'Example', description: 'desc',
      scopes: [ 'articles:read', 'articles:write' ]
    }],
    scopes: {
      'articles:read': { name: 'Read', description: 'Read' },
      'articles:write': { name: 'Write', description: 'Write' }
    },
    policy: { approval: 'approval-event', access: 'access-event', timeoutMs: 1000 },
    accessSeconds: 900,
    renewalSeconds: 604_800,
    codeSeconds: 60
  });

  const oauthPlugin = {
    config,
    finalized: true,
    apiOperations: new Map<string, { descriptor: unknown, fingerprint: string }>(),
    registerApiOperation() { /* unused */ },
    registerMcpResource() { /* unused */ },
    isNativeRoute() { return false; },
    finalize: async () => undefined,
    assertFinalized() { /* always finalized in this fixture */ }
  };

  const profiles: Record<string, { id: string, roles: string[], active: boolean }> = {
    [PROFILE_ID]: { id: PROFILE_ID, roles: [], active: true }
  };

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
      has() { return false; },
      get<T = unknown>() { return undefined as T; },
      path<T>(_key: string, fallback?: T) { return fallback as T; }
    },
    on() { /* not used by this fixture */ },
    plugin<T = unknown>(name: string): T {
      if (name === 'oauth') return oauthPlugin as unknown as T;
      return undefined as unknown as T;
    },
    register() { /* not used by this fixture */ },
    //mirror ctx.request() enough for the shared tool path: the event then
    // receives a request whose data is the tool payload
    request(init: Record<string, unknown> = {}) {
      return {
        data: init.data,
        method: init.method,
        session: init.session,
        url: init.url
      };
    },
    async resolve<T = unknown>(
      event: string, payload?: unknown
    ): Promise<{ code?: number, results?: T } | null> {
      //a tool call arrives as a request built by request() above; every
      // other event is given its data directly
      const data = payload && typeof payload === 'object' && 'data' in payload
        && 'method' in payload
        ? (payload as { data: unknown }).data
        : payload;
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
            allowed: true, scopes: input.scopes, operations: input.operations
          } as unknown as T
        };
      }
      if (event === 'oauth-grants-list') {
        return (await runHandler(grantsList, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-token-verify') {
        return (await runHandler(tokenVerify, data)) as { code?: number, results?: T };
      }
      if (event === 'oauth-revoke') {
        return (await runHandler(revoke, data)) as { code?: number, results?: T };
      }
      return { code: 404, results: undefined };
    }
  } as unknown as ToolResolverServer;

  return { ctx, store };
}

export type RealDbEngineKind = 'postgres' | 'mysql';

/**
 * Open one fresh, independent connection to the real disposable
 * PostgreSQL/MySQL container for this task's cross-process test. Every
 * caller (the main test process and each spawned worker process) must
 * call this itself rather than passing an `Engine` across a process
 * boundary - that is the entire point of the scenario.
 */
export async function connectRealDbEngine(
  kind: RealDbEngineKind
): Promise<{ engine: Engine, close: () => Promise<void> }> {
  const EngineImpl = (await import('@stackpress/inquire/Engine')).default;
  if (kind === 'postgres') {
    const { Client } = await import('pg');
    const Connection = (await import('@stackpress/inquire-pg/Connection')).default;
    const client = new Client({
      host: process.env.OAUTH_00009_PG_HOST || '127.0.0.1',
      port: Number(process.env.OAUTH_00009_PG_PORT || 55577),
      database: process.env.OAUTH_00009_PG_DATABASE || 'oauth_proof',
      user: process.env.OAUTH_00009_PG_USER || 'postgres'
    });
    await client.connect();
    const connection = new Connection(client);
    return { engine: new EngineImpl(connection), close: async () => { await client.end(); } };
  }
  const mysql = (await import('mysql2/promise')).default;
  const Connection = (await import('@stackpress/inquire-mysql2/Connection')).default;
  const client = await mysql.createConnection({
    host: process.env.OAUTH_00009_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.OAUTH_00009_MYSQL_PORT || 55578),
    database: process.env.OAUTH_00009_MYSQL_DATABASE || 'oauth_proof',
    user: process.env.OAUTH_00009_MYSQL_USER || 'root',
    //required so DATETIME columns round-trip as the correct UTC instant;
    //see OAuthStore.ts's `withMysqlDateSafety()` doc comment.
    timezone: 'Z'
  });
  const connection = new Connection(client);
  return { engine: new EngineImpl(connection), close: async () => { await client.end(); } };
}
