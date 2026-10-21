import { describe, it } from 'mocha';
import { expect } from 'chai';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeOAuthPlugin } from './events-helpers.js';
import { makePageReq, makePageRes, makePageCtx } from './pages-test-helpers.js';
import { issuerMetadata, resourceMetadata } from '../../src/oauth/pages/discovery.js';

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

describe('OAuth pages/discovery issuerMetadata', () => {
  it('serves the issuer metadata document', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({});
    const res = makePageRes();
    await issuerMetadata({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.issuer).to.equal('https://example.com');
  });

  it('ignores spoofed Host/X-Forwarded-* headers: the served issuer is always the configured one', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({
      headers: {
        Host: 'evil.example', 'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'http'
      }
    });
    const res = makePageRes();
    await issuerMetadata({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.issuer).to.equal('https://example.com');
    expect(res.body.token_endpoint).to.equal('https://example.com/auth/oauth2/token');
  });

  it('refuses with 503 while unfinalized', async () => {
    const oauth = { ...makeOAuthPlugin(baseConfig()), finalized: false };
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({});
    const res = makePageRes();
    await issuerMetadata({ req, res, ctx });
    expect(res.code).to.equal(503);
  });
});

describe('OAuth pages/discovery resourceMetadata', () => {
  it('serves the metadata for one named resource', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({});
    const res = makePageRes();
    const handler = resourceMetadata('https://example.com/mcp');
    await handler({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.resource).to.equal('https://example.com/mcp');
  });

  it('serves the sole configured resource at the unambiguous root alias', async () => {
    const oauth = makeOAuthPlugin(baseConfig());
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({});
    const res = makePageRes();
    const handler = resourceMetadata();
    await handler({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.resource).to.equal('https://example.com/mcp');
  });

  it('refuses the root alias as ambiguous when more than one resource is configured', async () => {
    const config = normalizeOAuthConfig({
      issuer: 'https://example.com',
      resources: [
        { resource: 'https://example.com/mcp', name: 'A', description: 'a', scopes: [ 'articles:read' ] },
        { resource: 'https://example.com/other', name: 'B', description: 'b', scopes: [ 'articles:read' ] }
      ],
      scopes: { 'articles:read': { name: 'Read', description: 'Read' } },
      policy: { approval: 'approval-event', access: 'access-event' }
    });
    const oauth = makeOAuthPlugin(config);
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({});
    const res = makePageRes();
    const handler = resourceMetadata();
    await handler({ req, res, ctx });
    expect(res.code).to.equal(404);
    expect(res.body.error).to.equal('invalid_target');
  });

  it('refuses with 503 while unfinalized', async () => {
    const oauth = { ...makeOAuthPlugin(baseConfig()), finalized: false };
    const ctx = makePageCtx({ oauth });
    const req = makePageReq({});
    const res = makePageRes();
    const handler = resourceMetadata('https://example.com/mcp');
    await handler({ req, res, ctx });
    expect(res.code).to.equal(503);
  });
});
