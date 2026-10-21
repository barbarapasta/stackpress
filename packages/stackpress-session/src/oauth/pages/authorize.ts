//modules
import type Request from '@stackpress/ingest/Request';
import type Response from '@stackpress/ingest/Response';
import type Server from '@stackpress/ingest/Server';
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { newPendingBinding, hashWithDomain } from '../storage/ids.js';
import { enforceRateLimit } from '../clients/rateLimit.js';
import { OAuthClientError } from '../clients/errors.js';
import { invokeApprovalPolicy } from '../policy.js';
import type {
  OAuthAuthorizationStartInput,
  OAuthAuthorizationStartResult,
  OAuthAuthorizeInput,
  OAuthAuthorizeResult,
  OAuthPlugin
} from '../types.js';
import type {
  OAuthAuthorizeNotice,
  OAuthAuthorizeSnapshot,
  OAuthAuthorizeState,
  OAuthBrowserLinks
} from '../views/types.js';
import { sourceAddress } from './helpers.js';
import {
  AUTHORIZE_VIEW,
  browserLinks,
  getBrowserContext,
  isSameSet,
  isSubset,
  loadBrowserProfile,
  newCsrf,
  operationViews,
  prepareApproval,
  readSelection,
  receiptMatches,
  receiptSeed,
  receiptSelection,
  renderBrowserPage,
  scopeViews,
  setContinuationCookie,
  signinRedirect,
  bodyField,
  validCsrf
} from './browser.js';
import type {
  OAuthApprovalReady,
  OAuthBrowserContext,
  OAuthBrowserProfile
} from './browser.js';

//the authorization query parameters `oauth-authorization-start` reads;
//any of them repeated is malformed (events.md: "Reject duplicate ...
//parameters and malformed/oversized input before resolving events").
const START_PARAMS = [
  'client_id', 'redirect_uri', 'response_type', 'state',
  'code_challenge', 'code_challenge_method', 'resource', 'scope'
];

function snapshot(
  state: OAuthAuthorizeState,
  links: OAuthBrowserLinks,
  extra: Partial<OAuthAuthorizeSnapshot> = {}
): OAuthAuthorizeSnapshot {
  return {
    state,
    scopes: [],
    operations: [],
    factor: { required: false, verified: false },
    links,
    ...extra
  };
}

async function render(
  req: Request,
  res: Response,
  ctx: Server,
  data: OAuthAuthorizeSnapshot,
  code: number
) {
  await renderBrowserPage(req, res, ctx, AUTHORIZE_VIEW, data, code);
}

/**
 * The address of the separate factor page for one exact selection. Only
 * selection identifiers (never a receipt, code or state) travel in it;
 * the factor page re-checks them against the saved request and policy.
 */
export function factorAddress(
  links: OAuthBrowserLinks,
  scopes: string[],
  operations: string[]
): string {
  const params = new URLSearchParams();
  for (const scope of scopes) params.append('scope', scope);
  for (const operation of operations) params.append('operation', operation);
  //always mark the selection explicitly so an empty selection is not
  //mistaken for "no selection supplied"
  params.set('selected', '1');
  return `${links.factor}?${params.toString()}`;
}

/**
 * J03 step 1: validate the program, request and return address through
 * `oauth-authorization-start` (which also enforces `limits.authorization`)
 * and save the request server-side, bound to a new HttpOnly continuation
 * cookie, before any sign-in redirect. The browser then continues on the
 * clean approval address so no state/PKCE value stays in the page URL.
 */
async function start(
  req: Request,
  res: Response,
  ctx: Server,
  browser: OAuthBrowserContext
) {
  const params = req.url.searchParams;
  for (const name of START_PARAMS) {
    if (params.getAll(name).length > 1) {
      await render(req, res, ctx, snapshot('invalid_request', browser.links), 400);
      return;
    }
  }
  const binding = newPendingBinding();
  const input: OAuthAuthorizationStartInput = {
    client_id: params.get('client_id') || '',
    redirect_uri: params.get('redirect_uri') || '',
    response_type: params.get('response_type') || '',
    code_challenge: params.get('code_challenge') || '',
    code_challenge_method: params.get('code_challenge_method') || '',
    bindingHash: hashWithDomain('pending-binding', binding),
    source: sourceAddress(req),
    ...(params.has('state') ? { state: params.get('state') as string } : {}),
    ...(params.has('resource') ? { resource: params.get('resource') as string } : {}),
    ...(params.has('scope') ? { scope: params.get('scope') as string } : {})
  };
  const resolved = await ctx.resolve<OAuthAuthorizationStartResult>(
    'oauth-authorization-start',
    input as unknown as Record<string, unknown>
  );
  if (resolved.code !== 200 || !resolved.results) {
    const code = resolved.code || 500;
    if (code === 429) {
      const errors = resolved.errors as Record<string, string> | undefined;
      const retryAfter = Math.max(1, Number(errors?.retryAfterSeconds) || 1);
      res.headers.set('Retry-After', String(retryAfter));
      await render(req, res, ctx, snapshot('rate_limited', browser.links, { retryAfter }), 429);
    } else if (code === 503) {
      await render(req, res, ctx, snapshot('unavailable', browser.links), 503);
    } else if (code >= 500) {
      await render(req, res, ctx, snapshot('error', browser.links), 500);
    } else {
      //unknown/unadmitted client, unsafe or unregistered return address,
      //missing parameters: stay on a local error page (J03 step 1)
      await render(req, res, ctx, snapshot('invalid_request', browser.links), 400);
    }
    return;
  }
  const results = resolved.results;
  if ('redirect' in results) {
    //a validated error redirect to the already-checked return address
    res.redirect(results.redirect);
    return;
  }
  setContinuationCookie(res, browser.config, binding);
  res.redirect(browser.links.authorize, 303);
}

type DisplayOptions = {
  notice?: OAuthAuthorizeNotice,
  code?: number
};

/**
 * Builds the page for an already-prepared request: the approval form,
 * the "not allowed" explanation (policy denial) or the "extra check
 * unavailable" explanation (J06). A required factor never disappears:
 * without an available factor there is no approve action at all.
 */
async function display(
  req: Request,
  res: Response,
  ctx: Server,
  browser: OAuthBrowserContext,
  ready: OAuthApprovalReady,
  account: OAuthBrowserProfile,
  options: DisplayOptions = {}
) {
  const { config, oauth, links } = browser;
  const now = new Date();
  const base = {
    account: { name: account.name },
    client: ready.client,
    resource: ready.resource,
    csrf: newCsrf(res, ctx)
  };
  const offered = ready.offered;
  if (!offered) {
    await render(req, res, ctx, snapshot('policy_denied', links, base), 403);
    return;
  }
  if (offered.requireFactor && !ready.factor) {
    await render(req, res, ctx, snapshot('factor_unavailable', links, {
      ...base,
      scopes: scopeViews(config, offered.scopes, []),
      operations: operationViews(oauth, offered.operations, []),
      factor: { required: true, verified: false }
    }), 403);
    return;
  }
  //after a successful factor check, preselect exactly the content the
  //saved receipt covers; otherwise preselect everything offered
  const verified = receiptSelection(receiptSeed(ctx), ready.pending, ready.profile.id, now);
  const useVerified = verified !== null &&
    isSubset(verified.scopes, offered.scopes) &&
    isSubset(verified.operations, offered.operations);
  const selected = useVerified ? verified! : offered;
  await render(req, res, ctx, snapshot('approve', links, {
    ...base,
    ...(options.notice ? { notice: options.notice } : {}),
    scopes: scopeViews(config, offered.scopes, selected.scopes),
    operations: operationViews(oauth, offered.operations, selected.operations),
    factor: { required: offered.requireFactor, verified: useVerified }
  }), options.code || 200);
}

function stopPage(
  links: OAuthBrowserLinks,
  state: OAuthAuthorizeState,
  account: OAuthBrowserProfile
): OAuthAuthorizeSnapshot {
  return snapshot(state, links, { account: { name: account.name } });
}

/**
 * J04: approve or deny. Body-only fields, CSRF and `limits.authorization`
 * first; then everything is reloaded and re-checked fresh before the
 * atomic `oauth-authorize` event. Hidden inputs can only choose a subset
 * of what is offered right now; anything else redisplays the page.
 */
async function submit(
  req: Request,
  res: Response,
  ctx: Server,
  browser: OAuthBrowserContext,
  account: OAuthBrowserProfile
) {
  const { store, config, links } = browser;
  const now = new Date();
  const csrfOk = validCsrf(req, res, ctx);
  if (csrfOk) {
    try {
      await enforceRateLimit(store, [ {
        key: `authorization:${config.issuer}:${sourceAddress(req)}`,
        limit: config.limits.authorization
      } ], config.limits.windowSeconds, now);
    } catch (e) {
      if (e instanceof OAuthClientError && e.code === 'rate_limited') {
        const retryAfter = e.retryAfterSeconds || 1;
        res.headers.set('Retry-After', String(retryAfter));
        await render(req, res, ctx, snapshot('rate_limited', links, { retryAfter }), 429);
      } else {
        await render(req, res, ctx, snapshot('unavailable', links), 503);
      }
      return;
    }
  }
  const ready = await prepareApproval(req, ctx, browser, account.id, now);
  if (ready.kind === 'stop') {
    await render(req, res, ctx, stopPage(links, ready.state, account), ready.code);
    return;
  }
  if (!csrfOk) {
    //a forged or stale form changes nothing; show the current request
    //again with a fresh token
    await display(req, res, ctx, browser, ready, account, { notice: 'form_expired', code: 419 });
    return;
  }
  const choice = bodyField(req, 'action');
  if (choice === 'deny') {
    await finish(req, res, ctx, browser, ready, account, {
      pending: ready.pending.id,
      profileId: ready.profile.id,
      scopes: [],
      operations: [],
      approve: false
    });
    return;
  }
  if (choice !== 'approve') {
    await display(req, res, ctx, browser, ready, account, { notice: 'selection_changed', code: 400 });
    return;
  }
  const scopes = readSelection(req.post('scope'));
  const operations = readSelection(req.post('operation'));
  const offered = ready.offered;
  if (!offered || scopes === null || operations === null) {
    await display(req, res, ctx, browser, ready, account, {
      notice: 'selection_changed',
      code: offered ? 400 : 403
    });
    return;
  }
  //rules, roles or the program changed since the page was shown, or a
  //hidden input was altered: never approve more than is offered now
  if (!isSubset(scopes, offered.scopes) || !isSubset(operations, offered.operations)) {
    await display(req, res, ctx, browser, ready, account, { notice: 'selection_changed', code: 409 });
    return;
  }
  const decision = await invokeApprovalPolicy(ctx, config, {
    phase: 'approval',
    profile: ready.profile,
    client: { id: ready.client.id, name: ready.client.name },
    resource: ready.pending.resource,
    scopes,
    operations,
    factor: { available: ready.factor !== null }
  });
  if (!decision) {
    await display(req, res, ctx, browser, ready, account, { notice: 'selection_denied', code: 403 });
    return;
  }
  //the app policy would grant something other than exactly what the
  //person chose; show the result for review instead of approving it
  if (!isSameSet(decision.scopes, scopes) || !isSameSet(decision.operations, operations)) {
    await display(req, res, ctx, browser, ready, account, { notice: 'selection_changed', code: 409 });
    return;
  }
  if (decision.requireFactor) {
    if (!ready.factor) {
      //J06: never silently skip the required check
      await display(req, res, ctx, browser, { ...ready, offered: decision }, account, { code: 403 });
      return;
    }
    if (!receiptMatches(receiptSeed(ctx), ready.pending, ready.profile.id, decision, now)) {
      res.redirect(factorAddress(links, scopes, operations), 303);
      return;
    }
  }
  await finish(req, res, ctx, browser, ready, account, {
    pending: ready.pending.id,
    profileId: ready.profile.id,
    scopes,
    operations,
    //read back from the server-saved pending row, never from the form
    ...(ready.pending.factorReceipt ? { factorReceipt: ready.pending.factorReceipt } : {}),
    approve: true
  });
}

/**
 * Resolves `oauth-authorize` and follows its validated redirect. A
 * concurrent or repeated submission (`conflict`) shows the completion
 * page; an expiry in between shows the restart page; anything else
 * issues nothing and offers another attempt while the request is valid.
 */
async function finish(
  req: Request,
  res: Response,
  ctx: Server,
  browser: OAuthBrowserContext,
  ready: OAuthApprovalReady,
  account: OAuthBrowserProfile,
  input: OAuthAuthorizeInput
) {
  const { store, links } = browser;
  const resolved = await ctx.resolve<OAuthAuthorizeResult>(
    'oauth-authorize',
    input as unknown as Record<string, unknown>
  );
  if (resolved.code === 200 && resolved.results?.redirect) {
    res.redirect(resolved.results.redirect);
    return;
  }
  if (resolved.code === 409) {
    await render(req, res, ctx, stopPage(links, 'completed', account), 200);
    return;
  }
  const current = await store.getPendingById(ready.pending.id).catch(() => null);
  if (current && current.status !== 'pending') {
    await render(req, res, ctx, stopPage(links, 'completed', account), 200);
    return;
  }
  if (!current || current.expires.getTime() <= Date.now()) {
    await render(req, res, ctx, stopPage(links, 'expired', account), 410);
    return;
  }
  if (resolved.code === 403) {
    //policy or account changed between this page's checks and the
    //event's own fresh checks
    await display(req, res, ctx, browser, ready, account, { notice: 'selection_changed', code: 409 });
    return;
  }
  await display(req, res, ctx, browser, ready, account, {
    notice: 'retry',
    code: (resolved.code || 500) >= 500 ? 503 : 400
  });
}

/**
 * GET/POST `${base}/authorize` (configuration.md). An ordinary signed-in
 * browser page: not a native route, so `session.access` still applies,
 * and this handler loads the current profile itself.
 */
export default action(async function OAuthAuthorizePage({ req, res, ctx }) {
  //if there is a response body or there is an error code
  if (res.body || (res.code && res.code !== 200)) {
    //let the response pass through
    return;
  }
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  const browser = getBrowserContext(ctx);
  if (!browser) {
    await render(req, res, ctx, snapshot('unavailable', browserLinks(ctx, oauth.config)), 503);
    return;
  }
  const method = req.method.toUpperCase();
  if (method === 'GET' && req.url.searchParams.has('client_id')) {
    await start(req, res, ctx, browser);
    return;
  }
  const account = await loadBrowserProfile(req, ctx);
  if (!account) {
    //J03 step 2: the saved request survives sign-in through the cookie;
    //the sign-in return is this app's own approval page only
    res.redirect(signinRedirect(ctx, browser.links.authorize), method === 'POST' ? 303 : 302);
    return;
  }
  if (method === 'POST') {
    await submit(req, res, ctx, browser, account);
    return;
  }
  const ready = await prepareApproval(req, ctx, browser, account.id, new Date());
  if (ready.kind === 'stop') {
    await render(req, res, ctx, stopPage(browser.links, ready.state, account), ready.code);
    return;
  }
  await display(req, res, ctx, browser, ready, account);
});
