import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  buildTools,
  inferName,
  inferTitle,
  listToolsForAuth,
  normalizeTool,
  parseAuthorization,
  readJsonBody,
  requiresSecret,
  resolveApplication,
  resolveListAuth,
  resolveSession,
  resolveTool,
  sendJson,
  sendText,
  toMcpText,
  toolAllowed,
  validateInput,
  withToolData
} from '../src/helpers.js';
import type { AuthContext, ToolResolverServer } from '../src/types.js';
import { createCtxStub, createMockRequest, MockResponse } from './helpers.js';

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
      application: {
        id: 'app_1',
        name: 'App',
        secret: 'secret',
        scopes: [ 'articles.read' ],
        active: true,
        expires: new Date(),
        created: new Date(),
        updated: new Date()
      },
      session: {
        id: 'app_1',
        applicationId: 'app_1',
        profileId: 'profile_1',
        secret: 'secret',
        scopes: [ 'comments.read' ],
        active: true,
        expires: new Date(),
        created: new Date(),
        updated: new Date()
      }
    });
    const auth = await resolveListAuth(
      ctx as unknown as ToolResolverServer,
      'Bearer app_1'
    );

    expect(auth.kind).to.equal('app');
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

    const filtered = listToolsForAuth(tools, {
      kind: 'app',
      token: { token: 'app_1', id: 'app_1', secret: '' },
      application: {
        id: 'app_1',
        name: 'App',
        secret: 'secret',
        scopes: [ 'articles.read' ],
        active: true,
        expires: new Date(),
        created: new Date(),
        updated: new Date()
      }
    });

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
      {
        kind: 'user',
        token: { token: 'session_1:secret', id: 'session_1', secret: 'secret' },
        session: {
          id: 'session_1',
          applicationId: 'app_1',
          profileId: 'profile_1',
          secret: 'secret',
          scopes: [ 'comments.write' ],
          active: true,
          expires: new Date(),
          created: new Date(),
          updated: new Date()
        }
      }
    );

    expect(data).to.include({
      body: 'hi',
      profileId: 'profile_1',
      applicationId: 'app_1',
      sessionId: 'session_1'
    });
  });

  it('should classify non-get methods as secret-required', () => {
    expect(requiresSecret('GET')).to.equal(false);
    expect(requiresSecret('POST')).to.equal(true);
    expect(requiresSecret('delete')).to.equal(true);
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

  it('should fall back to public when neither an application nor a session resolve', async () => {
    const ctx = createCtxStub({
      resolves: {
        'application-detail': { results: undefined },
        'session-detail': { results: undefined }
      }
    });
    const auth = await resolveListAuth(
      ctx as unknown as ToolResolverServer,
      'Bearer missing_1'
    );

    expect(auth).to.deep.equal({ kind: 'public' });
  });

  it('should fall back to the user session when no application matches the id', async () => {
    const ctx = createCtxStub({
      session: {
        id: 'session_1',
        applicationId: 'app_1',
        profileId: 'profile_1',
        secret: 'secret',
        scopes: [ 'comments.read' ],
        active: true,
        expires: new Date(),
        created: new Date(),
        updated: new Date()
      }
    });
    const auth = await resolveListAuth(
      ctx as unknown as ToolResolverServer,
      'Bearer session_1'
    );

    expect(auth.kind).to.equal('user');
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
      {
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
      }
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
