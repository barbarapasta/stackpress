//stackpress-session
import StackpressSessionException from '../Exception.js';
import type {
  NormalizedOAuthSessionConfig,
  OAuthSessionConfig
} from './types.js';

//RFC 6749 scope-token grammar: 1*NQCHAR, printable ASCII except
//space (0x20), double quote (0x22) and backslash (0x5C).
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

//safe upper bound so a configured limit cannot be used to force an
//unbounded allocation or overflow arithmetic elsewhere.
const MAX_SAFE_LIMIT = 2_147_483_647;

function fail(message: string): never {
  throw StackpressSessionException.for(
    `Invalid session.oauth configuration: ${message}`
  ).withCode(500);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(
  value: unknown,
  fallback: number,
  path: string,
  min = 1,
  max = MAX_SAFE_LIMIT
): number {
  if (typeof value === 'undefined') return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(`${path} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

//canonical resource identity: exact URL, no credentials, query or
//fragment; do not trim paths or fold a trailing slash into another
//service.
function validateUrl(
  value: unknown,
  path: string,
  allowDevelopmentHttp: boolean
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} is required`);
  }
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    fail(`${path} must be an absolute URL`);
  }
  if (url!.username || url!.password) {
    fail(`${path} must not contain credentials`);
  }
  if (url!.search) {
    fail(`${path} must not contain a query string`);
  }
  if (url!.hash) {
    fail(`${path} must not contain a fragment`);
  }
  const isLoopback = url!.hostname === 'localhost' ||
    url!.hostname === '127.0.0.1' ||
    url!.hostname === '::1';
  if (url!.protocol !== 'https:') {
    if (!(allowDevelopmentHttp && url!.protocol === 'http:' && isLoopback)) {
      fail(`${path} must be HTTPS`);
    }
  }
  return value as string;
}

function validateOrigin(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    fail(`${path} must be a valid origin`);
  }
  if (url!.pathname !== '/' && url!.pathname !== '') {
    fail(`${path} must not contain a path`);
  }
  return value as string;
}

/**
 * Validates and applies defaults to the raw `session.oauth` setting,
 * per the frozen configuration contract. Throws on any invalid,
 * malformed, duplicate or conflicting value; startup must stop rather
 * than continue with a partially trusted configuration.
 */
export default function normalizeOAuthConfig(
  raw: unknown
): NormalizedOAuthSessionConfig {
  if (!isPlainObject(raw)) {
    fail('session.oauth must be an object');
  }
  const config = raw as OAuthSessionConfig;
  const development = typeof config.development === 'undefined'
    ? false
    : config.development;
  if (typeof development !== 'boolean') {
    fail('development must be a boolean');
  }

  const issuer = validateUrl(config.issuer, 'issuer', development);
  //issuer must not carry a path fragment beyond authority; reject a
  //trailing slash turning it into a different canonical identity by
  //normalizing against URL parsing above (already exact string kept).

  const base = typeof config.base === 'undefined'
    ? '/auth/oauth2'
    : config.base;
  if (typeof base !== 'string' || !base.startsWith('/')) {
    fail('base must be an absolute application path');
  }
  if (base === '/auth/oauth') {
    fail('base must be separate from the existing API OAuth routes');
  }

  //--------------------------------------------------------------//
  // scopes

  if (!isPlainObject(config.scopes)) {
    fail('scopes must be an object');
  }
  const scopeNames = Object.keys(config.scopes as object);
  for (const name of scopeNames) {
    if (!SCOPE_TOKEN.test(name)) {
      fail(`scope name "${name}" does not follow OAuth scope-token grammar`);
    }
    const scope = (config.scopes as Record<string, unknown>)[name];
    if (!isPlainObject(scope) ||
      typeof scope.name !== 'string' || !scope.name ||
      typeof scope.description !== 'string' || !scope.description
    ) {
      fail(`scope "${name}" must declare a name and description`);
    }
  }
  const scopes = config.scopes as NormalizedOAuthSessionConfig['scopes'];

  //--------------------------------------------------------------//
  // resources

  if (!Array.isArray(config.resources) || config.resources.length === 0) {
    fail('resources must be a non-empty list');
  }
  const seenResources = new Set<string>();
  for (const entry of config.resources) {
    if (!isPlainObject(entry)) {
      fail('each resource must be an object');
    }
    const resource = validateUrl(
      entry.resource,
      'resources[].resource',
      development
    );
    if (seenResources.has(resource)) {
      fail(`duplicate resource URL: ${resource}`);
    }
    seenResources.add(resource);
    if (typeof entry.name !== 'string' || !entry.name) {
      fail('resources[].name is required');
    }
    if (typeof entry.description !== 'string' || !entry.description) {
      fail('resources[].description is required');
    }
    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
      fail(`resource "${resource}" must declare at least one scope`);
    }
    const seenScopes = new Set<string>();
    for (const scope of entry.scopes) {
      if (typeof scope !== 'string' || !scopeNames.includes(scope)) {
        fail(`resource "${resource}" references unknown scope "${scope}"`);
      }
      if (seenScopes.has(scope)) {
        fail(`resource "${resource}" declares duplicate scope "${scope}"`);
      }
      seenScopes.add(scope);
    }
  }
  const resources = config.resources as
    NormalizedOAuthSessionConfig['resources'];

  //--------------------------------------------------------------//
  // policy

  if (!isPlainObject(config.policy)) {
    fail('policy is required');
  }
  if (typeof config.policy.approval !== 'string' || !config.policy.approval) {
    fail('policy.approval must name a registered app event');
  }
  if (typeof config.policy.access !== 'string' || !config.policy.access) {
    fail('policy.access must name a registered app event');
  }
  const policy = {
    approval: config.policy.approval,
    access: config.policy.access,
    timeoutMs: positiveInt(
      config.policy.timeoutMs, 5000, 'policy.timeoutMs'
    )
  };

  //--------------------------------------------------------------//
  // clients

  const clientsRaw = config.clients || {};
  if (!isPlainObject(clientsRaw)) {
    fail('clients must be an object');
  }
  let allowed: string[] | undefined;
  if (typeof clientsRaw.allowed !== 'undefined') {
    if (!Array.isArray(clientsRaw.allowed)) {
      fail('clients.allowed must be a list of client IDs');
    }
    const seen = new Set<string>();
    for (const id of clientsRaw.allowed) {
      if (typeof id !== 'string' || !id) {
        fail('clients.allowed entries must be non-empty strings');
      }
      if (seen.has(id)) {
        fail(`clients.allowed contains duplicate client ID "${id}"`);
      }
      seen.add(id);
    }
    allowed = clientsRaw.allowed as string[];
  }
  const clients = { allowed };

  //--------------------------------------------------------------//
  // registration

  const registrationRaw = config.registration || {};
  if (!isPlainObject(registrationRaw)) {
    fail('registration must be an object');
  }
  const registration = {
    enabled: typeof registrationRaw.enabled === 'undefined'
      ? true
      : registrationRaw.enabled,
    bodyBytes: positiveInt(
      registrationRaw.bodyBytes, 16384, 'registration.bodyBytes'
    ),
    redirects: positiveInt(
      registrationRaw.redirects, 10, 'registration.redirects'
    ),
    unusedSeconds: positiveInt(
      registrationRaw.unusedSeconds, 86400, 'registration.unusedSeconds'
    ),
    maxUnused: positiveInt(
      registrationRaw.maxUnused, 10000, 'registration.maxUnused'
    )
  };
  if (typeof registration.enabled !== 'boolean') {
    fail('registration.enabled must be a boolean');
  }

  //--------------------------------------------------------------//
  // clientMetadata

  const clientMetadataRaw = config.clientMetadata || {};
  if (!isPlainObject(clientMetadataRaw)) {
    fail('clientMetadata must be an object');
  }
  const clientMetadata = {
    timeoutMs: positiveInt(
      clientMetadataRaw.timeoutMs, 5000, 'clientMetadata.timeoutMs'
    ),
    bodyBytes: positiveInt(
      clientMetadataRaw.bodyBytes, 5120, 'clientMetadata.bodyBytes'
    ),
    maxEntries: positiveInt(
      clientMetadataRaw.maxEntries, 1000, 'clientMetadata.maxEntries'
    ),
    maxAgeSeconds: positiveInt(
      clientMetadataRaw.maxAgeSeconds, 3600, 'clientMetadata.maxAgeSeconds'
    )
  };

  //--------------------------------------------------------------//
  // limits

  const limitsRaw = config.limits || {};
  if (!isPlainObject(limitsRaw)) {
    fail('limits must be an object');
  }
  const factorRaw = limitsRaw.factor || {};
  if (!isPlainObject(factorRaw)) {
    fail('limits.factor must be an object');
  }
  const limits = {
    windowSeconds: positiveInt(
      limitsRaw.windowSeconds, 60, 'limits.windowSeconds'
    ),
    registration: positiveInt(
      limitsRaw.registration, 10, 'limits.registration'
    ),
    authorization: positiveInt(
      limitsRaw.authorization, 30, 'limits.authorization'
    ),
    token: positiveInt(limitsRaw.token, 60, 'limits.token'),
    factor: {
      attempts: positiveInt(
        factorRaw.attempts, 5, 'limits.factor.attempts'
      ),
      source: positiveInt(
        factorRaw.source, 20, 'limits.factor.source'
      )
    },
    clientMetadata: positiveInt(
      limitsRaw.clientMetadata, 30, 'limits.clientMetadata'
    )
  };

  //--------------------------------------------------------------//
  // durations

  const accessSeconds = positiveInt(
    config.accessSeconds, 900, 'accessSeconds'
  );
  const renewalSeconds = positiveInt(
    config.renewalSeconds, 604800, 'renewalSeconds'
  );
  const codeSeconds = positiveInt(
    config.codeSeconds, 60, 'codeSeconds', 1, 600
  );
  const pendingSeconds = positiveInt(
    config.pendingSeconds, 600, 'pendingSeconds', 1, 1800
  );

  //--------------------------------------------------------------//
  // browserOrigins

  let browserOrigins: string[] = [];
  if (typeof config.browserOrigins !== 'undefined') {
    if (!Array.isArray(config.browserOrigins)) {
      fail('browserOrigins must be a list of origins');
    }
    browserOrigins = config.browserOrigins.map(
      (origin, index) => validateOrigin(origin, `browserOrigins[${index}]`)
    );
  }

  return {
    issuer,
    base,
    resources,
    scopes,
    policy,
    clients,
    registration,
    clientMetadata,
    limits,
    accessSeconds,
    renewalSeconds,
    codeSeconds,
    pendingSeconds,
    browserOrigins,
    development
  };
}
