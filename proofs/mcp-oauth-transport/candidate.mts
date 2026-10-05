//node
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
//modules
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport }
  from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError }
  from '@modelcontextprotocol/sdk/types.js';

//these types describe only the in-memory proof and are not library API proposals
export type Grant = {
  person: string, client: string, approval: string, scopes: string[],
  revoked: boolean, active: boolean
};
type Credential = { id: string, secret: string, expires: number, grant: Grant };
type Session = {
  transport: StreamableHTTPServerTransport, server: Server, owner?: string
};
export type RpcBody = { id?: number, method?: string,
  params?: { name?: string, arguments?: Record<string, unknown> } };
export type AuthRequest = IncomingMessage & { auth?: AuthInfo };

/** Carry an HTTP auth refusal out to the boundary before streaming begins. */
export class Refusal extends Error {
  //the status and scope are consumed only by the HTTP boundary
  public constructor(public status: number, message: string,
    public scope?: string) {
    super(message);
  }
}

/** Prove request-local identity with real SDK transports and simple fake storage. */
export class Candidate {
  //tests advance the clock and backing rows without waiting for real expiry
  public now = 1000;
  public credentials = new Map<string, Credential>();
  public sessions = new Map<string, Session>();
  public effects: { person: string, approval: string, marker: unknown }[] = [];
  public beforeEffect?: () => Promise<void>;
  public base = '';
  public mode: 'stateful' | 'stateless';

  /** Select the same saved-session or per-request modes offered today. */
  public constructor(mode: 'stateful' | 'stateless') {
    this.mode = mode;
  }

  /** Add a disposable credential; grant identity stays stable across renewal. */
  public issue(grant: Grant, ttl = 900) {
    const id = randomUUID();
    const secret = randomUUID();
    this.credentials.set(id, { id, secret, grant, expires: this.now + ttl });
    return `${id}:${secret}`;
  }

  /** Freeze a fresh identity snapshot from this request's validated credential. */
  public verify(token?: string): AuthInfo | undefined {
    if (!token) return undefined;
    const parts = token.split(':');
    const record = this.credentials.get(parts[0]);
    if (!record || parts.length > 2 ||
      (parts.length === 2 && parts[1] !== record.secret) ||
      record.expires <= this.now || record.grant.revoked || !record.grant.active) {
      throw new Refusal(401, 'invalid_token');
    }
    const grant = record.grant;
    return Object.freeze({ token, clientId: grant.client,
      scopes: Object.freeze([ ...grant.scopes ]) as unknown as string[],
      extra: Object.freeze({ person: grant.person, approval: grant.approval,
        full: parts.length === 2 }) });
  }

  /** Check configured tool method and any-of scopes, never the outer POST. */
  public authorize(name: string, auth?: AuthInfo) {
    if (![ 'public', 'read', 'write' ].includes(name)) {
      throw new Refusal(400, 'unknown_tool');
    }
    if (name === 'public') return;
    if (!auth) throw new Refusal(401, 'missing_token');
    if (name === 'write' && !auth.extra?.full) {
      throw new Refusal(401, 'full_key_required');
    }
    const scope = name === 'write' ? 'write' : 'read';
    if (!auth.scopes.includes(scope)) {
      throw new Refusal(403, 'insufficient_scope', scope);
    }
  }

  /** Run the HTTP checks before handing the request to the SDK. */
  public async dispatch(req: AuthRequest, res: ServerResponse, parsed?: RpcBody) {
    try {
      if (req.url?.split('?')[0] !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      //same-origin browser calls are allowed; native clients omit Origin
      if (req.headers.origin && req.headers.origin !== this.base) {
        throw new Refusal(403, 'origin_not_allowed');
      }
      if (this.mode === 'stateless' && req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      const authorization = req.headers.authorization;
      if (authorization && !authorization.startsWith('Bearer ')) {
        throw new Refusal(401, 'invalid_token');
      }
      const token = authorization?.slice(7);
      if (authorization && !token) throw new Refusal(401, 'invalid_token');
      const auth = this.verify(token);
      req.auth = auth;
      const body = req.method === 'POST'
        ? parsed || await this._read(req) : undefined;
      //reject arrays instead of guessing which credential a mixed batch needs
      if (Array.isArray(body)) throw new Refusal(400, 'batch_not_supported');
      const sessionId = req.headers['mcp-session-id'];
      let session = typeof sessionId === 'string'
        ? this.sessions.get(sessionId) : undefined;
      if (sessionId && !session) throw new Refusal(404, 'unknown_session');
      const owner = auth ? this._owner(auth) : undefined;
      if (session?.owner && owner !== session.owner) {
        throw new Refusal(auth ? 403 : 401, 'session_identity_mismatch');
      }
      if (body?.method === 'tools/call') {
        this.authorize(body.params?.name || '', auth);
      }
      if (req.method === 'DELETE' && !auth?.extra?.full) {
        throw new Refusal(401, 'full_key_required');
      }
      if (req.method === 'GET' && auth && !auth.extra?.full) {
        throw new Refusal(401, 'full_key_required');
      }
      const publicControls = [ 'initialize', 'notifications/initialized',
        'tools/list', 'tools/call' ];
      if (body && !publicControls.includes(body.method || '') &&
        !auth?.extra?.full) throw new Refusal(401, 'full_key_required');
      //a first successful approval binds an anonymous session once
      if (session && !session.owner && owner) {
        session.owner = owner;
        session.transport.closeStandaloneSSEStream();
      }
      if (!session) {
        if (this.mode === 'stateful' && body?.method !== 'initialize') {
          throw new Refusal(400, 'initialize_required');
        }
        session = await this._create(owner);
      }
      if (this.mode === 'stateless') {
        const transient = session;
        res.on('close', () => void transient.transport.close());
      }
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const refusal = error instanceof Refusal
        ? error : new Refusal(500, (error as Error).message);
      const headers: Record<string, string> = {
        'content-type': 'application/json', 'cache-control': 'no-store'
      };
      if (refusal.status === 401 || refusal.scope) {
        headers['www-authenticate'] = `Bearer resource_metadata="${
          this.base}/.well-known/oauth-protected-resource/mcp"`;
        if (refusal.scope) {
          headers['www-authenticate'] +=
            `, error="insufficient_scope", scope="${refusal.scope}"`;
        }
      }
      res.writeHead(refusal.status, headers).end(JSON.stringify({
        error: refusal.message
      }));
    }
  }

  /** Publish only a generic list-changed signal, without protected data. */
  public async changed() {
    await Promise.all([ ...this.sessions.values() ].map(session =>
      session.server.sendToolListChanged()));
  }

  /** Close every SDK session during proof cleanup. */
  public async close() {
    await Promise.all([ ...this.sessions.values() ].map(session =>
      session.transport.close()));
  }

  /** Build handlers that consume the SDK's current request auth argument. */
  protected async _create(owner?: string) {
    const server = this._makeServer();
    const session: Session = { server, owner, transport: undefined! };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: this.mode === 'stateful' ? randomUUID : undefined,
      onsessioninitialized: id => { this.sessions.set(id, session); },
      onsessionclosed: id => { this.sessions.delete(id); }
    });
    await server.connect(session.transport);
    return session;
  }

  /** Share current-request handlers across real HTTP and older SSE transports. */
  protected _makeServer() {
    const server = new Server({ name: 'oauth-transport-proof', version: '1' },
      { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      //publish discoverable descriptions; custom availability is informational
      const auth = this.verify(extra.authInfo?.token);
      return { tools: [ 'public', 'read', 'write' ].map(name => {
        let available = true;
        try { this.authorize(name, auth); } catch { available = false; }
        return { name, description: name === 'public' ? 'Public example'
          : `Requires ${name} permission; calling it may ask you to sign in`,
        inputSchema: { type: 'object' as const },
        _meta: { 'stackpress/available': available } };
      }) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      await this.beforeEffect?.();
      //this is intentionally after dispatch; a late refusal is a protocol error
      try {
        const auth = this.verify(extra.authInfo?.token);
        this.authorize(request.params.name, auth);
        const effect = { person: String(auth?.extra?.person || 'public'),
          approval: String(auth?.extra?.approval || ''),
          marker: request.params.arguments?.marker };
        this.effects.push(effect);
        return { content: [ { type: 'text' as const,
          text: JSON.stringify(effect) } ] };
      } catch (error) {
        throw new McpError(-32001, (error as Error).message);
      }
    });
    return server;
  }

  /** Build the stable binding independent of token rotation and read IDs. */
  protected _owner(auth: AuthInfo) {
    return JSON.stringify([ auth.extra?.person, auth.clientId,
      auth.extra?.approval ]);
  }

  /** Read the body only for standalone requests; Ingest passes parsed data. */
  protected async _read(req: IncomingMessage): Promise<RpcBody> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString());
  }
}
