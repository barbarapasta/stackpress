//node
import { readFileSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
//modules
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import { normalizeTool } from '../src/helpers.js';
import plugin, { createMcpServer, registerCallTools } from '../src/plugin.js';
import type {
  AuthContext,
  NormalizedToolConfig,
  ToolResolverServer
} from '../src/types.js';
import { caller } from '../src/scripts/tools.js';
import { createApplication, createCtxStub } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

//this helper runs the plugin against a handler map and returns the listeners
// it registered so each test can drive one of them.
function load() {
  const handlers = new Map<string, Function>();
  plugin({
    config: { has: (key: string) => key === 'mcp' },
    on: (event: string, listener: Function) => handlers.set(event, listener)
  } as never);
  return handlers;
}

//this helper links a real MCP client to a server whose handlers were built by
// registerCallTools, so tool calls run through the SDK and not a stub.
async function connect(
  ctx: ToolResolverServer,
  tools: NormalizedToolConfig[],
  auth?: AuthContext
) {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerCallTools(server, ctx, tools, auth);
  const [ near, far ] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([ server.connect(near), client.connect(far) ]);
  return client;
}

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

  it('should register the record guards ahead of the generated listeners whenever it is active', async () => {
    //the records come from the schema the package ships, not from the guard
    // code, so a record added there without a guard fails here. A thread is
    // the person's to edit; every other record belongs to the store alone
    const schema = readFileSync(
      path.join(here, '..', 'schema.idea'),
      'utf8'
    );
    const owned = Array.from(schema.matchAll(/^model (Agent[A-Za-z]+)/gm))
      .map(match => match[1])
      .filter(name => name !== 'AgentThread')
      .map(name => name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase());
    const verbs = [
      'update', 'remove', 'restore', 'purge', 'upsert', 'batch'
    ];

    //a lock and a usage record are among them, and the thread is not
    expect(owned).to.include.members([
      'agent-turn', 'agent-action', 'agent-usage', 'agent-lock'
    ]);
    expect(owned).to.not.include('agent-thread');

    for (const config of [ { mcp: {} }, { agent: {} } ]) {
      const handlers = new Map<string, Function>();
      plugin({
        config: { has: (key: string) => key in config },
        on: (event: string, listener: Function) => handlers.set(event, listener)
      } as never);
      const ctx = createCtxStub({ config });
      await handlers.get('listen')!({ ctx });

      //every owned record loses its six writes and its outside create, and a
      // thread loses only its purge
      expect(ctx.ranked).to.have.members([
        ...owned.flatMap(model => [
          ...verbs.map(verb => `${model}-${verb}`),
          `${model}-create`
        ]),
        'agent-thread-purge'
      ]);

      //reads, and a thread's own edits, stay open
      for (const model of owned) {
        for (const verb of [ 'detail', 'search', 'get' ]) {
          expect(ctx.ranked).to.not.include(`${model}-${verb}`);
        }
      }
      expect(ctx.ranked).to.not.include('agent-thread-update');
      expect(ctx.ranked).to.not.include('agent-thread-create');
    }
  });

  it('should return null when no tools are configured and no caller is given', async () => {
    const ctx = createCtxStub({
      config: { 'mcp.tools': [] }
    });
    const server = await createMcpServer(ctx as unknown as ToolResolverServer);

    expect(server).to.equal(null);
  });

  it('should return a server with no tools for a verified or public caller who sees none', async () => {
    const ctx = createCtxStub({
      config: {
        'mcp.tools': [{
          name: 'article_publish',
          type: 'app',
          method: 'POST',
          event: 'article-publish',
          scopes: [ 'articles.write' ]
        }]
      }
    });

    for (const auth of [
      { kind: 'public' },
      {
        kind: 'app',
        token: { id: 'a', secret: 's' },
        application: createApplication({ scopes: [ 'other' ] })
      }
    ] as const) {
      const server = await createMcpServer(
        ctx as unknown as ToolResolverServer,
        auth as never
      );
      expect(server, auth.kind).to.not.equal(null);
    }
  });

  it('should return null for a refused caller', async () => {
    const ctx = createCtxStub({
      config: { 'mcp.tools': [{ name: 'ping', type: 'public', event: 'ping' }] }
    });
    const server = await createMcpServer(
      ctx as unknown as ToolResolverServer,
      { kind: 'invalid' }
    );

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

  it('should register the factory and skip transports that do not attach', async () => {
    const listen = load().get('listen')!;
    const ctx = createCtxStub({
      config: { mcp: {}, 'mcp.port': 4999, 'mcp.tools': [] }
    });

    //there is no client plugin, so nothing is registered for it
    await listen({ ctx });

    //a separate mcp port means the http route does not ride the main server
    expect(ctx.events).to.deep.equal([ 'mcp-stdio', 'mcp-http', 'mcp-sse' ]);

    //the registered factory builds a server for any allowed caller, even one
    // who sees no tools, and none for a refused caller or an empty registry
    const factory = ctx.registered.mcp as (
      auth?: AuthContext
    ) => Promise<unknown>;
    expect(await factory({ kind: 'public' })).to.not.equal(null);
    expect(await factory({ kind: 'invalid' })).to.equal(null);
    expect(await factory()).to.equal(null);
  });

  it('should tolerate a client plugin that resolves to nothing', async () => {
    const listen = load().get('listen')!;
    const ctx = createCtxStub({
      config: { mcp: {}, 'mcp.port': 4999, 'mcp.tools': [] }
    });
    ctx.registered.client = async () => null;

    await listen({ ctx });

    expect(ctx.events).to.deep.equal([ 'mcp-stdio', 'mcp-http', 'mcp-sse' ]);
  });

  it('should keep plugins already registered on the schema', async () => {
    const idea = load().get('idea')!;
    const schema: Record<string, unknown> = { plugin: { './existing': {} } };

    await idea({
      req: { data: () => ({ schema: async () => schema }) }
    });

    expect(Object.keys(schema.plugin as object)).to.have.length(2);
    expect(schema.plugin).to.have.property('./existing');
  });

  describe('tool calls', () => {
    const ping = normalizeTool({
      name: 'ping',
      event: 'ping',
      type: 'public',
      method: 'GET'
    })!;

    it('should run a tool that declares no input and return its results', async () => {
      const ctx = createCtxStub({ resolves: { ping: { results: { ok: true } } } });
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(JSON.stringify(result.content)).to.contain('\\"ok\\": true');
      await client.close();
    });

    it('should answer null when the event answers with nothing', async () => {
      const ctx = createCtxStub({ resolves: { ping: { results: null } } });
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.not.equal(true);
      expect(result.content).to.deep.equal([{ type: 'text', text: 'null' }]);
      await client.close();
    });

    it('should answer an error when nothing answers the event', async () => {
      const ctx = createCtxStub();
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.equal(true);
      expect(JSON.stringify(result.content)).to.contain('Tool call failed');
      await client.close();
    });

    it('should refuse a call that the bound caller may not make', async () => {
      const ctx = createCtxStub({ resolves: { ping: { results: 'pong' } } });
      const client = await connect(
        ctx as unknown as ToolResolverServer,
        [ ping ],
        { kind: 'invalid' }
      );

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.equal(true);
      expect(JSON.stringify(result.content))
        .to.contain('Unauthorized MCP tool call: ping');
      await client.close();
    });

    it('should map a refused event to an MCP error result', async () => {
      const ctx = createCtxStub({
        resolves: {
          ping: {
            code: 403,
            status: 'Forbidden',
            error: 'An authenticated profile is required.',
            results: { leaked: 'no' }
          } as never
        }
      });
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.equal(true);
      expect(result.content).to.deep.equal([
        { type: 'text', text: 'An authenticated profile is required.' }
      ]);
      await client.close();
    });

    it('should map a failed event with no message to its status', async () => {
      const ctx = createCtxStub({
        resolves: { ping: { code: 500, status: 'Server Error' } as never }
      });
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.equal(true);
      expect(result.content).to.deep.equal([
        { type: 'text', text: 'Server Error' }
      ]);
      await client.close();
    });

    it('should map an event that sets only an error to an error result', async () => {
      const ctx = createCtxStub({
        resolves: { ping: { error: 'Boom' } as never }
      });
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.equal(true);
      expect(JSON.stringify(result.content)).to.contain('Boom');
      await client.close();
    });

    it('should name a failure that carries neither error nor status', async () => {
      const ctx = createCtxStub({
        resolves: { ping: { code: 502 } as never }
      });
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.equal(true);
      expect(JSON.stringify(result.content)).to.contain('Tool call failed');
      await client.close();
    });

    it('should still return results for a successful event with a 2xx code', async () => {
      const ctx = createCtxStub({
        resolves: { ping: { code: 200, results: { ok: 1 } } as never }
      });
      const client = await connect(ctx as unknown as ToolResolverServer, [ ping ]);

      const result = await client.callTool({ name: 'ping' });

      expect(result.isError).to.not.equal(true);
      expect(JSON.stringify(result.content)).to.contain('\\"ok\\": 1');
      await client.close();
    });

    it('should record the verified caller on the request the event receives', async () => {
      const ctx = createCtxStub({ resolves: { ping: { results: 'pong' } } });
      const client = await connect(
        ctx as unknown as ToolResolverServer,
        [ ping ],
        {
          kind: 'app',
          token: { token: 'app_1:secret', id: 'app_1', secret: 'secret' },
          application: createApplication({ scopes: [] })
        }
      );

      await client.callTool({ name: 'ping' });

      const [ call ] = ctx.calls.filter(call => call.event === 'ping');
      expect(call.req.data).to.deep.equal({ applicationId: 'app_1' });
      expect(call.req.method).to.equal('GET');
      expect(caller(call.req)).to.deep.equal({
        kind: 'app',
        applicationId: 'app_1',
        scopes: []
      });
      await client.close();
    });
  });
});
