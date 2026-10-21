import { describe, it } from 'mocha';
import { expect } from 'chai';
import type Server from '@stackpress/ingest/Server';
import { registerOAuthOperation } from '../src/plugin.js';
import type { ApiEndpoint } from '../src/types.js';

function endpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    method: 'GET',
    route: '/api/articles/:id',
    type: 'session',
    event: 'article-detail',
    data: {},
    oauth: {
      operation: 'articles.detail',
      resources: [ 'https://example.com/mcp' ]
    },
    ...overrides
  };
}

function createServerStub(oauth?: Record<string, unknown>) {
  const plugins: Record<string, unknown> = {};
  if (oauth) {
    plugins.oauth = oauth;
  }
  return {
    plugin(name: string) {
      return plugins[name];
    }
  } as unknown as Server;
}

describe('api/plugin registerOAuthOperation', () => {
  it('should do nothing when the endpoint does not opt into oauth', () => {
    const ctx = createServerStub();
    expect(() => registerOAuthOperation(
      endpoint({ oauth: undefined }), ctx, new Set()
    )).to.not.throw();
  });

  it('should reject oauth: true as an invalid boolean opt-in', () => {
    const ctx = createServerStub();
    expect(() => registerOAuthOperation(
      endpoint({ oauth: true }), ctx, new Set()
    )).to.throw(/must explicitly name one operation ID/);
  });

  it('should reject oauth on a non-session endpoint type', () => {
    const ctx = createServerStub();
    expect(() => registerOAuthOperation(
      endpoint({ type: 'app' }), ctx, new Set()
    )).to.throw(/only type: 'session' routes can enable user OAuth/);
    expect(() => registerOAuthOperation(
      endpoint({ type: 'public' }), ctx, new Set()
    )).to.throw(/only type: 'session' routes can enable user OAuth/);
  });

  it('should reject method ALL on an oauth-enabled route', () => {
    const ctx = createServerStub();
    expect(() => registerOAuthOperation(
      endpoint({ method: 'ALL' }), ctx, new Set()
    )).to.throw(/must declare a concrete method, not ALL/);
  });

  it('should require oauth.operation', () => {
    const ctx = createServerStub();
    expect(() => registerOAuthOperation(
      endpoint({ oauth: { operation: '', resources: [ 'x' ] } }),
      ctx,
      new Set()
    )).to.throw(/oauth.operation is required/);
  });

  it('should reject a duplicate operation ID across endpoints', () => {
    const ctx = createServerStub({ registerApiOperation: () => {} });
    const ids = new Set<string>();
    registerOAuthOperation(endpoint(), ctx, ids);
    expect(() => registerOAuthOperation(endpoint(), ctx, ids))
      .to.throw(/Duplicate OAuth API operation ID/);
  });

  it('should require at least one declared resource', () => {
    const ctx = createServerStub();
    expect(() => registerOAuthOperation(
      endpoint({ oauth: { operation: 'x', resources: [] } }),
      ctx,
      new Set()
    )).to.throw(/must declare at least one resource/);
  });

  it('should require session.oauth (the oauth plugin) to be configured', () => {
    const ctx = createServerStub();
    expect(() => registerOAuthOperation(endpoint(), ctx, new Set()))
      .to.throw(/requires session.oauth to be configured/);
  });

  it('should register a valid descriptor with the oauth service', () => {
    const registered: unknown[] = [];
    const ctx = createServerStub({
      registerApiOperation: (descriptor: unknown) => registered.push(descriptor)
    });
    registerOAuthOperation(endpoint(), ctx, new Set());
    expect(registered).to.deep.equal([{
      id: 'articles.detail',
      surface: 'api',
      method: 'GET',
      route: '/api/articles/:id',
      event: 'article-detail',
      resources: [ 'https://example.com/mcp' ],
      scopes: [],
      data: {}
    }]);
  });

  it('should propagate a registration error raised by the oauth service', () => {
    const ctx = createServerStub({
      registerApiOperation: () => {
        throw new Error('Duplicate OAuth API operation ID: articles.detail');
      }
    });
    expect(() => registerOAuthOperation(endpoint(), ctx, new Set()))
      .to.throw(/Duplicate OAuth API operation ID/);
  });
});
