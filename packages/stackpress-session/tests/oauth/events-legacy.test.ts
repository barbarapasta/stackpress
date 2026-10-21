import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import { makeReq, makeRes, makeCtx, makeOAuthPlugin } from './events-helpers.js';

import legacyBind from '../../src/oauth/events/legacyBind.js';
import legacyVerify from '../../src/oauth/events/legacyVerify.js';

//task 00008 (storage.md "Upgrade Existing MCP Keys Explicitly"): these
//two events are API's only way to create/check an OAuthLegacyBinding row
//(OAuthStore's hashing/storage stays private to session). Exercised here
//against a real PGlite-backed OAuthStore, independent of task 00005's
//store.test.ts/store-adapters.test.ts (not edited by this task).
describe('OAuth legacy binding events (PGlite, real OAuthStore)', () => {
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

  function baseConfig() {
    return normalizeOAuthConfig({
      issuer: 'https://example.com',
      resources: [{
        resource: 'https://example.com/mcp',
        name: 'Example', description: 'desc',
        scopes: [ 'articles:read' ]
      }],
      scopes: { 'articles:read': { name: 'Read', description: 'Read' } },
      policy: { approval: 'approval-event', access: 'access-event' }
    });
  }

  function ctxFor() {
    const oauth = makeOAuthPlugin(baseConfig());
    return makeCtx({ oauth, database: engine });
  }

  describe('oauth-legacy-bind', () => {
    it('rejects a malformed request', async () => {
      const ctx = ctxFor();
      const req = makeReq({ kind: 'app' });
      const res = makeRes();
      await legacyBind({ req, res, ctx });
      expect(res.code).to.equal(400);
    });

    it('rejects a legacy ID that collides with the oauth_ namespace', async () => {
      const ctx = ctxFor();
      const req = makeReq({
        kind: 'app', legacyId: 'oauth_not-a-legacy-id',
        incarnation: 'incarnation-1', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await legacyBind({ req, res, ctx });
      expect(res.code).to.equal(200);
      expect(res.body).to.deep.equal({ bound: false, reason: 'namespace_conflict' });
    });

    it('binds a valid legacy record', async () => {
      const ctx = ctxFor();
      const req = makeReq({
        kind: 'app', legacyId: 'app-legacy-1',
        incarnation: '2026-01-01T00:00:00.000Z', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await legacyBind({ req, res, ctx });
      expect(res.code).to.equal(200);
      expect(res.body).to.deep.equal({ bound: true });
    });

    it('is repeatable: binding the same record again reactivates it', async () => {
      const ctx = ctxFor();
      const req = makeReq({
        kind: 'session', legacyId: 'session-legacy-1',
        incarnation: 'incarnation-A', resource: 'https://example.com/mcp'
      });
      const res1 = makeRes();
      await legacyBind({ req, res: res1, ctx });
      expect(res1.body).to.deep.equal({ bound: true });
      const res2 = makeRes();
      await legacyBind({ req, res: res2, ctx });
      expect(res2.body).to.deep.equal({ bound: true });
    });

    it('rejects a recreated ID reusing the same legacy ID with a different incarnation', async () => {
      const ctx = ctxFor();
      const first = makeReq({
        kind: 'app', legacyId: 'app-recreated',
        incarnation: 'incarnation-old', resource: 'https://example.com/mcp'
      });
      await legacyBind({ req: first, res: makeRes(), ctx });

      const second = makeReq({
        kind: 'app', legacyId: 'app-recreated',
        incarnation: 'incarnation-new', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await legacyBind({ req: second, res, ctx });
      expect(res.body).to.deep.equal({ bound: false, reason: 'incarnation_mismatch' });
    });
  });

  describe('oauth-legacy-verify', () => {
    it('rejects a malformed request', async () => {
      const ctx = ctxFor();
      const req = makeReq({ kind: 'app' });
      const res = makeRes();
      await legacyVerify({ req, res, ctx });
      expect(res.code).to.equal(400);
    });

    it('reports inactive for an unbound record', async () => {
      const ctx = ctxFor();
      const req = makeReq({
        kind: 'app', legacyId: 'never-bound',
        incarnation: 'x', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await legacyVerify({ req, res, ctx });
      expect(res.code).to.equal(200);
      expect(res.body).to.deep.equal({ active: false });
    });

    it('reports active for a freshly bound record', async () => {
      const ctx = ctxFor();
      const bindReq = makeReq({
        kind: 'app', legacyId: 'app-verify-1',
        incarnation: 'incarnation-v1', resource: 'https://example.com/mcp'
      });
      await legacyBind({ req: bindReq, res: makeRes(), ctx });

      const verifyReq = makeReq({
        kind: 'app', legacyId: 'app-verify-1',
        incarnation: 'incarnation-v1', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await legacyVerify({ req: verifyReq, res, ctx });
      expect(res.body).to.deep.equal({ active: true });
    });

    it('reports inactive when the incarnation no longer matches (recreated record)', async () => {
      const ctx = ctxFor();
      const bindReq = makeReq({
        kind: 'session', legacyId: 'session-verify-1',
        incarnation: 'incarnation-v1', resource: 'https://example.com/mcp'
      });
      await legacyBind({ req: bindReq, res: makeRes(), ctx });

      const verifyReq = makeReq({
        kind: 'session', legacyId: 'session-verify-1',
        incarnation: 'incarnation-v2-recreated', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await legacyVerify({ req: verifyReq, res, ctx });
      expect(res.body).to.deep.equal({ active: false });
    });

    it('reports inactive for the wrong resource', async () => {
      const ctx = ctxFor();
      const bindReq = makeReq({
        kind: 'app', legacyId: 'app-wrong-resource',
        incarnation: 'incarnation-v1', resource: 'https://example.com/mcp'
      });
      await legacyBind({ req: bindReq, res: makeRes(), ctx });

      const verifyReq = makeReq({
        kind: 'app', legacyId: 'app-wrong-resource',
        incarnation: 'incarnation-v1', resource: 'https://example.com/other'
      });
      const res = makeRes();
      await legacyVerify({ req: verifyReq, res, ctx });
      expect(res.body).to.deep.equal({ active: false });
    });

    it('reports inactive for a namespace-colliding legacy ID', async () => {
      const ctx = ctxFor();
      const req = makeReq({
        kind: 'app', legacyId: 'oauth_fake',
        incarnation: 'x', resource: 'https://example.com/mcp'
      });
      const res = makeRes();
      await legacyVerify({ req, res, ctx });
      expect(res.body).to.deep.equal({ active: false });
    });
  });
});
