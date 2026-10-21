import { describe, it } from 'mocha';
import { expect } from 'chai';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeOAuthPlugin } from './events-helpers.js';
import { makePageReq, makePageRes, makePageCtx } from './pages-test-helpers.js';
import revokePage from '../../src/oauth/pages/revoke.js';

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

describe('OAuth pages/revoke', () => {
  it('translates a successful revoke into an empty top-level reply', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({
      oauth,
      resolvers: { 'oauth-revoke': () => ({ code: 200, results: {} }) }
    });
    const req = makePageReq({
      method: 'POST',
      post: { client_id: 'client-1', token: 'oauth_abc:secret' },
      remoteAddress: 'revoke-source-1'
    });
    const res = makePageRes();
    await revokePage({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body).to.deep.equal({});
  });

  it('rejects a missing required parameter', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({
      method: 'POST',
      post: { client_id: 'client-1' },
      remoteAddress: 'revoke-source-2'
    });
    const res = makePageRes();
    await revokePage({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_request');
  });

  it('rejects a duplicate form parameter', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({
      method: 'POST',
      post: { client_id: 'client-1', token: [ 'a', 'b' ] },
      remoteAddress: 'revoke-source-3'
    });
    const res = makePageRes();
    await revokePage({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_request');
  });

  it('refuses with 503 while unfinalized', async () => {
    const oauth = { ...makeOAuthPlugin(baseConfig()), finalized: false };
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({ method: 'POST', post: {}, remoteAddress: 'revoke-source-4' });
    const res = makePageRes();
    await revokePage({ req, res, ctx });
    expect(res.code).to.equal(503);
  });

  it('handles an OPTIONS preflight without requiring a bearer key', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({ method: 'OPTIONS', remoteAddress: 'revoke-source-5' });
    const res = makePageRes();
    await revokePage({ req, res, ctx });
    expect(res.code).to.equal(204);
  });
});
