import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  buildTools,
  callerFromAuth,
  findForbiddenCall,
  inferName,
  inferTitle,
  isLive,
  listToolsForAuth,
  normalizeTool,
  parseAuthorization,
  readJsonBody,
  requiresSecret,
  resolveApplication,
  resolveListAuth,
  resolveSession,
  resolveTool,
  sameCaller,
  sendJson,
  sendText,
  toMcpText,
  toolAllowed,
  validateInput,
  withToolData
} from '../src/helpers.js';
import { loadRegistry } from '../src/scripts/tools.js';
import type { AuthContext, ToolResolverServer } from '../src/types.js';
import {
  createApplication,
  createCtxStub,
  createMockRequest,
  createSession,
  MockResponse
} from './helpers.js';

//this helper builds one app caller that holds the given scopes
function appAuth(scopes: string[], secret = 'secret'): AuthContext {
  return {
    kind: 'app',
    token: { token: `app_1:${secret}`, id: 'app_1', secret },
    application: createApplication({ scopes })
  };
}

describe('ai/registry', () => {
  it('should resolve plugin-mode tools and let config override metadata', async () => {
    const ctx = createCtxStub({
      resolves: {
        'article-tool': {
          results: {
            name: 'article_search',
            title: 'Article Search',
            description: 'Default description',
            method: 'GET',
            type: 'app',
            event: 'article-search',
            scopes: [ 'articles.read' ]
          }
        }
      }
    });

    const tools = await buildTools(ctx as unknown as ToolResolverServer, [{
      mode: 'plugin',
      event: 'article-tool',
      description: 'Search articles'
    }]);

    expect(tools).to.have.length(1);
    expect(tools[0].description).to.equal('Search articles');
    expect(tools[0].event).to.equal('article-search');
    expect(tools[0].name).to.equal('article_search');
  });

  it('should ignore invalid plugin results', async () => {
    const ctx = createCtxStub({
      resolves: {
        'invalid-tool': {
          results: [ 'bad' ]
        }
      }
    });

    const tools = await buildTools(ctx as unknown as ToolResolverServer, [{
      mode: 'plugin',
      event: 'invalid-tool'
    }]);

    expect(tools).to.deep.equal([]);
  });

  it('should default missing title from the event name', async () => {
    const tool = normalizeTool({
      event: 'article-search',
      name: 'article_search',
      method: 'GET'
    });

    expect(tool?.title).to.equal('Article Search');
  });

  it('should prefer application auth over session auth in tools/list', async () => {
    const ctx = createCtxStub({
      application: createApplication(),
      session: createSession({ id: 'app_1' })
    });
    const auth = await resolveListAuth(
      ctx as unknown as ToolResolverServer,
      'Bearer app_1:secret'
    );

    expect(auth.kind).to.equal('app');
  });

  it('should keep a request with no key public', async () => {
    const ctx = createCtxStub();
    const server = ctx as unknown as ToolResolverServer;

    expect((await resolveListAuth(server)).kind).to.equal('public');
    expect((await resolveListAuth(server, 'Basic abc')).kind).to.equal('public');
  });

  it('should resolve a live user session key', async () => {
    const ctx = createCtxStub({ session: createSession() });
    const auth = await resolveListAuth(
      ctx as unknown as ToolResolverServer,
      'Bearer session_1:secret'
    );

    expect(auth.kind).to.equal('user');
  });

  it('should resolve an unknown key to invalid instead of public', async () => {
    const ctx = createCtxStub();
    const auth = await resolveListAuth(
      ctx as unknown as ToolResolverServer,
      'Bearer nobody:secret'
    );

    expect(auth.kind).to.equal('invalid');
  });

  it('should resolve an inactive key to invalid', async () => {
    const server = (options: object) => createCtxStub(
      options
    ) as unknown as ToolResolverServer;

    expect((await resolveListAuth(
      server({ application: createApplication({ active: false }) }),
      'Bearer app_1:secret'
    )).kind).to.equal('invalid');
    expect((await resolveListAuth(
      server({ session: createSession({ active: false }) }),
      'Bearer session_1:secret'
    )).kind).to.equal('invalid');
  });

  it('should resolve an expired key to invalid', async () => {
    const past = new Date(Date.now() - 1000);
    const server = (options: object) => createCtxStub(
      options
    ) as unknown as ToolResolverServer;

    expect((await resolveListAuth(
      server({ application: createApplication({ expires: past }) }),
      'Bearer app_1:secret'
    )).kind).to.equal('invalid');
    expect((await resolveListAuth(
      server({ session: createSession({ expires: past.toISOString() }) }),
      'Bearer session_1:secret'
    )).kind).to.equal('invalid');
  });

  it('should resolve a missing or wrong secret to invalid', async () => {
    const ctx = createCtxStub({
      application: createApplication(),
      session: createSession()
    });
    const server = ctx as unknown as ToolResolverServer;

    expect((await resolveListAuth(server, 'Bearer app_1')).kind)
      .to.equal('invalid');
    expect((await resolveListAuth(server, 'Bearer app_1:wrong')).kind)
      .to.equal('invalid');
    expect((await resolveListAuth(
      createCtxStub({ session: createSession() }) as unknown as ToolResolverServer,
      'Bearer session_1:wrong'
    )).kind).to.equal('invalid');
  });

  it('should not fall back to a session when the application key is dead', async () => {
    const ctx = createCtxStub({
      application: createApplication({ active: false }),
      session: createSession({ id: 'app_1' })
    });
    const auth = await resolveListAuth(
      ctx as unknown as ToolResolverServer,
      'Bearer app_1:secret'
    );

    expect(auth.kind).to.equal('invalid');
  });

  it('should treat only an explicit false or a past expiry as dead', () => {
    expect(isLive({})).to.equal(true);
    expect(isLive({ active: null, expires: null })).to.equal(true);
    expect(isLive({ active: false })).to.equal(false);
    expect(isLive({ expires: Date.now() + 60_000 })).to.equal(true);
    expect(isLive({ expires: Date.now() - 60_000 })).to.equal(false);
    expect(isLive({ expires: 'not a date' })).to.equal(false);
  });

  it('should filter app tools by scope and keep public tools', () => {
    const tools = [
      normalizeTool({
        name: 'public_ping',
        title: 'Public Ping',
        event: 'public-ping',
        type: 'public',
        method: 'GET'
      })!,
      normalizeTool({
        name: 'article_search',
        title: 'Article Search',
        event: 'article-search',
        type: 'app',
        method: 'GET',
        scopes: [ 'articles.read' ]
      })!,
      normalizeTool({
        name: 'comment_search',
        title: 'Comment Search',
        event: 'comment-search',
        type: 'user',
        method: 'GET',
        scopes: [ 'comments.read' ]
      })!
    ];

    const filtered = listToolsForAuth(tools, appAuth([ 'articles.read' ]));

    expect(filtered.map(tool => tool.name)).to.deep.equal([
      'public_ping',
      'article_search'
    ]);
  });

  it('should parse bearer tokens with optional secret', () => {
    expect(parseAuthorization('Bearer app_1:secret')).to.deep.equal({
      token: 'app_1:secret',
      id: 'app_1',
      secret: 'secret'
    });
    expect(parseAuthorization('Bearer session_1')).to.deep.equal({
      token: 'session_1',
      id: 'session_1',
      secret: ''
    });
  });

  it('should inject session context for user tools', () => {
    const data = withToolData(
      normalizeTool({
        name: 'comment_create',
        title: 'Comment Create',
        event: 'comment-create',
        type: 'user',
        method: 'POST'
      })!,
      { body: 'hi' },
      callerFromAuth({
        kind: 'user',
        token: { token: 'session_1:secret', id: 'session_1', secret: 'secret' },
        session: createSession({ scopes: [ 'comments.write' ] })
      })!
    );

    expect(data).to.include({
      body: 'hi',
      profileId: 'profile_1',
      applicationId: 'app_1',
      sessionId: 'session_1'
    });
  });

  it('should classify every method as secret-required', () => {
    expect(requiresSecret('GET')).to.equal(true);
    expect(requiresSecret('POST')).to.equal(true);
    expect(requiresSecret('delete')).to.equal(true);
  });

  it('should require every listed scope, not any', () => {
    const tool = normalizeTool({
      name: 'article_publish',
      event: 'article-publish',
      type: 'app',
      method: 'POST',
      scopes: [ 'articles.read', 'articles.write' ]
    })!;

    expect(toolAllowed(tool, appAuth([ 'articles.read' ]))).to.equal(false);
    expect(toolAllowed(tool, appAuth([ 'articles.write' ]))).to.equal(false);
    expect(toolAllowed(tool, appAuth([ 'articles.read', 'articles.write' ])))
      .to.equal(true);
  });

  it('should require the secret on read tools too', () => {
    const tool = normalizeTool({
      name: 'article_search',
      event: 'article-search',
      type: 'app',
      method: 'GET',
      scopes: [ 'articles.read' ]
    })!;

    expect(toolAllowed(tool, appAuth([ 'articles.read' ], ''))).to.equal(false);
    expect(toolAllowed(tool, appAuth([ 'articles.read' ], 'wrong')))
      .to.equal(false);
    expect(toolAllowed(tool, appAuth([ 'articles.read' ]))).to.equal(true);
  });

  it('should gate user tools on session scopes and secret', () => {
    const tool = normalizeTool({
      name: 'comment_search',
      event: 'comment-search',
      type: 'user',
      method: 'GET',
      scopes: [ 'comments.read' ]
    })!;
    const user = (secret: string): AuthContext => ({
      kind: 'user',
      token: { token: `session_1:${secret}`, id: 'session_1', secret },
      session: createSession()
    });

    expect(toolAllowed(tool, user('secret'))).to.equal(true);
    expect(toolAllowed(tool, user(''))).to.equal(false);
    expect(toolAllowed(tool, appAuth([ 'comments.read' ]))).to.equal(false);
  });

  it('should never allow an invalid caller, even for public tools', () => {
    const tool = normalizeTool({
      name: 'public_ping',
      event: 'public-ping',
      type: 'public',
      method: 'GET'
    })!;

    expect(toolAllowed(tool, { kind: 'public' })).to.equal(true);
    expect(toolAllowed(tool, { kind: 'invalid' })).to.equal(false);
    expect(listToolsForAuth([ tool ], { kind: 'invalid' })).to.deep.equal([]);
  });

  it('should compare callers by the key they presented', () => {
    const one = appAuth([ 'articles.read' ]);

    expect(sameCaller({ kind: 'public' }, { kind: 'public' })).to.equal(true);
    expect(sameCaller({ kind: 'public' }, one)).to.equal(false);
    expect(sameCaller(one, { kind: 'public' })).to.equal(false);
    expect(sameCaller(one, appAuth([]))).to.equal(true);
    expect(sameCaller(one, appAuth([], 'other'))).to.equal(false);
    expect(sameCaller(one, { kind: 'invalid' })).to.equal(false);
    expect(sameCaller({ kind: 'invalid' }, one)).to.equal(false);
  });

  it('should find a call to a registered tool the caller lacks', async () => {
    let loads = 0;
    const tools = [
      normalizeTool({
        name: 'article_publish',
        event: 'article-publish',
        type: 'app',
        method: 'POST',
        scopes: [ 'articles.write' ]
      })!,
      normalizeTool({
        name: 'public_ping',
        event: 'public-ping',
        type: 'public',
        method: 'GET'
      })!
    ];
    const registry = async () => {
      loads++;
      return tools;
    };
    const call = (name: unknown, id = 7) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name }
    });
    const auth = appAuth([ 'articles.read' ]);

    expect(await findForbiddenCall(registry, auth, call('article_publish')))
      .to.deep.equal({ id: 7, name: 'article_publish' });
    expect(await findForbiddenCall(registry, auth, [
      call('public_ping', 1),
      call('article_publish', 2)
    ])).to.deep.equal({ id: 2, name: 'article_publish' });
    expect(await findForbiddenCall(registry, auth, {
      ...call('article_publish'),
      id: undefined
    })).to.deep.equal({ id: null, name: 'article_publish' });

    //allowed, unregistered, and non-call bodies are all left alone
    expect(await findForbiddenCall(registry, appAuth([ 'articles.write' ]),
      call('article_publish'))).to.equal(null);
    expect(await findForbiddenCall(registry, auth, call('missing_tool')))
      .to.equal(null);
    expect(loads).to.equal(5);
    expect(await findForbiddenCall(registry, auth, { method: 'tools/list' }))
      .to.equal(null);
    expect(await findForbiddenCall(registry, auth, call(42))).to.equal(null);
    expect(await findForbiddenCall(registry, auth, null)).to.equal(null);
    expect(loads).to.equal(5);
  });

  it('should load the full configured registry', async () => {
    const ctx = createCtxStub({
      config: {
        'mcp.tools': [{ name: 'public_ping', event: 'public-ping' }]
      }
    });
    const tools = await loadRegistry(ctx as unknown as ToolResolverServer)();

    expect(tools.map(tool => tool.name)).to.deep.equal([ 'public_ping' ]);
  });

  it('should validate input against a JSON schema when provided', () => {
    const tool = normalizeTool({
      name: 'article_search',
      title: 'Article Search',
      event: 'article-search',
      method: 'GET',
      input: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        },
        required: [ 'query' ]
      }
    })!;

    expect(validateInput(tool, { query: 'elden ring' })).to.deep.equal({
      query: 'elden ring'
    });
  });

  it('should infer the name and title of a tool that gives neither', async () => {
    const ctx = createCtxStub();
    const tools = await buildTools(ctx as unknown as ToolResolverServer, [
      { event: 'article-search' }
    ]);

    expect(tools).to.have.length(1);
    expect(tools[0].name).to.equal('article_search');
    expect(tools[0].title).to.equal('Article Search');
    expect(tools[0].method).to.equal('GET');
    expect(tools[0].type).to.equal('public');
  });

  it('should drop configs that cannot become tools', () => {
    //no event to call
    expect(normalizeTool({ event: '', name: 'a' })).to.equal(null);
    //a method the package does not support
    expect(normalizeTool({ event: 'a', name: 'a', method: 'TRACE' }))
      .to.equal(null);
    //no name, and no way to infer one
    expect(normalizeTool({ event: 'a' })).to.equal(null);
    expect(normalizeTool({ event: 'a', name: '   ' })).to.equal(null);
  });

  it('should reject bearer headers that carry no usable id', () => {
    expect(parseAuthorization('Bearer')).to.equal(null);
    expect(parseAuthorization('Bearer :secret')).to.equal(null);
    expect(parseAuthorization('Basic abc')).to.equal(null);
    expect(parseAuthorization(null)).to.equal(null);
  });

  it('should hide a tool of an unknown type from every caller', () => {
    const tool = {
      ...normalizeTool({ name: 'odd', event: 'odd', method: 'GET' })!,
      type: 'unknown'
    } as unknown as ReturnType<typeof normalizeTool> & object;

    expect(toolAllowed(tool, appAuth([ 'articles.read' ]))).to.equal(false);
  });

  it('should read a JSON body and treat an empty one as null', async () => {
    const json = await readJsonBody(createMockRequest({
      body: '{"a":1}'
    }) as never);
    const empty = await readJsonBody(createMockRequest() as never);
    const strings = await readJsonBody({
      async *[Symbol.asyncIterator]() {
        yield '{"b":';
        yield '2}';
      }
    } as never);

    expect(json).to.deep.equal({ a: 1 });
    expect(empty).to.equal(null);
    expect(strings).to.deep.equal({ b: 2 });
  });

  it('should infer both name and title when a resolved tool has neither', async () => {
    const ctx = createCtxStub({});
    const tool = await resolveTool(ctx as unknown as ToolResolverServer, {
      event: 'article-search-tool'
    });

    expect(tool?.name).to.equal('article_search_tool');
    expect(tool?.title).to.equal('Article Search Tool');
  });

  it('should reject tool configs with an unsupported http method', () => {
    expect(normalizeTool({ event: 'x', method: 'TRACE' })).to.equal(null);
  });

  it('should reject tool configs missing a callable event', () => {
    expect(normalizeTool({ event: '' })).to.equal(null);
  });

  it('should reject tool configs whose name collapses to empty', () => {
    expect(normalizeTool({ event: 'x', name: '   ' })).to.equal(null);
  });

  it('should reject tool configs whose inferred title collapses to empty', () => {
    expect(normalizeTool({ event: 'x', name: '___' })).to.equal(null);
  });

  it('should reject authorization headers that are missing or not bearer', () => {
    expect(parseAuthorization(undefined)).to.equal(null);
    expect(parseAuthorization(null)).to.equal(null);
    expect(parseAuthorization('Basic abc123')).to.equal(null);
    expect(parseAuthorization('Bearer   ')).to.equal(null);
  });

  it('should reject a bearer token that has no id half', () => {
    expect(parseAuthorization('Bearer :secret')).to.equal(null);
  });

  it('should stay public when no bearer token is presented to tools/list', async () => {
    const ctx = createCtxStub({});
    const auth = await resolveListAuth(ctx as unknown as ToolResolverServer, undefined);

    expect(auth).to.deep.equal({ kind: 'public' });
  });

  it('should treat non object-like application/session results as missing', async () => {
    const missingApplication = await resolveApplication(
      createCtxStub({
        resolves: { 'application-detail': { results: 'nope' as never } }
      }) as unknown as ToolResolverServer,
      'app_1'
    );
    const missingSession = await resolveSession(
      createCtxStub({
        resolves: { 'session-detail': { results: [] as never } }
      }) as unknown as ToolResolverServer,
      'session_1'
    );

    expect(missingApplication).to.equal(null);
    expect(missingSession).to.equal(null);
  });

  it('should inject the calling application id for app-scoped tool data', () => {
    const data = withToolData(
      normalizeTool({
        name: 'article_create',
        title: 'Article Create',
        event: 'article-create',
        type: 'app',
        method: 'POST'
      })!,
      { title: 'hi' },
      callerFromAuth({
        kind: 'app',
        token: { token: 'app_1:secret', id: 'app_1', secret: 'secret' },
        application: {
          id: 'app_1',
          name: 'App',
          secret: 'secret',
          scopes: [],
          active: true,
          expires: new Date(),
          created: new Date(),
          updated: new Date()
        }
      })!
    );

    expect(data).to.include({ title: 'hi', applicationId: 'app_1' });
  });

  it('should deny tools of an unrecognized type by default', () => {
    const tool = normalizeTool({
      name: 'x',
      title: 'X',
      event: 'x',
      method: 'GET'
    })!;

    expect(toolAllowed(
      { ...tool, type: 'admin' as never },
      { kind: 'public' }
    )).to.equal(false);
  });

  it('should require the matching secret half for non-get app methods', () => {
    const appTool = normalizeTool({
      name: 'article_create',
      title: 'Article Create',
      event: 'article-create',
      type: 'app',
      method: 'POST',
      scopes: []
    })!;
    const application = {
      id: 'app_1',
      name: 'App',
      secret: 'secret',
      scopes: [] as string[],
      active: true,
      expires: new Date(),
      created: new Date(),
      updated: new Date()
    };

    const allowed: AuthContext = {
      kind: 'app',
      token: { token: 'app_1:secret', id: 'app_1', secret: 'secret' },
      application
    };
    const wrongSecret: AuthContext = {
      kind: 'app',
      token: { token: 'app_1:wrong', id: 'app_1', secret: 'wrong' },
      application
    };
    const noSecret: AuthContext = {
      kind: 'app',
      token: { token: 'app_1', id: 'app_1', secret: '' },
      application
    };

    expect(toolAllowed(appTool, allowed)).to.equal(true);
    expect(toolAllowed(appTool, wrongSecret)).to.equal(false);
    expect(toolAllowed(appTool, noSecret)).to.equal(false);
  });

  it('should pass input through untouched when a tool declares no schema', () => {
    const tool = normalizeTool({
      name: 'ping',
      title: 'Ping',
      event: 'ping',
      method: 'GET'
    })!;

    expect(validateInput(tool, { a: 1 })).to.deep.equal({ a: 1 });
  });

  it('should wrap string and object results into the MCP text content shape', () => {
    expect(toMcpText('done')).to.deep.equal({
      content: [{ type: 'text', text: 'done' }]
    });
    expect(toMcpText({ ok: true })).to.deep.equal({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }]
    });
  });

  it('should infer stable machine names and readable titles', () => {
    expect(inferName('Article Search!!')).to.equal('article_search');
    expect(inferName('  --weird__event--  ')).to.equal('weird_event');
    expect(inferTitle('article_search')).to.equal('Article Search');
  });

  it('should send JSON and plain text responses with the expected headers', () => {
    const jsonRes = new MockResponse();
    sendJson(jsonRes as unknown as ServerResponse, 400, { ok: false });

    expect(jsonRes.statusCode).to.equal(400);
    expect(jsonRes.headers.get('content-type')).to.equal('application/json');
    expect(JSON.parse(jsonRes.body)).to.deep.equal({ ok: false });

    const textRes = new MockResponse();
    sendText(textRes as unknown as ServerResponse, 404, 'nope');

    expect(textRes.statusCode).to.equal(404);
    expect(textRes.headers.get('content-type'))
      .to.equal('text/plain; charset=utf-8');
    expect(textRes.body).to.equal('nope');
  });

  it('should read and parse a JSON request body, returning null when empty', async () => {
    const withBody = createMockRequest({ body: JSON.stringify({ a: 1 }) });
    expect(await readJsonBody(withBody as unknown as IncomingMessage))
      .to.deep.equal({ a: 1 });

    const empty = createMockRequest({ body: '' });
    expect(await readJsonBody(empty as unknown as IncomingMessage))
      .to.equal(null);
  });
});
