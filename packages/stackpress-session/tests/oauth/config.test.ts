import { describe, it } from 'mocha';
import { expect } from 'chai';
import normalizeOAuthConfig from '../../src/oauth/config.js';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    issuer: 'https://example.com',
    resources: [{
      resource: 'https://example.com/mcp',
      name: 'Example service',
      description: 'Tools and approved API operations',
      scopes: [ 'articles:read', 'articles:write' ]
    }],
    scopes: {
      'articles:read': { name: 'Read articles', description: 'Read your articles' },
      'articles:write': { name: 'Change articles', description: 'Change your articles' }
    },
    policy: {
      approval: 'example-oauth-approval',
      access: 'example-oauth-access'
    },
    ...overrides
  };
}

describe('session/oauth/config', () => {
  it('should normalize a minimal valid config with documented defaults', () => {
    const config = normalizeOAuthConfig(baseConfig());
    expect(config.issuer).to.equal('https://example.com');
    expect(config.base).to.equal('/auth/oauth2');
    expect(config.accessSeconds).to.equal(900);
    expect(config.renewalSeconds).to.equal(604800);
    expect(config.codeSeconds).to.equal(60);
    expect(config.pendingSeconds).to.equal(600);
    expect(config.policy.timeoutMs).to.equal(5000);
    expect(config.registration.enabled).to.equal(true);
    expect(config.registration.bodyBytes).to.equal(16384);
    expect(config.registration.redirects).to.equal(10);
    expect(config.registration.unusedSeconds).to.equal(86400);
    expect(config.registration.maxUnused).to.equal(10000);
    expect(config.clientMetadata.timeoutMs).to.equal(5000);
    expect(config.clientMetadata.bodyBytes).to.equal(5120);
    expect(config.clientMetadata.maxEntries).to.equal(1000);
    expect(config.clientMetadata.maxAgeSeconds).to.equal(3600);
    expect(config.limits.windowSeconds).to.equal(60);
    expect(config.limits.registration).to.equal(10);
    expect(config.limits.authorization).to.equal(30);
    expect(config.limits.token).to.equal(60);
    expect(config.limits.factor.attempts).to.equal(5);
    expect(config.limits.factor.source).to.equal(20);
    expect(config.limits.clientMetadata).to.equal(30);
    expect(config.browserOrigins).to.deep.equal([]);
    expect(config.development).to.equal(false);
    expect(config.clients.allowed).to.equal(undefined);
  });

  it('should reject a non-object config', () => {
    expect(() => normalizeOAuthConfig(undefined)).to.throw(/must be an object/);
    expect(() => normalizeOAuthConfig('nope')).to.throw(/must be an object/);
    expect(() => normalizeOAuthConfig([])).to.throw(/must be an object/);
  });

  it('should reject a non-boolean development flag', () => {
    expect(() => normalizeOAuthConfig(baseConfig({ development: 'yes' })))
      .to.throw(/development must be a boolean/);
  });

  describe('issuer', () => {
    it('should require an absolute URL', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ issuer: 'not a url' })))
        .to.throw(/issuer must be an absolute URL/);
    });

    it('should require issuer to be present', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ issuer: undefined })))
        .to.throw(/issuer is required/);
    });

    it('should reject credentials in the issuer', () => {
      expect(() => normalizeOAuthConfig(
        baseConfig({ issuer: 'https://user:pass@example.com' })
      )).to.throw(/must not contain credentials/);
    });

    it('should reject a query string in the issuer', () => {
      expect(() => normalizeOAuthConfig(
        baseConfig({ issuer: 'https://example.com?x=1' })
      )).to.throw(/must not contain a query string/);
    });

    it('should reject a fragment in the issuer', () => {
      expect(() => normalizeOAuthConfig(
        baseConfig({ issuer: 'https://example.com#x' })
      )).to.throw(/must not contain a fragment/);
    });

    it('should reject a non-HTTPS issuer by default', () => {
      expect(() => normalizeOAuthConfig(
        baseConfig({ issuer: 'http://example.com' })
      )).to.throw(/must be HTTPS/);
    });

    it('should allow HTTP issuer on loopback only in development mode', () => {
      const config = normalizeOAuthConfig(baseConfig({
        issuer: 'http://localhost:3000',
        development: true,
        resources: [{
          resource: 'http://localhost:3000/mcp',
          name: 'Example service',
          description: 'desc',
          scopes: [ 'articles:read' ]
        }]
      }));
      expect(config.issuer).to.equal('http://localhost:3000');
    });

    it('should reject HTTP issuer on a non-loopback host even in development mode', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        issuer: 'http://example.com',
        development: true
      }))).to.throw(/must be HTTPS/);
    });
  });

  describe('base', () => {
    it('should reject a non-string or relative base', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ base: 'auth/oauth2' })))
        .to.throw(/base must be an absolute application path/);
    });

    it('should reject reusing the existing API OAuth base', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ base: '/auth/oauth' })))
        .to.throw(/separate from the existing API OAuth routes/);
    });

    it('should accept a custom base', () => {
      const config = normalizeOAuthConfig(baseConfig({ base: '/oauth2' }));
      expect(config.base).to.equal('/oauth2');
    });
  });

  describe('scopes', () => {
    it('should require scopes to be an object', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ scopes: undefined })))
        .to.throw(/scopes must be an object/);
    });

    it('should reject a scope name that breaks the scope-token grammar', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        scopes: { 'bad scope': { name: 'x', description: 'y' } }
      }))).to.throw(/does not follow OAuth scope-token grammar/);
    });

    it('should require a name and description on every scope', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        scopes: { 'articles:read': { name: '', description: 'y' } }
      }))).to.throw(/must declare a name and description/);
    });
  });

  describe('resources', () => {
    it('should require a non-empty list', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ resources: [] })))
        .to.throw(/resources must be a non-empty list/);
      expect(() => normalizeOAuthConfig(baseConfig({ resources: undefined })))
        .to.throw(/resources must be a non-empty list/);
    });

    it('should reject a non-object resource entry', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ resources: [ 'nope' ] })))
        .to.throw(/each resource must be an object/);
    });

    it('should reject duplicate resource URLs', () => {
      const resource = {
        resource: 'https://example.com/mcp',
        name: 'Example service',
        description: 'desc',
        scopes: [ 'articles:read' ]
      };
      expect(() => normalizeOAuthConfig(baseConfig({
        resources: [ resource, { ...resource } ]
      }))).to.throw(/duplicate resource URL/);
    });

    it('should require a name and description', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        resources: [{
          resource: 'https://example.com/mcp',
          description: 'desc',
          scopes: [ 'articles:read' ]
        }]
      }))).to.throw(/resources\[\]\.name is required/);
      expect(() => normalizeOAuthConfig(baseConfig({
        resources: [{
          resource: 'https://example.com/mcp',
          name: 'Example service',
          scopes: [ 'articles:read' ]
        }]
      }))).to.throw(/resources\[\]\.description is required/);
    });

    it('should require at least one scope', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        resources: [{
          resource: 'https://example.com/mcp',
          name: 'Example service',
          description: 'desc',
          scopes: []
        }]
      }))).to.throw(/must declare at least one scope/);
    });

    it('should reject an unknown scope reference', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        resources: [{
          resource: 'https://example.com/mcp',
          name: 'Example service',
          description: 'desc',
          scopes: [ 'articles:delete' ]
        }]
      }))).to.throw(/references unknown scope/);
    });

    it('should reject a duplicate scope on one resource', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        resources: [{
          resource: 'https://example.com/mcp',
          name: 'Example service',
          description: 'desc',
          scopes: [ 'articles:read', 'articles:read' ]
        }]
      }))).to.throw(/declares duplicate scope/);
    });
  });

  describe('policy', () => {
    it('should require the policy object', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ policy: undefined })))
        .to.throw(/policy is required/);
    });

    it('should require policy.approval', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        policy: { access: 'x' }
      }))).to.throw(/policy.approval must name a registered app event/);
    });

    it('should require policy.access', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        policy: { approval: 'x' }
      }))).to.throw(/policy.access must name a registered app event/);
    });

    it('should reject an invalid policy.timeoutMs', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        policy: {
          approval: 'a', access: 'b', timeoutMs: -1
        }
      }))).to.throw(/policy.timeoutMs must be an integer/);
    });
  });

  describe('clients', () => {
    it('should accept an omitted allowed list', () => {
      const config = normalizeOAuthConfig(baseConfig());
      expect(config.clients.allowed).to.equal(undefined);
    });

    it('should accept an empty allowed list, denying all clients', () => {
      const config = normalizeOAuthConfig(baseConfig({
        clients: { allowed: [] }
      }));
      expect(config.clients.allowed).to.deep.equal([]);
    });

    it('should reject a non-array allowed list', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        clients: { allowed: 'nope' }
      }))).to.throw(/clients.allowed must be a list/);
    });

    it('should reject a non-string entry', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        clients: { allowed: [ 1 ] }
      }))).to.throw(/entries must be non-empty strings/);
    });

    it('should reject a duplicate client ID', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        clients: { allowed: [ 'a', 'a' ] }
      }))).to.throw(/duplicate client ID/);
    });

    it('should reject a non-object clients setting', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ clients: 'nope' })))
        .to.throw(/clients must be an object/);
    });
  });

  describe('registration', () => {
    it('should reject a non-object registration setting', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ registration: 'nope' })))
        .to.throw(/registration must be an object/);
    });

    it('should reject a non-boolean enabled flag', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        registration: { enabled: 'yes' }
      }))).to.throw(/registration.enabled must be a boolean/);
    });

    it('should reject an unlimited bodyBytes value', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        registration: { bodyBytes: 0 }
      }))).to.throw(/registration.bodyBytes must be an integer/);
      expect(() => normalizeOAuthConfig(baseConfig({
        registration: { bodyBytes: Infinity }
      }))).to.throw(/registration.bodyBytes must be an integer/);
    });

    it('should accept explicit registration overrides', () => {
      const config = normalizeOAuthConfig(baseConfig({
        registration: {
          enabled: false,
          bodyBytes: 8192,
          redirects: 3,
          unusedSeconds: 100,
          maxUnused: 5
        }
      }));
      expect(config.registration).to.deep.equal({
        enabled: false,
        bodyBytes: 8192,
        redirects: 3,
        unusedSeconds: 100,
        maxUnused: 5
      });
    });
  });

  describe('clientMetadata', () => {
    it('should reject a non-object setting', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ clientMetadata: 'nope' })))
        .to.throw(/clientMetadata must be an object/);
    });

    it('should reject an invalid maxAgeSeconds', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        clientMetadata: { maxAgeSeconds: -5 }
      }))).to.throw(/clientMetadata.maxAgeSeconds must be an integer/);
    });
  });

  describe('limits', () => {
    it('should reject a non-object limits setting', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ limits: 'nope' })))
        .to.throw(/limits must be an object/);
    });

    it('should reject a non-object limits.factor setting', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        limits: { factor: 'nope' }
      }))).to.throw(/limits.factor must be an object/);
    });

    it('should accept explicit factor limit overrides', () => {
      const config = normalizeOAuthConfig(baseConfig({
        limits: { factor: { attempts: 2, source: 4 } }
      }));
      expect(config.limits.factor).to.deep.equal({ attempts: 2, source: 4 });
    });

    it('should reject an out-of-range limit', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        limits: { windowSeconds: 2 ** 32 }
      }))).to.throw(/limits.windowSeconds must be an integer/);
    });
  });

  describe('durations', () => {
    it('should enforce the codeSeconds range', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ codeSeconds: 0 })))
        .to.throw(/codeSeconds must be an integer between 1 and 600/);
      expect(() => normalizeOAuthConfig(baseConfig({ codeSeconds: 601 })))
        .to.throw(/codeSeconds must be an integer between 1 and 600/);
    });

    it('should enforce the pendingSeconds range', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ pendingSeconds: 0 })))
        .to.throw(/pendingSeconds must be an integer between 1 and 1800/);
      expect(() => normalizeOAuthConfig(baseConfig({ pendingSeconds: 1801 })))
        .to.throw(/pendingSeconds must be an integer between 1 and 1800/);
    });

    it('should accept overridden accessSeconds and renewalSeconds', () => {
      const config = normalizeOAuthConfig(baseConfig({
        accessSeconds: 60,
        renewalSeconds: 3600
      }));
      expect(config.accessSeconds).to.equal(60);
      expect(config.renewalSeconds).to.equal(3600);
    });

    it('should reject a non-integer duration', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ accessSeconds: 1.5 })))
        .to.throw(/accessSeconds must be an integer/);
    });
  });

  describe('browserOrigins', () => {
    it('should reject a non-array value', () => {
      expect(() => normalizeOAuthConfig(baseConfig({ browserOrigins: 'nope' })))
        .to.throw(/browserOrigins must be a list of origins/);
    });

    it('should reject an origin with a path', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        browserOrigins: [ 'https://client.example.com/app' ]
      }))).to.throw(/must not contain a path/);
    });

    it('should reject a malformed origin', () => {
      expect(() => normalizeOAuthConfig(baseConfig({
        browserOrigins: [ 'not a url' ]
      }))).to.throw(/must be a valid origin/);
    });

    it('should accept a list of bare origins', () => {
      const config = normalizeOAuthConfig(baseConfig({
        browserOrigins: [ 'https://client.example.com' ]
      }));
      expect(config.browserOrigins).to.deep.equal([
        'https://client.example.com'
      ]);
    });
  });
});
