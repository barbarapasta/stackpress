//node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
//modules
import type { CLIProps } from '@stackpress/idea-transformer/types';
import type Transformer from '@stackpress/idea-transformer/Transformer';
import type Server from '@stackpress/ingest/Server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { fromJSONSchema } from 'zod';
//client
import type {
  AuthContext,
  ClientPlugin,
  NormalizedToolConfig,
  ToolResolverServer
} from './types.js';
import {
  callerFromAuth,
  listToolsForAuth,
  toMcpText,
  toolAllowed
} from './helpers.js';
import {
  AGENT_EVENTS,
  approve,
  create,
  decline,
  http,
  sse,
  start,
  stdio,
  thread,
  threads,
  turn,
  undo
} from './events/index.js';
import guardRecords from './events/guard.js';
import { attachHttpToServer, shouldAttachHttpToServer } from './scripts/http.js';
import { attachSseToServer, shouldAttachSseToServer } from './scripts/sse.js';
import { base } from './pages/helpers.js';
import { createRuntime } from './scripts/agent.js';
import { callTool, collectTools, failed } from './scripts/tools.js';

/**
 * Create one MCP server instance from the current Stackpress config.
 */
export async function createMcpServer(
  ctx: ToolResolverServer,
  auth?: AuthContext
) {
  //start by collecting contributed and configured tools into one registry,
  // the same source the transports use to refuse forbidden calls.
  const registry = await collectTools(ctx);

  //when a live transport resolved caller auth, only expose the visible slice
  // of the registry to that one connected caller.
  const visible = auth ? listToolsForAuth(registry, auth) : registry;

  //a refused caller never gets a server, and neither does stdio when the whole
  // registry is empty, since that means the server is misconfigured. A
  // verified or public network caller that sees nothing still connects.
  if (auth?.kind === 'invalid' || (!auth && !visible.length)) {
    return null;
  }

  //now create the MCP server shell that transports will attach to later
  const server = new McpServer({
    name: ctx.config.path('mcp.name', 'Stackpress AI Server'),
    version: ctx.config.path('mcp.version', '0.10.8'),
    title: ctx.config.path('mcp.title', 'Stackpress AI Server'),
    description: ctx.config.path<string | undefined>('mcp.description')
  });

  //the SDK answers tools/list only once a tool has been registered, so a
  // server with no tools would reject the call as an unknown method. Register
  // and remove one tool to switch the tool handlers on with nothing listed.
  if (!visible.length) {
    server.registerTool('empty', {}, async () => toMcpText(null)).remove();
  }

  registerCallTools(server, ctx, visible, auth);
  return server;
}

/**
 * Register the callable tool handlers on one MCP server instance.
 */
export function registerCallTools(
  server: McpServer,
  ctx: ToolResolverServer,
  tools: NormalizedToolConfig[],
  auth?: AuthContext
) {
  //for each normalized tool, register one callable MCP handler
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        //convert the serializable JSON Schema config into live zod schemas
        // because the MCP SDK validates tool contracts during registration.
        inputSchema: tool.input
          ? fromJSONSchema(tool.input) as unknown as AnySchema
          : undefined,
        outputSchema: tool.output
          ? fromJSONSchema(tool.output) as unknown as AnySchema
          : undefined
      },
      async (input: unknown) => {
        //when a tool declares no input the SDK hands the handler its request
        // extras in place of the arguments, which must not reach the event.
        const args = tool.input ? (input || {}) : {};

        //if this server was built for one caller, enforce that same auth at
        // call time too so stale or manually-crafted calls cannot bypass it.
        const who = callerFromAuth(auth);
        if (!who || (auth && !toolAllowed(tool, auth))) {
          throw new Error(`Unauthorized MCP tool call: ${tool.name}`);
        }

        //the shared execution path validates the input, records the caller
        // and resolves the tool's event.
        const result = await callTool(
          ctx,
          tool,
          args as Record<string, unknown>,
          who
        );

        //a refused or failed event is an error result, not a success
        if (failed(result)) {
          return {
            ...toMcpText(result.error || result.status || 'Tool call failed'),
            isError: true
          };
        }

        //finally convert Stackpress results into the MCP text result shape
        return toMcpText(result.results ?? null);
      }
    );
  }
}

/**
 * Register the MCP factory and transport events, and the agent events, with
 * Stackpress. The plugin activates when either `mcp` or `agent` config exists,
 * and each part registers only for its own config.
 */
export default function plugin(ctx: Server) {
  const mcp = ctx.config.has('mcp');
  const agent = ctx.config.has('agent');

  //if neither config exists, skip registering the plugin
  if (!mcp && !agent) return;

  ctx.on('listen', async ({ ctx }) => {
    //an app that uses this package's schema also gets generated events for
    // the agent records. Guard them first: the guards outrank the generated
    // listeners, so it does not matter which plugin registers first.
    guardRecords(ctx);

    //load the generated client tools if the client package already exists
    // and let that registry attach its plugin-mode resolver events first.
    const client = ctx.plugin<ClientPlugin>('client');
    if (typeof client === 'function') {
      const generated = await client(true) || {};
      generated.tools?.listen(ctx);
    }

    //the agent answers events, which a route or a job resolves with the
    // request that carries the person's session
    if (agent) {
      ctx.register('agent', createRuntime(ctx as ToolResolverServer));
      ctx.on(AGENT_EVENTS.turn, turn);
      ctx.on(AGENT_EVENTS.approve, approve);
      ctx.on(AGENT_EVENTS.decline, decline);
      ctx.on(AGENT_EVENTS.undo, undo);
      ctx.on(AGENT_EVENTS.threads, threads);
      ctx.on(AGENT_EVENTS.thread, thread);
      ctx.on(AGENT_EVENTS.start, start);
      ctx.on(AGENT_EVENTS.create, create);
    }

    //the MCP transports stay behind their own config
    if (!mcp) return;

    //expose the MCP factory so transport scripts can request a fresh server
    // that is already filtered to one resolved caller auth context.
    ctx.register('mcp', async (auth?: AuthContext) => createMcpServer(
      ctx as ToolResolverServer,
      auth
    ));

    //then register the transport entry events that the CLI can emit later
    ctx.on('mcp-stdio', stdio);
    ctx.on('mcp-http', http);
    ctx.on('mcp-sse', sse);

    if (shouldAttachHttpToServer(ctx)) {
      attachHttpToServer(ctx);
    }

    if (ctx.config.has('mcp.sse') && shouldAttachSseToServer(ctx)) {
      attachSseToServer(ctx);
    }
  });

  //the panel reaches the agent through these routes, which exist only when
  // the app configured the agent. Each is a page that adapts the request to
  // one of the agent events
  ctx.on('route', ({ ctx }) => {
    if (!ctx.config.has('agent')) return;
    const path = base(ctx);
    ctx.import.get(`${path}/start`, () => import('./pages/start.js'));
    ctx.import.get(`${path}/threads`, () => import('./pages/threads.js'));
    ctx.import.get(
      `${path}/threads/:threadId`,
      () => import('./pages/thread.js')
    );
    ctx.import.post(`${path}/threads`, () => import('./pages/create.js'));
    ctx.import.post(`${path}/turn`, () => import('./pages/send.js'));
    ctx.import.post(
      `${path}/actions/:actionId/approve`,
      () => import('./pages/approve.js')
    );
    ctx.import.post(
      `${path}/actions/:actionId/decline`,
      () => import('./pages/decline.js')
    );
    ctx.import.post(
      `${path}/actions/:actionId/undo`,
      () => import('./pages/undo.js')
    );
  });

  //generate MCP tool code into the client package through the standard idea
  // plugin pipeline instead of reparsing schema files at runtime.
  ctx.on('idea', async ({ req }) => {
    const transformer = req.data<Transformer<CLIProps>>('transformer');
    const schema = await transformer.schema();
    if (!schema.plugin) {
      schema.plugin = {};
    }
    const dirname = typeof __dirname === 'undefined'
      //@ts-ignore - import.meta only exists in esm builds
      ? path.dirname(fileURLToPath(import.meta.url))
      : __dirname;
    schema.plugin[`${dirname}/transform`] = {};
  });
}
