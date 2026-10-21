//node
import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
//modules
import type Server from '@stackpress/ingest/Server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Method } from '@stackpress/lib/types';
//stackpress-session
import type { OAuthPlugin } from 'stackpress-session/types';
//client
import type {
  AuthContext,
  McpHttpSession,
  McpPlugin,
  McpServer,
  McpSessionMode,
  Promiser,
  ToolRegistry,
  ToolResolverServer
} from '../types.js';
import {
  findForbiddenCall,
  readJsonBody,
  resolveListAuth,
  sameCaller,
  sendForbidden,
  sendJson,
  sendText,
  sendUnauthorized
} from '../helpers.js';
import { loadRegistry } from './tools.js';
import {
  buildAuthInfo,
  createOAuthMcpServer,
  GrantWatcherHandle,
  identityIsFullCredential,
  identityOwnerKey,
  isOriginAllowed,
  OAuthMcpRefusal,
  requiresFullCredentialForMethod,
  resolveMcpAuthContext,
  watchGrantForChanges,
  writeCorsPreflight,
  writeOAuthRefusal
} from '../oauth.js';

const HTTP_ATTACH_KEY = '__stackpress_ai_http_attached__';
const HTTP_BODY_UNSET = Symbol('HTTP_BODY_UNSET');

/**
 * Resolve the main server host and port from Stackpress config.
 */
export function resolveServerConfig(ctx: Server) {
  return {
    host: ctx.config.path('server.host', '127.0.0.1'),
    port: ctx.config.path('server.port', 3000)
  };
}

/**
 * Resolve the HTTP MCP transport config from MCP and server settings.
 */
export function resolveHttpConfig(ctx: Server) {
  return {
    endpoint: ctx.config.path('mcp.route', '/mcp'),
    host: ctx.config.path(
      'mcp.host',
      ctx.config.path('server.host', '127.0.0.1')
    ),
    mode: ctx.config.path('mcp.mode', 'stateful') as McpSessionMode,
    port: ctx.config.path(
      'mcp.port',
      ctx.config.path('server.port', 3000)
    )
  };
}

/**
 * configuration.md: `mcp.oauth` only ever carries a declared `resource`;
 * everything else (issuer, scopes, the verification operation) resolves
 * through the session service so an app cannot substitute a weaker
 * verifier through this object.
 */
export function resolveHttpOAuthResource(ctx: Server): string | undefined {
  return ctx.config.path<string | undefined>('mcp.oauth.resource');
}

/**
 * Determine whether the MCP HTTP route should attach to the main server.
 */
export function shouldAttachHttpToServer(ctx: Server) {
  const http = resolveHttpConfig(ctx);
  const server = resolveServerConfig(ctx);
  return http.host === server.host && http.port === server.port;
}

/**
 * This transport owns the Streamable HTTP server lifecycle and maps inbound
 * HTTP requests into one MCP session strategy.
 */
export class McpHttpServer {
  //this shutdown handle is exposed so the caller can stop the server cleanly
  public readonly shutdown: () => Promise<void>;
  //this callback resolves one caller auth context from a raw request
  protected _authResolver: (req: IncomingMessage) => Promise<AuthContext>;
  //this endpoint is the one HTTP path that accepts MCP requests
  protected _endpoint: string;
  //this flag prevents the shutdown path from running more than once
  protected _exiting = false;
  //this factory creates one MCP tool server whenever a session is needed
  protected _factory: McpPlugin;
  //this host binds the HTTP listener to the configured interface
  protected _host: string;
  //this mode decides whether requests reuse sessions or rebuild them
  protected _mode: McpSessionMode;
  //this port binds the HTTP listener to the configured port
  protected _port: number;
  //this promise bridge keeps the CLI event open until the server exits
  protected _promiser: Promiser<void>;
  //this loader returns the full registry so forbidden calls can be told apart
  // from missing tools before the transport runs
  protected _registry?: ToolRegistry;
  //this Node server accepts the HTTP requests for the MCP endpoint
  protected _service = createServer(this._handleRequest.bind(this));
  //this live session map lets stateful requests route back to the right
  // transport instance.
  protected _sessions: Record<string, McpHttpSession> = {};
  //the Stackpress runtime these requests dispatch tool events through;
  // only used by the OAuth-aware dispatch path below.
  protected _ctx?: ToolResolverServer;
  //configuration.md's declared resource for this listener; undefined when
  // `mcp.oauth` is not configured, which keeps every existing non-OAuth
  // behavior in this class completely unchanged.
  protected _oauthResource?: string;
  //the stable identity binding each saved session was first verified
  // against (recovery.md: "Bind anonymous sessions once to the first
  // verified profile/client/grant/resource").
  protected _owners: Record<string, string | undefined> = {};
  //one background list-changed watcher per bound oauth session
  protected _watchers: Record<string, GrantWatcherHandle> = {};
  //storage.md: "at most five seconds between polls" - a hard ceiling,
  //not a fixed value; tests may request a shorter one.
  protected _watchIntervalMs: number;

  /**
   * Store the transport configuration and prepare one shutdown callback.
   */
  public constructor(
    factory: McpPlugin,
    authResolver: (req: IncomingMessage) => Promise<AuthContext>,
    host: string,
    port: number,
    endpoint: string,
    mode: McpSessionMode,
    promiser: Promiser<void>,
    registry?: ToolRegistry,
    ctx?: ToolResolverServer,
    oauthResource?: string,
    watchIntervalMs = 5000
  ) {
    this._factory = factory;
    this._authResolver = authResolver;
    this._host = host;
    this._port = port;
    this._endpoint = endpoint;
    this._mode = mode;
    this._promiser = promiser;
    this._registry = registry;
    this._ctx = ctx;
    this._oauthResource = oauthResource;
    this._watchIntervalMs = watchIntervalMs;
    this.shutdown = async () => {
      if (this._exiting) return;
      this._exiting = true;
      await this._closeSessions();
      await this._closeService();
    };
  }

  /**
   * Handle one raw Node request without creating a dedicated listener.
   */
  public async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown = HTTP_BODY_UNSET
  ) {
    await this._handleRequest(req, res, body);
  }

  /**
   * Start listening for HTTP MCP requests.
   */
  public async start() {
    //when the process is interrupted, close the transport cleanly
    process.once('SIGINT', this.shutdown);

    //these events settle the outer CLI promise when the server stops
    this._service.on('close', () => this._promiser.resolve());
    this._service.on('error', error => this._promiser.reject(error));

    //now listen on the configured address and surface startup errors
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this._service.once('error', onError);
      this._service.listen(this._port, this._host, () => {
        this._service.off('error', onError);
        resolve();
      });
    });
  }

  /**
   * Close the underlying Node HTTP service.
   */
  protected async _closeService() {
    await new Promise<void>((resolve, reject) => {
      this._service.close(error => error ? reject(error) : resolve());
    });
  }

  /**
   * Close every live HTTP session transport.
   */
  protected async _closeSessions() {
    for (const watcher of Object.values(this._watchers)) {
      watcher.stop();
    }
    this._watchers = {};
    await Promise.all(
      Object.values(this._sessions).map(session => session.transport.close())
    );
  }

  /**
   * Resolve one MCP server instance from the registered factory.
   */
  protected async _createServer(auth: AuthContext): Promise<McpServer> {
    const server = await this._factory(auth);

    //a caller that sees no tools still gets a server with an empty list, so
    // only a factory that made no server at all is a failure here
    if (!server) {
      throw new Error('No MCP server was created for this caller.');
    }

    return server;
  }

  /**
   * Create one MCP session and attach it to the HTTP transport.
   */
  protected async _createSession(auth: AuthContext): Promise<McpHttpSession> {
    //first build one MCP tool server from the registered factory
    const server = await this._createServer(auth);
    let transport!: StreamableHTTPServerTransport;

    //then create the HTTP transport and record new session ids as they appear
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this._mode === 'stateless'
        ? undefined
        : () => randomUUID(),
      onsessioninitialized: sessionId => {
        this._sessions[sessionId] = { auth, server, transport };
      }
    });

    //when the transport closes, remove its session from the lookup table
    transport.onclose = async () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        delete this._sessions[sessionId];
        delete this._owners[sessionId];
        this._watchers[sessionId]?.stop();
        delete this._watchers[sessionId];
      }
    };

    await server.connect(transport);
    return { auth, server, transport };
  }

  /**
   * Build one MCP server whose tool handlers read identity per-call from
   * `extra.authInfo` instead of a session-creation-time snapshot, for an
   * OAuth-enabled resource (recovery.md: "recheck the authoritative
   * grant/account immediately before invoking a protected event").
   */
  protected async _createOAuthServer(): Promise<McpServer> {
    const server = await createOAuthMcpServer(this._ctx as ToolResolverServer);
    return server as unknown as McpServer;
  }

  /**
   * Create one dynamic-identity MCP session for an OAuth-enabled resource.
   */
  protected async _createOAuthSession(
    auth: AuthContext | undefined
  ): Promise<McpHttpSession> {
    const server = await this._createOAuthServer();
    let transport!: StreamableHTTPServerTransport;

    const owner = auth && identityOwnerKey(auth);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this._mode === 'stateless'
        ? undefined
        : () => randomUUID(),
      //the session id is only assigned while the SDK processes this very
      //initialize call, not when the transport is constructed - bind the
      //owner (and start its watcher) here, the first point it is known,
      //rather than trying to read transport.sessionId immediately after
      //this method returns (recovery.md: "Bind anonymous sessions once to
      //the first verified profile/client/grant/resource").
      onsessioninitialized: sessionId => {
        const session: McpHttpSession = {
          auth: auth || { kind: 'public' }, server, transport
        };
        this._sessions[sessionId] = session;
        if (owner) {
          this._owners[sessionId] = owner;
          this._startWatcher(sessionId, session, auth as AuthContext);
        }
      }
    });

    transport.onclose = async () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        delete this._sessions[sessionId];
        delete this._owners[sessionId];
        this._watchers[sessionId]?.stop();
        delete this._watchers[sessionId];
      }
    };

    await server.connect(transport);
    return { auth: auth || { kind: 'public' }, server, transport };
  }

  /**
   * Route one inbound HTTP request into the correct MCP flow.
   */
  protected async _handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown = HTTP_BODY_UNSET
  ) {
    //an OAuth-enabled resource runs entirely through the identity-aware
    // dispatcher below; every other configuration keeps its exact
    // pre-existing behavior.
    if (this._oauthResource) {
      await this._dispatchOAuth(req, res, body);
      return;
    }

    try {
      //build one URL object so path matching works even on raw Node requests
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || `${this._host}:${this._port}`}`
      );

      //if the request missed the configured endpoint, then stop early
      if (url.pathname !== this._endpoint) {
        sendText(res, 404, 'Not Found');
        return;
      }

      //only POST requests carry JSON-RPC bodies, so read them conditionally
      const payload = req.method === 'POST'
        ? body === HTTP_BODY_UNSET
          ? await readJsonBody(req)
          : body
        : undefined;

      //stateless mode creates a fresh session per request and exits early
      if (this._mode === 'stateless') {
        await this._handleStatelessRequest(req, res, payload);
        return;
      }

      //otherwise route the request through the long-lived session flow
      await this._handleStatefulRequest(req, res, payload);
    } catch (error) {
      //if the response is still writable, translate the failure to JSON-RPC
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: (error as Error).message
          },
          id: null
        });
      } else {
        //if headers already left the server, then just close the socket
        res.end();
      }
    }
  }

  /**
   * recovery.md's full identity-aware HTTP dispatch for an OAuth-enabled
   * resource: Origin checks, the saved/per-request method rules, fresh
   * per-request verification carried through `req.auth`, control/DELETE
   * credential strength, session binding, and the 401/403/404/405/503
   * reply table.
   */
  protected async _dispatchOAuth(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ) {
    const ctx = this._ctx as ToolResolverServer;
    const resource = this._oauthResource as string;
    let oauth: OAuthPlugin | undefined;

    try {
      oauth = ctx.plugin<OAuthPlugin>('oauth');
      if (!oauth) {
        throw new OAuthMcpRefusal(503, 'service_unavailable', 'OAuth is not configured');
      }
      //configuration.md: "All OAuth handlers refuse requests with 503
      // until it succeeds" - assertFinalized() throws its own 503.
      oauth.assertFinalized();

      const origin = header(req, 'origin');
      if (origin && !isOriginAllowed(origin, oauth.config)) {
        throw new OAuthMcpRefusal(403, 'origin_not_allowed', 'Disallowed Origin');
      }

      if (req.method === 'OPTIONS') {
        writeCorsPreflight(
          res, origin,
          this._mode === 'stateless' ? 'POST, OPTIONS' : 'GET, POST, DELETE, OPTIONS'
        );
        return;
      }

      if (this._mode === 'stateless' && req.method !== 'POST' && req.method !== 'OPTIONS') {
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }

      const authorization = header(req, 'authorization');
      const auth = await resolveMcpAuthContext(
        ctx, resource, (req.method || 'GET') as Method, authorization
      );
      (req as IncomingMessage & { auth?: unknown }).auth = buildAuthInfo(
        auth || { kind: 'public' }
      );

      const payload = req.method === 'POST'
        ? (body === HTTP_BODY_UNSET ? await readJsonBody(req) : body)
        : undefined;
      if (Array.isArray(payload)) {
        throw new OAuthMcpRefusal(400, 'batch_not_supported', 'Batch requests are not supported');
      }

      const sessionId = header(req, 'mcp-session-id');
      const session = sessionId ? this._sessions[sessionId] : undefined;
      if (sessionId && !session) {
        throw new OAuthMcpRefusal(404, 'unknown_session', 'Unknown MCP session');
      }

      const owner = auth ? identityOwnerKey(auth) : undefined;
      if (session && sessionId) {
        const bound = this._owners[sessionId];
        if (bound && owner !== bound) {
          throw new OAuthMcpRefusal(
            auth ? 403 : 401,
            'session_identity_mismatch',
            'This session is bound to a different identity'
          );
        }
      }

      const methodName = (payload as { method?: string } | undefined)?.method;
      const full = identityIsFullCredential(auth || { kind: 'public' });
      if (payload && requiresFullCredentialForMethod(methodName) && !full) {
        throw new OAuthMcpRefusal(401, 'invalid_token', 'A full access key is required for this operation');
      }
      if (req.method === 'DELETE' && !full) {
        throw new OAuthMcpRefusal(401, 'invalid_token', 'A full access key is required to end this session');
      }
      if (req.method === 'GET' && auth && !full) {
        throw new OAuthMcpRefusal(401, 'invalid_token', 'A full access key is required for this operation');
      }

      //a first verified identity binds an anonymous saved session once
      // (recovery.md), then closes the pre-auth notification stream.
      if (session && sessionId && !this._owners[sessionId] && owner && auth) {
        this._owners[sessionId] = owner;
        session.transport.closeStandaloneSSEStream?.();
        this._startWatcher(sessionId, session, auth);
      }

      let activeSession = session;
      if (!activeSession) {
        if (this._mode === 'stateful' && !(payload && isInitializeRequest(payload))) {
          sendJson(res, 400, {
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null
          });
          return;
        }
        //owner binding (and starting its watcher) for a brand-new
        //session happens inside _createOAuthSession's own
        //onsessioninitialized callback, the first point a stateful
        //session's id actually exists; stateless mode has no session id
        //to bind at all.
        activeSession = await this._createOAuthSession(auth);
      }

      if (this._mode === 'stateless') {
        const transient = activeSession;
        res.on('close', () => { void transient.transport.close(); });
      }

      await activeSession.transport.handleRequest(req, res, payload);
    } catch (error) {
      writeOAuthRefusal(res, error, oauth?.config.issuer, resource);
    }
  }

  /**
   * Start a bounded, advisory background poll that sends a generic
   * `notifications/tools/list_changed` signal when the bound grant's
   * safe summary changes (storage.md's grant-revision rule). Never
   * grants anything by itself; the next real call still runs the full
   * verifier.
   */
  protected _startWatcher(
    sessionId: string,
    session: McpHttpSession,
    auth: AuthContext
  ) {
    if (this._watchers[sessionId] || auth.kind !== 'oauth') {
      return;
    }
    this._watchers[sessionId] = watchGrantForChanges(
      this._ctx as ToolResolverServer,
      auth.identity.profileId,
      auth.identity.grantId,
      () => { void session.server.sendToolListChanged(); },
      this._watchIntervalMs
    );
  }

  /**
   * Handle one request in stateful session mode.
   */
  protected async _handleStatefulRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ) {
    //pull the MCP session id header into one stable string key
    const sessionId = req.headers['mcp-session-id'];
    const key = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    const session = typeof key === 'string' ? this._sessions[key] : undefined;

    //resolve the key again on every request so a key that died mid-session
    // stops working instead of riding on the session that was opened with it.
    const auth = await this._authResolver(req);
    if (auth.kind === 'invalid') {
      //if the session exists, then end it along with the key
      if (session) {
        await session.transport.close();
      }
      sendUnauthorized(res);
      return;
    }

    //if the caller already has a session, let that transport own the request
    // as long as the request presents the same key the session was opened by.
    if (session) {
      if (!sameCaller(session.auth, auth)) {
        sendUnauthorized(res);
        return;
      }
      if (await this._refuseCall(res, auth, body)) {
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    //without a session id, only initialize requests may create a new session
    if (!key && req.method === 'POST' && isInitializeRequest(body)) {
      const created = await this._createSession(auth);
      await created.transport.handleRequest(req, res, body);
      return;
    }

    //everything else is a bad request because the session could not be found
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided'
      },
      id: null
    });
  }

  /**
   * Answer 403 when the body calls a registered tool the caller lacks.
   */
  protected async _refuseCall(
    res: ServerResponse,
    auth: AuthContext,
    body: unknown
  ) {
    if (!this._registry) {
      return false;
    }

    const forbidden = await findForbiddenCall(this._registry, auth, body);
    if (!forbidden) {
      return false;
    }

    sendForbidden(res, forbidden.id, forbidden.name);
    return true;
  }

  /**
   * Handle one request in stateless session mode.
   */
  protected async _handleStatelessRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ) {
    //stateless transport only supports POST JSON-RPC requests
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.'
        },
        id: null
      });
      return;
    }

    //refuse a key that failed verification before any session is built
    const auth = await this._authResolver(req);
    if (auth.kind === 'invalid') {
      sendUnauthorized(res);
      return;
    }

    //refuse a call to a tool the caller lacks, since the per-caller registry
    // below would leave that tool out and the SDK would answer 200 not found.
    if (await this._refuseCall(res, auth, body)) {
      return;
    }

    //create one throwaway session and close it once the response finishes
    const session = await this._createSession(auth);
    res.on('close', async () => {
      await session.transport.close();
    });

    //now let the per-request transport answer the JSON-RPC payload
    await session.transport.handleRequest(req, res, body);
  }
}

/**
 * Start the MCP Streamable HTTP transport from Stackpress config.
 */
export default async function http(ctx: Server) {
  //start by loading the registered MCP server factory and transport config
  if (shouldAttachHttpToServer(ctx)) {
    attachHttpToServer(ctx);
    return;
  }

  const factory = ctx.plugin<McpPlugin>('mcp');
  const { endpoint, host, mode, port } = resolveHttpConfig(ctx);
  const oauthResource = resolveHttpOAuthResource(ctx);
  //build one per-request auth resolver so both stateless calls and new
  // stateful sessions use the same bearer parsing behavior.
  const authResolver = async (req: IncomingMessage) => resolveListAuth(
    ctx as ToolResolverServer,
    header(req, 'authorization') || undefined
  );
  const registry = loadRegistry(ctx as ToolResolverServer);

  //configuration.md: "AI standalone HTTP/SSE entrypoints call finalize
  // before listening, after Terminal.bootstrap has run config/listen/
  // route." A standalone listener has no outer app bootstrap to do this
  // for it, so it must call it itself; an attached listener's app
  // bootstrap owns that call instead (see attachHttpToServer, which never
  // calls finalize()).
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (oauth) {
    await oauth.finalize();
  }

  //then keep the event open until the underlying HTTP service closes
  return new Promise<void>(async (resolve, reject) => {
    const transport = new McpHttpServer(
      factory,
      authResolver,
      host,
      port,
      endpoint,
      mode,
      { resolve, reject },
      registry,
      ctx as ToolResolverServer,
      oauthResource
    );

    //finally start listening on the configured interface
    await transport.start();
  });
}

/**
 * Attach the MCP HTTP handler to the main Stackpress server request pipeline.
 */
export function attachHttpToServer(ctx: Server) {
  //cast once so the attach marker can live on the request pipeline host
  const attachable = ctx as Server & Record<string, unknown>;

  if (attachable[HTTP_ATTACH_KEY]) {
    return;
  }

  attachable[HTTP_ATTACH_KEY] = true;
  const factory = ctx.plugin<McpPlugin>('mcp');
  const { endpoint, host, mode, port } = resolveHttpConfig(ctx);
  const oauthResource = resolveHttpOAuthResource(ctx);
  const authResolver = async (req: IncomingMessage) => resolveListAuth(
    ctx as ToolResolverServer,
    header(req, 'authorization') || undefined
  );
  const registry = loadRegistry(ctx as ToolResolverServer);
  const transport = new McpHttpServer(
    factory,
    authResolver,
    host,
    port,
    endpoint,
    mode,
    { resolve: () => undefined, reject: error => { throw error; } },
    registry,
    ctx as ToolResolverServer,
    oauthResource
  );

  ctx.on('request', async ({ req, res }) => {
    if (!(req.resource instanceof IncomingMessage)
      || !(res.resource instanceof ServerResponse)
    ) {
      return;
    }

    const im = req.resource;
    const sr = res.resource;
    const url = new URL(
      im.url || '/',
      `http://${im.headers.host || `${host}:${port}`}`
    );

    const methodMatches = im.method === 'POST' ||
      (!!oauthResource && (im.method === 'GET' || im.method === 'DELETE' || im.method === 'OPTIONS'));
    if (!methodMatches || url.pathname !== endpoint) {
      return;
    }

    //recovery.md: "All attached handlers pass body-only req.post() into
    // the SDK" - see the call site below.
    await transport.dispatch(im, sr, req.post());
    if (sr.headersSent) {
      res.stop();
      return false;
    }
  });
}

/**
 * Read one header value from a Node request, normalizing array values.
 */
function header(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value ?? null;
}

