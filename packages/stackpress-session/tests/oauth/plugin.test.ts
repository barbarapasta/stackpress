import { describe, it } from 'mocha';
import { expect } from 'chai';
import plugin from '../../src/oauth/plugin.js';
import type { OAuthPlugin } from '../../src/oauth/types.js';

function createServerStub(session: Record<string, unknown> | undefined) {
  const handlers = new Map<string, Function[]>();
  const plugins: Record<string, unknown> = {};
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
    listeners: {} as Record<string, Set<unknown>>,
    handlers,
    plugins
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
});
