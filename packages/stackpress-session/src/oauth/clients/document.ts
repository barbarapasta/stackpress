//modules
import type { NormalizedOAuthSessionConfig } from '../types.js';
import { hashWithDomain } from '../storage/ids.js';
import type { OAuthClientDocumentRow, OAuthClientRow } from '../storage/types.js';
//stackpress-session/oauth/clients
import { isClientAllowed } from './policy.js';
import { isIpLiteralHostname, isDisallowedAddress, type OAuthDnsResolver } from './network.js';
import { isLocalMachineHost, isAcceptableRegisteredRedirect } from './redirect.js';
import { enforceRateLimit, type OAuthRateLimitStore } from './rateLimit.js';
import { OAuthClientError } from './errors.js';
import { defaultTransport, type OAuthTransport } from './transport.js';

//Safely reads a client-document URL acting as a `client_id`
//(configuration.md/storage.md "Client documents"). This is the only
//production path that ever makes an outbound request on this server's
//behalf toward a caller-supplied address, so every step here exists to
//keep that request from being turned into an SSRF primitive: exact
//HTTPS/path validation, DNS resolution checked before connecting,
//binding the connection to that checked address, one combined timeout,
//a decoded-byte ceiling that also covers decompression, no redirect
//following, and HTTP caching rules that never serve a stale copy after
//a failed revalidation.

export type OAuthClientDocumentStore = OAuthRateLimitStore & {
  getClientDocumentByUrlHash(urlHash: string): Promise<OAuthClientDocumentRow | null>,
  saveClientDocument(input: {
    urlHash: string,
    metadata: Record<string, unknown>,
    etag?: string | null,
    lastModified?: string | null,
    freshUntil: Date,
    now?: Date
  }): Promise<OAuthClientDocumentRow>,
  getClientByClientId(clientId: string): Promise<OAuthClientRow | null>,
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

export type OAuthClientDocumentDeps = {
  store: OAuthClientDocumentStore,
  resolveHost: OAuthDnsResolver,
  transport?: OAuthTransport,
  now?: () => Date
};

export type OAuthClientDocument = {
  clientId: string,
  metadata: Record<string, unknown>,
  cached: boolean
};

function validateDocumentUrl(
  clientId: string,
  development: boolean
): URL {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthClientError('invalid_request', 'Client document URL is malformed');
  }
  if (url.username || url.password || url.hash) {
    throw new OAuthClientError('invalid_request', 'Client document URL must not contain credentials or a fragment');
  }
  const isLoopback = isLocalMachineHost(url.hostname);
  if (url.protocol !== 'https:') {
    if (!(development && url.protocol === 'http:' && isLoopback)) {
      throw new OAuthClientError('invalid_request', 'Client document URL must be HTTPS');
    }
  }
  if (url.pathname === '/' || url.pathname === '') {
    throw new OAuthClientError('invalid_request', 'Client document URL must not be the root path');
  }
  return url;
}

async function checkedAddress(
  url: URL,
  resolveHost: OAuthDnsResolver
): Promise<string> {
  if (isIpLiteralHostname(url.hostname)) {
    if (isDisallowedAddress(url.hostname)) {
      throw new OAuthClientError('unsafe_target', 'Client document host is not a public address');
    }
    return url.hostname;
  }
  let answers;
  try {
    answers = await resolveHost(url.hostname);
  } catch {
    throw new OAuthClientError('fetch_failed', 'Client document host could not be resolved');
  }
  const allowed = answers.filter((a) => !isDisallowedAddress(a.address));
  if (allowed.length === 0) {
    throw new OAuthClientError('unsafe_target', 'Client document host has no public address');
  }
  return allowed[0].address;
}

function parseCacheControl(value: string | undefined): {
  noStore: boolean, maxAgeSeconds: number | null
} {
  if (!value) {
    return { noStore: false, maxAgeSeconds: null };
  }
  const directives = value.toLowerCase().split(',').map((d) => d.trim());
  const noStore = directives.includes('no-store') || directives.includes('no-cache');
  const maxAgeDirective = directives.find((d) => d.startsWith('max-age='));
  let maxAgeSeconds: number | null = null;
  if (maxAgeDirective) {
    const parsed = parseInt(maxAgeDirective.split('=')[1], 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      maxAgeSeconds = parsed;
    }
  }
  return { noStore, maxAgeSeconds };
}

function validateMetadata(
  clientId: string,
  body: Buffer
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new OAuthClientError('invalid_client_metadata', 'Client document is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OAuthClientError('invalid_client_metadata', 'Client document must be a JSON object');
  }
  const metadata = parsed as Record<string, unknown>;
  if (metadata.client_id !== clientId) {
    throw new OAuthClientError('invalid_client_metadata', 'Client document client_id does not match its own URL');
  }
  if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
    throw new OAuthClientError('invalid_client_metadata', 'Client document must declare redirect_uris');
  }
  for (const uri of metadata.redirect_uris) {
    if (typeof uri !== 'string' || !isAcceptableRegisteredRedirect(uri)) {
      throw new OAuthClientError('invalid_client_metadata', 'Client document contains an unacceptable redirect_uri');
    }
  }
  const grantTypes = typeof metadata.grant_types === 'undefined' ?
    [ 'authorization_code' ] : metadata.grant_types;
  if (
    !Array.isArray(grantTypes) ||
    grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
  ) {
    throw new OAuthClientError('invalid_client_metadata', 'Client document declares an unsupported grant type');
  }
  const responseTypes = typeof metadata.response_types === 'undefined' ?
    [ 'code' ] : metadata.response_types;
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code')) {
    throw new OAuthClientError('invalid_client_metadata', 'Client document declares an unsupported response type');
  }
  const authMethod = typeof metadata.token_endpoint_auth_method === 'undefined' ?
    'none' : metadata.token_endpoint_auth_method;
  if (authMethod !== 'none') {
    throw new OAuthClientError('invalid_client_metadata', 'Client document declares an unsupported token endpoint auth method');
  }
  return { ...metadata, grant_types: grantTypes, response_types: responseTypes, token_endpoint_auth_method: authMethod };
}

/**
 * Fetches (or serves a fresh cached copy of) a client-document URL
 * acting as a `client_id`. `source` is the caller's rate-limit source
 * address. Never returns stale data after a failed revalidation: on any
 * transport/validation failure this throws instead of falling back to
 * whatever was last cached.
 */
export async function fetchClientDocument(
  clientId: string,
  source: string,
  config: NormalizedOAuthSessionConfig,
  deps: OAuthClientDocumentDeps
): Promise<OAuthClientDocument> {
  if (!isClientAllowed(clientId, config.clients)) {
    throw new OAuthClientError('invalid_request', 'Client is not on the configured allowed-client list');
  }
  const url = validateDocumentUrl(clientId, config.development);
  const urlHash = hashWithDomain('client-document-url', clientId);
  const now = (deps.now || (() => new Date()))();

  const existing = await deps.store.getClientDocumentByUrlHash(urlHash);
  if (existing && existing.freshUntil && existing.freshUntil.getTime() > now.getTime()) {
    return { clientId, metadata: existing.metadata, cached: true };
  }

  await enforceRateLimit(
    deps.store,
    [ { key: `clientMetadata:${config.issuer}:${source}`, limit: config.limits.clientMetadata } ],
    config.limits.windowSeconds,
    now
  );

  const address = await checkedAddress(url, deps.resolveHost);
  const transport = deps.transport || defaultTransport;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (existing?.etag) {
    headers['If-None-Match'] = existing.etag;
  }
  if (existing?.lastModified) {
    headers['If-Modified-Since'] = existing.lastModified;
  }

  const response = await transport({
    address,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    headers,
    timeoutMs: config.clientMetadata.timeoutMs,
    maxDecodedBytes: config.clientMetadata.bodyBytes
  });

  const header = (name: string): string | undefined => {
    const value = response.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  if (response.status === 304 && existing) {
    const { noStore, maxAgeSeconds } = parseCacheControl(header('cache-control'));
    if (noStore) {
      return { clientId, metadata: existing.metadata, cached: true };
    }
    const freshUntil = new Date(now.getTime() +
      Math.min(maxAgeSeconds ?? config.clientMetadata.maxAgeSeconds, config.clientMetadata.maxAgeSeconds) * 1000
    );
    await deps.store.saveClientDocument({
      urlHash,
      metadata: existing.metadata,
      etag: existing.etag,
      lastModified: existing.lastModified,
      freshUntil,
      now
    });
    return { clientId, metadata: existing.metadata, cached: true };
  }

  if (response.status !== 200) {
    //includes redirects (3xx): never followed, always a failure here.
    throw new OAuthClientError('fetch_failed', `Client document request returned HTTP ${response.status}`);
  }

  const metadata = validateMetadata(clientId, response.body);
  const { noStore, maxAgeSeconds } = parseCacheControl(header('cache-control'));

  //Capacity is reserved atomically and only for a client identity that
  //does not already exist - refreshing an already-tracked document
  //client (the common case: the same document fetched again) must not
  //consume a second capacity slot for the one identity it already
  //holds (storage.md: "Reserve unused-client...capacity atomically,
  //not COUNT then insert").
  const alreadyTracked = await deps.store.getClientByClientId(clientId);
  const unusedExpires = new Date(now.getTime() + config.registration.unusedSeconds * 1000);
  if (alreadyTracked) {
    await deps.store.touchUnusedClient(clientId, 'document', {}, unusedExpires, now);
  } else {
    const reserved = await deps.store.reserveClientCapacity('document', config.registration.maxUnused);
    if (!reserved) {
      throw new OAuthClientError('unsafe_target', 'Too many unused client document identities for this issuer');
    }
    try {
      await deps.store.touchUnusedClient(clientId, 'document', {}, unusedExpires, now);
    } catch (e) {
      await deps.store.releaseClientCapacity('document');
      throw e;
    }
  }

  if (!noStore) {
    const freshUntil = new Date(now.getTime() +
      Math.min(maxAgeSeconds ?? config.clientMetadata.maxAgeSeconds, config.clientMetadata.maxAgeSeconds) * 1000
    );
    await deps.store.saveClientDocument({
      urlHash,
      metadata,
      etag: header('etag') ?? null,
      lastModified: header('last-modified') ?? null,
      freshUntil,
      now
    });
  }

  return { clientId, metadata, cached: false };
}
