import { describe, it } from 'mocha';
import { expect } from 'chai';
import legacyMigrate from '../src/migrate.js';
import { createRequest, createResponse, createCtxStub } from './mocks.js';

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

describe('api/migrate oauth-legacy-migrate', () => {
  it('rejects a malformed request', async () => {
    const ctx = createCtxStub();
    const req = createRequest({ data: { kind: 'app' } });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect(res.code).to.equal(400);
  });

  it('reports invalid for an unknown record without binding anything', async () => {
    let bindCalled = false;
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: undefined }),
        'oauth-legacy-bind': () => { bindCalled = true; return { code: 200, results: { bound: true } }; }
      }
    });
    const req = createRequest({
      data: { kind: 'app', resource: 'https://example.com/mcp', ids: [ 'missing-1' ] }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect(bindCalled).to.equal(false);
    expect(res.body).to.deep.equal({
      dryRun: false, total: 1, bound: 0, invalid: 1,
      records: [{ id: 'missing-1', status: 'invalid' }]
    });
  });

  it('reports invalid for an inactive record', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application({ active: false }) })
      }
    });
    const req = createRequest({
      data: { kind: 'app', resource: 'https://example.com/mcp', ids: [ 'app-1' ] }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect((res.body as any).records).to.deep.equal([{ id: 'app-1', status: 'invalid' }]);
  });

  it('reports invalid for an expired record', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({
          results: application({ expires: new Date(Date.now() - 1000) })
        })
      }
    });
    const req = createRequest({
      data: { kind: 'app', resource: 'https://example.com/mcp', ids: [ 'app-1' ] }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect((res.body as any).records).to.deep.equal([{ id: 'app-1', status: 'invalid' }]);
  });

  it('surfaces a namespace_conflict reason and forwards expiresInSeconds as a Date', async () => {
    let bindInput: any;
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application() }),
        'oauth-legacy-bind': (data: unknown) => {
          bindInput = data;
          return { code: 200, results: { bound: false, reason: 'namespace_conflict' } };
        }
      }
    });
    const req = createRequest({
      data: {
        kind: 'app', resource: 'https://example.com/mcp', ids: [ 'app-1' ],
        expiresInSeconds: 3600
      }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect((res.body as any).records).to.deep.equal([
      { id: 'app-1', status: 'namespace_conflict' }
    ]);
    expect(bindInput.expires).to.be.instanceOf(Date);
  });

  it('falls back to invalid for an unrecognized bind failure with no results', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application() }),
        'oauth-legacy-bind': () => ({ code: 503 })
      }
    });
    const req = createRequest({
      data: { kind: 'app', resource: 'https://example.com/mcp', ids: [ 'app-1' ] }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect((res.body as any).records).to.deep.equal([{ id: 'app-1', status: 'invalid' }]);
  });

  it('dry-run reports would_bind and never calls oauth-legacy-bind, never exposes a secret', async () => {
    let bindCalled = false;
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application() }),
        'oauth-legacy-bind': () => { bindCalled = true; return { code: 200, results: { bound: true } }; }
      }
    });
    const req = createRequest({
      data: { kind: 'app', resource: 'https://example.com/mcp', ids: [ 'app-1' ], dryRun: true }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect(bindCalled).to.equal(false);
    const body = res.body as any;
    expect(body).to.deep.equal({
      dryRun: true, total: 1, bound: 1, invalid: 0,
      records: [{ id: 'app-1', status: 'would_bind' }]
    });
    expect(JSON.stringify(body)).to.not.include('real-secret');
  });

  it('binds a valid record and forwards the raw id/incarnation/resource to session', async () => {
    let bindInput: any;
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application() }),
        'oauth-legacy-bind': (data: unknown) => {
          bindInput = data;
          return { code: 200, results: { bound: true } };
        }
      }
    });
    const req = createRequest({
      data: { kind: 'app', resource: 'https://example.com/mcp', ids: [ 'app-1' ] }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect(bindInput).to.deep.equal({
      kind: 'app', legacyId: 'app-1',
      incarnation: '2026-01-01T00:00:00.000Z',
      resource: 'https://example.com/mcp',
      expires: null
    });
    expect((res.body as any).records).to.deep.equal([{ id: 'app-1', status: 'bound' }]);
  });

  it('surfaces a namespace_conflict/incarnation_mismatch reason from session without secrets', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({ results: application() }),
        'oauth-legacy-bind': () => ({
          code: 200, results: { bound: false, reason: 'incarnation_mismatch' }
        })
      }
    });
    const req = createRequest({
      data: { kind: 'app', resource: 'https://example.com/mcp', ids: [ 'app-1' ] }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    expect((res.body as any).records).to.deep.equal([
      { id: 'app-1', status: 'incarnation_mismatch' }
    ]);
  });

  it('is repeatable across multiple ids and mixes statuses correctly', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': (data: any) => ({
          results: data.id === 'missing' ? undefined : application({ id: data.id })
        }),
        'oauth-legacy-bind': () => ({ code: 200, results: { bound: true } })
      }
    });
    const req = createRequest({
      data: {
        kind: 'app', resource: 'https://example.com/mcp',
        ids: [ 'app-1', 'missing', 'app-2' ]
      }
    });
    const res = createResponse();
    await legacyMigrate({ req, res, ctx: ctx as any });
    const body = res.body as any;
    expect(body.total).to.equal(3);
    expect(body.bound).to.equal(2);
    expect(body.invalid).to.equal(1);
  });
});
