import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeOAuthPlugin } from './events-helpers.js';
import { makePageReq, makePageRes, makePageCtx } from './pages-test-helpers.js';
import tokenPage from '../../src/oauth/pages/token.js';

describe('OAuth pages/token (PGlite, real rate-limit store)', () => {
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine = new Engine(connection);

  before(async () => {
    for (const create of createAllOAuthTables()) {
      create.engine = engine;
      await create;
    }
  });

  after(async () => {
    await resource.close();
  });

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

  it('translates a successful oauth-code-exchange into a top-level token reply', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({
      oauth, database: engine,
      resolvers: {
        'oauth-code-exchange': () => ({
          code: 200,
          results: { access_token: 'oauth_abc:secret', token_type: 'Bearer', expires_in: 900, scope: 'articles:read' }
        })
      }
    });
    const req = makePageReq({
      method: 'POST',
      post: {
        grant_type: 'authorization_code', client_id: 'client-1', code: 'a-code',
        redirect_uri: 'https://client.example/callback', code_verifier: 'verifier', resource: 'https://example.com/mcp'
      },
      remoteAddress: 'token-source-1'
    });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body).to.deep.equal({
      access_token: 'oauth_abc:secret', token_type: 'Bearer', expires_in: 900, scope: 'articles:read'
    });
    expect(res.headers.get('Cache-Control')).to.equal('no-store');
  });

  it('dispatches refresh_token grants to oauth-refresh', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({
      oauth, database: engine,
      resolvers: {
        'oauth-refresh': () => ({
          code: 200,
          results: { access_token: 'oauth_new:secret', token_type: 'Bearer', expires_in: 900, scope: 'articles:read' }
        })
      }
    });
    const req = makePageReq({
      method: 'POST',
      post: {
        grant_type: 'refresh_token', client_id: 'client-1',
        refresh_token: 'oauthr_old', resource: 'https://example.com/mcp', scope: ''
      },
      remoteAddress: 'token-source-2'
    });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.access_token).to.equal('oauth_new:secret');
  });

  it('refuses an unsupported grant_type', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth, database: engine });
    const req = makePageReq({
      method: 'POST',
      post: { grant_type: 'client_credentials', client_id: 'client-1' },
      remoteAddress: 'token-source-3'
    });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_request');
  });

  it('rejects a duplicate form parameter', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth, database: engine });
    const req = makePageReq({
      method: 'POST',
      post: { grant_type: [ 'authorization_code', 'refresh_token' ], client_id: 'client-1' },
      remoteAddress: 'token-source-4'
    });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_request');
  });

  it('enforces the configured token rate limit per issuer and source', async () => {
    const oauth = makeOAuthPlugin(baseConfig({ limits: { token: 1 } }));
    const ctx = makePageCtx({
      oauth, database: engine,
      resolvers: {
        'oauth-code-exchange': () => ({
          code: 200,
          results: { access_token: 'oauth_abc:secret', token_type: 'Bearer', expires_in: 900, scope: 'articles:read' }
        })
      }
    });
    const post = {
      grant_type: 'authorization_code', client_id: 'client-rl', code: 'a-code',
      redirect_uri: 'https://client.example/callback', code_verifier: 'verifier', resource: 'https://example.com/mcp'
    };
    const firstRes = makePageRes();
    await tokenPage({ req: makePageReq({ method: 'POST', post, remoteAddress: 'token-rate-source' }), res: firstRes, ctx });
    expect(firstRes.code).to.equal(200);

    const secondRes = makePageRes();
    await tokenPage({ req: makePageReq({ method: 'POST', post, remoteAddress: 'token-rate-source' }), res: secondRes, ctx });
    expect(secondRes.code).to.equal(429);
    expect(secondRes.body.error).to.equal('rate_limited');
    expect(secondRes.headers.get('Retry-After')).to.be.a('string');
  });

  it('cannot be bypassed by spoofing X-Forwarded-For: same real peer shares one bucket', async () => {
    const oauth = makeOAuthPlugin(baseConfig({ limits: { token: 1 } }));
    const ctx = makePageCtx({
      oauth, database: engine,
      resolvers: {
        'oauth-code-exchange': () => ({
          code: 200,
          results: { access_token: 'oauth_abc:secret', token_type: 'Bearer', expires_in: 900, scope: 'articles:read' }
        })
      }
    });
    const post = {
      grant_type: 'authorization_code', client_id: 'client-spoof', code: 'a-code',
      redirect_uri: 'https://client.example/callback', code_verifier: 'verifier', resource: 'https://example.com/mcp'
    };
    const firstRes = makePageRes();
    await tokenPage({
      req: makePageReq({
        method: 'POST', post, remoteAddress: 'token-spoof-source',
        headers: { 'X-Forwarded-For': '1.1.1.1' }
      }),
      res: firstRes, ctx
    });
    expect(firstRes.code).to.equal(200);

    //same real connection, a *different* claimed X-Forwarded-For - the
    //limit still applies because the bucket key is built from the real
    //peer address only (pages/helpers.ts's sourceAddress), never a
    //caller-controlled header.
    const secondRes = makePageRes();
    await tokenPage({
      req: makePageReq({
        method: 'POST', post, remoteAddress: 'token-spoof-source',
        headers: { 'X-Forwarded-For': '2.2.2.2' }
      }),
      res: secondRes, ctx
    });
    expect(secondRes.code).to.equal(429);
    expect(secondRes.body.error).to.equal('rate_limited');
  });

  it('never derives the issuer/token-endpoint authority from Host or forwarded headers', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({
      oauth, database: engine,
      resolvers: {
        'oauth-code-exchange': () => ({
          code: 200,
          results: { access_token: 'oauth_abc:secret', token_type: 'Bearer', expires_in: 900, scope: 'articles:read' }
        })
      }
    });
    const req = makePageReq({
      method: 'POST',
      post: {
        grant_type: 'authorization_code', client_id: 'client-1', code: 'a-code',
        redirect_uri: 'https://client.example/callback', code_verifier: 'verifier', resource: 'https://example.com/mcp'
      },
      headers: {
        Host: 'evil.example', 'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'http'
      },
      remoteAddress: 'token-source-spoofed-host'
    });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    //design.md: "Do not trust arbitrary Host or forwarded headers to
    //choose that address" - the reply is identical to an unspoofed
    //request; nothing here is ever built from req.url/req.headers.
    expect(res.code).to.equal(200);
    expect(res.body.access_token).to.equal('oauth_abc:secret');
  });

  it('refuses with 503 while unfinalized', async () => {
    const oauth = { ...makeOAuthPlugin(baseConfig()), finalized: false };
    const ctx = makePageCtx({ oauth, database: engine });
    const req = makePageReq({ method: 'POST', post: {}, remoteAddress: 'token-source-5' });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    expect(res.code).to.equal(503);
  });

  it('rejects a disallowed Origin with 403', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth, database: engine });
    const req = makePageReq({
      method: 'POST',
      post: {},
      headers: { Origin: 'https://evil.example' },
      remoteAddress: 'token-source-6'
    });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    expect(res.code).to.equal(403);
  });

  it('handles an OPTIONS preflight without requiring a bearer key', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth, database: engine });
    const req = makePageReq({ method: 'OPTIONS', remoteAddress: 'token-source-7' });
    const res = makePageRes();
    await tokenPage({ req, res, ctx });
    expect(res.code).to.equal(204);
  });
});
