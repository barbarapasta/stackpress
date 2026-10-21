//node
import { createHash } from 'node:crypto';
//modules
import type Request from '@stackpress/ingest/Request';
import type Response from '@stackpress/ingest/Response';
import type Server from '@stackpress/ingest/Server';
//stackpress-sql
import type { DatabasePlugin } from 'stackpress-sql/types';
//stackpress-csrf
import type { CsrfPlugin } from 'stackpress-csrf/types';
//stackpress-session
import type { SessionPlugin } from '../../session/types.js';
import type { AuthExtended } from '../../auth/types.js';
import { generateTOTP } from '../../session/helpers.js';
//stackpress-session/oauth
import OAuthStore from '../storage/OAuthStore.js';
import type { OAuthPendingRow } from '../storage/types.js';
import { hashWithDomain } from '../storage/ids.js';
import { isClientAllowed } from '../clients/policy.js';
import { validateReturnAddress, isLocalMachineHost } from '../clients/redirect.js';
import { fetchClientDocument } from '../clients/document.js';
import { resolveHostname } from '../clients/network.js';
import { loadSafeProfile, invokeApprovalPolicy } from '../policy.js';
import type { OAuthApprovalDecision } from '../policy.js';
import { verifyFactorReceipt } from '../factor.js';
import type {
  NormalizedOAuthSessionConfig,
  OAuthPlugin,
  OAuthSafeProfile
} from '../types.js';
import type {
  OAuthBrowserCsrf,
  OAuthBrowserLinks,
  OAuthClientView,
  OAuthOperationView,
  OAuthResourceView,
  OAuthScopeView
} from '../views/types.js';
import { encodeSnapshot } from '../views/snapshot.js';
import { setNoStore, sourceAddress } from './helpers.js';

//Shared plumbing for the three ordinary signed-in browser pages task 00007
//owns: GET/POST /authorize, GET/POST /factor and GET /connections plus
//POST /connections/revoke. None of these are native protocol routes:
//`OAuthService.isNativeRoute()` deliberately does not list them, so the
//global `session.access` authorizer still applies, and every page below
//additionally loads the current browser profile itself, checks CSRF on
//POST and renders only an explicit safe snapshot (events.md "Browser
//Continuation And Disconnect").

//events.md: "Bind it to an unguessable HttpOnly, Secure, SameSite=Lax
//browser continuation cookie; store only its hash."
export const CONTINUATION_COOKIE = 'oauth_continue';

export const AUTHORIZE_VIEW = 'stackpress-session/esm/oauth/views/authorize';
export const FACTOR_VIEW = 'stackpress-session/esm/oauth/views/factor';
export const CONNECTIONS_VIEW = 'stackpress-session/esm/oauth/views/connections';

const CLIENT_DOCUMENT_PATTERN = /^https?:\/\//i;
const TOTP_STEP_SECONDS = 30;

export type OAuthBrowserContext = {
  oauth: OAuthPlugin,
  config: NormalizedOAuthSessionConfig,
  store: OAuthStore,
  links: OAuthBrowserLinks
};

export type OAuthBrowserProfile = {
  id: string,
  name: string
};

/**
 * Same-app links every page needs. All are built from trusted
 * configuration only; none ever carries a client-supplied address.
 */
export function browserLinks(
  ctx: Server,
  config: NormalizedOAuthSessionConfig
): OAuthBrowserLinks {
  const authBase = ctx.config.path<string>('auth.base', '/auth');
  const authorize = `${config.base}/authorize`;
  return {
    authorize,
    factor: `${config.base}/factor`,
    connections: `${config.base}/connections`,
    account: `${authBase}/account`,
    //the existing 2FA set-up page already honours a same-app
    //redirect_uri, so finishing set-up returns to the saved approval
    factorSetup: `${authBase}/account/security/2fa?redirect_uri=${
      encodeURIComponent(authorize)
    }`
  };
}

/**
 * The page's OAuth service, configuration and a fresh store, or `null`
 * while `OAuthService.finalize()` has not succeeded (configuration.md:
 * "All OAuth handlers refuse requests with 503 until it succeeds").
 */
export function getBrowserContext(ctx: Server): OAuthBrowserContext | null {
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  try {
    oauth.assertFinalized();
  } catch {
    return null;
  }
  const engine = ctx.plugin<DatabasePlugin>('database');
  return {
    oauth,
    config: oauth.config,
    store: new OAuthStore(engine),
    links: browserLinks(ctx, oauth.config)
  };
}

/**
 * The signed-in browser profile from the ordinary session cookie, or
 * `null` for a guest/invalid session. Only `{ id, name }` leaves this
 * function - never the session JWT or permission list.
 */
export async function loadBrowserProfile(
  req: Request,
  ctx: Server
): Promise<OAuthBrowserProfile | null> {
  const session = ctx.plugin<SessionPlugin>('session');
  if (!session) {
    return null;
  }
  const data = await session.load(req).data();
  if (!data || (typeof data.id !== 'string' && typeof data.id !== 'number')) {
    return null;
  }
  const id = String(data.id);
  if (!id) {
    return null;
  }
  return { id, name: typeof data.name === 'string' ? data.name : '' };
}

/**
 * The app's existing sign-in page with a safe same-app return (J03/J14).
 */
export function signinRedirect(ctx: Server, returnPath: string): string {
  const authBase = ctx.config.path<string>('auth.base', '/auth');
  return `${authBase}/signin?redirect_uri=${encodeURIComponent(returnPath)}`;
}

/**
 * Secure is always set, except in `development` mode with an HTTP
 * loopback issuer (the only case configuration.md permits plain HTTP),
 * where a browser would otherwise drop the cookie entirely.
 */
export function continuationSecure(config: NormalizedOAuthSessionConfig): boolean {
  return !(config.development && new URL(config.issuer).protocol === 'http:');
}

export function setContinuationCookie(
  res: Response,
  config: NormalizedOAuthSessionConfig,
  value: string
): void {
  res.session.set(CONTINUATION_COOKIE, value, {
    httpOnly: true,
    secure: continuationSecure(config),
    sameSite: 'lax',
    path: config.base,
    maxAge: config.pendingSeconds
  });
}

export function readContinuation(req: Request): string | null {
  const value = req.session.get(CONTINUATION_COOKIE);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export type OAuthPendingResolution =
  | { kind: 'ok', pending: OAuthPendingRow }
  | { kind: 'lost' | 'expired' | 'completed' | 'denied' | 'wrong_account' };

/**
 * Finds the pending request bound to this browser's continuation cookie
 * and binds it to the signed-in profile on first use. Another
 * account's request is reported before its status so a different
 * person never learns whether it completed (J04: "this request belongs
 * to the person").
 */
export async function resolvePending(
  req: Request,
  store: OAuthStore,
  profileId: string,
  now: Date
): Promise<OAuthPendingResolution> {
  const value = readContinuation(req);
  if (!value) {
    return { kind: 'lost' };
  }
  const pending = await store.getPendingByBindingHash(
    hashWithDomain('pending-binding', value)
  );
  if (!pending) {
    return { kind: 'lost' };
  }
  if (pending.profileId !== null && pending.profileId !== profileId) {
    return { kind: 'wrong_account' };
  }
  if (pending.status === 'completed') {
    return { kind: 'completed' };
  }
  if (pending.status === 'denied') {
    return { kind: 'denied' };
  }
  if (pending.expires.getTime() <= now.getTime()) {
    return { kind: 'expired' };
  }
  if (pending.profileId === null) {
    await store.bindPendingProfile(pending.id, profileId);
    const bound = await store.getPendingById(pending.id);
    if (!bound || bound.profileId !== profileId) {
      return { kind: 'wrong_account' };
    }
    return { kind: 'ok', pending: bound };
  }
  return { kind: 'ok', pending };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ?
    value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Reloads and re-checks the client for display/submission: still
 * admitted, still known, and the saved return address still matches one
 * of its current return addresses. `null` means the client or return
 * address is no longer valid (local error page); a thrown error is a
 * temporary metadata failure (retry page) - never a stale fallback.
 */
export async function loadClientView(
  store: OAuthStore,
  config: NormalizedOAuthSessionConfig,
  pending: OAuthPendingRow,
  source: string
): Promise<OAuthClientView | null> {
  if (!isClientAllowed(pending.clientId, config.clients)) {
    return null;
  }
  const document = CLIENT_DOCUMENT_PATTERN.test(pending.clientId);
  let metadata: Record<string, unknown>;
  if (document) {
    const fetched = await fetchClientDocument(pending.clientId, source, config, {
      store,
      resolveHost: resolveHostname
    });
    metadata = fetched.metadata;
  } else {
    const client = await store.getClientByClientId(pending.clientId);
    if (!client) {
      return null;
    }
    metadata = client.metadata;
  }
  if (!validateReturnAddress(pending.redirectUri, stringList(metadata.redirect_uris))) {
    return null;
  }
  const redirect = new URL(pending.redirectUri);
  return {
    id: pending.clientId,
    name: typeof metadata.client_name === 'string' && metadata.client_name.length > 0 ?
      metadata.client_name : undefined,
    kind: document ? 'document' : 'registered',
    host: document ? new URL(pending.clientId).host : undefined,
    redirect: pending.redirectUri,
    redirectHost: redirect.host,
    local: isLocalMachineHost(redirect.hostname)
  };
}

/**
 * Display name for an already-approved connection, from saved data only
 * (registered metadata or the cached client document) - the connections
 * page never makes a network request.
 */
export async function savedClientName(
  store: OAuthStore,
  clientId: string
): Promise<string | undefined> {
  let metadata: Record<string, unknown> | undefined;
  if (CLIENT_DOCUMENT_PATTERN.test(clientId)) {
    const cached = await store.getClientDocumentByUrlHash(
      hashWithDomain('client-document-url', clientId)
    );
    metadata = cached?.metadata;
  } else {
    const client = await store.getClientByClientId(clientId);
    metadata = client?.metadata;
  }
  return metadata && typeof metadata.client_name === 'string' &&
    metadata.client_name.length > 0 ? metadata.client_name : undefined;
}

export function clientHost(clientId: string): string | undefined {
  if (!CLIENT_DOCUMENT_PATTERN.test(clientId)) {
    return undefined;
  }
  try {
    return new URL(clientId).host;
  } catch {
    return undefined;
  }
}

export function resourceView(
  config: NormalizedOAuthSessionConfig,
  resource: string
): OAuthResourceView | null {
  const entry = config.resources.find((item) => item.resource === resource);
  if (!entry) {
    return null;
  }
  return { id: entry.resource, name: entry.name, description: entry.description };
}

/**
 * The saved request narrowed to what is still configured/registered
 * now: scopes the resource still declares and API operations still
 * registered for that resource. Never adds anything to the saved set.
 */
export function requestedAccess(
  oauth: OAuthPlugin,
  pending: OAuthPendingRow
): { scopes: string[], operations: string[] } {
  const entry = oauth.config.resources.find((item) => item.resource === pending.resource);
  const configured = new Set(entry ? entry.scopes : []);
  return {
    scopes: pending.scopes.filter((scope) => configured.has(scope)),
    operations: pending.operations.filter((id) => {
      const operation = oauth.apiOperations.get(id);
      return Boolean(operation && operation.descriptor.resources.includes(pending.resource));
    })
  };
}

export function scopeViews(
  config: NormalizedOAuthSessionConfig,
  scopes: string[],
  selected: string[]
): OAuthScopeView[] {
  const chosen = new Set(selected);
  return scopes.map((id) => ({
    id,
    name: config.scopes[id]?.name || id,
    description: config.scopes[id]?.description || '',
    checked: chosen.has(id)
  }));
}

export function operationViews(
  oauth: OAuthPlugin,
  operations: string[],
  selected: string[]
): OAuthOperationView[] {
  const chosen = new Set(selected);
  return operations.map((id) => {
    const descriptor = oauth.apiOperations.get(id)?.descriptor;
    return {
      id,
      method: descriptor ? String(descriptor.method) : '',
      route: descriptor ? descriptor.route : '',
      checked: chosen.has(id)
    };
  });
}

/**
 * Whether the person has a verified authenticator (events.md: factor
 * availability is reported, never its secret). A failed lookup counts
 * as unavailable, which can only ever refuse - never approve.
 */
export async function findFactor(
  ctx: Server,
  profileId: string
): Promise<AuthExtended | null> {
  const found = await ctx.resolve<AuthExtended[]>('auth-search', {
    eq: { type: '2fa', profileId }
  });
  if (found.code !== 200 || !Array.isArray(found.results)) {
    return null;
  }
  const factor = found.results.find((item) => item && item.type === '2fa');
  return factor && typeof factor.token === 'string' && factor.token.length > 0 ?
    factor : null;
}

export type OAuthApprovalReady = {
  kind: 'ready',
  pending: OAuthPendingRow,
  profile: OAuthSafeProfile,
  client: OAuthClientView,
  resource: OAuthResourceView,
  requested: { scopes: string[], operations: string[] },
  factor: AuthExtended | null,
  //the app policy's answer for the full saved request; `null` = denied
  offered: OAuthApprovalDecision | null
};

export type OAuthApprovalStop = {
  kind: 'stop',
  state:
    | 'lost' | 'expired' | 'completed' | 'denied' | 'wrong_account'
    | 'inactive' | 'invalid_request' | 'unavailable',
  code: number
};

/**
 * Reloads everything J03-J06 require fresh, in a fixed order, before an
 * approval or factor page is displayed or submitted: the pending request
 * bound to this browser and person, the current account (J07), the
 * client and its return address, the service, the saved request still
 * configured, factor availability and the app approval policy.
 */
export async function prepareApproval(
  req: Request,
  ctx: Server,
  browser: OAuthBrowserContext,
  profileId: string,
  now: Date
): Promise<OAuthApprovalReady | OAuthApprovalStop> {
  const { store, config, oauth } = browser;
  const resolution = await resolvePending(req, store, profileId, now);
  if (resolution.kind !== 'ok') {
    const codes = { lost: 400, expired: 410, completed: 200, denied: 200, wrong_account: 403 };
    return { kind: 'stop', state: resolution.kind, code: codes[resolution.kind] };
  }
  const pending = resolution.pending;
  const profile = await loadSafeProfile(ctx, profileId);
  if (!profile) {
    return { kind: 'stop', state: 'inactive', code: 403 };
  }
  let client: OAuthClientView | null;
  try {
    client = await loadClientView(store, config, pending, sourceAddress(req));
  } catch {
    return { kind: 'stop', state: 'unavailable', code: 503 };
  }
  const resource = resourceView(config, pending.resource);
  if (!client || !resource) {
    return { kind: 'stop', state: 'invalid_request', code: 400 };
  }
  const requested = requestedAccess(oauth, pending);
  const factor = await findFactor(ctx, profile.id);
  const offered = await invokeApprovalPolicy(ctx, config, {
    phase: 'approval',
    profile,
    client: { id: client.id, name: client.name },
    resource: pending.resource,
    scopes: requested.scopes,
    operations: requested.operations,
    factor: { available: factor !== null }
  });
  return { kind: 'ready', pending, profile, client, resource, requested, factor, offered };
}

/**
 * Normalizes one submitted multi-value field (`scope[]`, `operation[]`)
 * into distinct strings. A missing field is an empty selection; any
 * nested object is malformed (`null`).
 */
export function readSelection(value: unknown): string[] | null {
  if (typeof value === 'undefined' || value === null || value === '') {
    return [];
  }
  const values = Array.isArray(value) ? value : [ value ];
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      return null;
    }
    const text = String(item);
    if (text.length > 0 && !result.includes(text)) {
      result.push(text);
    }
  }
  return result;
}

export function isSubset(subset: string[], superset: string[]): boolean {
  const allowed = new Set(superset);
  return subset.every((value) => allowed.has(value));
}

export function isSameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && isSubset(a, b) && isSubset(b, a);
}

export function receiptSeed(ctx: Server): string {
  //must match the seed `oauth-authorize` verifies receipts with
  return ctx.config.path<string>('session.seed', '');
}

/**
 * True when the receipt saved on the pending row was minted for exactly
 * this person, this request and this final approval content. Any
 * changed selection produces different content and fails (events.md:
 * "Scope/membership changes invalidate the receipt").
 */
export function receiptMatches(
  seed: string,
  pending: OAuthPendingRow,
  profileId: string,
  decision: { scopes: string[], operations: string[] },
  now: Date
): boolean {
  if (!pending.factorReceipt) {
    return false;
  }
  return verifyFactorReceipt(seed, pending.factorReceipt, {
    profileId,
    pendingId: pending.id,
    scopes: decision.scopes,
    operations: decision.operations
  }, pending.expires, now);
}

/**
 * The approval content a saved, still-valid receipt was minted for, so
 * the approval page can preselect exactly that content after the factor
 * check. The decoded content is only trusted after the receipt verifies
 * against this person and request; otherwise `null`.
 */
export function receiptSelection(
  seed: string,
  pending: OAuthPendingRow,
  profileId: string,
  now: Date
): { scopes: string[], operations: string[] } | null {
  const receipt = pending.factorReceipt;
  if (!receipt) {
    return null;
  }
  let decoded: unknown;
  try {
    const payload = receipt.substring(0, receipt.indexOf('.'));
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const content = decoded as { scopes?: unknown, operations?: unknown };
  if (
    !content || typeof content !== 'object' ||
    !Array.isArray(content.scopes) || !Array.isArray(content.operations)
  ) {
    return null;
  }
  const selection = {
    scopes: stringList(content.scopes),
    operations: stringList(content.operations)
  };
  return receiptMatches(seed, pending, profileId, selection, now) ? selection : null;
}

/**
 * Finds the accepted TOTP time-step counter for `code` using the
 * existing verified TOTP mechanism (`generateTOTP`, same +-1 step window
 * as `verifyTOTP`). The counter feeds `OAuthStore.checkAndAdvanceFactor`
 * so one code can mint at most one receipt. The step is sampled before
 * and after matching; if a step boundary passed in between, the match
 * is redone so the counter always corresponds to the code that matched.
 */
export function matchTotpCounter(code: string, secret: string): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    let found: number | null = null;
    try {
      for (let offset = -1; offset <= 1; offset++) {
        if (generateTOTP(secret, offset) === code) {
          found = before + offset;
          break;
        }
      }
    } catch {
      return null;
    }
    const after = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    if (before === after) {
      return found;
    }
  }
  return null;
}

/**
 * Identifies one enrolment of a verified factor without storing its
 * secret: re-enrolling 2FA replaces the secret and therefore starts a
 * fresh `OAuthFactorUse` counter row (storage.md: "Unique verified-
 * factor ID plus incarnation ... no factor secret").
 */
export function factorIncarnation(secret: string): string {
  return createHash('sha256')
    .update('oauth-factor-incarnation:')
    .update(secret)
    .digest('hex');
}

/**
 * Reads one body-only scalar field. A repeated or nested value is
 * malformed (`null`); browser POSTs never read query values.
 */
export function bodyField(req: Request, name: string): string | null | undefined {
  const value = req.post(name);
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return null;
}

/**
 * Body-only CSRF check: the token must arrive in the POST body (never
 * the query string) and match the cookie via the existing csrf plugin.
 */
export function validCsrf(req: Request, res: Response, ctx: Server): boolean {
  const csrf = ctx.plugin<CsrfPlugin>('csrf');
  const name = ctx.config.path<string>('csrf.name', 'csrf');
  if (typeof bodyField(req, name) !== 'string') {
    return false;
  }
  return csrf.valid(req, res);
}

export function newCsrf(res: Response, ctx: Server): OAuthBrowserCsrf {
  const csrf = ctx.plugin<CsrfPlugin>('csrf');
  const name = ctx.config.path<string>('csrf.name', 'csrf');
  const token = csrf.generate(res, ctx);
  return { name, token };
}

/**
 * Renders one browser page from an explicit safe snapshot. The generic
 * view engine serializes the full `me` result (including the session
 * JWT), every request header, every cookie and all request data into
 * page startup data, so these pages are deliberately not registered
 * with `ctx.view` - they call the configured renderer directly with
 * props built here from public configuration plus the snapshot only.
 * Without a renderer (or with the `?json` no-view flag) the same safe
 * snapshot is returned as JSON.
 */
export async function renderBrowserPage<S>(
  req: Request,
  res: Response,
  ctx: Server,
  entry: string,
  snapshot: S,
  code = 200
): Promise<void> {
  setNoStore(res);
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Content-Security-Policy', 'frame-ancestors \'none\'');
  res.headers.set('Referrer-Policy', 'no-referrer');
  const noview = ctx.config.path<string>('view.noview', 'json');
  if (!req.url.searchParams.has(noview)) {
    const html = await ctx.view.render(entry, buildViewProps(req, ctx, snapshot, code));
    if (typeof html === 'string' && html.length > 0) {
      res.html(html, code);
      return;
    }
  }
  res.json(JSON.stringify({ oauth: snapshot }), code);
}

/**
 * The complete prop set handed to the renderer. Only public brand/
 * language/view configuration and the snapshot; the session prop is an
 * empty guest shape (no token, roles or permits), the request prop has
 * no headers, cookies, query or body, and the response prop carries
 * only the status code.
 */
export function buildViewProps<S>(
  req: Request,
  ctx: Server,
  snapshot: S,
  code: number
) {
  const view = ctx.config.path<Record<string, unknown>>('view', {});
  const brand = ctx.config.path<Record<string, string>>('brand', {});
  const language = ctx.config.path<Record<string, unknown>>('language', {});
  const theme = req.session.get('theme');
  return {
    data: {
      brand: {
        name: brand.name || 'Stackpress',
        logo: brand.logo || '/logo.png',
        icon: brand.icon || '/icon.png',
        favicon: brand.favicon || '/favicon.ico'
      },
      language: {
        key: language.key || 'locale',
        locale: language.locale || 'en_US',
        languages: language.languages || {}
      },
      view: {
        base: view.base || '/',
        notify: view.notify || {}
      },
      //one inert URI-encoded string: never raw client text in the
      //document's startup JSON (views/snapshot.ts)
      oauth: encodeSnapshot(snapshot)
    },
    session: { id: '', name: '', roles: [], token: '', permits: [] },
    request: {
      url: {
        hash: '',
        host: req.url.host,
        hostname: req.url.hostname,
        href: `${req.url.origin}${req.url.pathname}`,
        origin: req.url.origin,
        pathname: req.url.pathname,
        port: req.url.port,
        protocol: req.url.protocol,
        search: ''
      },
      headers: {},
      session: typeof theme === 'string' ? { theme } : {},
      method: req.method,
      mime: '',
      data: {}
    },
    response: { code }
  };
}
