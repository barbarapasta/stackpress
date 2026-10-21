import { describe, it } from 'mocha';
import { expect } from 'chai';
import { session, app, registerOAuthOperation, oauthSession } from '../src/plugin.js';
import type { ApiEndpoint } from '../src/types.js';
import { createRequest, createResponse, createCtxStub } from './mocks.js';

function endpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    method: 'GET',
    route: '/api/articles/:id',
    type: 'session',
    event: 'article-detail',
    data: {},
    scopes: [ 'articles:read' ],
    oauth: {
      operation: 'articles.detail',
      resources: [ 'https://example.com/mcp' ]
    },
    ...overrides
  };
}

function identity(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    profileId: 'profile-1',
    clientId: 'client-1',
    grantId: 'grant-1',
    resource: 'https://example.com/mcp',
    scopes: [ 'articles:read' ],
    expires: new Date(),
    deadline: new Date(),
    credential: 'read',
    ...overrides
  };
}

describe('api/plugin session route action (oauth_ credentials)', () => {
  it('refuses an oauth_ credential outright when the route is not oauth-enabled', async () => {
    const ctx = createCtxStub();
    session(endpoint({ oauth: undefined }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(ctx.emitted).to.have.length(0);
  });

  it('never falls back to the legacy session-detail lookup for an oauth_ id', async () => {
    let legacyCalled = false;
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => { legacyCalled = true; return { results: undefined }; },
        'oauth-token-verify': () => ({ code: 401 })
      }
    });
    session(endpoint(), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc:secret' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(legacyCalled).to.equal(false);
  });

  it('rejects a reserved field in the request body with 400', async () => {
    const ctx = createCtxStub({
      resolves: { 'oauth-token-verify': () => ({ code: 200, results: identity() }) }
    });
    session(endpoint(), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({
      headers: { authorization: 'Bearer oauth_abc:secret' },
      data: { profileId: 'attacker-supplied' }
    });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(ctx.emitted).to.have.length(0);
  });

  it('requests a read credential on GET and a full credential otherwise', async () => {
    const seen: string[] = [];
    const ctx = createCtxStub({
      resolves: {
        'oauth-token-verify': (data: any) => {
          seen.push(data.requiredCredential);
          return { code: 200, results: identity() };
        }
      }
    });
    session(endpoint({ method: 'GET' }), ctx as any);
    const getAction = ctx.routes[0].action;
    await getAction({
      req: createRequest({ method: 'GET', headers: { authorization: 'Bearer oauth_abc' } }),
      res: createResponse(),
      ctx
    });

    const ctx2 = createCtxStub({
      resolves: {
        'oauth-token-verify': (data: any) => {
          seen.push(data.requiredCredential);
          return { code: 200, results: identity() };
        }
      }
    });
    session(endpoint({ method: 'POST' }), ctx2 as any);
    const postAction = ctx2.routes[0].action;
    await postAction({
      req: createRequest({
        method: 'POST', headers: { authorization: 'Bearer oauth_abc:secret' }
      }),
      res: createResponse(),
      ctx: ctx2
    });

    expect(seen).to.deep.equal([ 'read', 'full' ]);
  });

  it('tries each declared resource until the real grant resource matches', async () => {
    const tried: string[] = [];
    const ctx = createCtxStub({
      resolves: {
        'oauth-token-verify': (data: any) => {
          tried.push(data.resource);
          if (data.resource === 'https://example.com/second') {
            return { code: 200, results: identity({ resource: data.resource }) };
          }
          return { code: 401 };
        }
      }
    });
    session(
      endpoint({
        oauth: {
          operation: 'articles.detail',
          resources: [ 'https://example.com/first', 'https://example.com/second' ]
        }
      }),
      ctx as any
    );
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(tried).to.deep.equal([
      'https://example.com/first', 'https://example.com/second'
    ]);
    expect(ctx.emitted).to.have.length(1);
  });

  it('returns unauthorized when the key verifies for no declared resource', async () => {
    const ctx = createCtxStub({
      resolves: { 'oauth-token-verify': () => ({ code: 401 }) }
    });
    session(endpoint(), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(ctx.emitted).to.have.length(0);
  });

  it('denies an empty configured scopes list even with a verified identity', async () => {
    const ctx = createCtxStub({
      resolves: { 'oauth-token-verify': () => ({ code: 200, results: identity() }) }
    });
    session(endpoint({ scopes: [] }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(ctx.emitted).to.have.length(0);
  });

  it('denies when the identity scopes do not intersect the endpoint scopes', async () => {
    const ctx = createCtxStub({
      resolves: {
        'oauth-token-verify': () => ({
          code: 200, results: identity({ scopes: [ 'other:scope' ] })
        })
      }
    });
    session(endpoint({ scopes: [ 'articles:read' ] }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
  });

  it('one matching scope is enough, injects trusted profileId/oauth last and emits the event', async () => {
    const ctx = createCtxStub({
      resolves: {
        'oauth-token-verify': () => ({
          code: 200,
          results: identity({ scopes: [ 'other:scope', 'articles:read' ] })
        })
      }
    });
    session(
      endpoint({ scopes: [ 'articles:read' ], data: { foo: 'bar' } }),
      ctx as any
    );
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(ctx.emitted).to.have.length(1);
    expect(ctx.emitted[0].event).to.equal('article-detail');
    expect(req.data.get('foo')).to.equal('bar');
    expect(req.data.get('profileId')).to.equal('profile-1');
    expect(req.data.get('oauth')).to.deep.equal({
      clientId: 'client-1',
      grantId: 'grant-1',
      resource: 'https://example.com/mcp',
      scopes: [ 'other:scope', 'articles:read' ]
    });
  });
});

describe('api/plugin oauthSession (direct)', () => {
  it('refuses when endpoint.oauth is a boolean', async () => {
    const ctx = createCtxStub();
    const req = createRequest();
    const res = createResponse();
    await oauthSession(endpoint({ oauth: true }), req, res, ctx as any, 'oauth_abc');
    expect(res.code).to.equal(401);
  });
});

describe('api/plugin app route action (oauth_ credentials)', () => {
  it('refuses an oauth_ credential without attempting the legacy application lookup', async () => {
    let legacyCalled = false;
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => { legacyCalled = true; return { results: undefined }; }
      }
    });
    app(endpoint({ type: 'app' }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer oauth_abc:secret' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(legacyCalled).to.equal(false);
  });
});

describe('api/plugin registerOAuthOperation reserved fixed data', () => {
  it('rejects fixed data that sets a reserved field', () => {
    const ctx = { plugin: () => ({ registerApiOperation: () => {} }) } as any;
    expect(() => registerOAuthOperation(
      endpoint({ data: { profileId: 'nope' } }), ctx, new Set()
    )).to.throw(/reserved field "profileId"/);
  });
});
