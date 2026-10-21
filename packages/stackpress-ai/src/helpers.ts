//node
import type { IncomingMessage, ServerResponse } from 'node:http';
//modules
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fromJSONSchema } from 'zod';
import type { Application, Session } from 'stackpress-api/types';
//client
import type {
  AuthContext,
  Caller,
  NormalizedToolConfig,
  Token,
  ToolConfig,
  ToolRegistry,
  ToolResolverServer
} from './types.js';

//this supported method list is owned by normalization so the package has one
// definition of the verbs a tool may declare.
const METHODS = [ 'GET', 'POST', 'PUT', 'PATCH', 'DELETE' ] as const;

type SupportedMethod = typeof METHODS[number];

//these fields tell a tool event who is calling, so tool input may not carry
// them.
const IDENTITY_FIELDS = [
  'profileId',
  'applicationId',
  'sessionId',
  'oauth'
] as const;

//--------------------------------------------------------------------//
// Functions

/**
 * Build the full normalized tool registry from config entries.
 */
export async function buildTools(
  ctx: ToolResolverServer,
  configs: ToolConfig[]
) {
  const tools = await Promise.all(
    configs.map(config => resolveTool(ctx, config))
  );

  return tools.filter(
    (tool): tool is NormalizedToolConfig => tool !== null
  );
}

/**
 * Resolve one tool entry into the normalized runtime shape.
 */
export async function resolveTool(
  ctx: ToolResolverServer,
  config: ToolConfig
): Promise<NormalizedToolConfig | null> {
  const merged = await resolveToolConfig(ctx, config);

  //if the plugin did not give back a usable tool config, then drop it
  if (!merged) {
    return null;
  }

  //finally normalize defaults and reject unsupported methods
  return normalizeTool(merged);
}

/**
 * Resolve one tool entry into a named but not yet normalized config, so two
 * entries for the same tool can be merged before defaults fill in the gaps.
 */
export async function resolveToolConfig(
  ctx: ToolResolverServer,
  config: ToolConfig
): Promise<ToolConfig | null> {
  //if the config is deferred, first ask the plugin event for its defaults
  const resolved = config.mode === 'plugin'
    ? await resolvePluginTool(ctx, config)
    : config;

  //if the plugin did not give back a usable tool config, then drop it
  if (!resolved) {
    return null;
  }

  //now merge the resolved defaults with the original config so the explicit
  // config remains the final authority.
  const merged = config.mode === 'plugin'
    ? mergePluginTool(resolved, config)
    : mergeTool(config, resolved);

  //if the config did not name the tool, derive a stable machine name
  if (!merged.name) {
    merged.name = inferName(merged.event);
  }

  return merged;
}

/**
 * Ask a plugin resolver event for one deferred tool definition.
 */
export async function resolvePluginTool(
  ctx: ToolResolverServer,
  config: ToolConfig
) {
  const response = await ctx.resolve<ToolConfig>(config.event, config);
  const results = response?.results;

  //if the plugin did not return one object-like config, ignore it quietly
  if (!isRecord(results)) {
    return null;
  }

  return results as ToolConfig;
}

/**
 * Merge one plugin result with the original config overrides.
 */
export function mergePluginTool(
  resolved: ToolConfig,
  config: ToolConfig
): ToolConfig {
  const {
    event: _resolverEvent,
    mode: _resolverMode,
    data: configData,
    ...configOverrides
  } = config;

  return {
    ...resolved,
    ...configOverrides,
    //the plugin can seed static data, but the template config wins on overlap
    data: {
      ...(resolved.data || {}),
      ...(configData || {})
    }
  };
}

/**
 * Merge two concrete tool configs into one shallow tool config.
 */
export function mergeTool(
  base: ToolConfig,
  overrides: ToolConfig
): ToolConfig {
  return {
    ...base,
    ...overrides,
    data: {
      ...(base.data || {}),
      ...(overrides.data || {})
    }
  };
}

/**
 * Normalize one tool config into the runtime contract.
 */
export function normalizeTool(
  config: ToolConfig
): NormalizedToolConfig | null {
  //if there is no callable event, this config cannot become a tool
  if (!config.event) {
    return null;
  }

  //normalize the method once so later helpers can treat it as authoritative
  const method = String(config.method || 'GET')
    .toUpperCase() as SupportedMethod;

  //if the method is not one we support, then drop the tool entirely
  if (!METHODS.includes(method)) {
    return null;
  }

  const name = config.name?.trim();

  //if there is still no stable name after inference, stop here
  if (!name) {
    return null;
  }

  const title = (config.title || inferTitle(name)).trim();

  //if the display title still collapsed to nothing, then reject it
  if (!title.length) {
    return null;
  }

  return {
    ...config,
    mode: 'event',
    type: config.type || 'public',
    name,
    title,
    method,
    scopes: config.scopes || [],
    data: config.data || {}
  };
}

/**
 * Parse a bearer token into the id and optional secret pair.
 */
export function parseAuthorization(
  authorization?: string | null
): Token | null {
  //without a header there is nothing to authenticate
  if (!authorization) {
    return null;
  }

  const [ scheme, token ] = authorization.split(' ');

  //if the header is not bearer auth, then it does not belong to this flow
  if (scheme?.toLowerCase() !== 'bearer' || !token?.trim().length) {
    return null;
  }

  const [ id, secret ] = token.split(':');

  //if the token did not even include an id, then it is unusable
  if (!id?.trim().length) {
    return null;
  }

  return {
    token: token.trim(),
    id: id.trim(),
    secret: secret?.trim() || ''
  };
}

/**
 * Resolve the auth context used by tools/list and tools/call.
 */
export async function resolveListAuth(
  ctx: ToolResolverServer,
  authorization?: string
): Promise<AuthContext> {
  //if there is no usable bearer token, then the caller is public only
  const token = parseAuthorization(authorization);
  if (!token) {
    return { kind: 'public' };
  }

  //first prefer application auth so the listing stays on the broader app view
  // when the same id could theoretically resolve in both tables.
  const application = await resolveApplication(ctx, token.id);
  if (application) {
    //a presented key must be live and carry the matching secret, otherwise
    // it is refused instead of being downgraded to a public caller.
    return isLive(application) && secretAllowed(token.secret, application.secret)
      ? { kind: 'app', token, application }
      : { kind: 'invalid' };
  }

  //only fall back to the user session if no application was found
  const session = await resolveSession(ctx, token.id);
  if (session) {
    return isLive(session) && secretAllowed(token.secret, session.secret)
      ? { kind: 'user', token, session }
      : { kind: 'invalid' };
  }

  //a key that matches neither table is unknown, which is not the same as no key
  return { kind: 'invalid' };
}

/**
 * Check that a key record is active and has not expired.
 */
export function isLive(record: {
  active?: boolean | null,
  expires?: Date | string | number | null
}) {
  //only an explicit false deactivates a key
  if (record.active === false) {
    return false;
  }

  //a key without an expiry never expires
  if (record.expires === null || record.expires === undefined) {
    return true;
  }

  //an unreadable expiry yields NaN, which fails the comparison and so refuses
  return new Date(record.expires).getTime() > Date.now();
}

/**
 * Resolve one application by id through Stackpress.
 */
export async function resolveApplication(
  ctx: ToolResolverServer,
  id: string
): Promise<Application | null> {
  const response = await ctx.resolve<Application>(
    'application-detail',
    { id }
  );

  //if the results are not object-like, then treat the lookup as missing
  if (!isRecord(response?.results)) {
    return null;
  }

  return response.results as Application;
}

/**
 * Resolve one user session by id through Stackpress.
 */
export async function resolveSession(
  ctx: ToolResolverServer,
  id: string
): Promise<Session | null> {
  const response = await ctx.resolve<Session>('session-detail', { id });

  //if the results are not object-like, then treat the lookup as missing
  if (!isRecord(response?.results)) {
    return null;
  }

  return response.results as Session;
}

/**
 * Merge static tool data, runtime input, and the caller's identity into one
 * payload. Identity fields are owned by the system: input can never set them,
 * so they are stripped from input and then written only from the caller.
 */
export function withToolData(
  tool: NormalizedToolConfig,
  input: Record<string, unknown>,
  caller?: Caller
) {
  const rest = { ...input };
  for (const field of IDENTITY_FIELDS) {
    delete rest[field];
  }

  //start with config defaults, then let caller input override those defaults
  const data: Record<string, unknown> = {
    ...tool.data,
    ...rest
  };

  //app-scoped tools often need the calling application id downstream.
  if (caller?.kind === 'app') {
    data.applicationId = caller.applicationId;
  }

  //if this is a user-scoped tool, then inject the user context that downstream
  // events expect to see.
  if (caller?.kind === 'user') {
    data.profileId = caller.profileId;
    data.applicationId = caller.applicationId;
    data.sessionId = caller.sessionId;
  }

  //an OAuth grant acts for one person. The event is told that person and
  // the grant that approved the call (client, grant, resource and scopes),
  // never the credential itself. It is written last so input cannot
  // overwrite it.
  if (caller?.kind === 'oauth') {
    data.profileId = caller.profileId;
    data.oauth = caller.oauth ? { ...caller.oauth } : undefined;
  }

  return data;
}

/**
 * Turn a verified auth context into the caller record a tool event receives.
 * A key that failed verification has no caller.
 */
export function callerFromAuth(auth?: AuthContext): Caller | null {
  if (!auth || auth.kind === 'public') {
    return { kind: 'public', scopes: [] };
  }

  if (auth.kind === 'app') {
    return {
      kind: 'app',
      applicationId: auth.application.id,
      scopes: [ ...auth.application.scopes ]
    };
  }

  if (auth.kind === 'user') {
    return {
      kind: 'user',
      profileId: auth.session.profileId,
      sessionId: auth.session.id,
      applicationId: auth.session.applicationId,
      scopes: [ ...auth.session.scopes ]
    };
  }

  //an OAuth identity is one person acting through an approved grant
  if (auth.kind === 'oauth') {
    return {
      kind: 'oauth',
      profileId: auth.identity.profileId,
      scopes: [ ...auth.identity.scopes ],
      oauth: {
        clientId: auth.identity.clientId,
        grantId: auth.identity.grantId,
        resource: auth.identity.resource,
        scopes: [ ...auth.identity.scopes ]
      }
    };
  }

  return null;
}

/**
 * Check whether one tool is visible for the given auth context.
 */
export function toolAllowed(
  tool: NormalizedToolConfig,
  auth: AuthContext
) {
  //a key that failed verification never sees or calls anything
  if (auth.kind === 'invalid') {
    return false;
  }

  //public tools are visible to every verified or anonymous caller
  if (tool.type === 'public') {
    return true;
  }

  //app tools only show up for apps that own every required scope
  if (tool.type === 'app') {
    return auth.kind === 'app'
      && hasRequiredScopes(auth.application.scopes, tool.scopes)
      && secretAllowed(auth.token.secret, auth.application.secret);
  }

  //user tools only show up for sessions that own every required scope. An
  // OAuth identity is a user too, under the OAuth spec's accepted rules: any
  // one matching scope is enough (Q-004), an empty list still needs a valid
  // identity (Q-006), and its credential strength must satisfy the method.
  if (tool.type === 'user') {
    if (auth.kind === 'oauth') {
      return hasAnyScope(auth.identity.scopes, tool.scopes)
        && oauthCredentialAllowed(tool.method, auth.identity.credential);
    }
    return auth.kind === 'user'
      && hasRequiredScopes(auth.session.scopes, tool.scopes)
      && secretAllowed(auth.token.secret, auth.session.secret);
  }

  return false;
}

/**
 * Return only the tools visible to one resolved auth context.
 */
export function listToolsForAuth(
  tools: NormalizedToolConfig[],
  auth: AuthContext
) {
  return tools.filter(tool => toolAllowed(tool, auth));
}

/**
 * Decide whether a method should require the secret half of the token pair.
 * Every method does now; the export stays for the public helpers subpath.
 */
export function requiresSecret(_method: string) {
  return true;
}

/**
 * Check whether two resolved callers are the same presented key.
 */
export function sameCaller(a: AuthContext, b: AuthContext) {
  if (a.kind === 'public' || b.kind === 'public') {
    return a.kind === b.kind;
  }

  //an OAuth identity has no key to compare; the same grant for the same
  // person, client and resource is the same caller
  if (a.kind === 'oauth' || b.kind === 'oauth') {
    return a.kind === 'oauth'
      && b.kind === 'oauth'
      && a.identity.grantId === b.identity.grantId
      && a.identity.profileId === b.identity.profileId
      && a.identity.clientId === b.identity.clientId
      && a.identity.resource === b.identity.resource;
  }

  return a.kind !== 'invalid'
    && b.kind !== 'invalid'
    && a.kind === b.kind
    && a.token.token === b.token.token;
}

/**
 * Find the first tools/call in one JSON-RPC body that names a registered tool
 * the caller may not use. The full registry is searched because the per-caller
 * registry no longer holds such a tool, so the MCP SDK would only answer
 * "tool not found" inside a 200.
 */
export async function findForbiddenCall(
  registry: ToolRegistry,
  auth: AuthContext,
  body: unknown
) {
  //a body can be one message or a batch of them
  const calls = (Array.isArray(body) ? body : [ body ]).filter(
    message => isRecord(message)
      && message.method === 'tools/call'
      && isRecord(message.params)
      && typeof message.params.name === 'string'
  ) as { id?: unknown, params: { name: string } }[];

  //skip loading the registry when the body calls nothing
  if (!calls.length) {
    return null;
  }

  const tools = await registry();
  for (const call of calls) {
    const tool = tools.find(tool => tool.name === call.params.name);
    //an unregistered name is left to the MCP SDK to report as not found
    if (tool && !toolAllowed(tool, auth)) {
      return { id: call.id ?? null, name: call.params.name };
    }
  }

  return null;
}

/**
 * Validate incoming MCP input against the tool's JSON schema.
 */
export function validateInput(
  tool: NormalizedToolConfig,
  input: Record<string, unknown>
) {
  //if the tool does not declare input, then pass the payload through untouched
  if (!tool.input) {
    return input;
  }

  //otherwise build a zod schema from JSON Schema and enforce it at the edge
  return fromJSONSchema(tool.input).parse(input) as Record<string, unknown>;
}

/**
 * Read and parse a JSON request body from a Node HTTP request.
 */
export async function readJsonBody(req: IncomingMessage) {
  const chunks: Uint8Array[] = [];

  //read the incoming stream into one buffer so JSON parsing has the full body
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8').trim();

  //if the request body is empty, represent that as a null payload
  if (!body.length) {
    return null;
  }

  return JSON.parse(body);
}

/**
 * Send a JSON response with the given status and body.
 */
export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Send a plain text response with the given status and body.
 */
export function sendText(
  res: ServerResponse,
  statusCode: number,
  body: string
) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

/**
 * Refuse a request whose key failed verification.
 */
export function sendUnauthorized(res: ServerResponse) {
  res.setHeader('WWW-Authenticate', 'Bearer');
  sendJson(res, 401, {
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null
  });
}

/**
 * Refuse a verified caller that lacks access to the named tool.
 */
export function sendForbidden(
  res: ServerResponse,
  id: unknown,
  name: string
) {
  sendJson(res, 403, {
    jsonrpc: '2.0',
    error: { code: -32002, message: `Forbidden MCP tool call: ${name}` },
    id
  });
}

/**
 * Wrap results into the MCP text content format.
 */
export function toMcpText<T>(results: T): CallToolResult {
  return {
    content: [{
      type: 'text',
      text: typeof results === 'string'
        ? results
        : JSON.stringify(results, null, 2)
    }]
  };
}

/**
 * Infer a machine-friendly tool name from an event name.
 */
export function inferName(event: string) {
  return event
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * Infer a display-friendly title from a tool name or event.
 */
export function inferTitle(value: string) {
  return value
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

/**
 * Narrow unknown values to plain object-like records.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check whether one caller has every scope a tool requires.
 */
function hasRequiredScopes(owned: string[], required: string[]) {
  return required.every(scope => owned.includes(scope));
}

/**
 * Check whether one OAuth grant holds any one of the scopes a tool lists, or
 * the tool lists none.
 */
function hasAnyScope(owned: string[], required: string[]) {
  return required.length === 0 || owned.some(scope => required.includes(scope));
}

/**
 * Check whether one OAuth identity's credential strength satisfies a tool's
 * method. The OAuth spec keeps ID-only read credentials: a GET tool accepts
 * one, and every other method needs the full key. Legacy app and user keys
 * get no such allowance; every method needs their secret.
 */
function oauthCredentialAllowed(
  method: string,
  credential: 'read' | 'full'
) {
  return String(method).toUpperCase() === 'GET' || credential === 'full';
}

/**
 * Check whether the caller supplied the secret that matches the stored one.
 */
function secretAllowed(provided: string, expected?: string | null) {
  return !!provided.length && !!expected?.length && provided === expected;
}
