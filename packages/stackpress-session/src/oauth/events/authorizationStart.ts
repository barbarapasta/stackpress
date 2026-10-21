//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { randomToken } from '../storage/ids.js';
import { isClientAllowed } from '../clients/policy.js';
import { validateReturnAddress } from '../clients/redirect.js';
import { fetchClientDocument } from '../clients/document.js';
import { resolveHostname, type OAuthDnsResolver } from '../clients/network.js';
import type { OAuthTransport } from '../clients/transport.js';
import { enforceRateLimit } from '../clients/rateLimit.js';
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import { resolveResource } from './resource.js';
import type {
  NormalizedOAuthSessionConfig,
  OAuthAuthorizationStartInput,
  OAuthAuthorizationStartResult,
  OAuthPlugin
} from '../types.js';
import type { OAuthClientRegisterStore } from '../clients/register.js';
import type { OAuthClientDocumentStore } from '../clients/document.js';

const PENDING_ID_PREFIX = 'oauthp_';

//the real store object this event uses (`OAuthStore`) satisfies both of
//00004's narrower store interfaces plus the pending-creation method this
//task needs; kept as a structural intersection rather than importing
//`OAuthStore` itself so this stays decoupled from the concrete class.
export type OAuthAuthorizationStartStore =
  OAuthClientRegisterStore &
  OAuthClientDocumentStore & {
    createPending(input: {
      id: string, bindingHash: string, clientId: string, redirectUri: string,
      state?: string | null, codeChallenge: string, codeChallengeMethod?: string,
      resource: string, scopes: string[], operations: string[], expires: Date
    }): Promise<{ id: string }>
  };

export type OAuthAuthorizationStartContext = {
  store: OAuthAuthorizationStartStore,
  config: NormalizedOAuthSessionConfig,
  oauth: OAuthPlugin
};

//injectable network dependencies: production defaults to the real DNS
//resolver and `fetchClientDocument`'s own default HTTPS transport; tests
//substitute both with 00004's in-memory fakes (never a real socket or
//DNS lookup), matching sprint.md's "controllable test substitutes".
export type OAuthAuthorizationStartDeps = {
  resolveHost?: OAuthDnsResolver,
  transport?: OAuthTransport,
  now?: () => Date
};

function isClientDocumentId(clientId: string): boolean {
  return /^https?:\/\//i.test(clientId);
}

function errorRedirect(
  redirectUri: string,
  issuer: string,
  state: string | null,
  error: string
): OAuthAuthorizationStartResult {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (state !== null) {
    url.searchParams.set('state', state);
  }
  url.searchParams.set('iss', issuer);
  return { redirect: url.toString() };
}

/**
 * The testable core of `oauth-authorization-start`, decoupled from the
 * `ctx`/`req`/`res` event plumbing so a test can inject a fake DNS
 * resolver/transport (00004's substitutes) to exercise the
 * client-document path end to end, the same way `fetchClientDocument`
 * itself is tested directly in `client-document.test.ts`. Client and
 * return address are checked before anything is ever saved or
 * redirected to (design.md: "Check the client and return address before
 * redirecting anywhere. Unknown clients or unsafe addresses get a normal
 * local error page"); only once that pair is safe do later problems
 * (unsupported response_type, invalid_scope, invalid_target) come back
 * as a redirect carrying the original `state` and configured `iss`,
 * never a local page. Calls task 00004's `isClientAllowed`/
 * `validateReturnAddress`/`fetchClientDocument` rather than
 * reimplementing client admission, return-address matching or
 * client-document fetching.
 */
export async function runAuthorizationStart(
  input: OAuthAuthorizationStartInput,
  context: OAuthAuthorizationStartContext,
  deps: OAuthAuthorizationStartDeps = {}
): Promise<OAuthAuthorizationStartResult> {
  const { store, config, oauth } = context;
  const now = (deps.now || (() => new Date()))();

  if (
    typeof input.client_id !== 'string' || !input.client_id ||
    typeof input.redirect_uri !== 'string' || !input.redirect_uri ||
    typeof input.response_type !== 'string' ||
    typeof input.code_challenge !== 'string' || !input.code_challenge ||
    typeof input.code_challenge_method !== 'string' ||
    typeof input.bindingHash !== 'string' || !input.bindingHash
  ) {
    throw oauthError('invalid_request', 'Missing required authorization parameters');
  }

  await enforceRateLimit(
    store,
    [ { key: `authorization:${config.issuer}:${input.source}`, limit: config.limits.authorization } ],
    config.limits.windowSeconds,
    now
  );

  if (!isClientAllowed(input.client_id, config.clients)) {
    throw oauthError('invalid_client', 'Client is not admitted');
  }

  let redirectUris: string[];
  let clientName: string | undefined;
  if (isClientDocumentId(input.client_id)) {
    const document = await fetchClientDocument(
      input.client_id,
      input.source,
      config,
      {
        store,
        resolveHost: deps.resolveHost || resolveHostname,
        ...(deps.transport ? { transport: deps.transport } : {}),
        ...(deps.now ? { now: deps.now } : {})
      }
    );
    const metadata = document.metadata;
    redirectUris = Array.isArray(metadata.redirect_uris) ?
      metadata.redirect_uris as string[] : [];
    clientName = typeof metadata.client_name === 'string' ?
      metadata.client_name : undefined;
  } else {
    const client = await store.getClientByClientId(input.client_id);
    if (!client) {
      throw oauthError('invalid_client', 'Unknown client');
    }
    const metadata = client.metadata;
    redirectUris = Array.isArray(metadata.redirect_uris) ?
      metadata.redirect_uris as string[] : [];
    clientName = typeof metadata.client_name === 'string' ?
      metadata.client_name : undefined;
  }

  if (!validateReturnAddress(input.redirect_uri, redirectUris)) {
    throw oauthError('invalid_request', 'Return address does not match a registered entry');
  }

  //client and return address are now safe; every remaining problem
  //goes back as a redirect carrying the original state/iss, never a
  //local error page.
  const state = input.state ?? null;

  if (input.response_type !== 'code') {
    return errorRedirect(input.redirect_uri, config.issuer, state, 'unsupported_response_type');
  }
  if (input.code_challenge_method !== 'S256') {
    return errorRedirect(input.redirect_uri, config.issuer, state, 'invalid_request');
  }

  const resource = resolveResource(config, input.resource);
  if (!resource) {
    return errorRedirect(input.redirect_uri, config.issuer, state, 'invalid_target');
  }
  const resourceEntry = config.resources.find((entry) => entry.resource === resource)!;

  let scopes: string[];
  if (typeof input.scope === 'string' && input.scope.length > 0) {
    scopes = input.scope.split(' ').filter(Boolean);
    const allowed = new Set(resourceEntry.scopes);
    if (scopes.some((scope) => !allowed.has(scope))) {
      return errorRedirect(input.redirect_uri, config.issuer, state, 'invalid_scope');
    }
  } else {
    scopes = resourceEntry.scopes;
  }

  //the currently registered API operations for this resource: shown
  //on the approval page as the set that may be opted into, narrowed
  //(never expanded) by app policy and the person's own selection at
  //approval time.
  const operations = Array.from(oauth.apiOperations.values())
    .filter((entry) => entry.descriptor.resources.includes(resource))
    .map((entry) => entry.descriptor.id);

  const pending = await store.createPending({
    id: randomToken(PENDING_ID_PREFIX),
    bindingHash: input.bindingHash,
    clientId: input.client_id,
    redirectUri: input.redirect_uri,
    state,
    codeChallenge: input.code_challenge,
    codeChallengeMethod: input.code_challenge_method,
    resource,
    scopes,
    operations,
    expires: new Date(now.getTime() + config.pendingSeconds * 1000)
  });

  return {
    pending: pending.id,
    client: { id: input.client_id, name: clientName },
    resource,
    scopes,
    operations
  };
}

/**
 * `oauth-authorization-start` (events.md): validated authorization query
 * and trusted browser continuation context -> safe approval summary and
 * opaque pending reference, or a validated redirect/error result.
 */
export default action(async function OAuthAuthorizationStart({ req, res, ctx }) {
  try {
    const context = getOAuthContext(ctx);
    const input = req.data() as OAuthAuthorizationStartInput;
    const result = await runAuthorizationStart(input, context);
    res.results(result as unknown as Record<string, unknown>);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
