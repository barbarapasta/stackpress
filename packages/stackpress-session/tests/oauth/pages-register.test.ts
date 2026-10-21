import { describe, it } from 'mocha';
import { expect } from 'chai';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeOAuthPlugin } from './events-helpers.js';
import { makePageReq, makePageRes, makePageCtx } from './pages-test-helpers.js';
import registerPage from '../../src/oauth/pages/register.js';

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

describe('OAuth pages/register', () => {
  it('maps a successful registration to HTTP 201', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({
      oauth,
      resolvers: {
        'oauth-client-register': () => ({
          code: 200,
          results: {
            client_id: 'oauthreg_abc', client_id_issued_at: 1,
            redirect_uris: [ 'https://new.example/callback' ],
            grant_types: [ 'authorization_code' ], response_types: [ 'code' ],
            token_endpoint_auth_method: 'none'
          }
        })
      }
    });
    const req = makePageReq({
      method: 'POST',
      body: JSON.stringify({ redirect_uris: [ 'https://new.example/callback' ] }),
      remoteAddress: 'register-source-1'
    });
    const res = makePageRes();
    await registerPage({ req, res, ctx });
    expect(res.code).to.equal(201);
    expect(res.body.client_id).to.equal('oauthreg_abc');
  });

  it('refuses when registration.enabled is false, without calling the event', async () => {
    const oauth = makeOAuthPlugin(baseConfig({ registration: { enabled: false } }));
    let called = false;
    const ctx = makePageCtx({
      oauth,
      resolvers: { 'oauth-client-register': () => { called = true; return { code: 200, results: {} }; } }
    });
    const req = makePageReq({ method: 'POST', body: '{}', remoteAddress: 'register-source-2' });
    const res = makePageRes();
    await registerPage({ req, res, ctx });
    expect(res.code).to.equal(403);
    expect(res.body.error).to.equal('registration_disabled');
    expect(called).to.equal(false);
  });

  it('passes a failed event result through as a top-level error', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({
      oauth,
      resolvers: {
        'oauth-client-register': () => ({ code: 429, error: 'rate_limited' })
      }
    });
    const req = makePageReq({ method: 'POST', body: '{}', remoteAddress: 'register-source-3' });
    const res = makePageRes();
    await registerPage({ req, res, ctx });
    expect(res.code).to.equal(429);
    expect(res.body.error).to.equal('rate_limited');
  });

  it('refuses with 503 while unfinalized', async () => {
    const oauth = { ...makeOAuthPlugin(baseConfig()), finalized: false };
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({ method: 'POST', body: '{}', remoteAddress: 'register-source-4' });
    const res = makePageRes();
    await registerPage({ req, res, ctx });
    expect(res.code).to.equal(503);
  });

  it('rejects a disallowed Origin with 403', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({
      method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' },
      remoteAddress: 'register-source-5'
    });
    const res = makePageRes();
    await registerPage({ req, res, ctx });
    expect(res.code).to.equal(403);
  });

  it('handles an OPTIONS preflight without requiring a bearer key', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({ method: 'OPTIONS', remoteAddress: 'register-source-6' });
    const res = makePageRes();
    await registerPage({ req, res, ctx });
    expect(res.code).to.equal(204);
  });
});
