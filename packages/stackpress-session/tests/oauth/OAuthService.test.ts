import { describe, it } from 'mocha';
import { expect } from 'chai';
import type Server from '@stackpress/ingest/Server';
import OAuthService, { canonicalize } from '../../src/oauth/OAuthService.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import type { NormalizedOAuthSessionConfig } from '../../src/oauth/types.js';

const REQUIRED_EVENTS = [
  'oauth-client-register',
  'oauth-authorization-start',
  'oauth-authorize',
  'oauth-code-exchange',
  'oauth-refresh',
  'oauth-token-verify',
  'oauth-revoke',
  'oauth-grants-list',
  'oauth-grant-revoke'
];

type StubOptions = {
  database?: boolean,
  listeners?: string[]
};

function createServerStub(options: StubOptions = {}) {
  const listeners: Record<string, Set<unknown>> = {};
  for (const name of options.listeners || []) {
    listeners[name] = new Set([ function noop() {} ]);
  }
  const plugins: Record<string, unknown> = {};
  if (options.database !== false) {
    plugins.database = {};
  }
  const stub = {
    listeners,
    plugin(name: string) {
      return plugins[name];
    },
    register(name: string, value: unknown) {
      plugins[name] = value;
      return stub;
    }
  };
  return stub as unknown as Server;
}

function baseConfig(): NormalizedOAuthSessionConfig {
  return normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: [{
      resource: 'https://example.com/mcp',
      name: 'Example service',
      description: 'desc',
      scopes: [ 'articles:read', 'articles:write' ]
    }],
    scopes: {
      'articles:read': { name: 'Read', description: 'Read articles' },
      'articles:write': { name: 'Write', description: 'Change articles' }
    },
    policy: { approval: 'approval-event', access: 'access-event' }
  });
}

describe('session/oauth/OAuthService', () => {
  describe('canonicalize', () => {
    it('should sort object keys but keep array order', () => {
      const a = canonicalize({ b: 1, a: [ 3, 2, 1 ] });
      const b = canonicalize({ a: [ 3, 2, 1 ], b: 1 });
      expect(a).to.equal(b);
      expect(a).to.equal('{"a":[3,2,1],"b":1}');
    });

    it('should throw on a circular value', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      expect(() => canonicalize(value)).to.throw(/circular/);
    });
  });

  describe('registerApiOperation', () => {
    it('should register a valid operation and compute a fingerprint', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      service.registerApiOperation({
        id: 'articles.detail',
        surface: 'api',
        method: 'GET',
        route: '/api/articles/:id',
        event: 'article-detail',
        resources: [ 'https://example.com/mcp' ],
        scopes: [ 'articles:read' ],
        data: {}
      });
      const saved = service.apiOperations.get('articles.detail');
      expect(saved).to.not.equal(undefined);
      expect(saved!.fingerprint).to.be.a('string');
    });

    it('should reject method ALL', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(() => service.registerApiOperation({
        id: 'x',
        surface: 'api',
        method: 'ALL',
        route: '/x',
        event: 'x',
        resources: [ 'https://example.com/mcp' ],
        scopes: [],
        data: {}
      })).to.throw(/must declare a concrete method/);
    });

    it('should reject a duplicate operation ID', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      const descriptor = {
        id: 'articles.detail',
        surface: 'api' as const,
        method: 'GET' as const,
        route: '/api/articles/:id',
        event: 'article-detail',
        resources: [ 'https://example.com/mcp' ],
        scopes: [],
        data: {}
      };
      service.registerApiOperation(descriptor);
      expect(() => service.registerApiOperation(descriptor))
        .to.throw(/Duplicate OAuth API operation ID/);
    });

    it('should reject an operation referencing an undeclared resource', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(() => service.registerApiOperation({
        id: 'x',
        surface: 'api',
        method: 'GET',
        route: '/x',
        event: 'x',
        resources: [ 'https://other.example.com/mcp' ],
        scopes: [],
        data: {}
      })).to.throw(/references unknown resource/);
    });

    it('should reject non-JSON fixed data', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(() => service.registerApiOperation({
        id: 'x',
        surface: 'api',
        method: 'GET',
        route: '/x',
        event: 'x',
        resources: [ 'https://example.com/mcp' ],
        scopes: [],
        data: { handler: () => {} } as unknown as Record<string, unknown>
      })).to.throw(/must be plain JSON data/);
      expect(() => service.registerApiOperation({
        id: 'y',
        surface: 'api',
        method: 'GET',
        route: '/y',
        event: 'y',
        resources: [ 'https://example.com/mcp' ],
        scopes: [],
        data: { count: NaN }
      })).to.throw(/must be finite JSON data/);
      expect(() => service.registerApiOperation({
        id: 'z',
        surface: 'api',
        method: 'GET',
        route: '/z',
        event: 'z',
        resources: [ 'https://example.com/mcp' ],
        scopes: [],
        data: { nested: [ { bad: undefined as unknown as string } ] }
      })).to.throw(/must be plain JSON data, not undefined/);
    });

    it('should refuse mutation after finalize has run', async () => {
      const service = new OAuthService(
        createServerStub({ listeners: [ 'approval-event', 'access-event', ...REQUIRED_EVENTS ] }),
        baseConfig()
      );
      await service.finalize();
      expect(() => service.registerApiOperation({
        id: 'x',
        surface: 'api',
        method: 'GET',
        route: '/x',
        event: 'x',
        resources: [ 'https://example.com/mcp' ],
        scopes: [],
        data: {}
      })).to.throw(/Cannot register an OAuth operation after finalize/);
    });
  });

  describe('registerMcpResource', () => {
    it('should register a valid resource', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      service.registerMcpResource({
        surface: 'mcp',
        route: '/mcp',
        resource: 'https://example.com/mcp'
      });
      expect(service.mcpResources.get('/mcp')).to.not.equal(undefined);
    });

    it('should reject an undeclared resource', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(() => service.registerMcpResource({
        surface: 'mcp',
        route: '/mcp',
        resource: 'https://other.example.com/mcp'
      })).to.throw(/not declared in session.oauth.resources/);
    });

    it('should reject a route collision between mcp and sse', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      service.registerMcpResource({
        surface: 'mcp',
        route: '/mcp',
        resource: 'https://example.com/mcp'
      });
      expect(() => service.registerMcpResource({
        surface: 'sse',
        route: '/mcp',
        resource: 'https://example.com/mcp'
      })).to.throw(/route collision/);
    });
  });

  describe('assertFinalized', () => {
    it('should throw a 503 before finalize has run', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      try {
        service.assertFinalized();
        expect.fail('expected assertFinalized to throw');
      } catch (error: any) {
        expect(error.code).to.equal(503);
      }
    });

    it('should not throw once finalize has succeeded', async () => {
      const service = new OAuthService(
        createServerStub({ listeners: [ 'approval-event', 'access-event', ...REQUIRED_EVENTS ] }),
        baseConfig()
      );
      await service.finalize();
      expect(() => service.assertFinalized()).to.not.throw();
    });
  });

  describe('finalize', () => {
    it('should fail closed when policy listeners are missing', async () => {
      const service = new OAuthService(
        createServerStub({ listeners: REQUIRED_EVENTS }),
        baseConfig()
      );
      let caught: any;
      try {
        await service.finalize();
      } catch (error) {
        caught = error;
      }
      expect(caught).to.not.equal(undefined);
      expect(caught.code).to.equal(503);
      expect(String(caught.message)).to.match(/approval-event/);
      expect(String(caught.message)).to.match(/access-event/);
      expect(service.finalized).to.equal(false);
    });

    it('should fail closed when the database plugin is absent', async () => {
      const service = new OAuthService(
        createServerStub({
          database: false,
          listeners: [ 'approval-event', 'access-event', ...REQUIRED_EVENTS ]
        }),
        baseConfig()
      );
      let caught: any;
      try {
        await service.finalize();
      } catch (error) {
        caught = error;
      }
      expect(caught.message).to.match(/database plugin/);
    });

    it('should fail closed when required OAuth runtime listeners are missing', async () => {
      const service = new OAuthService(
        createServerStub({ listeners: [ 'approval-event', 'access-event' ] }),
        baseConfig()
      );
      let caught: any;
      try {
        await service.finalize();
      } catch (error) {
        caught = error;
      }
      expect(caught.message).to.match(/oauth-token-verify/);
    });

    it('should succeed once every dependency is present, and be idempotent', async () => {
      const service = new OAuthService(
        createServerStub({ listeners: [ 'approval-event', 'access-event', ...REQUIRED_EVENTS ] }),
        baseConfig()
      );
      await service.finalize();
      expect(service.finalized).to.equal(true);
      //calling again must be a no-op, not a re-check that could flip state
      await service.finalize();
      expect(service.finalized).to.equal(true);
    });

    it('should collapse concurrent finalize calls into one run', async () => {
      const service = new OAuthService(
        createServerStub({ listeners: [ 'approval-event', 'access-event', ...REQUIRED_EVENTS ] }),
        baseConfig()
      );
      const [ first, second ] = await Promise.all([
        service.finalize(),
        service.finalize()
      ]);
      expect(first).to.equal(undefined);
      expect(second).to.equal(undefined);
      expect(service.finalized).to.equal(true);
    });

    it('should allow a repeated finalize attempt after an earlier failure', async () => {
      const stub = createServerStub({ listeners: [ 'approval-event', 'access-event' ] });
      const service = new OAuthService(stub, baseConfig());
      await service.finalize().catch(() => {});
      expect(service.finalized).to.equal(false);
      //now the app registers the remaining listeners and retries
      for (const event of REQUIRED_EVENTS) {
        (stub as any).listeners[event] = new Set([ function noop() {} ]);
      }
      await service.finalize();
      expect(service.finalized).to.equal(true);
    });
  });

  describe('isNativeRoute', () => {
    it('recognizes the issuer metadata well-known path', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(service.isNativeRoute('GET', '/.well-known/oauth-authorization-server'))
        .to.equal(true);
    });

    it('recognizes the single-resource root metadata alias and its own path', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(service.isNativeRoute('GET', '/.well-known/oauth-protected-resource'))
        .to.equal(true);
      expect(service.isNativeRoute('GET', '/.well-known/oauth-protected-resource/mcp'))
        .to.equal(true);
    });

    it('does not alias root metadata when more than one resource is configured', () => {
      const config = normalizeOAuthConfig({
        issuer: 'https://example.com',
        resources: [
          { resource: 'https://example.com/mcp', name: 'A', description: 'a', scopes: [ 'articles:read' ] },
          { resource: 'https://example.com/other', name: 'B', description: 'b', scopes: [ 'articles:read' ] }
        ],
        scopes: { 'articles:read': { name: 'Read', description: 'Read' } },
        policy: { approval: 'approval-event', access: 'access-event' }
      });
      const service = new OAuthService(createServerStub(), config);
      expect(service.isNativeRoute('GET', '/.well-known/oauth-protected-resource'))
        .to.equal(false);
      expect(service.isNativeRoute('GET', '/.well-known/oauth-protected-resource/mcp'))
        .to.equal(true);
      expect(service.isNativeRoute('GET', '/.well-known/oauth-protected-resource/other'))
        .to.equal(true);
    });

    it('recognizes the token/register/revoke protocol routes, GET and OPTIONS alike', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(service.isNativeRoute('POST', '/auth/oauth2/token')).to.equal(true);
      expect(service.isNativeRoute('OPTIONS', '/auth/oauth2/token')).to.equal(true);
      expect(service.isNativeRoute('POST', '/auth/oauth2/register')).to.equal(true);
      expect(service.isNativeRoute('POST', '/auth/oauth2/revoke')).to.equal(true);
      expect(service.isNativeRoute('GET', '/auth/oauth2/token')).to.equal(false);
    });

    it('does not treat /authorize, /connections or /factor as native', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(service.isNativeRoute('GET', '/auth/oauth2/authorize')).to.equal(false);
      expect(service.isNativeRoute('POST', '/auth/oauth2/authorize')).to.equal(false);
      expect(service.isNativeRoute('GET', '/auth/oauth2/connections')).to.equal(false);
      expect(service.isNativeRoute('GET', '/auth/oauth2/factor')).to.equal(false);
    });

    it('recognizes a registered API operation by its exact method and route', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      service.registerApiOperation({
        id: 'articles.detail', surface: 'api', method: 'GET',
        route: '/api/articles/:id', event: 'article-detail',
        resources: [ 'https://example.com/mcp' ], scopes: [], data: {}
      });
      expect(service.isNativeRoute('GET', '/api/articles/:id')).to.equal(true);
      expect(service.isNativeRoute('POST', '/api/articles/:id')).to.equal(false);
    });

    it('recognizes a registered MCP resource route for GET/POST/DELETE/OPTIONS', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      service.registerMcpResource({
        surface: 'mcp', route: '/mcp', resource: 'https://example.com/mcp'
      });
      expect(service.isNativeRoute('GET', '/mcp')).to.equal(true);
      expect(service.isNativeRoute('POST', '/mcp')).to.equal(true);
      expect(service.isNativeRoute('DELETE', '/mcp')).to.equal(true);
      expect(service.isNativeRoute('OPTIONS', '/mcp')).to.equal(true);
      expect(service.isNativeRoute('PUT', '/mcp')).to.equal(false);
    });

    it('rejects an unrelated route entirely', () => {
      const service = new OAuthService(createServerStub(), baseConfig());
      expect(service.isNativeRoute('GET', '/auth/account')).to.equal(false);
    });
  });
});
