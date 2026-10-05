import { describe, it, afterEach } from 'mocha';
import { expect } from 'chai';
import plugin, { cors, session, app, open } from '../src/plugin.js';
import type { ApiEndpoint } from '../src/types.js';
import { createRequest, createResponse, createCtxStub } from './mocks.js';

function endpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    method: 'GET',
    route: '/api/articles/:id',
    type: 'session',
    event: 'article-detail',
    data: {},
    ...overrides
  };
}

describe('api/plugin default export', () => {
  it('should do nothing when there is no api config', () => {
    const ctx = createCtxStub({ config: {} });
    plugin(ctx as any);
    expect(ctx.listeners['listen']).to.equal(undefined);
    expect(ctx.listeners['route']).to.equal(undefined);
  });

  it('should register listen and route listeners when api config exists', () => {
    const ctx = createCtxStub({ config: { api: {} } });
    plugin(ctx as any);
    expect(ctx.listeners['listen']).to.have.length(1);
    expect(ctx.listeners['route']).to.have.length(1);
  });

  describe('route listener', () => {
    it('should not register anything when there are no endpoints', async () => {
      const ctx = createCtxStub({ config: { api: {} } });
      plugin(ctx as any);
      await ctx.listeners['route'][0].callback({ ctx });
      expect(ctx.imports).to.have.length(0);
      expect(ctx.views).to.have.length(0);
      expect(ctx.routes).to.have.length(0);
    });

    it('should register token/oauth pages and dispatch endpoints by type', async () => {
      const registered: unknown[] = [];
      const ctx = createCtxStub({
        config: {
          api: {
            endpoints: [
              endpoint({ type: 'session', route: '/api/session', event: 'session-event' }),
              endpoint({ type: 'app', route: '/api/app', event: 'app-event' }),
              endpoint({ type: 'public', route: '/api/open', event: 'open-event' })
            ]
          }
        },
        plugins: {
          oauth: { registerApiOperation: (d: unknown) => registered.push(d) }
        }
      });
      plugin(ctx as any);
      await ctx.listeners['route'][0].callback({ ctx });
      expect(ctx.imports.map(i => i.path)).to.deep.equal([
        '/auth/oauth/token',
        '/auth/oauth'
      ]);
      expect(ctx.views).to.have.length(1);
      expect(ctx.views[0]).to.include({
        path: '/auth/oauth',
        component: 'stackpress-api/esm/views/oauth',
        priority: -100
      });
      const routePaths = ctx.routes.map(r => `${r.method} ${r.path}`);
      expect(routePaths).to.include('GET /api/session');
      expect(routePaths).to.include('GET /api/app');
      expect(routePaths).to.include('GET /api/open');
    });
  });

  describe('listen listener (webhooks)', () => {
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should do nothing when there are no webhooks', async () => {
      const ctx = createCtxStub({ config: { api: {} } });
      plugin(ctx as any);
      await ctx.listeners['listen'][0].callback({ ctx });
      expect(ctx.listeners['auth-signin']).to.equal(undefined);
    });

    it('should skip the webhook call when the response is not a 200', async () => {
      let called = false;
      global.fetch = (async () => { called = true; return new Response('{}'); }) as any;
      const ctx = createCtxStub({
        config: {
          api: {
            webhooks: [{
              event: 'auth-signin',
              uri: 'http://localhost/webhook',
              method: 'POST',
              validity: {},
              data: {}
            }]
          }
        }
      });
      plugin(ctx as any);
      await ctx.listeners['listen'][0].callback({ ctx });
      const req = createRequest();
      const res = createResponse();
      res.setError('nope', {}, [], 500);
      await ctx.listeners['auth-signin'][0].callback({ req, res, ctx });
      expect(called).to.equal(false);
    });

    it('should skip the webhook call when the results do not satisfy validity', async () => {
      let called = false;
      global.fetch = (async () => { called = true; return new Response('{}'); }) as any;
      const ctx = createCtxStub({
        config: {
          api: {
            webhooks: [{
              event: 'auth-signin',
              uri: 'http://localhost/webhook',
              method: 'POST',
              validity: { status: 'active' },
              data: {}
            }]
          }
        }
      });
      plugin(ctx as any);
      await ctx.listeners['listen'][0].callback({ ctx });
      const req = createRequest();
      const res = createResponse();
      res.results({ status: 'inactive' });
      await ctx.listeners['auth-signin'][0].callback({ req, res, ctx });
      expect(called).to.equal(false);
    });

    it('should POST to the webhook uri with data/params/results when everything is valid', async () => {
      let capturedUrl: string | undefined;
      let capturedInit: any;
      global.fetch = (async (url: string, init: any) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response('{}');
      }) as any;
      const ctx = createCtxStub({
        config: {
          api: {
            webhooks: [{
              event: 'auth-signin',
              uri: 'http://localhost/webhook',
              method: 'POST',
              validity: { status: 'active' },
              data: { source: 'stackpress' }
            }]
          }
        }
      });
      plugin(ctx as any);
      await ctx.listeners['listen'][0].callback({ ctx });
      const req = createRequest({ data: { userId: 'u1' } });
      const res = createResponse();
      res.results({ status: 'active', id: 'sess1' });
      await ctx.listeners['auth-signin'][0].callback({ req, res, ctx });
      expect(capturedUrl).to.equal('http://localhost/webhook');
      expect(capturedInit.method).to.equal('POST');
      expect(capturedInit.headers).to.deep.equal({ 'Content-Type': 'application/json' });
      const body = JSON.parse(capturedInit.body);
      expect(body.data).to.deep.equal({ source: 'stackpress' });
      expect(body.params).to.deep.equal({ userId: 'u1' });
      expect(body.results).to.deep.equal({ status: 'active', id: 'sess1' });
    });
  });
});

describe('api/plugin cors', () => {
  it('should register nothing when cors is not configured', () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: undefined }), ctx as any);
    expect(ctx.routes).to.have.length(0);
  });

  it('should register nothing when cors is false', () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: false }), ctx as any);
    expect(ctx.routes).to.have.length(0);
  });

  it('should register OPTIONS preflight and the method route for a wildcard origin', () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: true }), ctx as any);
    expect(ctx.routes).to.have.length(2);
    expect(ctx.routes.map(r => r.method)).to.deep.equal([ 'OPTIONS', 'GET' ]);
    expect(ctx.routes.every(r => r.priority === 1000)).to.equal(true);
  });

  it('should set the wildcard Access-Control-Allow-Origin header', async () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: true }), ctx as any);
    const corsAction = ctx.routes[1].action;
    const req = createRequest({ url: 'http://example.com/api/articles/1' });
    const res = createResponse();
    await corsAction({ req, res });
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).to.equal('OPTIONS, GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).to.equal('*');
    expect(res.headers.get('Access-Control-Request-Method')).to.equal('GET');
  });

  it('should use * for the request-method header when the endpoint method is ALL', async () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: true, method: 'ALL' }), ctx as any);
    const corsAction = ctx.routes[1].action;
    const req = createRequest({ url: 'http://example.com/api/articles/1' });
    const res = createResponse();
    await corsAction({ req, res });
    expect(res.headers.get('Access-Control-Request-Method')).to.equal('*');
  });

  it('should allow a matching specific origin', async () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: 'http://example.com' }), ctx as any);
    const corsAction = ctx.routes[1].action;
    const req = createRequest({ url: 'http://example.com/api/articles/1' });
    const res = createResponse();
    await corsAction({ req, res });
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal('http://example.com');
  });

  it('should reject a mismatched origin (no header set)', async () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: [ 'http://allowed.com' ] }), ctx as any);
    const corsAction = ctx.routes[1].action;
    const req = createRequest({ url: 'http://not-allowed.com/api/articles/1' });
    const res = createResponse();
    await corsAction({ req, res });
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal(undefined);
  });

  it('should set code 200 on the preflight route', async () => {
    const ctx = createCtxStub();
    cors(endpoint({ cors: true }), ctx as any);
    const preflightAction = ctx.routes[0].action;
    const req = createRequest({ url: 'http://example.com/api/articles/1' });
    const res = createResponse();
    await preflightAction({ req, res });
    expect(res.code).to.equal(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal('*');
  });
});

describe('api/plugin session route action', () => {
  it('should stop when authorization fails', async () => {
    const ctx = createCtxStub();
    session(endpoint(), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest();
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(ctx.emitted).to.have.length(0);
  });

  it('should return unauthorized when the session lookup fails', async () => {
    const ctx = createCtxStub({
      resolves: { 'session-detail': () => ({ results: undefined }) }
    });
    session(endpoint(), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer id1' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized on a secret mismatch for a non-GET request', async () => {
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: { profileId: 'p1', secret: 'real-secret', scopes: [ 'read' ] }
        })
      }
    });
    session(endpoint({ method: 'POST', scopes: [ 'read' ] }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:wrong-secret' }
    });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when scopes do not intersect', async () => {
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: { profileId: 'p1', secret: 'real-secret', scopes: [ 'write' ] }
        })
      }
    });
    session(endpoint({ method: 'GET', scopes: [ 'read' ] }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer id1' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(ctx.emitted).to.have.length(0);
  });

  it('should emit the endpoint event and set profileId on success', async () => {
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: { profileId: 'p1', secret: 'real-secret', scopes: [ 'read' ] }
        })
      }
    });
    session(
      endpoint({ method: 'GET', scopes: [ 'read' ], data: { foo: 'bar' } }),
      ctx as any
    );
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer id1' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(ctx.emitted).to.have.length(1);
    expect(ctx.emitted[0].event).to.equal('article-detail');
    expect(req.data.get('foo')).to.equal('bar');
    expect(req.data.get('profileId')).to.equal('p1');
  });
});

describe('api/plugin app route action', () => {
  it('should stop when authorization fails', async () => {
    const ctx = createCtxStub();
    app(endpoint({ type: 'app' }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest();
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
    expect(ctx.emitted).to.have.length(0);
  });

  it('should return unauthorized when the application lookup fails', async () => {
    const ctx = createCtxStub({
      resolves: { 'application-detail': () => ({ results: undefined }) }
    });
    app(endpoint({ type: 'app' }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer id1' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized on a secret mismatch for a non-GET request', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({
          results: { secret: 'real-secret', scopes: [ 'read' ] }
        })
      }
    });
    app(endpoint({ type: 'app', method: 'POST', scopes: [ 'read' ] }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:wrong-secret' }
    });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when scopes do not intersect', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({
          results: { secret: 'real-secret', scopes: [ 'write' ] }
        })
      }
    });
    app(endpoint({ type: 'app', method: 'GET', scopes: [ 'read' ] }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer id1' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(res.code).to.equal(401);
  });

  it('should emit the endpoint event on success without touching profileId', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': () => ({
          results: { secret: 'real-secret', scopes: [ 'read' ] }
        })
      }
    });
    app(
      endpoint({ type: 'app', method: 'GET', scopes: [ 'read' ], data: { foo: 'bar' } }),
      ctx as any
    );
    const action = ctx.routes[0].action;
    const req = createRequest({ headers: { authorization: 'Bearer id1' } });
    const res = createResponse();
    await action({ req, res, ctx });
    expect(ctx.emitted).to.have.length(1);
    expect(ctx.emitted[0].event).to.equal('article-detail');
    expect(req.data.get('foo')).to.equal('bar');
    expect(req.data.get('profileId')).to.equal(undefined);
  });
});

describe('api/plugin open route action', () => {
  it('should set endpoint data and emit the event without any authorization', async () => {
    const ctx = createCtxStub();
    open(endpoint({ type: 'public', data: { foo: 'bar' } }), ctx as any);
    const action = ctx.routes[0].action;
    const req = createRequest();
    const res = createResponse();
    await action({ req, res, ctx });
    expect(ctx.emitted).to.have.length(1);
    expect(ctx.emitted[0].event).to.equal('article-detail');
    expect(req.data.get('foo')).to.equal('bar');
  });
});
