//node
import { IncomingMessage, ServerResponse } from 'node:http';
//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
//client
import plugin, { createMcpServer } from '../src/plugin.js';
import type { AuthContext, ToolResolverServer } from '../src/types.js';
import { createCtxStub } from './helpers.js';

//this local server slice is enough to exercise plugin registration behavior
// without rebuilding the full ingest server surface in tests.
type PluginServerStub = {
  config: {
    get<T = unknown>(key: string): T | undefined,
    has?(key: string): boolean
  },
  on(event: string, listener: Function): void
};

describe('ai/package', () => {
  it('should register a route handler that validates oauth resources', () => {
    const handlers = new Map<string, Function>();
    const server: PluginServerStub = {
      config: {
        get() {
          return {};
        },
        has(key: string) {
          return key === 'mcp';
        }
      },
      on(event: string, listener: Function) {
        handlers.set(event, listener);
      }
    };

    plugin(server as never);

    const route = handlers.get('route');
    expect(route).to.be.a('function');

    const ctx = createCtxStub({ config: { mcp: {} } });
    //no oauth configured, so this must not throw
    route!({ ctx });
  });

  it('should export the package entrypoints', async () => {
    const mod = await import('../src/index.js');
    expect(mod).to.have.property('default');
  });

  it('should not activate when no mcp config exists', () => {
    const handlers = new Map<string, Function>();
    const server: PluginServerStub = {
      config: {
        get() {
          return undefined;
        },
        has() {
          return false;
        }
      },
      on(event: string, listener: Function) {
        handlers.set(event, listener);
      }
    };

    plugin(server as never);

    expect(handlers.has('listen')).to.equal(false);
  });

  it('should register mcp factory and transport events on listen', async () => {
    const handlers = new Map<string, Function>();
    const server: PluginServerStub = {
      config: {
        get() {
          return {};
        },
        has(key: string) {
          return key === 'mcp';
        }
      },
      on(event: string, listener: Function) {
        handlers.set(event, listener);
      }
    };

    plugin(server as never);

    const listen = handlers.get('listen');
    expect(listen).to.be.a('function');

    const ctx = createCtxStub({
      config: { mcp: {} }
    });
    ctx.registered.client = async () => ({
      tools: {
        listen(target) {
          target.on('article-detail-tool', () => null);
        }
      }
    });
    await listen!({ ctx });

    expect(ctx.registered.mcp).to.be.a('function');
    expect(ctx.events).to.deep.equal([
      'article-detail-tool',
      'mcp-stdio',
      'mcp-http',
      'mcp-sse',
      'request'
    ]);
  });

  it('should attach the http request handler when mcp matches the main server', async () => {
    const handlers = new Map<string, Function[]>();
    const server: PluginServerStub = {
      config: {
        get() {
          return {};
        },
        has(key: string) {
          return key === 'mcp';
        }
      },
      on(event: string, listener: Function) {
        const list = handlers.get(event) || [];
        list.push(listener);
        handlers.set(event, list);
      }
    };

    plugin(server as never);

    const listen = handlers.get('listen')?.[0];
    const ctx = createCtxStub({
      config: {
        mcp: {},
        'mcp.tools': [{
          name: 'ping',
          title: 'Ping',
          event: 'ping',
          method: 'GET'
        }]
      },
      resolves: {
        ping: { results: { ok: true } }
      }
    });
    ctx.registered.client = async () => ({
      tools: {
        listen(target) {
          target.on('article-search-tool', () => null);
        }
      }
    });

    await listen!({ ctx });

    expect(ctx.events).to.deep.equal([
      'article-search-tool',
      'mcp-stdio',
      'mcp-http',
      'mcp-sse',
      'request'
    ]);
  });

  it('should attach the sse request handler when sse matches the main server', async () => {
    const handlers = new Map<string, Function[]>();
    const server: PluginServerStub = {
      config: {
        get() {
          return {};
        },
        has(key: string) {
          return key === 'mcp';
        }
      },
      on(event: string, listener: Function) {
        const list = handlers.get(event) || [];
        list.push(listener);
        handlers.set(event, list);
      }
    };

    plugin(server as never);

    const listen = handlers.get('listen')?.[0];
    const ctx = createCtxStub({
      config: {
        mcp: {},
        'mcp.tools': [{
          name: 'ping',
          title: 'Ping',
          event: 'ping',
          method: 'GET'
        }],
        'mcp.sse': {},
        'mcp.sse.route': '/sse'
      },
      resolves: {
        ping: { results: { ok: true } }
      }
    });
    ctx.registered.client = async () => ({
      tools: {
        listen(target) {
          target.on('comment-create-tool', () => null);
        }
      }
    });

    await listen!({ ctx });

    expect(ctx.events).to.deep.equal([
      'comment-create-tool',
      'mcp-stdio',
      'mcp-http',
      'mcp-sse',
      'request',
      'request'
    ]);
  });

  it('should register the idea transform during generation', async () => {
    const handlers = new Map<string, Function>();
    const server: PluginServerStub = {
      config: {
        get() {
          return {};
        },
        has(key: string) {
          return key === 'mcp';
        }
      },
      on(event: string, listener: Function) {
        handlers.set(event, listener);
      }
    };

    plugin(server as never);

    const idea = handlers.get('idea');
    expect(idea).to.be.a('function');

    const schema: Record<string, unknown> = {};
    await idea!({
      req: {
        data() {
          return {
            async schema() {
              return schema;
            }
          };
        }
      }
    });

    expect(schema).to.have.property('plugin');
    expect(Object.keys(
      schema.plugin as Record<string, unknown>
    )[0]).to.match(/packages\/stackpress-ai\/src\/transform$/);
  });

  it('should return null when no tools are configured', async () => {
    const ctx = createCtxStub({
      config: { 'mcp.tools': [] }
    });
    const server = await createMcpServer(ctx as unknown as ToolResolverServer);

    expect(server).to.equal(null);
  });

  it('should register JSON-schema tools without throwing', async () => {
    const ctx = createCtxStub({
      config: {
        'mcp.tools': [{
          name: 'article_search',
          title: 'Search Articles',
          event: 'article-search',
          method: 'GET',
          input: {
            type: 'object',
            properties: {
              q: { type: 'string' }
            }
          },
          output: {
            type: 'array'
          }
        }]
      },
      resolves: {
        'article-search': { results: [] }
      }
    });

    const server = await createMcpServer(ctx as unknown as ToolResolverServer);
    expect(server).to.not.equal(null);
  });

  it('should validate input, resolve the event, and enforce auth at call time', async () => {
    //capture the handler each tool registers on the real MCP SDK server so
    // this test can invoke it directly, the same way a connected transport
    // would once a client actually calls the tool.
    const originalRegisterTool = McpServer.prototype.registerTool;
    const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};

    McpServer.prototype.registerTool = function (
      this: McpServer,
      name: string,
      config: unknown,
      handler: (input: unknown) => Promise<unknown>
    ) {
      handlers[name] = handler;
      return originalRegisterTool.call(this, name, config as never, handler as never);
    } as never;

    try {
      const ctx = createCtxStub({
        config: {
          'mcp.tools': [{
            name: 'article_search',
            title: 'Article Search',
            event: 'article-search',
            method: 'GET',
            type: 'app',
            scopes: [ 'articles.read' ]
          }]
        },
        resolves: {
          'article-search': { results: [{ id: 1 }] }
        }
      });
      const application = {
        id: 'app_1',
        name: 'App',
        secret: 'secret',
        scopes: [ 'articles.read' ],
        active: true,
        expires: new Date(),
        created: new Date(),
        updated: new Date()
      };
      const auth: AuthContext = {
        kind: 'app',
        token: { token: 'app_1:secret', id: 'app_1', secret: 'secret' },
        application
      };

      const server = await createMcpServer(ctx as unknown as ToolResolverServer, auth);
      expect(server).to.not.equal(null);
      expect(handlers.article_search).to.be.a('function');

      const result = await handlers.article_search({ q: 'hi' });
      expect(result).to.deep.equal({
        content: [{ type: 'text', text: JSON.stringify([{ id: 1 }], null, 2) }]
      });

      //simulate the caller's scope being revoked after the session was
      //created; a stale/manually-crafted call must be rejected at call time
      application.scopes = [];
      try {
        await handlers.article_search({ q: 'hi' });
        expect.fail('expected the stale call to be rejected');
      } catch (error) {
        expect((error as Error).message)
          .to.equal('Unauthorized MCP tool call: article_search');
      }
    } finally {
      McpServer.prototype.registerTool = originalRegisterTool;
    }
  });
});
