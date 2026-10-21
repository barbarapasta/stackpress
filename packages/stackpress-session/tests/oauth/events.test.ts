import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { hashWithDomain, newPendingBinding, splitFullKey } from '../../src/oauth/storage/ids.js';
import { computeS256Challenge } from '../../src/oauth/pkce.js';
import { createFactorReceipt } from '../../src/oauth/factor.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeReq, makeRes, makeCtx, makeOAuthPlugin } from './events-helpers.js';

import authorize from '../../src/oauth/events/authorize.js';
import codeExchange from '../../src/oauth/events/codeExchange.js';
import refresh from '../../src/oauth/events/refresh.js';
import tokenVerify from '../../src/oauth/events/tokenVerify.js';
import revoke from '../../src/oauth/events/revoke.js';
import grantsList from '../../src/oauth/events/grantsList.js';
import grantRevoke from '../../src/oauth/events/grantRevoke.js';
import cleanup from '../../src/oauth/events/cleanup.js';

describe('OAuth fixed events (PGlite, real OAuthStore)', () => {
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine = new Engine(connection);
  const store = new OAuthStore(engine);

  const CODE_VERIFIER = 'a-real-verifier-with-enough-entropy-0123456789';
  const CODE_CHALLENGE = computeS256Challenge(CODE_VERIFIER);
  const SEED = 'test-seed';

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
        scopes: [ 'articles:read', 'articles:write' ]
      }],
      scopes: {
        'articles:read': { name: 'Read', description: 'Read' },
        'articles:write': { name: 'Write', description: 'Write' }
      },
      policy: { approval: 'approval-event', access: 'access-event', timeoutMs: 1000 },
      accessSeconds: 900,
      renewalSeconds: 604_800,
      codeSeconds: 60,
      ...overrides
    });
  }

  function activeProfileResolver(id = 'profile-1', roles: string[] = []) {
    return () => ({ code: 200, results: { id, roles, active: true } });
  }

  function allowAccess(scopes?: string[]) {
    return () => ({ code: 200, results: { allowed: true, ...(scopes ? { scopes } : {}) } });
  }

  async function createApprovedGrant(config: ReturnType<typeof baseConfig>, opts: {
    clientId?: string, scopes?: string[], operationFingerprints?: string[]
  } = {}) {
    const clientId = opts.clientId || 'client-1';
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: CODE_CHALLENGE,
      resource: 'https://example.com/mcp',
      scopes: opts.scopes || [ 'articles:read' ],
      operations: [],
      expires: new Date(Date.now() + 600_000)
    });
    const { grant, code } = await store.approvePending({
      pendingId: pending.id,
      profileId: 'profile-1',
      approvedScopes: opts.scopes || [ 'articles:read' ],
      approvedOperations: [],
      operationFingerprints: opts.operationFingerprints || [],
      accessSeconds: config.accessSeconds,
      renewalSeconds: config.renewalSeconds,
      codeSeconds: config.codeSeconds
    });
    return { pending, grant, code, clientId };
  }

  describe('oauth-code-exchange / oauth-refresh / oauth-token-verify', () => {
    it('exchanges a code for a real access+refresh key, then verifies and refreshes it', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: {
          'profile-detail': activeProfileResolver(),
          'access-event': allowAccess()
        }
      });
      const { grant, code, clientId } = await createApprovedGrant(config);

      const exchangeReq = makeReq({
        client_id: clientId, code, redirect_uri: 'https://client.example/callback',
        code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
      });
      const exchangeRes = makeRes();
      await codeExchange({ req: exchangeReq, res: exchangeRes, ctx });
      expect(exchangeRes.code).to.equal(200);
      const token = exchangeRes.body;
      expect(token.token_type).to.equal('Bearer');
      expect(token.access_token).to.be.a('string');
      expect(token.refresh_token).to.be.a('string');

      const verifyReq = makeReq({
        token: token.access_token, resource: 'https://example.com/mcp',
        surface: 'api', method: 'GET', requiredCredential: 'full'
      });
      const verifyRes = makeRes();
      await tokenVerify({ req: verifyReq, res: verifyRes, ctx });
      expect(verifyRes.code).to.equal(200);
      expect(verifyRes.body.grantId).to.equal(grant.id);
      expect(verifyRes.body.credential).to.equal('full');

      const refreshReq = makeReq({
        client_id: clientId, refresh_token: token.refresh_token,
        resource: 'https://example.com/mcp'
      });
      const refreshRes = makeRes();
      await refresh({ req: refreshReq, res: refreshRes, ctx });
      expect(refreshRes.code).to.equal(200);
      expect(refreshRes.body.access_token).to.not.equal(token.access_token);
    });

    it('rejects an unadmitted client before ever touching the code', async () => {
      const config = baseConfig({ clients: { allowed: [ 'only-this-client' ] } });
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });
      const { code, clientId } = await createApprovedGrant(config);
      const req = makeReq({
        client_id: clientId, code, redirect_uri: 'https://client.example/callback',
        code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await codeExchange({ req, res, ctx });
      expect(res.code).to.equal(400);
      expect(res.body.error).to.equal('invalid_client');
    });

    it('rejects an unknown/ambiguous resource with invalid_target', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });
      const { code, clientId } = await createApprovedGrant(config);
      const req = makeReq({
        client_id: clientId, code, redirect_uri: 'https://client.example/callback',
        code_verifier: CODE_VERIFIER, resource: 'https://not-configured.example/mcp'
      });
      const res = makeRes();
      await codeExchange({ req, res, ctx });
      expect(res.code).to.equal(400);
      expect(res.body.error).to.equal('invalid_target');
    });

    it('denies exchange when the access policy refuses', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: {
          'profile-detail': activeProfileResolver(),
          'access-event': () => ({ code: 200, results: { allowed: false } })
        }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const req = makeReq({
        client_id: clientId, code, redirect_uri: 'https://client.example/callback',
        code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await codeExchange({ req, res, ctx });
      expect(res.code).to.equal(400);
      expect(res.body.error).to.equal('invalid_grant');
    });

    it('denies exchange when the account is no longer active', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': () => ({ code: 200, results: { id: 'profile-1', roles: [], active: false } }) }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const req = makeReq({
        client_id: clientId, code, redirect_uri: 'https://client.example/callback',
        code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await codeExchange({ req, res, ctx });
      expect(res.code).to.equal(400);
      expect(res.body.error).to.equal('invalid_grant');
    });

    it('rejects a mismatched PKCE verifier', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const req = makeReq({
        client_id: clientId, code, redirect_uri: 'https://client.example/callback',
        code_verifier: 'wrong-verifier', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await codeExchange({ req, res, ctx });
      expect(res.code).to.equal(400);
      expect(res.body.error).to.equal('invalid_grant');
    });

    it('token-verify: a read-only ID cannot satisfy a required full credential', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });
      const split = splitFullKey(exchangeRes.body.access_token);
      const verifyRes = makeRes();
      await tokenVerify({
        req: makeReq({
          token: split!.id, resource: 'https://example.com/mcp',
          surface: 'api', method: 'POST', requiredCredential: 'full'
        }),
        res: verifyRes, ctx
      });
      expect(verifyRes.code).to.equal(401);
      expect(verifyRes.body.error).to.equal('invalid_token');

      const readVerifyRes = makeRes();
      await tokenVerify({
        req: makeReq({
          token: split!.id, resource: 'https://example.com/mcp',
          surface: 'mcp', method: 'GET', requiredCredential: 'read'
        }),
        res: readVerifyRes, ctx
      });
      expect(readVerifyRes.code).to.equal(200);
      expect(readVerifyRes.body.credential).to.equal('read');
    });

    it('token-verify: enforces API membership by fingerprint', async () => {
      const config = baseConfig();
      const apiOperations = new Map<string, { descriptor: unknown, fingerprint: string }>();
      apiOperations.set('articles.detail', { descriptor: {}, fingerprint: 'fp-articles-detail' });
      const oauth = makeOAuthPlugin(config, apiOperations);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config, {
        operationFingerprints: [ 'fp-articles-detail' ]
      });
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });

      const allowedRes = makeRes();
      await tokenVerify({
        req: makeReq({
          token: exchangeRes.body.access_token, resource: 'https://example.com/mcp',
          surface: 'api', method: 'GET', requiredCredential: 'full', operation: 'articles.detail'
        }),
        res: allowedRes, ctx
      });
      expect(allowedRes.code).to.equal(200);

      const deniedRes = makeRes();
      await tokenVerify({
        req: makeReq({
          token: exchangeRes.body.access_token, resource: 'https://example.com/mcp',
          surface: 'api', method: 'GET', requiredCredential: 'full', operation: 'articles.update'
        }),
        res: deniedRes, ctx
      });
      expect(deniedRes.code).to.equal(403);
      expect(deniedRes.body.error).to.equal('access_denied');
    });

    it('refresh: validates input, client admission, resource, and narrows scope', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });

      const missingRes = makeRes();
      await refresh({ req: makeReq({}), res: missingRes, ctx });
      expect(missingRes.code).to.equal(400);
      expect(missingRes.body.error).to.equal('invalid_request');

      const { code, clientId } = await createApprovedGrant(config, { scopes: [ 'articles:read', 'articles:write' ] });
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });

      const badClientRes = makeRes();
      await refresh({
        req: makeReq({ client_id: 'someone-else', refresh_token: exchangeRes.body.refresh_token }),
        res: badClientRes, ctx: makeCtx({ oauth: makeOAuthPlugin(baseConfig({ clients: { allowed: [ 'only-this' ] } })), database: engine })
      });
      expect(badClientRes.code).to.equal(400);
      expect(badClientRes.body.error).to.equal('invalid_client');

      const badResourceRes = makeRes();
      await refresh({
        req: makeReq({
          client_id: clientId, refresh_token: exchangeRes.body.refresh_token,
          resource: 'https://unknown.example/mcp'
        }),
        res: badResourceRes, ctx
      });
      expect(badResourceRes.code).to.equal(400);
      expect(badResourceRes.body.error).to.equal('invalid_target');

      const narrowedRes = makeRes();
      await refresh({
        req: makeReq({ client_id: clientId, refresh_token: exchangeRes.body.refresh_token, scope: 'articles:read' }),
        res: narrowedRes, ctx
      });
      expect(narrowedRes.code).to.equal(200);
      expect(narrowedRes.body.scope).to.equal('articles:read');
    });

    it('revoke: validates refresh-token-hint revocation and ends on an unexpected error', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { grant, code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });

      const hintRes = makeRes();
      await revoke({
        req: makeReq({
          client_id: clientId, token: exchangeRes.body.refresh_token, token_type_hint: 'refresh_token'
        }),
        res: hintRes, ctx
      });
      expect(hintRes.code).to.equal(200);
      const grants = await store.listGrantsForProfile('profile-1');
      expect(grants.find((g) => g.id === grant.id)).to.equal(undefined);

      const brokenCtx = makeCtx({ oauth: makeOAuthPlugin(config) }); //no database plugin registered
      const errorRes = makeRes();
      await revoke({ req: makeReq({ client_id: clientId, token: 'anything' }), res: errorRes, ctx: brokenCtx });
      expect(errorRes.code).to.equal(500);
      expect(errorRes.body.error).to.equal('server_error');
    });

    it('token-verify: rejects a malformed full key and a missing token', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });

      const emptyRes = makeRes();
      await tokenVerify({
        req: makeReq({ token: '', resource: 'https://example.com/mcp', surface: 'api', method: 'GET', requiredCredential: 'read' }),
        res: emptyRes, ctx
      });
      expect(emptyRes.code).to.equal(401);

      const malformedRes = makeRes();
      await tokenVerify({
        req: makeReq({ token: 'oauth_abc:def:ghi', resource: 'https://example.com/mcp', surface: 'api', method: 'GET', requiredCredential: 'full' }),
        res: malformedRes, ctx
      });
      expect(malformedRes.code).to.equal(401);

      const nonOAuthRes = makeRes();
      await tokenVerify({
        req: makeReq({ token: 'legacy_abc', resource: 'https://example.com/mcp', surface: 'api', method: 'GET', requiredCredential: 'read' }),
        res: nonOAuthRes, ctx
      });
      expect(nonOAuthRes.code).to.equal(401);
    });

    it('token-verify: a wrong secret does not downgrade to an ID-only read', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });
      const split = splitFullKey(exchangeRes.body.access_token)!;
      const wrongSecretRes = makeRes();
      await tokenVerify({
        req: makeReq({
          token: `${split.id}:wrong-secret`, resource: 'https://example.com/mcp',
          surface: 'api', method: 'GET', requiredCredential: 'read'
        }),
        res: wrongSecretRes, ctx
      });
      expect(wrongSecretRes.code).to.equal(401);
    });

    it('token-verify: denies when the access policy refuses verification', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });
      const denyCtx = makeCtx({
        oauth, database: engine,
        resolvers: {
          'profile-detail': activeProfileResolver(),
          'access-event': () => ({ code: 200, results: { allowed: false } })
        }
      });
      const res = makeRes();
      await tokenVerify({
        req: makeReq({
          token: exchangeRes.body.access_token, resource: 'https://example.com/mcp',
          surface: 'api', method: 'GET', requiredCredential: 'full'
        }),
        res, ctx: denyCtx
      });
      expect(res.code).to.equal(403);
      expect(res.body.error).to.equal('access_denied');
    });

    it('token-verify: rejects when the account is no longer active', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });
      const inactiveCtx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': () => ({ code: 200, results: { id: 'profile-1', roles: [], active: false } }) }
      });
      const res = makeRes();
      await tokenVerify({
        req: makeReq({
          token: exchangeRes.body.access_token, resource: 'https://example.com/mcp',
          surface: 'api', method: 'GET', requiredCredential: 'full'
        }),
        res, ctx: inactiveCtx
      });
      expect(res.code).to.equal(401);
    });

    it('token-verify: rejects a client that is no longer on the allowed list', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });
      const restrictedCtx = makeCtx({
        oauth: makeOAuthPlugin(baseConfig({ clients: { allowed: [ 'some-other-client' ] } })),
        database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const res = makeRes();
      await tokenVerify({
        req: makeReq({
          token: exchangeRes.body.access_token, resource: 'https://example.com/mcp',
          surface: 'api', method: 'GET', requiredCredential: 'full'
        }),
        res, ctx: restrictedCtx
      });
      expect(res.code).to.equal(401);
    });

    it('token-verify: rejects when the current account is no longer loadable', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });
      const missingProfileCtx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': () => ({ code: 404 }) }
      });
      const res = makeRes();
      await tokenVerify({
        req: makeReq({
          token: exchangeRes.body.access_token, resource: 'https://example.com/mcp',
          surface: 'api', method: 'GET', requiredCredential: 'full'
        }),
        res, ctx: missingProfileCtx
      });
      expect(res.code).to.equal(401);
    });

    it('token-verify: rejects an unknown token, a wrong resource, and a cancelled grant', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });

      const unknownRes = makeRes();
      await tokenVerify({
        req: makeReq({ token: 'oauth_unknown-id', resource: 'https://example.com/mcp', surface: 'api', method: 'GET', requiredCredential: 'read' }),
        res: unknownRes, ctx
      });
      expect(unknownRes.code).to.equal(401);

      const { grant, code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });

      const wrongResourceRes = makeRes();
      await tokenVerify({
        req: makeReq({ token: exchangeRes.body.access_token, resource: 'https://other.example/mcp', surface: 'api', method: 'GET', requiredCredential: 'full' }),
        res: wrongResourceRes, ctx
      });
      expect(wrongResourceRes.code).to.equal(401);

      await store.cancelGrant(grant.id);
      const cancelledRes = makeRes();
      await tokenVerify({
        req: makeReq({ token: exchangeRes.body.access_token, resource: 'https://example.com/mcp', surface: 'api', method: 'GET', requiredCredential: 'full' }),
        res: cancelledRes, ctx
      });
      expect(cancelledRes.code).to.equal(401);
    });
  });

  describe('oauth-revoke / oauth-grants-list / oauth-grant-revoke', () => {
    it('revoke: a wrong secret does not revoke; the right full key does', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: { 'profile-detail': activeProfileResolver(), 'access-event': allowAccess() }
      });
      const { grant, code, clientId } = await createApprovedGrant(config);
      const exchangeRes = makeRes();
      await codeExchange({
        req: makeReq({
          client_id: clientId, code, redirect_uri: 'https://client.example/callback',
          code_verifier: CODE_VERIFIER, resource: 'https://example.com/mcp'
        }),
        res: exchangeRes, ctx
      });
      const split = splitFullKey(exchangeRes.body.access_token)!;

      const wrongRes = makeRes();
      await revoke({
        req: makeReq({ client_id: clientId, token: `${split.id}:wrong-secret` }),
        res: wrongRes, ctx
      });
      expect(wrongRes.code).to.equal(200);
      let grants = await store.listGrantsForProfile('profile-1');
      expect(grants.find((g) => g.id === grant.id)).to.not.equal(undefined);

      const rightRes = makeRes();
      await revoke({ req: makeReq({ client_id: clientId, token: exchangeRes.body.access_token }), res: rightRes, ctx });
      expect(rightRes.code).to.equal(200);
      grants = await store.listGrantsForProfile('profile-1');
      expect(grants.find((g) => g.id === grant.id)).to.equal(undefined);
    });

    it('grants-list: returns a safe summary with membership labels, never hashes', async () => {
      const config = baseConfig();
      const apiOperations = new Map<string, { descriptor: unknown, fingerprint: string }>();
      apiOperations.set('articles.detail', { descriptor: {}, fingerprint: 'fp-list-1' });
      const oauth = makeOAuthPlugin(config, apiOperations);
      const ctx = makeCtx({ oauth, database: engine });
      const { grant } = await createApprovedGrant(config, { operationFingerprints: [ 'fp-list-1' ] });

      const res = makeRes();
      await grantsList({ req: makeReq({ profileId: 'profile-1' }), res, ctx });
      expect(res.code).to.equal(200);
      const item = res.body.find((g: any) => g.grantId === grant.id);
      expect(item).to.not.equal(undefined);
      expect(item.operations).to.deep.equal([ 'articles.detail' ]);
      expect(JSON.stringify(item)).to.not.include('Hash');
    });

    it('grant-revoke: owner can revoke; another profile gets invalid_grant without revealing the owner', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });
      const { grant } = await createApprovedGrant(config);

      const otherRes = makeRes();
      await grantRevoke({ req: makeReq({ profileId: 'someone-else', grantId: grant.id }), res: otherRes, ctx });
      expect(otherRes.code).to.equal(400);
      expect(otherRes.body.error).to.equal('invalid_grant');

      const ownRes = makeRes();
      await grantRevoke({ req: makeReq({ profileId: 'profile-1', grantId: grant.id }), res: ownRes, ctx });
      expect(ownRes.code).to.equal(200);
      expect(ownRes.body.revoked).to.equal(true);
    });
  });

  describe('oauth-cleanup', () => {
    it('removes expired records and reports counts, never raw keys', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });
      await store.createPending({
        id: `pending_cleanup_${Math.random().toString(36).slice(2)}`,
        bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        codeChallenge: CODE_CHALLENGE,
        resource: 'https://example.com/mcp',
        scopes: [], operations: [],
        expires: new Date(Date.now() - 1000)
      });
      const res = makeRes();
      await cleanup({ req: makeReq({ batchSize: 50 }), res, ctx });
      expect(res.code).to.equal(200);
      expect(res.body.removed).to.be.greaterThan(0);
      expect(JSON.stringify(res.body)).to.not.include('hash');
    });
  });

  describe('oauth-authorize', () => {
    async function freshPending(scopes: string[] = [ 'articles:read' ]) {
      return store.createPending({
        id: `pending_auth_${Math.random().toString(36).slice(2)}`,
        bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        codeChallenge: CODE_CHALLENGE,
        resource: 'https://example.com/mcp',
        scopes, operations: [],
        expires: new Date(Date.now() + 600_000)
      });
    }

    it('approves a request, consumes the pending row once, and redirects with a fresh code', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        resolvers: {
          'profile-detail': activeProfileResolver(),
          'approval-event': () => ({ code: 200, results: { allowed: true, scopes: [ 'articles:read' ], operations: [] } }),
          'auth-search': () => ({ code: 200, results: [] })
        }
      });
      const pending = await freshPending();
      const res = makeRes();
      await authorize({
        req: makeReq({ pending: pending.id, profileId: 'profile-1', scopes: [ 'articles:read' ], operations: [], approve: true }),
        res, ctx
      });
      expect(res.code).to.equal(200);
      const url = new URL(res.body.redirect);
      expect(url.searchParams.get('code')).to.be.a('string');
      expect(url.searchParams.get('iss')).to.equal('https://example.com');

      const duplicateRes = makeRes();
      await authorize({
        req: makeReq({ pending: pending.id, profileId: 'profile-1', scopes: [ 'articles:read' ], operations: [], approve: true }),
        res: duplicateRes, ctx
      });
      expect(duplicateRes.code).to.equal(409);
      expect(duplicateRes.body.error).to.equal('conflict');
    });

    it('denies a request and redirects with access_denied', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });
      const pending = await freshPending();
      const res = makeRes();
      await authorize({
        req: makeReq({ pending: pending.id, profileId: 'profile-1', scopes: [], operations: [], approve: false }),
        res, ctx
      });
      expect(res.code).to.equal(200);
      const url = new URL(res.body.redirect);
      expect(url.searchParams.get('error')).to.equal('access_denied');
    });

    it('rejects a hidden-input selection that is not a subset of the saved pending request', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });
      const pending = await freshPending([ 'articles:read' ]);
      const res = makeRes();
      await authorize({
        req: makeReq({
          pending: pending.id, profileId: 'profile-1',
          scopes: [ 'articles:read', 'articles:admin' ], operations: [], approve: true
        }),
        res, ctx
      });
      expect(res.code).to.equal(400);
      expect(res.body.error).to.equal('invalid_request');
    });

    it('requires a valid factor receipt when the approval policy asks for one', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({
        oauth, database: engine,
        configPaths: { 'session.seed': SEED },
        resolvers: {
          'profile-detail': activeProfileResolver(),
          'approval-event': () => ({
            code: 200,
            results: { allowed: true, scopes: [ 'articles:read' ], operations: [], requireFactor: true }
          }),
          'auth-search': () => ({ code: 200, results: [ { type: '2fa' } ] })
        }
      });
      const pending = await freshPending();

      const missingReceiptRes = makeRes();
      await authorize({
        req: makeReq({ pending: pending.id, profileId: 'profile-1', scopes: [ 'articles:read' ], operations: [], approve: true }),
        res: missingReceiptRes, ctx
      });
      expect(missingReceiptRes.code).to.equal(403);
      expect(missingReceiptRes.body.error).to.equal('access_denied');

      const receipt = createFactorReceipt(
        SEED,
        { profileId: 'profile-1', pendingId: pending.id, scopes: [ 'articles:read' ], operations: [] },
        pending.expires
      );
      const approvedRes = makeRes();
      await authorize({
        req: makeReq({
          pending: pending.id, profileId: 'profile-1', scopes: [ 'articles:read' ], operations: [],
          approve: true, factorReceipt: receipt
        }),
        res: approvedRes, ctx
      });
      expect(approvedRes.code).to.equal(200);
    });

    it('returns invalid_request for a missing or expired pending request', async () => {
      const config = baseConfig();
      const oauth = makeOAuthPlugin(config);
      const ctx = makeCtx({ oauth, database: engine });

      const missingRes = makeRes();
      await authorize({ req: makeReq({ pending: 'does-not-exist', profileId: 'profile-1', scopes: [], operations: [], approve: true }), res: missingRes, ctx });
      expect(missingRes.code).to.equal(400);

      const expired = await store.createPending({
        id: `pending_expired_${Math.random().toString(36).slice(2)}`,
        bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        codeChallenge: CODE_CHALLENGE,
        resource: 'https://example.com/mcp',
        scopes: [], operations: [],
        expires: new Date(Date.now() - 1000)
      });
      const expiredRes = makeRes();
      await authorize({ req: makeReq({ pending: expired.id, profileId: 'profile-1', scopes: [], operations: [], approve: true }), res: expiredRes, ctx });
      expect(expiredRes.code).to.equal(400);
    });
  });
});
