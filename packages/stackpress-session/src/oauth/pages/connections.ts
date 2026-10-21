//modules
import type Request from '@stackpress/ingest/Request';
import type Response from '@stackpress/ingest/Response';
import type Server from '@stackpress/ingest/Server';
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { loadSafeProfile } from '../policy.js';
import type {
  OAuthGrantRevokeResult,
  OAuthGrantsListItem,
  OAuthPlugin
} from '../types.js';
import type {
  OAuthConnectionView,
  OAuthConnectionsResult,
  OAuthConnectionsSnapshot,
  OAuthConnectionsState
} from '../views/types.js';
import {
  CONNECTIONS_VIEW,
  bodyField,
  browserLinks,
  clientHost,
  getBrowserContext,
  loadBrowserProfile,
  newCsrf,
  renderBrowserPage,
  resourceView,
  savedClientName,
  signinRedirect,
  validCsrf
} from './browser.js';
import type { OAuthBrowserContext, OAuthBrowserProfile } from './browser.js';

function snapshot(
  state: OAuthConnectionsState,
  browser: { links: OAuthConnectionsSnapshot['links'] },
  extra: Partial<OAuthConnectionsSnapshot> = {}
): OAuthConnectionsSnapshot {
  return { state, connections: [], links: browser.links, ...extra };
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * The person's own active approvals through the fixed
 * `oauth-grants-list` event, turned into display rows from saved data
 * only. Rows never carry access IDs, hashes, codes or renewal tokens -
 * the event already omits them and nothing else is added here except
 * saved display names. Legacy API keys are not OAuth grants and never
 * appear (storage.md: legacy key management stays in its existing UI).
 */
async function listConnections(
  ctx: Server,
  browser: OAuthBrowserContext,
  profileId: string
): Promise<OAuthConnectionView[] | null> {
  const resolved = await ctx.resolve<OAuthGrantsListItem[]>(
    'oauth-grants-list',
    { profileId }
  );
  if (resolved.code !== 200 || !Array.isArray(resolved.results)) {
    return null;
  }
  const { config, store } = browser;
  const rows: OAuthConnectionView[] = [];
  for (const grant of resolved.results) {
    if (!grant.active) continue;
    const name = await savedClientName(store, grant.client.id).catch(() => undefined);
    rows.push({
      grantId: grant.grantId,
      client: {
        id: grant.client.id,
        ...(name ? { name } : {}),
        ...(clientHost(grant.client.id) ? { host: clientHost(grant.client.id) } : {})
      },
      resource: resourceView(config, grant.resource) ||
        { id: grant.resource, name: grant.resource, description: '' },
      scopes: grant.scopes.map((id) => ({ id, name: config.scopes[id]?.name || id })),
      operations: grant.operations,
      issued: toIso(grant.issued),
      deadline: toIso(grant.deadline)
    });
  }
  return rows;
}

async function show(
  req: Request,
  res: Response,
  ctx: Server,
  browser: OAuthBrowserContext,
  account: OAuthBrowserProfile,
  result?: OAuthConnectionsResult,
  resultName?: string,
  code = 200
) {
  const connections = await listConnections(ctx, browser, account.id);
  const extra = {
    account: { name: account.name },
    ...(result ? { result } : {}),
    ...(resultName ? { resultName } : {})
  };
  if (!connections) {
    await renderBrowserPage(req, res, ctx, CONNECTIONS_VIEW,
      snapshot('error', browser, extra), result === 'disconnected' ? 200 : 503);
    return;
  }
  await renderBrowserPage(req, res, ctx, CONNECTIONS_VIEW, snapshot('list', browser, {
    ...extra,
    connections,
    csrf: newCsrf(res, ctx)
  }), code);
}

/**
 * Shared guard for both connection routes: finalized service, signed-in
 * browser profile (J14 sign-in with a safe return to this list) and a
 * freshly loaded active account (J07). Returns `null` once it has
 * already written the response.
 */
async function guard(
  req: Request,
  res: Response,
  ctx: Server
): Promise<{ browser: OAuthBrowserContext, account: OAuthBrowserProfile } | null> {
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  const browser = getBrowserContext(ctx);
  if (!browser) {
    await renderBrowserPage(req, res, ctx, CONNECTIONS_VIEW,
      snapshot('unavailable', { links: browserLinks(ctx, oauth.config) }), 503);
    return null;
  }
  const account = await loadBrowserProfile(req, ctx);
  if (!account) {
    res.redirect(
      signinRedirect(ctx, browser.links.connections),
      req.method.toUpperCase() === 'POST' ? 303 : 302
    );
    return null;
  }
  const profile = await loadSafeProfile(ctx, account.id);
  if (!profile) {
    await renderBrowserPage(req, res, ctx, CONNECTIONS_VIEW,
      snapshot('inactive', browser, { account: { name: account.name } }), 403);
    return null;
  }
  return { browser, account: { id: profile.id, name: account.name } };
}

/**
 * GET `${base}/connections` (J13/J14): the signed-in person's own
 * connected programs, or an empty state.
 */
export default action(async function OAuthConnectionsPage({ req, res, ctx }) {
  //if there is a response body or there is an error code
  if (res.body || (res.code && res.code !== 200)) {
    //let the response pass through
    return;
  }
  const guarded = await guard(req, res, ctx);
  if (!guarded) return;
  await show(req, res, ctx, guarded.browser, guarded.account);
});

/**
 * POST `${base}/connections/revoke` (J13 step 2): body-only grant ID,
 * CSRF, ownership checked by `oauth-grant-revoke` against the trusted
 * signed-in profile. Success is reported only after the event returns,
 * i.e. after the cancellation transaction committed; another person's
 * or an unknown approval is reported as unavailable without revealing
 * its owner; a failure offers a retry and claims nothing.
 */
export const connectionsRevokePage = action(async function OAuthConnectionsRevokePage({ req, res, ctx }) {
  //if there is a response body or there is an error code
  if (res.body || (res.code && res.code !== 200)) {
    //let the response pass through
    return;
  }
  const guarded = await guard(req, res, ctx);
  if (!guarded) return;
  const { browser, account } = guarded;
  if (!validCsrf(req, res, ctx)) {
    await show(req, res, ctx, browser, account, 'form_expired', undefined, 419);
    return;
  }
  const grantId = bodyField(req, 'grant');
  if (typeof grantId !== 'string' || grantId.length === 0) {
    await show(req, res, ctx, browser, account, 'not_found', undefined, 404);
    return;
  }
  //name for the confirmation, from the person's own list only
  const before = await listConnections(ctx, browser, account.id);
  const known = before?.find((row) => row.grantId === grantId);
  const name = known ? known.client.name || known.client.host || known.client.id : undefined;
  const resolved = await ctx.resolve<OAuthGrantRevokeResult>(
    'oauth-grant-revoke',
    { profileId: account.id, grantId }
  );
  if (resolved.code === 200 && resolved.results?.revoked === true) {
    await show(req, res, ctx, browser, account, 'disconnected', name, 200);
    return;
  }
  if (resolved.code === 400 && resolved.error === 'invalid_grant') {
    await show(req, res, ctx, browser, account, 'not_found', undefined, 404);
    return;
  }
  await show(req, res, ctx, browser, account, 'failed', undefined,
    (resolved.code || 500) >= 500 ? 503 : 400);
});
