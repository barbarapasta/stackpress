import { describe, it } from 'mocha';
import { expect } from 'chai';
import { loadSafeProfile, invokeApprovalPolicy, invokeAccessPolicy } from '../../src/oauth/policy.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeCtx } from './events-helpers.js';

function baseConfig() {
  return normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: [{
      resource: 'https://example.com/mcp',
      name: 'Example', description: 'desc',
      scopes: [ 'articles:read', 'articles:write' ]
    }],
    scopes: {
      'articles:read': { name: 'Read', description: 'Read' },
      'articles:write': { name: 'Write', description: 'Write' }
    },
    policy: { approval: 'approval-event', access: 'access-event', timeoutMs: 50 },
    accessSeconds: 900,
    renewalSeconds: 604_800
  });
}

describe('OAuth loadSafeProfile', () => {
  it('returns a safe {id, roles} summary for an active profile', async () => {
    const ctx = makeCtx({
      resolvers: {
        'profile-detail': () => ({
          code: 200, results: { id: 'profile-1', roles: [ 'MEMBER' ], active: true }
        })
      }
    });
    const profile = await loadSafeProfile(ctx, 'profile-1');
    expect(profile).to.deep.equal({ id: 'profile-1', roles: [ 'MEMBER' ] });
  });

  it('returns null for an inactive profile', async () => {
    const ctx = makeCtx({
      resolvers: {
        'profile-detail': () => ({ code: 200, results: { id: 'p', roles: [], active: false } })
      }
    });
    expect(await loadSafeProfile(ctx, 'p')).to.equal(null);
  });

  it('returns null when the profile lookup fails or is missing', async () => {
    const ctx = makeCtx({ resolvers: { 'profile-detail': () => ({ code: 404 }) } });
    expect(await loadSafeProfile(ctx, 'missing')).to.equal(null);
  });
});

describe('OAuth invokeApprovalPolicy', () => {
  const input = {
    phase: 'approval' as const,
    profile: { id: 'profile-1', roles: [] },
    client: { id: 'client-1' },
    resource: 'https://example.com/mcp',
    scopes: [ 'articles:read', 'articles:write' ],
    operations: [ 'articles.detail' ],
    factor: { available: false }
  };

  it('denies when the listener is missing', async () => {
    const ctx = makeCtx({ resolvers: {} });
    expect(await invokeApprovalPolicy(ctx, baseConfig(), input)).to.equal(null);
  });

  it('denies when allowed is not explicitly true', async () => {
    const ctx = makeCtx({ resolvers: { 'approval-event': () => ({ code: 200, results: { allowed: false } }) } });
    expect(await invokeApprovalPolicy(ctx, baseConfig(), input)).to.equal(null);
  });

  it('denies when scopes/operations are missing from an allowed result', async () => {
    const ctx = makeCtx({ resolvers: { 'approval-event': () => ({ code: 200, results: { allowed: true } }) } });
    expect(await invokeApprovalPolicy(ctx, baseConfig(), input)).to.equal(null);
  });

  it('denies an expanding scope list', async () => {
    const ctx = makeCtx({
      resolvers: {
        'approval-event': () => ({
          code: 200,
          results: { allowed: true, scopes: [ 'articles:read', 'articles:admin' ], operations: [] }
        })
      }
    });
    expect(await invokeApprovalPolicy(ctx, baseConfig(), input)).to.equal(null);
  });

  it('accepts a narrowed allowed result and applies library defaults for omitted durations', async () => {
    const ctx = makeCtx({
      resolvers: {
        'approval-event': () => ({
          code: 200,
          results: { allowed: true, scopes: [ 'articles:read' ], operations: [] }
        })
      }
    });
    const decision = await invokeApprovalPolicy(ctx, baseConfig(), input);
    expect(decision).to.deep.equal({
      scopes: [ 'articles:read' ],
      operations: [],
      accessSeconds: 900,
      renewalSeconds: 604_800,
      requireFactor: false
    });
  });

  it('accepts a shortened duration but rejects one that would expand the default', async () => {
    const shortened = makeCtx({
      resolvers: {
        'approval-event': () => ({
          code: 200,
          results: { allowed: true, scopes: [], operations: [], accessSeconds: 60 }
        })
      }
    });
    const decision = await invokeApprovalPolicy(shortened, baseConfig(), input);
    expect(decision?.accessSeconds).to.equal(60);

    const expanded = makeCtx({
      resolvers: {
        'approval-event': () => ({
          code: 200,
          results: { allowed: true, scopes: [], operations: [], accessSeconds: 9999 }
        })
      }
    });
    expect(await invokeApprovalPolicy(expanded, baseConfig(), input)).to.equal(null);
  });

  it('passes requireFactor through only when explicitly true', async () => {
    const ctx = makeCtx({
      resolvers: {
        'approval-event': () => ({
          code: 200,
          results: { allowed: true, scopes: [], operations: [], requireFactor: true }
        })
      }
    });
    const decision = await invokeApprovalPolicy(ctx, baseConfig(), input);
    expect(decision?.requireFactor).to.equal(true);
  });

  it('denies on a listener timeout', async () => {
    const ctx = makeCtx({
      resolvers: {
        'approval-event': () => new Promise((resolve) => {
          setTimeout(() => resolve({ code: 200, results: { allowed: true, scopes: [], operations: [] } }), 200);
        }) as any
      }
    });
    const config = baseConfig();
    expect(await invokeApprovalPolicy(ctx, config, input)).to.equal(null);
  });
});

describe('OAuth invokeAccessPolicy', () => {
  const input = {
    phase: 'verify' as const,
    profile: { id: 'profile-1', roles: [] },
    client: { id: 'client-1' },
    grant: {
      grantId: 'grant-1', clientId: 'client-1', resource: 'https://example.com/mcp',
      scopes: [ 'articles:read', 'articles:write' ], operations: [], deadline: new Date()
    }
  };

  it('denies when the listener is missing', async () => {
    const ctx = makeCtx({ resolvers: {} });
    expect(await invokeAccessPolicy(ctx, baseConfig(), input)).to.equal(null);
  });

  it('preserves the stored scope set when scopes are omitted', async () => {
    const ctx = makeCtx({ resolvers: { 'access-event': () => ({ code: 200, results: { allowed: true } }) } });
    const decision = await invokeAccessPolicy(ctx, baseConfig(), input);
    expect(decision).to.deep.equal({ scopes: [ 'articles:read', 'articles:write' ] });
  });

  it('accepts a narrowed subset', async () => {
    const ctx = makeCtx({
      resolvers: { 'access-event': () => ({ code: 200, results: { allowed: true, scopes: [ 'articles:read' ] } }) }
    });
    const decision = await invokeAccessPolicy(ctx, baseConfig(), input);
    expect(decision).to.deep.equal({ scopes: [ 'articles:read' ] });
  });

  it('denies a scope that is not a subset of the grant', async () => {
    const ctx = makeCtx({
      resolvers: { 'access-event': () => ({ code: 200, results: { allowed: true, scopes: [ 'articles:admin' ] } }) }
    });
    expect(await invokeAccessPolicy(ctx, baseConfig(), input)).to.equal(null);
  });

  it('denies when allowed is false', async () => {
    const ctx = makeCtx({ resolvers: { 'access-event': () => ({ code: 200, results: { allowed: false } }) } });
    expect(await invokeAccessPolicy(ctx, baseConfig(), input)).to.equal(null);
  });
});
