import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import type Engine from '@stackpress/inquire/Engine';
import Update from '@stackpress/inquire/Update';
import Select from '@stackpress/inquire/Select';
import { verifyLegacyMcpKey } from '../src/legacy.js';

//Cross-package, test-only integration: exercises the real session-owned
//`OAuthLegacyBinding` store through its real `oauth-legacy-bind`/
//`oauth-legacy-verify` fixed event handlers (not a mocked resolver), so
//`verifyLegacyMcpKey()` is proven against a real store for the three
//scenarios the task's Verification Process names ("source deletion/
//recreation, original key revocation and binding removal"). These are
//plain relative filesystem imports into `stackpress-session`'s private
//`src/` - not a `stackpress-session/...` package-specifier import, so
//they do not go through (and do not change) that package's public
//`exports` map; this stays test-only, local to this one verification
//pass, and does not make any session internal part of a public contract.
import { createAllOAuthTables } from '../../stackpress-session/src/oauth/storage/tables.js';
import legacyBind from '../../stackpress-session/src/oauth/events/legacyBind.js';
import legacyVerify from '../../stackpress-session/src/oauth/events/legacyVerify.js';

const RESOURCE = 'https://example.com/mcp';

type LegacyRecord = {
  id: string,
  secret: string,
  scopes: string[],
  active: boolean,
  expires: Date,
  created: Date,
  applicationId?: string,
  profileId?: string
};

function makeOAuthPlugin() {
  return {
    assertFinalized() {},
    config: {} as unknown,
    finalized: true,
    apiOperations: new Map(),
    registerApiOperation() {},
    registerMcpResource() {},
    finalize: async () => {}
  };
}

//A thin ctx.resolve shim wired to the *real* legacyBind/legacyVerify
//action handlers (backed by a real PGlite-backed OAuthStore) plus a
//simple mutable in-memory stand-in for the consuming app's generated
//Application/Session records - stackpress-api owns no store of its own
//for those models in any real deployment either; a real app's generated
//`application-detail`/`session-detail` events are the only thing this
//validator ever calls for them.
function makeRealCtx(engine: Engine, records: {
  app: Record<string, LegacyRecord>,
  session: Record<string, LegacyRecord>
}) {
  const oauth = makeOAuthPlugin();
  const innerCtx = {
    plugin(name: string) {
      if (name === 'oauth') return oauth;
      if (name === 'database') return engine;
      return undefined;
    }
  };
  async function runHandler(handler: Function, data: unknown) {
    let code: number | undefined;
    let body: unknown;
    const req = { data: () => data };
    const res = {
      results(b: unknown, c = 200) { body = b; code = c; return res; },
      setError(r: { code?: number }) { body = r; code = r.code; return res; }
    };
    await handler({ req: req as any, res: res as any, ctx: innerCtx as any });
    return { code, results: body };
  }
  return {
    resolve: async (event: string, data?: unknown) => {
      if (event === 'application-detail') {
        const record = records.app[(data as { id: string }).id];
        return record ? { code: 200, results: record } : { code: 404, results: undefined };
      }
      if (event === 'session-detail') {
        const record = records.session[(data as { id: string }).id];
        return record ? { code: 200, results: record } : { code: 404, results: undefined };
      }
      if (event === 'oauth-legacy-bind') {
        return runHandler(legacyBind, data);
      }
      if (event === 'oauth-legacy-verify') {
        return runHandler(legacyVerify, data);
      }
      return { code: 404 };
    }
  };
}

describe('api/legacy verifyLegacyMcpKey against a real session-owned store', () => {
  let engine: Engine;
  let close: () => Promise<void>;

  before(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const Connection = (await import('@stackpress/inquire-pglite/Connection')).default;
    const EngineImpl = (await import('@stackpress/inquire/Engine')).default;
    const resource = new PGlite();
    const connection = new Connection(resource);
    engine = new EngineImpl(connection);
    close = async () => { await resource.close(); };
    for (const create of createAllOAuthTables()) {
      create.engine = engine;
      await create;
    }
  });

  after(async () => {
    await close();
  });

  function application(overrides: Partial<LegacyRecord> = {}): LegacyRecord {
    return {
      id: 'app-real-1',
      secret: 'real-secret',
      scopes: [ 'articles:read' ],
      active: true,
      expires: new Date(Date.now() + 1_000_000),
      created: new Date('2026-01-01T00:00:00.000Z'),
      applicationId: 'app-real-1',
      ...overrides
    };
  }

  it('bind then verify succeeds through the real store', async () => {
    const records = { app: { 'app-real-1': application() }, session: {} };
    const ctx = makeRealCtx(engine, records);
    await ctx.resolve('oauth-legacy-bind', {
      kind: 'app', legacyId: 'app-real-1',
      incarnation: application().created.toISOString(), resource: RESOURCE
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'app-real-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.deep.equal({
      kind: 'app', legacyId: 'app-real-1', applicationId: 'app-real-1',
      scopes: [ 'articles:read' ], resource: RESOURCE
    });
  });

  it('original key revocation: deactivating the legacy record ends access even with an untouched binding', async () => {
    const legacyId = 'app-real-revoke';
    const record = application({ id: legacyId, applicationId: legacyId });
    const records = { app: { [legacyId]: record }, session: {} };
    const ctx = makeRealCtx(engine, records);
    await ctx.resolve('oauth-legacy-bind', {
      kind: 'app', legacyId, incarnation: record.created.toISOString(), resource: RESOURCE
    });
    const before = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: `${legacyId}:real-secret`, resource: RESOURCE }
    );
    expect(before).to.not.equal(null);

    //the operator/app revokes the original API key
    records.app[legacyId] = { ...record, active: false };
    const after = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: `${legacyId}:real-secret`, resource: RESOURCE }
    );
    expect(after).to.equal(null);
  });

  it('binding removal: deactivating the real OAuthLegacyBinding row ends MCP access even though the legacy key is still valid', async () => {
    const legacyId = 'app-real-unbind';
    const record = application({ id: legacyId, applicationId: legacyId });
    const records = { app: { [legacyId]: record }, session: {} };
    const ctx = makeRealCtx(engine, records);
    await ctx.resolve('oauth-legacy-bind', {
      kind: 'app', legacyId, incarnation: record.created.toISOString(), resource: RESOURCE
    });
    const before = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: `${legacyId}:real-secret`, resource: RESOURCE }
    );
    expect(before).to.not.equal(null);

    //removal, through the real table (the generated admin page per
    //amendment A-001 would perform the same real UPDATE)
    const { hashWithDomain } = await import('../../stackpress-session/src/oauth/storage/ids.js');
    const matching = await new Select<Record<string, unknown>>('id', engine)
      .from('oauth_legacy_binding')
      .where(
        'kind = ? AND resource = ? AND legacy_id_hash = ?',
        [ 'app', RESOURCE, hashWithDomain('legacy-id', legacyId) ]
      )
      .limit(1);
    expect(matching.length).to.equal(1);
    await new Update('oauth_legacy_binding', engine)
      .set({ active: false })
      .where('id = ?', [ String(matching[0].id) ]);

    const after = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: `${legacyId}:real-secret`, resource: RESOURCE }
    );
    expect(after).to.equal(null);
  });

  it('source deletion/recreation: a recreated record reusing the same ID cannot inherit the old binding', async () => {
    const legacyId = 'app-real-recreate';
    const original = application({
      id: legacyId, applicationId: legacyId,
      created: new Date('2026-02-01T00:00:00.000Z')
    });
    const records = { app: { [legacyId]: original }, session: {} };
    const ctx = makeRealCtx(engine, records);
    await ctx.resolve('oauth-legacy-bind', {
      kind: 'app', legacyId, incarnation: original.created.toISOString(), resource: RESOURCE
    });
    const before = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: `${legacyId}:real-secret`, resource: RESOURCE }
    );
    expect(before).to.not.equal(null);

    //the original record is deleted and a new one is created reusing the
    //exact same legacy ID - a different `created` timestamp (incarnation)
    records.app[legacyId] = application({
      id: legacyId, applicationId: legacyId,
      created: new Date('2026-03-01T00:00:00.000Z')
    });
    const after = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: `${legacyId}:real-secret`, resource: RESOURCE }
    );
    expect(after).to.equal(null);
  });
});
