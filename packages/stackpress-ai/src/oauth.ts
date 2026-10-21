//node
import type { ServerResponse } from 'node:http';
//modules
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { fromJSONSchema } from 'zod';
import type { Method } from '@stackpress/lib/types';
//stackpress-session
import type { OAuthCredential, OAuthIdentity } from 'stackpress-session/types';
import {
  issuerMetadataPath,
  resourceMetadataPath
} from 'stackpress-session/oauth/metadata';
//stackpress-api
import { verifyLegacyMcpKey } from 'stackpress-api';
//client
import type {
  AuthContext,
  NormalizedToolConfig,
  ToolResolverServer
} from './types.js';
import {
  callerFromAuth,
  parseAuthorization,
  resolveApplication,
  resolveSession,
  toMcpText,
  toolAllowed,
  validateInput
} from './helpers.js';
import { callTool, collectTools, failed } from './scripts/tools.js';

export { issuerMetadataPath, resourceMetadataPath };

//--------------------------------------------------------------------//
// Error vocabulary (recovery.md's reply table), shared by the HTTP and
// older SSE dispatchers so both transports produce one consistent set
// of machine codes/challenges.

export type OAuthMcpErrorCode =
  | 'invalid_token'
  | 'insufficient_scope'
  | 'access_denied'
  | 'session_identity_mismatch'
  | 'unknown_session'
  | 'unknown_tool'
  | 'origin_not_allowed'
  | 'service_unavailable'
  | 'batch_not_supported'
  | 'invalid_request';

/** Carry an HTTP refusal out to the transport boundary before streaming begins. */
export class OAuthMcpRefusal extends Error {
  public constructor(
    public status: number,
    public code: OAuthMcpErrorCode,
    message?: string,
    public scope?: string
  ) {
    super(message || code);
    this.name = 'OAuthMcpRefusal';
  }
}

const OAUTH_ID_PREFIX = 'oauth_';

/**
 * storage.md: "The oauth_ namespace selects the OAuth verifier."
 */
export function isOAuthAccessToken(id: string): boolean {
  return id.startsWith(OAUTH_ID_PREFIX);
}

//recovery.md/the transport proof: "Anonymous initialization, initialized
// notification, tool listing, public tools and the initial GET connection
// are explicitly safe." Any other JSON-RPC method (including `ping` and
// a saved-session DELETE) is a control operation that needs a full key.
const SAFE_PUBLIC_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call'
]);

export function requiresFullCredentialForMethod(method?: string): boolean {
  return !!method && !SAFE_PUBLIC_METHODS.has(method);
}

//--------------------------------------------------------------------//
// Identity binding

/**
 * The stable binding key for one verified identity, independent of
 * token rotation and read-vs-full credential strength. Used to bind an
 * anonymous saved/legacy session once and reject a different identity
 * reusing it later.
 */
export function identityOwnerKey(auth: AuthContext): string | undefined {
  if (auth.kind === 'oauth') {
    return JSON.stringify([
      'oauth',
      auth.identity.profileId,
      auth.identity.clientId,
      auth.identity.grantId,
      auth.identity.resource
    ]);
  }
  if (auth.kind === 'app') {
    return JSON.stringify([ 'app', auth.application.id ]);
  }
  if (auth.kind === 'user') {
    return JSON.stringify([
      'user',
      auth.session.profileId,
      auth.session.applicationId,
      auth.session.id
    ]);
  }
  return undefined;
}

/** Whether this resolved identity presented the full id:secret credential. */
export function identityIsFullCredential(auth: AuthContext): boolean {
  if (auth.kind === 'oauth') {
    return auth.identity.credential === 'full';
  }
  if (auth.kind === 'app' || auth.kind === 'user') {
    return !!auth.token.secret.length;
  }
  return false;
}

//--------------------------------------------------------------------//
// Identity resolution

/**
 * Resolve the live caller identity for one MCP/SSE request. Returns
 * `undefined` for an anonymous caller (no bearer token at all); throws
 * `OAuthMcpRefusal` for a malformed, unknown, expired, or unbound
 * credential. Never falls back from a failed check to a public identity
 * (storage.md: "a supplied bad secret never becomes an ID-only read").
 */
export async function resolveMcpAuthContext(
  ctx: ToolResolverServer,
  resource: string,
  method: Method,
  authorization?: string | null
): Promise<AuthContext | undefined> {
  const token = parseAuthorization(authorization || undefined);
  if (!token) {
    return undefined;
  }

  const requiredCredential: OAuthCredential = method === 'GET' ? 'read' : 'full';

  if (isOAuthAccessToken(token.id)) {
    const response = await ctx.resolve<OAuthIdentity>('oauth-token-verify', {
      token: token.token,
      resource,
      surface: 'mcp',
      method,
      requiredCredential
    });
    if (!response || response.code !== 200 || !response.results) {
      throw new OAuthMcpRefusal(401, 'invalid_token', 'Invalid or expired access key');
    }
    return { kind: 'oauth', identity: response.results };
  }

  //storage.md "Upgrade Existing MCP Keys Explicitly": an unbound legacy
  //key is refused outright at an OAuth-enabled resource, never silently
  //treated as public and never falling through to a weaker check.
  const legacy = await resolveLegacyAuthContext(ctx, token.token, resource);
  if (!legacy) {
    throw new OAuthMcpRefusal(401, 'invalid_token', 'Unknown or unbound access key');
  }
  return legacy;
}

async function resolveLegacyAuthContext(
  ctx: ToolResolverServer,
  token: string,
  resource: string
): Promise<AuthContext | null> {
  const appIdentity = await verifyLegacyMcpKey(ctx, { kind: 'app', token, resource });
  if (appIdentity) {
    const application = await resolveApplication(ctx, appIdentity.applicationId);
    if (!application) {
      return null;
    }
    const [ id, secret ] = token.split(':');
    return { kind: 'app', token: { token, id, secret: secret || '' }, application };
  }

  const sessionIdentity = await verifyLegacyMcpKey(ctx, { kind: 'session', token, resource });
  if (sessionIdentity) {
    const session = await resolveSession(ctx, sessionIdentity.legacyId);
    if (!session) {
      return null;
    }
    const [ id, secret ] = token.split(':');
    return { kind: 'user', token: { token, id, secret: secret || '' }, session };
  }

  return null;
}

//--------------------------------------------------------------------//
// Carrying identity through req.auth -> extra.authInfo

/**
 * Wrap one resolved auth context as the SDK's `AuthInfo` shape so the
 * real StreamableHTTP/SSE transports carry it from `req.auth` into every
 * handler's `extra.authInfo` for that exact request (proof-results.md:
 * "The SDK carries request-local req.auth into each handler's
 * extra.authInfo"). The full richer context lives under `extra.context`;
 * nothing secret (no raw token/secret) is placed in the SDK-visible
 * `token` field for an oauth identity, since OAuthIdentity never retains it.
 */
export function buildAuthInfo(auth: AuthContext): AuthInfo | undefined {
  //a refused key never reaches a handler; the transport answered it already
  if (auth.kind === 'public' || auth.kind === 'invalid') {
    return undefined;
  }
  if (auth.kind === 'oauth') {
    return {
      token: '',
      clientId: auth.identity.clientId,
      scopes: auth.identity.scopes,
      extra: { context: auth }
    };
  }
  if (auth.kind === 'app') {
    return {
      token: auth.token.token,
      clientId: auth.application.id,
      scopes: auth.application.scopes,
      extra: { context: auth }
    };
  }
  return {
    token: auth.token.token,
    clientId: auth.session.applicationId,
    scopes: auth.session.scopes,
    extra: { context: auth }
  };
}

function isAuthContext(value: unknown): value is AuthContext {
  return !!value && typeof value === 'object' &&
    typeof (value as { kind?: unknown }).kind === 'string';
}

/** Read the current request's identity back out of the SDK's extra. */
export function extractAuthContext(
  extra: { authInfo?: AuthInfo }
): AuthContext {
  const context = extra.authInfo?.extra?.context;
  return isAuthContext(context) ? context : { kind: 'public' };
}

//--------------------------------------------------------------------//
// Public tool-listing projection (Q-013 / recovery.md)

export type ToolListingEntry = {
  name: string,
  title: string,
  description?: string,
  inputSchema: Record<string, unknown>,
  outputSchema?: Record<string, unknown>
};

const RESERVED_OAUTH_FIELDS = [ 'profileId', 'applicationId', 'sessionId', 'oauth' ];

/**
 * events.md: reject caller-submitted reserved fields before anything
 * trusted is injected over them.
 */
export function assertNoReservedOAuthFields(payload: Record<string, unknown>) {
  for (const field of RESERVED_OAUTH_FIELDS) {
    if (field in payload) {
      throw new OAuthMcpRefusal(
        400,
        'invalid_request',
        `Reserved field "${field}" is not allowed in tool input`
      );
    }
  }
}

/**
 * recovery.md: "For protected tools, anonymous listings project only
 * accepted names/descriptions and a minimal protocol-required
 * inputSchema...suppress full input/output schemas, examples, enums,
 * defaults and other private metadata." Public tools and fully
 * authorized callers keep their real, callable contract.
 */
export function projectToolForListing(
  tool: NormalizedToolConfig,
  auth: AuthContext
): ToolListingEntry {
  if (tool.type === 'public' || toolAllowed(tool, auth)) {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input || { type: 'object' },
      ...(tool.output ? { outputSchema: tool.output } : {})
    };
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: 'object' }
  };
}

//--------------------------------------------------------------------//
// Dynamic (per-request identity) MCP server for OAuth-enabled resources
//
// The existing createMcpServer()/registerCallTools() in plugin.ts build
// one registry filtered to, and one set of handlers closed over, the
// identity that existed when the session/server was *created*. That is
// exactly the stale-identity defect proof-results.md reproduces for
// saved HTTP/SSE sessions. For an OAuth-enabled resource the full
// registry is always registered (so an unknown tool name is rejected by
// the SDK itself, before any read/write classification runs), and every
// call/list re-reads the *current* request's identity from
// `extra.authInfo` instead of a captured closure variable.

export async function createOAuthMcpServer(
  ctx: ToolResolverServer
): Promise<McpServer> {
  //the registry is the same one the plain transports and the agent use:
  // contributed tools merged with the configured ones
  const registry = await collectTools(ctx);

  const server = new McpServer({
    name: ctx.config.path('mcp.name', 'Stackpress AI Server'),
    version: ctx.config.path('mcp.version', '0.10.8'),
    title: ctx.config.path('mcp.title', 'Stackpress AI Server'),
    description: ctx.config.path<string | undefined>('mcp.description')
  });

  //a caller that sees no tools still connects and gets an empty list. The
  // SDK answers tools/list only once a tool has been registered, so switch
  // the tool handlers on with nothing listed.
  if (!registry.length) {
    server.registerTool('empty', {}, async () => toMcpText(null)).remove();
  }

  registerDynamicCallTools(server, ctx, registry);
  return server;
}

export function registerDynamicCallTools(
  server: McpServer,
  ctx: ToolResolverServer,
  tools: NormalizedToolConfig[]
) {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input
          ? fromJSONSchema(tool.input) as unknown as AnySchema
          : undefined,
        outputSchema: tool.output
          ? fromJSONSchema(tool.output) as unknown as AnySchema
          : undefined
      },
      //the SDK calls a zero-argument-schema tool's callback with only
      //`extra` (no `input`); registering a fixed two-parameter handler
      //for every tool would silently receive `extra` into the `input`
      //parameter and leave `extra` undefined for exactly those tools.
      (async (...args: unknown[]) => {
        const [ input, extra ] = (tool.input
          ? args
          : [ undefined, args[0] ]) as [unknown, RequestHandlerExtra<any, any>];
        //recovery.md: "...execution: 'not_started' only when the final
        //check prevented the business event from being invoked...Unknown
        //execution outcome does not carry not_started." Flip this only
        //once ctx.resolve() (the business event) is actually called.
        let started = false;
        try {
          //recovery.md: "recheck the authoritative grant/account
          //immediately before invoking a protected event" - the identity
          //read here is the one the transport verified for *this exact*
          //request, never a session-creation-time snapshot.
          const auth = extractAuthContext(extra);
          const who = callerFromAuth(auth);
          if (!who || !toolAllowed(tool, auth)) {
            throw new OAuthMcpRefusal(
              403, 'insufficient_scope', `Unauthorized MCP tool call: ${tool.name}`
            );
          }

          const payload = validateInput(
            tool,
            (input || {}) as Record<string, unknown>
          );
          assertNoReservedOAuthFields(payload);

          //the shared execution path records the caller and resolves the
          // tool's event, the same way the plain MCP door and the agent do
          started = true;
          const result = await callTool(ctx, tool, payload, who);

          //a refused or failed event is an error result, not a success
          if (failed(result)) {
            return {
              ...toMcpText(result.error || result.status || 'Tool call failed'),
              isError: true
            };
          }

          const results = result.results ?? null;
          const text = toMcpText(results);
          //the SDK validates `structuredContent` against a configured
          //outputSchema, never the rendered text content; include it
          //whenever the tool declares one so a real structured contract
          //is actually callable once authorized, not just listed.
          return tool.output && results && typeof results === 'object'
            ? { ...text, structuredContent: results as Record<string, unknown> }
            : text;
        } catch (error) {
          //recovery.md: "If headers have already been sent, return an
          //MCP protocol error with code -32001" - by the time a tool
          //handler runs, the SDK has already begun its JSON-RPC
          //dispatch, so every refusal here becomes a protocol error
          //rather than a fresh HTTP challenge.
          if (error instanceof McpError) {
            throw error;
          }
          //McpServer's own registerTool() wrapper turns a thrown error
          //into a plain isError text result built only from
          //error.message (it never reads McpError.data), so the
          //not_started marker is appended to the message text itself -
          //still advisory only, per recovery.md, not a new protocol field.
          const message = started
            ? (error as Error).message
            : `${(error as Error).message} (execution: not_started)`;
          throw new McpError(-32001, message);
        }
      }) as any
    );
  }

  //override the default list handler McpServer installs from the
  //registered tool configs above, so the response reflects the
  //*current* request's identity and the public projection rule.
  server.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const auth = extractAuthContext(extra as { authInfo?: AuthInfo });
    return { tools: tools.map(tool => projectToolForListing(tool, auth)) };
  });
}

//--------------------------------------------------------------------//
// Generic list-changed notifications (storage.md's grant-revision rule)
//
// storage.md: "persist a monotonic grant revision and have each process
// watch/poll revisions (at most five seconds between polls); also
// compare current account/policy state and expiry." No dedicated
// revision column is exposed by the fixed events this task may add to,
// so the already-safe `oauth-grants-list` summary (active/scopes/
// expires) is used as the practical, already-contract-defined signal: a
// changed snapshot triggers one generic, content-free notification. The
// poller is advisory only - the next real call still runs the full
// oauth-token-verify check, so a missed or stale poll cannot grant or
// retain access.

export type GrantWatcherHandle = { stop(): void };

type GrantSnapshot = { active: boolean, scopes: string, expires: number };

export function watchGrantForChanges(
  ctx: ToolResolverServer,
  profileId: string,
  grantId: string,
  onChanged: () => void,
  intervalMs = 5000
): GrantWatcherHandle {
  let stopped = false;
  let last: GrantSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const boundedInterval = Math.max(1, Math.min(intervalMs, 5000));

  const tick = async () => {
    if (stopped) return;
    try {
      const response = await ctx.resolve<Array<{
        grantId: string, active: boolean, scopes: string[], expires: Date
      }>>('oauth-grants-list', { profileId });
      const list = response?.results || [];
      const current = Array.isArray(list)
        ? list.find(item => item.grantId === grantId)
        : undefined;
      const snapshot: GrantSnapshot = current
        ? {
          active: current.active,
          scopes: [ ...current.scopes ].sort().join(','),
          expires: new Date(current.expires).getTime()
        }
        : { active: false, scopes: '', expires: 0 };
      if (last && (
        last.active !== snapshot.active ||
        last.scopes !== snapshot.scopes ||
        last.expires !== snapshot.expires
      )) {
        onChanged();
      }
      last = snapshot;
    } catch {
      //a failed background check must never grant access; it only
      //skips one generic signal, never a positive authorization result.
    } finally {
      if (!stopped) {
        timer = setTimeout(tick, boundedInterval);
      }
    }
  };

  timer = setTimeout(tick, boundedInterval);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

//--------------------------------------------------------------------//
// Shared HTTP/SSE error, Origin and preflight translation
//
// recovery.md's "Browser, Proxy And Local Connections" rules are the
// same for the Streamable HTTP and older SSE transports, so both
// scripts/http.ts and scripts/sse.ts share these pure translators
// instead of duplicating the reply shape.

/**
 * recovery.md: "For browser requests, compare exact parsed origins
 * against the configured service origin plus explicit additional
 * origins; reject null, wildcard and malformed origins." Native
 * requests with no Origin header are always permitted by the caller
 * before this function ever runs.
 */
export function isOriginAllowed(
  origin: string,
  config: { issuer: string, browserOrigins: string[] }
): boolean {
  if (origin === 'null' || origin === '*') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const allowed = [ config.issuer, ...config.browserOrigins ];
  return allowed.some(candidate => {
    try {
      return new URL(candidate).origin === parsed.origin;
    } catch {
      return false;
    }
  });
}

/**
 * recovery.md: "Handle OPTIONS without a bearer key but with origin/
 * method/header validation... Expose WWW-Authenticate, Mcp-Session-Id,
 * MCP-Protocol-Version and Retry-After; send Vary: Origin."
 */
export function writeCorsPreflight(
  res: ServerResponse,
  origin: string | null,
  allowedMethods: string
) {
  res.setHeader('Vary', 'Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', allowedMethods);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version, Retry-After'
  );
  res.writeHead(204).end();
}

function toRefusal(error: unknown): OAuthMcpRefusal {
  const status = typeof (error as { code?: unknown })?.code === 'number'
    ? (error as { code: number }).code
    : 500;
  return new OAuthMcpRefusal(status, 'invalid_token', (error as Error)?.message);
}

/**
 * recovery.md's reply table translated to HTTP: a 401/insufficient-scope
 * refusal carries the Bearer `resource_metadata` challenge pointing at
 * this resource's RFC 9728 document; once headers have already been
 * sent, only the socket is closed, since a fresh HTTP challenge is no
 * longer possible after streaming has begun ("If headers have already
 * been sent, return an MCP protocol error...Never claim a new HTTP
 * 401/403 was sent then" - the still-open stream's own JSON-RPC error
 * path, inside the registered tool handler, covers that case instead).
 */
export function writeOAuthRefusal(
  res: ServerResponse,
  error: unknown,
  issuer: string | undefined,
  resource: string
) {
  if (res.headersSent) {
    try { res.end(); } catch { /* already closing */ }
    return;
  }
  const refusal = error instanceof OAuthMcpRefusal ? error : toRefusal(error);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store'
  };
  if ((refusal.status === 401 || refusal.scope) && issuer) {
    headers['www-authenticate'] = `Bearer resource_metadata="${
      issuer}${resourceMetadataPath(resource)}"` + (refusal.scope
      ? `, error="insufficient_scope", scope="${refusal.scope}"`
      : '');
  }
  if (refusal.status === 405) {
    headers.allow = 'POST';
  }
  res.writeHead(refusal.status, headers).end(JSON.stringify({
    error: refusal.code,
    error_description: refusal.message
  }));
}
