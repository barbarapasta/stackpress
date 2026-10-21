//modules
import type Request from '@stackpress/ingest/Request';
import type Response from '@stackpress/ingest/Response';
import type { StatusResponse } from '@stackpress/lib/types';
//stackpress-session/oauth
import type { NormalizedOAuthSessionConfig } from '../types.js';

//Shared HTTP-layer translation for every native OAuth protocol route
//(discovery/token/register/revoke). events.md: "Translate fixed event
//results into top-level OAuth JSON/status/headers, never a Stackpress
//results wrapper" and "Set no-store on token, authorization and
//connection-management responses." `res.results()`/a plain object body
//are wrapped in the framework's `{code,status,results,...}` envelope by
//the Node HTTP adapter; only a pre-serialized JSON string bypasses that,
//so every writer here goes through `res.json(string, code)`.

/**
 * The caller's rate-limit/CORS source address. Never trusts forwarded
 * headers by default (configuration.md: "Never trust arbitrary
 * forwarded headers") - only the actual peer address of the underlying
 * connection.
 */
export function sourceAddress(req: Request): string {
  const resource = req.resource as
    { socket?: { remoteAddress?: string } } | undefined;
  return resource?.socket?.remoteAddress || 'unknown';
}

export function setNoStore(res: Response): void {
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Pragma', 'no-cache');
}

//recovery.md: "Expose WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version
//and Retry-After...Apply equivalent explicit rules to token/registration
//clients." WWW-Authenticate/Mcp-Session-Id/MCP-Protocol-Version are set by
//the MCP/API layer (task 00009); this task's routes only ever set
//Retry-After, but the full set is still declared readable cross-origin so a
//browser-based client never needs a second CORS round trip to learn why.
const EXPOSED_HEADERS = 'WWW-Authenticate, Retry-After, Mcp-Session-Id, MCP-Protocol-Version';

/**
 * Writes a resolved fixed-event `StatusResponse` as a raw top-level
 * JSON reply: `results` fields at the object root on success, or
 * `{ error, error_description? }` on failure - never the Ingest
 * envelope, matching events.md exactly. configuration.md: "Rate refusal
 * is 429 with Retry-After" - a real header, not merely a body field - so
 * a `retryAfterSeconds` value attached by `clients/rateLimit.ts` (via
 * `events/errors.ts`'s `mapKnownError`) is promoted onto the actual
 * `Retry-After` header rather than only appearing in `errors`.
 */
export function writeEventResult(
  res: Response,
  resolved: Partial<StatusResponse<unknown>>
): void {
  setNoStore(res);
  const code = resolved.code || 500;
  if (resolved.error) {
    const errors = resolved.errors as
      Record<string, string | string[]> | undefined;
    const description = errors && typeof errors.error_description === 'string' ?
      errors.error_description : undefined;
    const retryAfter = errors && typeof errors.retryAfterSeconds === 'string' ?
      errors.retryAfterSeconds : undefined;
    if (retryAfter) {
      res.headers.set('Retry-After', retryAfter);
    }
    res.json({
      error: resolved.error,
      ...(description ? { error_description: description } : {})
    }, code);
    return;
  }
  res.json((resolved.results || {}) as Record<string, unknown>, code);
}

/**
 * The configured browser origins allowed to call a protocol route with
 * cookies/CORS: the issuer's own origin plus `browserOrigins`
 * (recovery.md). A disallowed, `null` or malformed Origin is rejected;
 * a missing Origin is a native call and is always permitted.
 */
function allowedOrigins(config: NormalizedOAuthSessionConfig): string[] {
  const issuerOrigin = new URL(config.issuer).origin;
  return [ issuerOrigin, ...config.browserOrigins ];
}

/**
 * recovery.md: "Accept native requests with no Origin. For browser
 * requests, compare exact parsed origins against the configured service
 * origin plus explicit additional origins; reject null, wildcard and
 * malformed origins...Expose...Vary: Origin. Protocol bearer requests do
 * not enable credentialed-cookie CORS." Returns false when a present
 * Origin is disallowed, so the caller can refuse the request (403,
 * recovery.md: "Disallowed Origin | 403 without login challenge")
 * without ever reflecting an unapproved origin back.
 */
export function applyOAuthCors(
  req: Request,
  res: Response,
  config: NormalizedOAuthSessionConfig
): boolean {
  const origin = req.headers.get('origin');
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (!value) {
    //native request: no Origin, no CORS headers needed.
    return true;
  }
  res.headers.set('Vary', 'Origin');
  if (value === 'null') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return false;
  }
  if (!allowedOrigins(config).includes(parsed.origin)) {
    return false;
  }
  res.headers.set('Access-Control-Allow-Origin', parsed.origin);
  res.headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  return true;
}

/**
 * OPTIONS preflight for a native protocol route: validated like any
 * other request (origin/method/headers), but never requires a bearer
 * key (recovery.md: "Handle OPTIONS without a bearer key but with
 * origin/method/header validation").
 */
export function applyOAuthPreflight(
  req: Request,
  res: Response,
  config: NormalizedOAuthSessionConfig,
  methods: string[]
): void {
  const allowed = applyOAuthCors(req, res, config);
  if (!allowed) {
    res.statusCode(403);
    return;
  }
  res.headers.set('Access-Control-Allow-Methods', methods.join(', '));
  res.headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept'
  );
  res.headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  res.statusCode(204);
}

/**
 * Reads one form-encoded (`application/x-www-form-urlencoded`) field,
 * rejecting a repeated parameter outright rather than silently taking
 * the first/last value (events.md: "Reject duplicate form parameters
 * and malformed/oversized input before resolving events").
 */
export function singleFormField(
  req: Request,
  name: string
): string | undefined | null {
  const value = req.post(name);
  if (Array.isArray(value)) {
    //repeated parameter: malformed by this contract's rules.
    return null;
  }
  return typeof value === 'string' ? value : undefined;
}
