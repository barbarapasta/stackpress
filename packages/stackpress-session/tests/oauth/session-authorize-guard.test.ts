import { describe, it } from 'mocha';
import { expect } from 'chai';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import authorizeEvent from '../../src/session/events/authorize.js';
import OAuthService from '../../src/oauth/OAuthService.js';

//configuration.md: "The global browser session.access authorizer must
//recognize exact registered protocol/API/MCP route capabilities,
//allowing those handlers to enforce their own identity checks. No
//broad /auth/* bypass." These tests exercise the actual `authorize`
//event session/plugin.ts wires to the 'request' hook, not a
//reimplementation of its logic.

function baseConfig(overrides: Record<string, unknown> = {}) {
  return normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: [{
      resource: 'https://example.com/mcp',
      name: 'Example', description: 'desc',
      scopes: [ 'articles:read' ]
    }],
    scopes: { 'articles:read': { name: 'Read', description: 'Read' } },
    policy: { approval: 'approval-event', access: 'access-event' },
    ...overrides
  });
}

function makeReq(method: string, pathname: string) {
  return { method, url: { pathname } } as any;
}

function makeSessionStub() {
  let calledWith: unknown = undefined;
  const stub = {
    async authorize(req: unknown, res: unknown) {
      calledWith = req;
      return true;
    }
  };
  return { stub, wasCalled: () => typeof calledWith !== 'undefined' };
}

function makeCtx(options: { oauth?: unknown, session: unknown }) {
  const plugins: Record<string, unknown> = { session: options.session };
  if (typeof options.oauth !== 'undefined') plugins.oauth = options.oauth;
  return { plugin: (name: string) => plugins[name] } as any;
}

//a finalized `OAuthService` without actually running finalize() (which
//would require a full server stub with every listener registered) -
//these tests only exercise isNativeRoute()/finalized, not finalize()
//itself (already covered by OAuthService.test.ts).
function finalizedOAuthService(config: ReturnType<typeof baseConfig>) {
  const service = new OAuthService({} as any, config);
  (service as any)._finalized = true;
  return service;
}

describe('session authorize event: OAuth native-route bypass', () => {
  it('skips the cookie check for an exact registered native protocol route', async () => {
    const oauth = finalizedOAuthService(baseConfig());
    const { stub, wasCalled } = makeSessionStub();
    const ctx = makeCtx({ oauth, session: stub });
    const req = makeReq('POST', '/auth/oauth2/token');
    const res = {} as any;
    await authorizeEvent({ req, res, ctx });
    expect(wasCalled()).to.equal(false);
  });

  it('skips the cookie check for an exact registered API operation route', async () => {
    //registered before finalization - mutation is refused afterward.
    const service = new OAuthService({} as any, baseConfig());
    service.registerApiOperation({
      id: 'articles.detail', surface: 'api', method: 'GET',
      route: '/api/articles/:id', event: 'article-detail',
      resources: [ 'https://example.com/mcp' ], scopes: [], data: {}
    });
    (service as any)._finalized = true;
    const oauth = service;
    const { stub, wasCalled } = makeSessionStub();
    const ctx = makeCtx({ oauth, session: stub });
    const req = makeReq('GET', '/api/articles/:id');
    const res = {} as any;
    await authorizeEvent({ req, res, ctx });
    expect(wasCalled()).to.equal(false);
  });

  it('still requires the ordinary session check for /authorize', async () => {
    const oauth = finalizedOAuthService(baseConfig());
    const { stub, wasCalled } = makeSessionStub();
    const ctx = makeCtx({ oauth, session: stub });
    const req = makeReq('GET', '/auth/oauth2/authorize');
    const res = {} as any;
    await authorizeEvent({ req, res, ctx });
    expect(wasCalled()).to.equal(true);
  });

  it('still requires the ordinary session check for /connections', async () => {
    const oauth = finalizedOAuthService(baseConfig());
    const { stub, wasCalled } = makeSessionStub();
    const ctx = makeCtx({ oauth, session: stub });
    const req = makeReq('GET', '/auth/oauth2/connections');
    const res = {} as any;
    await authorizeEvent({ req, res, ctx });
    expect(wasCalled()).to.equal(true);
  });

  it('requires the ordinary session check for an unrelated route', async () => {
    const oauth = finalizedOAuthService(baseConfig());
    const { stub, wasCalled } = makeSessionStub();
    const ctx = makeCtx({ oauth, session: stub });
    const req = makeReq('GET', '/auth/account');
    const res = {} as any;
    await authorizeEvent({ req, res, ctx });
    expect(wasCalled()).to.equal(true);
  });

  it('requires the ordinary session check when the OAuth plugin is absent', async () => {
    const { stub, wasCalled } = makeSessionStub();
    const ctx = makeCtx({ session: stub });
    const req = makeReq('POST', '/auth/oauth2/token');
    const res = {} as any;
    await authorizeEvent({ req, res, ctx });
    expect(wasCalled()).to.equal(true);
  });

  it('requires the ordinary session check when OAuth is not yet finalized', async () => {
    //a real, un-finalized OAuthService (the ordinary constructor state,
    //not the test helper above).
    const oauth = new OAuthService({} as any, baseConfig());
    const { stub, wasCalled } = makeSessionStub();
    const ctx = makeCtx({ oauth, session: stub });
    const req = makeReq('POST', '/auth/oauth2/token');
    const res = {} as any;
    await authorizeEvent({ req, res, ctx });
    expect(wasCalled()).to.equal(true);
  });
});
