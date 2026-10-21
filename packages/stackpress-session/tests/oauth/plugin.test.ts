import { describe, it } from 'mocha';
import { expect } from 'chai';
import plugin from '../../src/oauth/plugin.js';
import type { OAuthPlugin } from '../../src/oauth/types.js';

function createServerStub(session: Record<string, unknown> | undefined) {
  const handlers = new Map<string, Function[]>();
  const plugins: Record<string, unknown> = {};
  const routes: Array<{ method: string, path: string }> = [];
  const stub = {
    config: {
      get(key: string) {
        return key === 'session' ? session : undefined;
      }
    },
    on(event: string, action: Function) {
      const list = handlers.get(event) || [];
      list.push(action);
      handlers.set(event, list);
      return stub;
    },
    register(name: string, value: unknown) {
      plugins[name] = value;
      return stub;
    },
    plugin(name: string) {
      return plugins[name];
    },
    route(method: string, path: string) {
      routes.push({ method, path });
      return stub;
    },
    listeners: {} as Record<string, Set<unknown>>,
    handlers,
    plugins,
    routes
  };
  return stub;
}

function validOAuthConfig() {
  return {
    oauth: {
      issuer: 'https://example.com',
      resources: [{
        resource: 'https://example.com/mcp',
        name: 'Example service',
        description: 'desc',
        scopes: [ 'articles:read' ]
      }],
      scopes: {
        'articles:read': { name: 'Read', description: 'Read articles' }
      },
      policy: { approval: 'a', access: 'b' }
    }
  };
}

describe('session/oauth/plugin', () => {
  it('should do nothing when session.oauth is absent', () => {
    const ctx = createServerStub({});
    plugin(ctx as never);
    expect(ctx.handlers.size).to.equal(0);
  });

  it('should do nothing when session config itself is absent', () => {
    const ctx = createServerStub(undefined);
    plugin(ctx as never);
    expect(ctx.handlers.size).to.equal(0);
  });

  it('should register the service on config with a valid setting', async () => {
    const ctx = createServerStub(validOAuthConfig());
    plugin(ctx as never);
    const configHandlers = ctx.handlers.get('config') || [];
    expect(configHandlers).to.have.length(1);
    await configHandlers[0]({ ctx });
    const oauth = ctx.plugin<OAuthPlugin>('oauth');
    expect(oauth).to.not.equal(undefined);
    expect(oauth!.config.issuer).to.equal('https://example.com');
  });

  it('should throw on config when the setting is invalid', async () => {
    const ctx = createServerStub({ oauth: { issuer: 'not a url' } });
    plugin(ctx as never);
    const configHandlers = ctx.handlers.get('config') || [];
    let caught: unknown;
    try {
      await configHandlers[0]({ ctx });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.not.equal(undefined);
  });

  it('should register the oauth-finalize listener on listen', () => {
    const ctx = createServerStub(validOAuthConfig());
    plugin(ctx as never);
    const listenHandlers = ctx.handlers.get('listen') || [];
    expect(listenHandlers).to.have.length(1);
    listenHandlers[0]({ ctx });
    expect(ctx.handlers.get('oauth-finalize')).to.have.length(1);
  });

  it('should register every fixed event listener finalize() requires, on listen', () => {
    const ctx = createServerStub(validOAuthConfig());
    plugin(ctx as never);
    (ctx.handlers.get('listen') || [])[0]({ ctx });
    for (const event of [
      'oauth-client-register', 'oauth-authorization-start', 'oauth-authorize',
      'oauth-code-exchange', 'oauth-refresh', 'oauth-token-verify',
      'oauth-revoke', 'oauth-grants-list', 'oauth-grant-revoke'
    ]) {
      expect(ctx.handlers.get(event), event).to.have.length(1);
    }
  });

  it('should add the native discovery/token/register/revoke routes on route', async () => {
    const ctx = createServerStub(validOAuthConfig());
    plugin(ctx as never);
    await (ctx.handlers.get('config') || [])[0]({ ctx });
    (ctx.handlers.get('route') || [])[0]({ ctx });
    const routeKeys = ctx.routes.map((r) => `${r.method} ${r.path}`);
    expect(routeKeys).to.include('GET /.well-known/oauth-authorization-server');
    expect(routeKeys).to.include('GET /.well-known/oauth-protected-resource/mcp');
    //single configured resource: the root alias is also registered.
    expect(routeKeys).to.include('GET /.well-known/oauth-protected-resource');
    expect(routeKeys).to.include('POST /auth/oauth2/token');
    expect(routeKeys).to.include('OPTIONS /auth/oauth2/token');
    expect(routeKeys).to.include('POST /auth/oauth2/revoke');
    expect(routeKeys).to.include('POST /auth/oauth2/register');
  });

  it('should not add the register route when registration is disabled', async () => {
    const config = validOAuthConfig();
    (config.oauth as Record<string, unknown>).registration = { enabled: false };
    const ctx = createServerStub(config);
    plugin(ctx as never);
    await (ctx.handlers.get('config') || [])[0]({ ctx });
    (ctx.handlers.get('route') || [])[0]({ ctx });
    const routeKeys = ctx.routes.map((r) => `${r.method} ${r.path}`);
    expect(routeKeys).to.not.include('POST /auth/oauth2/register');
  });
});
