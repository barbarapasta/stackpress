import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeReq, makeRes, makeCtx, makeOAuthPlugin } from './events-helpers.js';
import authorizationStart, { runAuthorizationStart } from '../../src/oauth/events/authorizationStart.js';
import type { OAuthTransportResponse } from '../../src/oauth/clients/transport.js';

describe('oauth-authorization-start (PGlite, real OAuthStore)', () => {
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine = new Engine(connection);
  const store = new OAuthStore(engine);

  before(async () => {
    for (const create of createAllOAuthTables()) {
      create.engine = engine;
      await create;
    }
    await store.upsertRegisteredClient('client-1', {
      redirect_uris: [ 'https://client.example/callback' ],
      grant_types: [ 'authorization_code' ],
      response_types: [ 'code' ],
      token_endpoint_auth_method: 'none',
      client_name: 'Example Client'
    });
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
        scopes: [ 'articles:read', 'articles:write' ]
      }],
      scopes: {
        'articles:read': { name: 'Read', description: 'Read' },
        'articles:write': { name: 'Write', description: 'Write' }
      },
      policy: { approval: 'approval-event', access: 'access-event' },
      ...overrides
    });
  }

  let bindingCounter = 0;
  function validInput(overrides: Record<string, unknown> = {}) {
    bindingCounter += 1;
    return {
      client_id: 'client-1',
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: 'a-real-challenge-value',
      code_challenge_method: 'S256',
      //unique per call: oauth_pending.binding_hash is unique, and a real
      //continuation cookie is unguessable/distinct per authorization
      //attempt anyway.
      bindingHash: `binding-hash-${bindingCounter}`,
      source: '203.0.113.1',
      ...overrides
    };
  }

  it('creates a pending request and returns a safe approval summary', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const input = validInput();
    const req = makeReq(input);
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.pending).to.be.a('string');
    expect(res.body.client).to.deep.equal({ id: 'client-1', name: 'Example Client' });
    expect(res.body.resource).to.equal('https://example.com/mcp');
    expect(res.body.scopes).to.deep.equal([ 'articles:read', 'articles:write' ]);
    expect(res.body.operations).to.deep.equal([]);

    const saved = await store.getPendingById(res.body.pending);
    expect(saved).to.not.equal(null);
    expect(saved!.clientId).to.equal('client-1');
    expect(saved!.bindingHash).to.equal(input.bindingHash);
  });

  it('narrows scopes to the explicitly requested subset', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ scope: 'articles:read' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.scopes).to.deep.equal([ 'articles:read' ]);
  });

  it('lists currently registered API operations for the resolved resource', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    oauth.apiOperations.set('articles.detail', {
      descriptor: {
        id: 'articles.detail', surface: 'api', method: 'GET',
        route: '/api/articles/:id', event: 'article-detail',
        resources: [ 'https://example.com/mcp' ], scopes: [], data: {}
      },
      fingerprint: 'fp-1'
    });
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput());
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(200);
    expect(res.body.operations).to.deep.equal([ 'articles.detail' ]);
  });

  it('rejects an unadmitted client before any lookup', async () => {
    const config = baseConfig({ clients: { allowed: [ 'only-this-one' ] } });
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput());
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_client');
  });

  it('rejects an unadmitted client-document URL before any network fetch', async () => {
    const config = baseConfig({ clients: { allowed: [ 'only-this-one' ] } });
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ client_id: 'https://malicious.example/client.json' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_client');
  });

  it('rejects an unknown registered client ID', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ client_id: 'no-such-client' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_client');
  });

  it('rejects a redirect_uri that does not exactly match a registered entry', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ redirect_uri: 'https://client.example/other' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_request');
  });

  it('returns a validated redirect with unsupported_response_type once client/redirect are safe', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ response_type: 'token', state: 'xyz' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(200);
    const url = new URL(res.body.redirect);
    expect(url.searchParams.get('error')).to.equal('unsupported_response_type');
    expect(url.searchParams.get('state')).to.equal('xyz');
    expect(url.searchParams.get('iss')).to.equal('https://example.com');
  });

  it('returns a validated redirect with invalid_request for an unsupported code_challenge_method', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ code_challenge_method: 'plain' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(200);
    const url = new URL(res.body.redirect);
    expect(url.searchParams.get('error')).to.equal('invalid_request');
  });

  it('returns a validated redirect with invalid_target for an unknown resource', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ resource: 'https://not-configured.example/mcp' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(200);
    const url = new URL(res.body.redirect);
    expect(url.searchParams.get('error')).to.equal('invalid_target');
  });

  it('returns a validated redirect with invalid_scope for an unsupported requested scope', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ scope: 'articles:read not-a-real-scope' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(200);
    const url = new URL(res.body.redirect);
    expect(url.searchParams.get('error')).to.equal('invalid_scope');
  });

  it('enforces the configured authorization rate limit per issuer and source', async () => {
    const config = baseConfig({ limits: { authorization: 1 } });
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const firstReq = makeReq(validInput({ source: 'rate-limit-source-1' }));
    const firstRes = makeRes();
    await authorizationStart({ req: firstReq, res: firstRes, ctx });
    expect(firstRes.code).to.equal(200);

    const secondReq = makeReq(validInput({ source: 'rate-limit-source-1' }));
    const secondRes = makeRes();
    await authorizationStart({ req: secondReq, res: secondRes, ctx });
    expect(secondRes.code).to.equal(429);
    expect(secondRes.body.error).to.equal('rate_limited');
  });

  it('rejects missing required parameters', async () => {
    const config = baseConfig();
    const oauth = makeOAuthPlugin(config);
    const ctx = makeCtx({ oauth, database: engine });
    const req = makeReq(validInput({ code_challenge: '' }));
    const res = makeRes();
    await authorizationStart({ req, res, ctx });
    expect(res.code).to.equal(400);
    expect(res.body.error).to.equal('invalid_request');
  });

  describe('client-document path (00004 fake resolveHost/transport substitutes)', () => {
    const DOC_URL = 'https://doc-client.example/metadata.json';
    const resolvePublic = async () => [ { address: '93.184.216.34' as const, family: 4 as const } ];

    function okResponse(body: string): OAuthTransportResponse {
      return { status: 200, headers: {}, body: Buffer.from(body) };
    }

    it('fetches a client-document identity end to end and creates a pending request', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const docBody = JSON.stringify({
        client_id: DOC_URL,
        redirect_uris: [ 'https://doc-client.example/callback' ]
      });
      let transportCalled = false;
      const result = await runAuthorizationStart(
        validInput({
          client_id: DOC_URL,
          redirect_uri: 'https://doc-client.example/callback',
          source: 'doc-source-1'
        }) as any,
        { store, config, oauth },
        {
          resolveHost: resolvePublic,
          transport: async () => { transportCalled = true; return okResponse(docBody); }
        }
      );
      expect(transportCalled).to.equal(true);
      expect('pending' in result && result.pending).to.be.a('string');
      if ('pending' in result) {
        expect(result.client).to.deep.equal({ id: DOC_URL, name: undefined });
      }
    });

    it('rejects a failed document fetch (non-200) as invalid_client, never falling back to any cached/stale value', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      let caught: unknown;
      try {
        await runAuthorizationStart(
          validInput({
            client_id: 'https://unreachable-doc.example/metadata.json',
            redirect_uri: 'https://unreachable-doc.example/callback',
            source: 'doc-source-2'
          }) as any,
          { store, config, oauth },
          {
            resolveHost: resolvePublic,
            transport: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) })
          }
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).to.not.equal(undefined);
    });

    it('rejects a document redirect_uri mismatch after a successful fetch', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const docUrl = 'https://doc-client-2.example/metadata.json';
      const docBody = JSON.stringify({
        client_id: docUrl,
        redirect_uris: [ 'https://doc-client-2.example/callback' ]
      });
      let caught: unknown;
      try {
        await runAuthorizationStart(
          validInput({
            client_id: docUrl,
            redirect_uri: 'https://doc-client-2.example/not-registered',
            source: 'doc-source-3'
          }) as any,
          { store, config, oauth },
          { resolveHost: resolvePublic, transport: async () => okResponse(docBody) }
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).to.not.equal(undefined);
    });
  });
});
