//node
import fs from 'node:fs';
import path from 'node:path';
//modules
import type { HttpServer } from '@stackpress/ingest';
import type {
  AgentRuntime,
  Caller,
  NormalizedToolConfig,
  ToolResolverServer
} from 'stackpress-ai';
import { PGlite } from '@electric-sql/pglite';
import { connect } from '@stackpress/inquire-pglite';
import { collectTools, callTool, runTurn } from 'stackpress-ai/scripts';
import { server as http } from 'stackpress/http';
import { Session } from 'stackpress/session';
//client
import ProfileStore from 'blog-client/Profile/ProfileStore';
import ArticleStore from 'blog-client/Article/ArticleStore';
import CommentStore from 'blog-client/Comment/CommentStore';
import listenProfile from 'blog-client/Profile/events/index';
import listenArticle from 'blog-client/Article/events/index';
import listenComment from 'blog-client/Comment/events/index';
//app
import type { Config } from '../config/common.js';
import { agent as agentConfig, session as sessionConfig } from '../config/common.js';
import { useOffline } from '../plugins/app/agent.js';
import plugin from '../plugins/app/plugin.js';

//--------------------------------------------------------------------//
// Fixture

//One isolated application per call: an in-memory database holding the
// generated blog tables, the blog's real access rules, the generated model
// events, and the blog app plugin with the tools it offers. Nothing reads or
// writes the blog's own database.
//
// The tests import the client that `yarn blog generate` writes to
// node_modules/blog-client, which is disposable and not committed. On a clean
// checkout run `yarn blog test:clean` (generate, then test), or run
// `yarn blog generate` once before `yarn blog test`.

//the request the agent and the tools take. The http server's own request
// type differs only in its resource type
export type ToolRequest = Parameters<typeof runTurn>[1];

export type Role = 'GUEST' | 'USER' | 'MANAGER' | 'ADMIN';

//a record the generated create event answers. Only its id is relied on
export type Row = Record<string, unknown> & { id: string };

//the in-memory databases opened by fixtures, closed by `closeFixtures`
const databases = new Set<PGlite>();

/**
 * Read a column of a row as a string, failing the test if it is not one.
 */
export function text(row: Record<string, unknown> | undefined, column: string) {
  const value = row?.[column];
  if (typeof value !== 'string') {
    throw new Error(`Expected ${column} to be a string, got ${typeof value}`);
  }
  return value;
}

/**
 * Close every database the fixtures opened.
 */
export async function closeFixtures() {
  const open = Array.from(databases);
  databases.clear();
  await Promise.all(open.map(database => database.close()));
}

/**
 * Import the generated store and event listener of every agent model the
 * generated client has, so the tables the agent runtime keeps (threads,
 * turns, actions, usage and whatever else the package adds) exist without the
 * tests naming them.
 */
async function agentModels() {
  const entry = import.meta.resolve('blog-client/package.json');
  const root = path.dirname(new URL(entry).pathname);
  const names = fs.readdirSync(root).filter(name => (
    name.startsWith('Agent')
    && fs.existsSync(path.join(root, name, `${name}Store.js`))
    && fs.existsSync(path.join(root, name, 'events', 'index.js'))
  )).sort();
  return Promise.all(names.map(async name => ({
    Store: (await import(`blog-client/${name}/${name}Store`)).default,
    listen: (await import(`blog-client/${name}/events/index`)).default
  })));
}

/**
 * Create the tables of the stores. A table that points at one not made yet
 * is tried again after the others, so the order the stores are found in does
 * not matter. It fails when a pass makes none.
 */
async function createTables(
  engine: ReturnType<typeof connect>,
  stores: (new () => { create(): { engine: unknown } & PromiseLike<unknown> })[]
) {
  let pending = stores;
  while (pending.length) {
    const failed: typeof stores = [];
    let failure: unknown;
    for (const Store of pending) {
      try {
        const creation = new Store().create();
        creation.engine = engine;
        await creation;
      } catch (error) {
        failed.push(Store);
        failure = error;
      }
    }
    if (failed.length === pending.length) throw failure;
    pending = failed;
  }
}

/**
 * Build one isolated application with its tables, rules, events and tools.
 */
export async function createFixture() {
  const database = new PGlite();
  databases.add(database);
  const engine = connect(async () => database);
  const agents = await agentModels();
  //the stores create their own tables, so the columns are the generated ones
  const stores = [
    ProfileStore,
    ArticleStore,
    CommentStore,
    ...agents.map(agent => agent.Store)
  ];
  await createTables(engine, stores);

  const app = http();
  //the server as the blog plugins and the agent types see it
  const server = app as unknown as HttpServer<Config>;
  const resolver = app as unknown as ToolResolverServer;
  app.config.set({ database: { seed: 'test-seed' }, agent: agentConfig });
  app.register('database', engine);
  const session = Session.configure(
    sessionConfig.key,
    sessionConfig.seed,
    sessionConfig.access
  );
  app.register('session', session);
  const listeners = [
    listenProfile,
    listenArticle,
    listenComment,
    ...agents.map(agent => agent.listen)
  ];
  for (const listen of listeners) {
    listen(server);
  }
  plugin(server);
  await app.emit('listen', app.request(), app.response());
  //the agent answers with the blog's offline model. Its environment is empty
  // rather than the machine's, so no provider is ever called, whatever keys
  // are set where the tests run
  useOffline(server, {});
  const runtime = app.plugin<AgentRuntime>('agent');

  //create a record with the generated create event, so its defaults and
  // validation apply as they would in the app
  const make = async (event: string, data: Record<string, unknown>) => {
    const response = await app.resolve<Row>(
      event,
      app.request({ data })
    );
    if (response.code !== 200 || !response.results) {
      throw new Error(`${event} failed: ${response.error}`);
    }
    return response.results;
  };
  const profile = (roles: Role[], name = roles.join('-')) => make(
    'profile-create',
    { name, roles }
  );

  const tools = await collectTools(resolver);
  const tool = (name: string) => {
    const found = tools.find(tool => tool.name === name) as NormalizedToolConfig;
    if (!found) throw new Error(`Tool ${name} is not registered`);
    return found;
  };

  //the request a signed in person's agent turn arrives on
  const withToken = (token: string) => app.request({
    url: 'http://localhost/agent/chat',
    method: 'POST',
    session: new Map([ [ sessionConfig.key, token ] ])
  }) as unknown as ToolRequest;
  const token = (profileId: string, roles: Role[]) => session.create(
    { id: profileId, name: 'Test', roles }
  );
  const signedIn = async (profileId: string, roles: Role[]) => withToken(
    await token(profileId, roles)
  );

  return {
    app,
    engine,
    runtime,
    make,
    profile,
    tool,
    tools,
    signedIn,
    token,
    withToken,
    //run a tool the way the agent or an MCP transport does
    call: (
      name: string,
      input: Record<string, unknown>,
      who: Caller,
      origin?: ToolRequest,
      undone?: Parameters<typeof callTool>[5]
    ) => callTool(resolver, tool(name), input, who, origin, undone),
    //read one row straight from the database
    row: async (table: string, id: string) => {
      const rows = await engine.query<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE id = ?`,
        [ id ]
      );
      return rows[0];
    }
  };
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>;
