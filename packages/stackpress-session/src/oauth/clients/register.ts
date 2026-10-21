//modules
import { randomToken } from '../storage/ids.js';
import type { OAuthClientRegisterResult, NormalizedOAuthSessionConfig } from '../types.js';
import type { OAuthClientRow } from '../storage/types.js';
//stackpress-session/oauth/clients
import { isAcceptableRegisteredRedirect } from './redirect.js';
import { enforceRateLimit, type OAuthRateLimitStore } from './rateLimit.js';
import { OAuthClientError } from './errors.js';

//Public dynamic client registration (configuration.md/storage.md/
//events.md "oauth-client-register"). Registration alone never issues
//an approval or user key (events.md: "Client registration creates no
//grant"); it only mints an exact client_id that may later be checked
//against `clients.allowed` at authorization time. Only the fixed,
//accepted public-client shape is accepted: `authorization_code` plus
//optional `refresh_token`, response type `code`, auth method `none` -
//anything else is rejected rather than silently downgraded.

const REGISTRATION_CLIENT_ID_PREFIX = 'oauthreg_';
const MAX_CLIENT_NAME_LENGTH = 255;

export type OAuthClientRegisterStore = OAuthRateLimitStore & {
  reserveClientCapacity(kind: 'document' | 'registered', max: number): Promise<boolean>,
  releaseClientCapacity(kind: 'document' | 'registered'): Promise<void>,
  touchUnusedClient(
    clientId: string,
    kind: 'document' | 'registered',
    metadata: Record<string, unknown>,
    unusedExpires: Date,
    now?: Date
  ): Promise<OAuthClientRow>
};

export type OAuthClientRegisterDeps = {
  store: OAuthClientRegisterStore,
  now?: () => Date
};

function fail(message: string): never {
  throw new OAuthClientError('invalid_client_metadata', message);
}

function validateBody(raw: Buffer, bodyBytes: number): Record<string, unknown> {
  if (raw.length > bodyBytes) {
    throw new OAuthClientError('invalid_request', 'Registration request body exceeds the configured byte limit');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('Registration request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail('Registration request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Registers a public client, enforcing every body/field/redirect
 * limit, accepted grant/response/authentication method and a
 * source-and-issuer rate limit, then reserves one unused-client
 * capacity slot (configuration.md `registration.maxUnused`). Returns
 * the fixed registration JSON shape from events.md - never an access
 * key of any kind.
 */
export async function registerClient(
  rawBody: Buffer,
  source: string,
  config: NormalizedOAuthSessionConfig,
  deps: OAuthClientRegisterDeps
): Promise<OAuthClientRegisterResult> {
  if (!config.registration.enabled) {
    throw new OAuthClientError('registration_disabled', 'Client registration is disabled');
  }
  const now = (deps.now || (() => new Date()))();

  await enforceRateLimit(
    deps.store,
    [ { key: `registration:${config.issuer}:${source}`, limit: config.limits.registration } ],
    config.limits.windowSeconds,
    now
  );

  const body = validateBody(rawBody, config.registration.bodyBytes);

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    fail('redirect_uris is required and must be a non-empty list');
  }
  const redirectUris = body.redirect_uris as unknown[];
  if (redirectUris.length > config.registration.redirects) {
    fail(`redirect_uris may not exceed ${config.registration.redirects} entries`);
  }
  const seen = new Set<string>();
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || !isAcceptableRegisteredRedirect(uri)) {
      fail(`redirect_uris contains an unacceptable entry: ${String(uri)}`);
    }
    if (seen.has(uri)) {
      fail(`redirect_uris contains a duplicate entry: ${uri}`);
    }
    seen.add(uri);
  }

  const grantTypes = typeof body.grant_types === 'undefined' ?
    [ 'authorization_code' ] : body.grant_types;
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.length === 0 ||
    grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token') ||
    !grantTypes.includes('authorization_code')
  ) {
    fail('grant_types must be authorization_code, optionally with refresh_token');
  }

  const responseTypes = typeof body.response_types === 'undefined' ?
    [ 'code' ] : body.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    fail('response_types must be exactly ["code"]');
  }

  const authMethod = typeof body.token_endpoint_auth_method === 'undefined' ?
    'none' : body.token_endpoint_auth_method;
  if (authMethod !== 'none') {
    fail('token_endpoint_auth_method must be "none"; public clients require no secret');
  }

  let clientName: string | undefined;
  if (typeof body.client_name !== 'undefined') {
    if (typeof body.client_name !== 'string' || body.client_name.length > MAX_CLIENT_NAME_LENGTH) {
      fail(`client_name must be a string of at most ${MAX_CLIENT_NAME_LENGTH} characters`);
    }
    clientName = body.client_name;
  }

  //Registration always mints a brand-new client identity (the CSPRNG
  //client_id below cannot already exist), so there is no "refresh an
  //existing identity" case to special-case here the way document.ts
  //has to: every call reserves exactly one capacity slot, atomically
  //(storage.md: "Reserve unused-client...capacity atomically, not
  //COUNT then insert"), and releases it if the insert that was
  //supposed to follow the reservation fails for any reason.
  const reserved = await deps.store.reserveClientCapacity('registered', config.registration.maxUnused);
  if (!reserved) {
    throw new OAuthClientError('unsafe_target', 'Too many unused registered clients for this issuer');
  }

  const clientId = randomToken(REGISTRATION_CLIENT_ID_PREFIX);
  const metadata: Record<string, unknown> = {
    redirect_uris: redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: authMethod,
    ...(clientName ? { client_name: clientName } : {})
  };
  try {
    await deps.store.touchUnusedClient(
      clientId,
      'registered',
      metadata,
      new Date(now.getTime() + config.registration.unusedSeconds * 1000),
      now
    );
  } catch (e) {
    await deps.store.releaseClientCapacity('registered');
    throw e;
  }

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    redirect_uris: redirectUris as string[],
    grant_types: grantTypes as string[],
    response_types: responseTypes as string[],
    token_endpoint_auth_method: authMethod as string
  };
}
