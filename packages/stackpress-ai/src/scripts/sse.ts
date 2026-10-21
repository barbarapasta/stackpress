//node
import { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
//modules
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type Server from '@stackpress/ingest/Server';
import type { Method } from '@stackpress/lib/types';
//stackpress-session
import type { OAuthPlugin } from 'stackpress-session/types';
//client
import type {
  AuthContext,
  McpPlugin,
  McpServer,
  McpSseSession,
  Promiser,
  ToolResolverServer
} from '../types.js';
import {
  readJsonBody,
  resolveListAuth,
  sendText
} from '../helpers.js';
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

const SSE_ATTACH_KEY = '__stackpress_ai_sse_attached__';
const SSE_BODY_UNSET = Symbol('SSE_BODY_UNSET');

/**
 * Resolve the SSE MCP transport config from SSE, MCP, and server settings.
 */
export function resolveSseConfig(ctx: Server) {
  return {
    endpoint: ctx.config.path(
      'mcp.sse.route',
      ctx.config.path('mcp.route', '/mcp')
    ),
    host: ctx.config.path(
      'mcp.sse.host',
      ctx.config.path(
        'mcp.host',
        ctx.config.path('server.host', '127.0.0.1')
      )
    ),
    key: ctx.config.path('mcp.sse.key', SSE_ATTACH_KEY),
    messages: ctx.config.path('mcp.messages', '/messages'),
    port: ctx.config.path(
      'mcp.sse.port',
      ctx.config.path(
        'mcp.port',
        ctx.config.path('server.port', 3000)
      )
    )
  };
}

/**
 * configuration.md: "For older SSE at another URL, set mcp.sse.oauth:
 * { resource } to that declared resource."
 */
export function resolveSseOAuthResource(ctx: Server): string | undefined {
  return ctx.config.path<string | undefined>('mcp.sse.oauth.resource');
}

/**
 * Determine whether the MCP SSE routes should attach to the main server.
 */
export function shouldAttachSseToServer(ctx: Server) {
  const sse = resolveSseConfig(ctx);
  return sse.host === ctx.config.path('server.host', '127.0.0.1')
    && sse.port === ctx.config.path('server.port', 3000);
}

/**
 * This transport owns the legacy SSE MCP server lifecycle and keeps each SSE
 * session paired with its message endpoint handler.
 */
export class McpSseServer {
  //this shutdown handle is exposed so the caller can stop the server cleanly
  public readonly shutdown: () => Promise<void>;
  //this callback resolves one caller auth context from a raw request
  protected _authResolver: (req: IncomingMessage) => Promise<AuthContext>;
  //this endpoint accepts the initial SSE connection request
  protected _endpoint: string;
  //this flag prevents the shutdown path from running more than once
  protected _exiting = false;
  //this factory creates one MCP tool server whenever a session is needed
  protected _factory: McpPlugin;
  //this host binds the HTTP listener to the configured interface
  protected _host: string;
  //this endpoint accepts follow-up POST messages for an SSE session
  protected _messages: string;
  //this port binds the HTTP listener to the configured port
  protected _port: number;
  //this promise bridge keeps the CLI event open until the server exits
  protected _promiser: Promiser<void>;
  //this Node server accepts the SSE handshake and message requests
  protected _service = createServer(this._handleRequest.bind(this));
  //this session map lets message requests route back to one live SSE session
  protected _sessions: Record<string, McpSseSession> = {};
  //the Stackpress runtime these requests dispatch tool events through;
  // only used by the OAuth-aware dispatch path below.
  protected _ctx?: ToolResolverServer;
  //configuration.md's declared resource for this SSE listener; undefined
  // when `mcp.sse.oauth` is not configured, which keeps every existing
  // non-OAuth behavior in this class completely unchanged.
  protected _oauthResource?: string;
  //the stable identity binding each SSE session was first verified
  // against (recovery.md: "Bind anonymous sessions once to the first
  // verified profile/client/grant/resource").
  protected _owners: Record<string, string | undefined> = {};
  //one background list-changed watcher per bound oauth session
  protected _watchers: Record<string, GrantWatcherHandle> = {};

  /**
   * Store the transport configuration and prepare one shutdown callback.
   */
  public constructor(
    factory: McpPlugin,
    authResolver: (req: IncomingMessage) => Promise<AuthContext>,
    host: string,
    port: number,
    endpoint: string,
    messages: string,
    promiser: Promiser<void>,
    ctx?: ToolResolverServer,
    oauthResource?: string
  ) {
    this._factory = factory;
    this._authResolver = authResolver;
    this._host = host;
    this._port = port;
    this._endpoint = endpoint;
    this._messages = messages;
    this._promiser = promiser;
    this._ctx = ctx;
    this._oauthResource = oauthResource;
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
    body: unknown = SSE_BODY_UNSET
  ) {
    await this._handleRequest(req, res, body);
  }

  /**
   * Start listening for SSE MCP requests.
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
   * Close every live SSE session transport.
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

    //if config produced no tools, fail loudly so the CLI does not hang
    if (!server) {
      throw new Error('Resolved MCP tool registry is empty.');
    }

    return server;
  }

  /**
   * Route one POST message into an existing SSE session.
   */
  protected async _handleMessageRequest(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: unknown = SSE_BODY_UNSET
  ) {
    //the session id lives in the query string for the SSE message endpoint
    const sessionId = url.searchParams.get('sessionId');

    //if the session is missing, then the message cannot be routed anywhere
    if (!sessionId || !this._sessions[sessionId]) {
      sendText(res, 404, 'Session not found');
      return;
    }

    //read the JSON body and hand it back to the active SSE transport
    const payload = body === SSE_BODY_UNSET
      ? await readJsonBody(req)
      : body;
    await this._sessions[sessionId].transport.handlePostMessage(req, res, payload);
  }

  /**
   * Route one inbound request into the SSE handshake or message flow.
   */
  protected async _handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown = SSE_BODY_UNSET
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

      //for GET on the SSE endpoint, start one long-lived event stream session
      if (req.method === 'GET' && url.pathname === this._endpoint) {
        await this._handleSseConnection(req, res);
        return;
      }

      //for POST on the message endpoint, route JSON-RPC messages to a session
      if (req.method === 'POST' && url.pathname === this._messages) {
        await this._handleMessageRequest(req, res, url, body);
        return;
      }

      //any other path or method misses the SSE transport contract
      sendText(res, 404, 'Not Found');
    } catch (error) {
      //if the response is still writable, send back one plain-text error
      if (!res.headersSent) {
        sendText(res, 500, (error as Error).message);
      } else {
        //if headers already left the server, then just close the socket
        res.end();
      }
    }
  }

  /**
   * recovery.md's identity-aware legacy SSE dispatch: fresh verification
   * on both the GET handshake and every message POST, control/full-key
   * rules, session binding and the 401/403/404/503 reply table. Unlike
   * Streamable HTTP, the GET stream is never closed at binding - older
   * SSE keeps that stream as its only reply channel, and a protected
   * result still requires a freshly verified POST (recovery.md: "Older
   * SSE retains its existing reply channel; protected results require
   * a fresh verified POST").
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
      const url = new URL(
        req.url || '/',
        `http://${req.headers.host || `${this._host}:${this._port}`}`
      );
      const isStream = req.method === 'GET' && url.pathname === this._endpoint;
      const isMessage = req.method === 'POST' && url.pathname === this._messages;
      const isPreflight = req.method === 'OPTIONS' &&
        (url.pathname === this._endpoint || url.pathname === this._messages);

      if (!isStream && !isMessage && !isPreflight) {
        sendText(res, 404, 'Not Found');
        return;
      }

      oauth = ctx.plugin<OAuthPlugin>('oauth');
      if (!oauth) {
        throw new OAuthMcpRefusal(503, 'service_unavailable', 'OAuth is not configured');
      }
      oauth.assertFinalized();

      const origin = header(req, 'origin');
      if (origin && !isOriginAllowed(origin, oauth.config)) {
        throw new OAuthMcpRefusal(403, 'origin_not_allowed', 'Disallowed Origin');
      }

      if (isPreflight) {
        writeCorsPreflight(res, origin, isStream ? 'GET, OPTIONS' : 'POST, OPTIONS');
        return;
      }

      const authorization = header(req, 'authorization');
      const auth = await resolveMcpAuthContext(
        ctx, resource, (req.method || 'GET') as Method, authorization
      );
      (req as IncomingMessage & { auth?: unknown }).auth = buildAuthInfo(
        auth || { kind: 'public' }
      );
      const owner = auth ? identityOwnerKey(auth) : undefined;
      const full = identityIsFullCredential(auth || { kind: 'public' });

      if (isStream) {
        //legacy-candidate.mts: "the GET stream carries later messages;
        // a supplied credential must prove full control even though
        // tool reads may later use only an ID."
        if (auth && !full) {
          throw new OAuthMcpRefusal(401, 'invalid_token', 'A full access key is required for this operation');
        }
        await this._createOAuthSseConnection(res, auth, owner);
        return;
      }

      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? this._sessions[sessionId] : undefined;
      if (!sessionId || !session) {
        throw new OAuthMcpRefusal(404, 'unknown_session', 'Unknown MCP session');
      }

      const bound = this._owners[sessionId];
      if (bound && owner !== bound) {
        throw new OAuthMcpRefusal(
          auth ? 403 : 401,
          'session_identity_mismatch',
          'This session is bound to a different identity'
        );
      }

      const payload = body === SSE_BODY_UNSET ? await readJsonBody(req) : body;
      if (Array.isArray(payload)) {
        throw new OAuthMcpRefusal(400, 'batch_not_supported', 'Batch requests are not supported');
      }

      const methodName = (payload as { method?: string } | undefined)?.method;
      if (payload && requiresFullCredentialForMethod(methodName) && !full) {
        throw new OAuthMcpRefusal(401, 'invalid_token', 'A full access key is required for this operation');
      }

      //bind once, then keep the person's/client's/approval's identity
      // stable; the only GET reply channel for this session stays open.
      if (!bound && owner && auth) {
        this._owners[sessionId] = owner;
        this._startWatcher(sessionId, session, auth);
      }

      await session.transport.handlePostMessage(req, res, payload);
    } catch (error) {
      writeOAuthRefusal(res, error, oauth?.config.issuer, resource);
    }
  }

  /**
   * Open one OAuth-aware SSE session, built from the full dynamic-identity
   * registry rather than the factory/auth snapshot the non-OAuth path uses.
   */
  protected async _createOAuthSseConnection(
    res: ServerResponse,
    auth: AuthContext | undefined,
    owner: string | undefined
  ) {
    const server = await createOAuthMcpServer(this._ctx as ToolResolverServer);
    if (!server) {
      throw new Error('Resolved MCP tool registry is empty.');
    }

    const transport = new SSEServerTransport(this._messages, res);
    const sessionId = transport.sessionId;
    const session: McpSseSession = {
      auth: auth || { kind: 'public' }, server: server as unknown as McpServer, transport
    };
    this._sessions[sessionId] = session;
    if (owner) {
      this._owners[sessionId] = owner;
      if (auth) this._startWatcher(sessionId, session, auth);
    }

    transport.onclose = async () => {
      delete this._sessions[sessionId];
      delete this._owners[sessionId];
      this._watchers[sessionId]?.stop();
      delete this._watchers[sessionId];
    };

    await server.connect(transport);
  }

  /**
   * Start a bounded, advisory background poll that sends a generic
   * `notifications/tools/list_changed` signal when the bound grant's
   * safe summary changes (storage.md's grant-revision rule).
   */
  protected _startWatcher(
    sessionId: string,
    session: McpSseSession,
    auth: AuthContext
  ) {
    if (this._watchers[sessionId] || auth.kind !== 'oauth') {
      return;
    }
    this._watchers[sessionId] = watchGrantForChanges(
      this._ctx as ToolResolverServer,
      auth.identity.profileId,
      auth.identity.grantId,
      () => { void session.server.sendToolListChanged(); }
    );
  }

  /**
   * Open one SSE session and register it in the live session map.
   */
  protected async _handleSseConnection(
    req: IncomingMessage,
    res: ServerResponse
  ) {
    const auth = await this._authResolver(req);
    //first build one MCP tool server from the registered factory
    const server = await this._createServer(auth);

    //then pair it with one SSE transport bound to the response stream
    const transport = new SSEServerTransport(this._messages, res);
    const sessionId = transport.sessionId;
    this._sessions[sessionId] = { auth, server, transport };

    //when the transport closes, remove its session from the lookup table
    transport.onclose = async () => {
      delete this._sessions[sessionId];
    };

    //finally connect the MCP server to the SSE transport
    await server.connect(transport);
  }
}

/**
 * Start the MCP SSE transport from Stackpress config.
 */
export default async function sse(ctx: Server) {
  //start by loading the registered MCP server factory and transport config
  if (shouldAttachSseToServer(ctx)) {
    attachSseToServer(ctx);
    return;
  }

  const factory = ctx.plugin<McpPlugin>('mcp');
  const { endpoint, host, messages, port } = resolveSseConfig(ctx);
  const oauthResource = resolveSseOAuthResource(ctx);
  //build one connection-level auth resolver so each SSE session binds to
  // the bearer token presented on the initial event-stream request.
  const authResolver = async (req: IncomingMessage) => resolveListAuth(
    ctx as ToolResolverServer,
    header(req, 'authorization') || undefined
  );

  //configuration.md: "AI standalone HTTP/SSE entrypoints call finalize
  // before listening, after Terminal.bootstrap has run config/listen/
  // route." An attached listener's app bootstrap owns that call instead
  // (see attachSseToServer, which never calls finalize()).
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (oauth) {
    await oauth.finalize();
  }

  //then keep the event open until the underlying HTTP service closes
  return new Promise<void>(async (resolve, reject) => {
    const transport = new McpSseServer(
      factory,
      authResolver,
      host,
      port,
      endpoint,
      messages,
      { resolve, reject },
      ctx as ToolResolverServer,
      oauthResource
    );

    //finally start listening on the configured interface
    await transport.start();
  });
}

/**
 * Attach the MCP SSE handlers to the main Stackpress server request pipeline.
 */
export function attachSseToServer(ctx: Server) {
  const { endpoint, host, key, messages, port } = resolveSseConfig(ctx);
  const oauthResource = resolveSseOAuthResource(ctx);
  //cast once so the configurable attach marker can live on the server context
  const attachable = ctx as Server & Record<string, unknown>;

  if (attachable[key]) {
    return;
  }

  attachable[key] = true;
  const factory = ctx.plugin<McpPlugin>('mcp');
  const authResolver = async (req: IncomingMessage) => resolveListAuth(
    ctx as ToolResolverServer,
    header(req, 'authorization') || undefined
  );
  const transport = new McpSseServer(
    factory,
    authResolver,
    host,
    port,
    endpoint,
    messages,
    { resolve: () => undefined, reject: error => { throw error; } },
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

    const matchesHandshake = url.pathname === endpoint &&
      (im.method === 'GET' || (!!oauthResource && im.method === 'OPTIONS'));
    const matchesMessages = url.pathname === messages &&
      (im.method === 'POST' || (!!oauthResource && im.method === 'OPTIONS'));
    if (!matchesHandshake && !matchesMessages) {
      return;
    }

    //recovery.md: "All attached handlers pass body-only req.post() into the
    // SDK; merged query data breaks strict JSON-RPC parsing." The existing
    // attached SSE path merged req.data()'s query sessionId into the
    // JSON-RPC body and failed strict schema validation; req.post() stays
    // body-only while still reusing the already-parsed Stackpress request.
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
