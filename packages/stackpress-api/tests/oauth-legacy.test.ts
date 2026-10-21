import { describe, it } from 'mocha';
import { expect } from 'chai';
import { verifyLegacyMcpKey } from '../src/legacy.js';
import { createCtxStub } from './mocks.js';

const RESOURCE = 'https://example.com/mcp';

function application(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'app-1',
    secret: 'real-secret',
    scopes: [ 'articles:read' ],
    active: true,
    expires: new Date(Date.now() + 100_000),
    created: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

function session(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sess-1',
    applicationId: 'app-1',
    profileId: 'profile-1',
    secret: 'real-secret',
    scopes: [ 'articles:read' ],
    active: true,
    expires: new Date(Date.now() + 100_000),
    created: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

describe('api/legacy verifyLegacyMcpKey', () => {
  it('rejects an empty token', async () => {
    const ctx = createCtxStub();
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: '', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects a malformed token (no secret)', async () => {
    const ctx = createCtxStub();
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'id-only', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects an unknown application id', async () => {
    const ctx = createCtxStub({
      resolves: { 'application-detail': () => ({ results: undefined }) }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'app-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects a wrong-secret application', async () => {
    const ctx = createCtxStub({
      resolves: { 'application-detail': () => ({ results: application() }) }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'app-1:wrong-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects an inactive application', async () => {
    const ctx = createCtxStub({
      resolves: { 'application-detail': () => ({ results: application({ active: false }) }) }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'app-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects an expired application', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({
          results: application({ expires: new Date(Date.now() - 1000) })
        })
      }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'app-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects a valid application record with no active session-owned binding', async () => {
    let verifyInput: unknown;
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application() }),
        'oauth-legacy-verify': (data: unknown) => {
          verifyInput = data;
          return { code: 200, results: { active: false } };
        }
      }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'app-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
    expect(verifyInput).to.deep.equal({
      kind: 'app', legacyId: 'app-1',
      incarnation: '2026-01-01T00:00:00.000Z', resource: RESOURCE
    });
  });

  it('returns a safe identity for a fully valid bound application key', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application() }),
        'oauth-legacy-verify': () => ({ code: 200, results: { active: true } })
      }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'app', token: 'app-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.deep.equal({
      kind: 'app', legacyId: 'app-1', applicationId: 'app-1',
      scopes: [ 'articles:read' ], resource: RESOURCE
    });
  });

  it('rejects a wrong-secret session', async () => {
    const ctx = createCtxStub({
      resolves: { 'session-detail': () => ({ results: session() }) }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'session', token: 'sess-1:wrong', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects an inactive session', async () => {
    const ctx = createCtxStub({
      resolves: { 'session-detail': () => ({ results: session({ active: false }) }) }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'session', token: 'sess-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects an expired session', async () => {
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: session({ expires: new Date(Date.now() - 1000) })
        })
      }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'session', token: 'sess-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('rejects a valid session record with no active session-owned binding', async () => {
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({ results: session() }),
        'oauth-legacy-verify': () => ({ code: 200, results: { active: false } })
      }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'session', token: 'sess-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.equal(null);
  });

  it('returns a safe identity for a fully valid bound session key', async () => {
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({ results: session() }),
        'oauth-legacy-verify': () => ({ code: 200, results: { active: true } })
      }
    });
    const result = await verifyLegacyMcpKey(
      ctx as any, { kind: 'session', token: 'sess-1:real-secret', resource: RESOURCE }
    );
    expect(result).to.deep.equal({
      kind: 'session', legacyId: 'sess-1', applicationId: 'app-1',
      profileId: 'profile-1', scopes: [ 'articles:read' ], resource: RESOURCE
    });
  });
});
