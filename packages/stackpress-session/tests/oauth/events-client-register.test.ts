import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeReq, makeRes, makeCtx, makeOAuthPlugin } from './events-helpers.js';
import clientRegister from '../../src/oauth/events/clientRegister.js';

describe('oauth-client-register (PGlite, real OAuthStore)', () => {
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

  it('registers a public client and returns the fixed registration shape, never a secret', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const body = Buffer.from(JSON.stringify({
      redirect_uris: [ 'https://new-client.example/callback' ]
    }), 'utf8');
    const req = makeReq({ body, source: '203.0.113.5' });
    const res = makeRes();
    await clientRegister({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.client_id).to.be.a('string');
    expect(res.body.redirect_uris).to.deep.equal([ 'https://new-client.example/callback' ]);
    expect(res.body.grant_types).to.deep.equal([ 'authorization_code' ]);
    expect(res.body.response_types).to.deep.equal([ 'code' ]);
    expect(res.body.token_endpoint_auth_method).to.equal('none');
    expect(Object.keys(res.body)).to.not.include('client_secret');
  });

  it('refuses registration once registration.enabled is false', async () => {
    const config = baseConfig({ registration: { enabled: false } });
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const body = Buffer.from(JSON.stringify({
      redirect_uris: [ 'https://new-client.example/callback' ]
    }), 'utf8');
    const req = makeReq({ body, source: '203.0.113.6' });
    const res = makeRes();
    await clientRegister({ req, res, ctx });
    expect(res.code).to.equal(403);
    expect(res.body.error).to.equal('registration_disabled');
  });

  it('rejects a malformed registration body', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq({ body: Buffer.from('not json', 'utf8'), source: '203.0.113.7' });
    const res = makeRes();
    await clientRegister({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_client');
  });

  it('enforces the configured registration rate limit per issuer and source', async () => {
    const config = baseConfig({ limits: { registration: 1 } });
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const body = Buffer.from(JSON.stringify({
      redirect_uris: [ 'https://rate-limited.example/callback' ]
    }), 'utf8');

    const firstReq = makeReq({ body, source: 'rate-limit-source-register' });
    const firstRes = makeRes();
    await clientRegister({ req: firstReq, res: firstRes, ctx });
    expect(firstRes.code).to.equal(200);

    const secondReq = makeReq({ body, source: 'rate-limit-source-register' });
    const secondRes = makeRes();
    await clientRegister({ req: secondReq, res: secondRes, ctx });
    expect(secondRes.code).to.equal(429);
    expect(secondRes.body.error).to.equal('rate_limited');
  });
});
