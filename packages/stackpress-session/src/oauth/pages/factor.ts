//modules
import type Request from '@stackpress/ingest/Request';
import type Response from '@stackpress/ingest/Response';
import type Server from '@stackpress/ingest/Server';
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { enforceRateLimit } from '../clients/rateLimit.js';
import { OAuthClientError } from '../clients/errors.js';
import { invokeApprovalPolicy } from '../policy.js';
import type { OAuthApprovalDecision } from '../policy.js';
import { createFactorReceipt } from '../factor.js';
import type { OAuthPlugin } from '../types.js';
import type {
  OAuthBrowserLinks,
  OAuthFactorError,
  OAuthFactorSnapshot,
  OAuthFactorState
} from '../views/types.js';
import { sourceAddress } from './helpers.js';
import {
  FACTOR_VIEW,
  bodyField,
  browserLinks,
  factorIncarnation,
  getBrowserContext,
  isSameSet,
  isSubset,
  loadBrowserProfile,
  matchTotpCounter,
  newCsrf,
  operationViews,
  prepareApproval,
  readSelection,
  receiptSeed,
  renderBrowserPage,
  scopeViews,
  signinRedirect,
  validCsrf
} from './browser.js';
import type {
  OAuthApprovalReady,
  OAuthApprovalStop,
  OAuthBrowserContext,
  OAuthBrowserProfile
} from './browser.js';

function snapshot(
  state: OAuthFactorState,
  links: OAuthBrowserLinks,
  extra: Partial<OAuthFactorSnapshot> = {}
): OAuthFactorSnapshot {
  return { state, scopes: [], operations: [], links, ...extra };
}

async function render(
  req: Request,
  res: Response,
  ctx: Server,
  data: OAuthFactorSnapshot,
  code: number
) {
  await renderBrowserPage(req, res, ctx, FACTOR_VIEW, data, code);
}

function stopState(state: OAuthApprovalStop['state']): OAuthFactorState {
  switch (state) {
    case 'denied':
      return 'completed';
    case 'invalid_request':
      return 'error';
    case 'unavailable':
      return 'unavailable_service';
    default:
      return state;
  }
}

/**
 * The exact selection the person is verifying for: the submitted subset
 * re-checked against what the app policy offers right now and the
 * policy's own answer for that subset. `null` means the selection is no
 * longer valid as shown, so the person is sent back to review approval.
 */
async function checkedSelection(
  ctx: Server,
  browser: OAuthBrowserContext,
  ready: OAuthApprovalReady,
  scopes: string[] | null,
  operations: string[] | null
): Promise<OAuthApprovalDecision | null> {
  const offered = ready.offered;
  if (!offered || scopes === null || operations === null) {
    return null;
  }
  if (!isSubset(scopes, offered.scopes) || !isSubset(operations, offered.operations)) {
    return null;
  }
  const decision = await invokeApprovalPolicy(ctx, browser.config, {
    phase: 'approval',
    profile: ready.profile,
    client: { id: ready.client.id, name: ready.client.name },
    resource: ready.pending.resource,
    scopes,
    operations,
    factor: { available: ready.factor !== null }
  });
  if (
    !decision ||
    !isSameSet(decision.scopes, scopes) ||
    !isSameSet(decision.operations, operations)
  ) {
    return null;
  }
  return decision;
}

async function showForm(
  req: Request,
  res: Response,
  ctx: Server,
  browser: OAuthBrowserContext,
  ready: OAuthApprovalReady,
  account: OAuthBrowserProfile,
  decision: OAuthApprovalDecision,
  error?: OAuthFactorError,
  code = 200,
  retryAfter?: number
) {
  await render(req, res, ctx, snapshot('verify', browser.links, {
    account: { name: account.name },
    client: ready.client,
    resource: ready.resource,
    scopes: scopeViews(browser.config, decision.scopes, decision.scopes),
    operations: operationViews(browser.oauth, decision.operations, decision.operations),
    csrf: newCsrf(res, ctx),
    ...(error ? { error } : {}),
    ...(retryAfter ? { retryAfter } : {})
  }), code);
}

/**
 * J05: the separate approval check. Rate limits apply across all
 * servers before the code is examined; a valid code advances the
 * factor's saved counter atomically (`OAuthFactorUse`, never
 * `Auth.consumed`) so the same code can mint at most one receipt; the
 * receipt is bound to this person, request and exact selection and is
 * saved server-side on the pending row.
 */
async function verify(
  req: Request,
  res: Response,
  ctx: Server,
  browser: OAuthBrowserContext,
  ready: OAuthApprovalReady,
  account: OAuthBrowserProfile,
  decision: OAuthApprovalDecision
) {
  const { store, config } = browser;
  const factor = ready.factor!;
  const now = new Date();
  const source = sourceAddress(req);
  try {
    //configuration.md: "5 attempts per window per pending request and
    //profile, plus 20 per source address" - the source stage first
    await enforceRateLimit(store, [
      { key: `factor-source:${config.issuer}:${source}`, limit: config.limits.factor.source },
      {
        key: `factor:${config.issuer}:${ready.pending.id}:${ready.profile.id}`,
        limit: config.limits.factor.attempts
      }
    ], config.limits.windowSeconds, now);
  } catch (e) {
    if (e instanceof OAuthClientError && e.code === 'rate_limited') {
      const retryAfter = e.retryAfterSeconds || 1;
      res.headers.set('Retry-After', String(retryAfter));
      await showForm(req, res, ctx, browser, ready, account, decision, 'rate_limited', 429, retryAfter);
    } else {
      await render(req, res, ctx, snapshot('unavailable_service', browser.links), 503);
    }
    return;
  }
  //form parsing turns digit strings into numbers (dropping leading
  //zeros), the same reason the existing sign-in 2FA page pads the code
  const raw = (bodyField(req, 'code') || '').trim();
  const code = /^\d{1,6}$/.test(raw) ? raw.padStart(6, '0') : '';
  const counter = code ? matchTotpCounter(code, factor.token) : null;
  if (counter === null) {
    await showForm(req, res, ctx, browser, ready, account, decision, 'invalid_code', 400);
    return;
  }
  let accepted: boolean;
  try {
    accepted = await store.checkAndAdvanceFactor(
      factor.id,
      factorIncarnation(factor.token),
      ready.profile.id,
      counter,
      now
    );
  } catch {
    await render(req, res, ctx, snapshot('unavailable_service', browser.links), 503);
    return;
  }
  if (!accepted) {
    await showForm(req, res, ctx, browser, ready, account, decision, 'code_reused', 409);
    return;
  }
  const receipt = createFactorReceipt(receiptSeed(ctx), {
    profileId: ready.profile.id,
    pendingId: ready.pending.id,
    scopes: decision.scopes,
    operations: decision.operations
  }, ready.pending.expires, now);
  try {
    await store.setPendingFactorReceipt(ready.pending.id, receipt, now);
  } catch {
    //the code was spent but no receipt was saved: nothing is approved,
    //and the person retries with the next code
    await render(req, res, ctx, snapshot('unavailable_service', browser.links), 503);
    return;
  }
  //return to J04 with the receipt saved server-side
  res.redirect(browser.links.authorize, 303);
}

/**
 * GET/POST `${base}/factor` (configuration.md). Ordinary signed-in
 * browser page; never a native route.
 */
export default action(async function OAuthFactorPage({ req, res, ctx }) {
  //if there is a response body or there is an error code
  if (res.body || (res.code && res.code !== 200)) {
    //let the response pass through
    return;
  }
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  const browser = getBrowserContext(ctx);
  if (!browser) {
    await render(req, res, ctx, snapshot('unavailable_service', browserLinks(ctx, oauth.config)), 503);
    return;
  }
  const { links } = browser;
  const method = req.method.toUpperCase();
  const account = await loadBrowserProfile(req, ctx);
  if (!account) {
    res.redirect(signinRedirect(ctx, links.authorize), method === 'POST' ? 303 : 302);
    return;
  }
  const csrfOk = method === 'POST' ? validCsrf(req, res, ctx) : true;
  const ready = await prepareApproval(req, ctx, browser, account.id, new Date());
  if (ready.kind === 'stop') {
    await render(req, res, ctx, snapshot(stopState(ready.state), links, {
      account: { name: account.name }
    }), ready.code);
    return;
  }
  //the selection being verified: body-only on POST; on GET the
  //approval page's own redirect, defaulting to everything offered
  let scopes: string[] | null;
  let operations: string[] | null;
  if (method === 'POST') {
    scopes = readSelection(req.post('scope'));
    operations = readSelection(req.post('operation'));
  } else if (req.url.searchParams.has('selected')) {
    scopes = readSelection(req.url.searchParams.getAll('scope'));
    operations = readSelection(req.url.searchParams.getAll('operation'));
  } else {
    scopes = ready.offered ? ready.offered.scopes : null;
    operations = ready.offered ? ready.offered.operations : null;
  }
  const decision = await checkedSelection(ctx, browser, ready, scopes, operations);
  if (!decision || !decision.requireFactor) {
    //changed rules/selection, or no check needed: review approval again
    res.redirect(links.authorize, 303);
    return;
  }
  if (!ready.factor) {
    //J06: explain; offer set-up, help or cancelling - never approve
    await render(req, res, ctx, snapshot('unavailable', links, {
      account: { name: account.name },
      client: ready.client,
      resource: ready.resource
    }), 403);
    return;
  }
  if (method !== 'POST') {
    await showForm(req, res, ctx, browser, ready, account, decision);
    return;
  }
  if (!csrfOk) {
    await showForm(req, res, ctx, browser, ready, account, decision, 'form_expired', 419);
    return;
  }
  await verify(req, res, ctx, browser, ready, account, decision);
});
