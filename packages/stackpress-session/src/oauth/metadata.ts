//stackpress-session/oauth
import type {
  NormalizedOAuthSessionConfig,
  OAuthResourceConfig
} from './types.js';

//RFC 8414 (3.1 well-known path insertion) / RFC 9728 well-known metadata
//document paths and bodies. Pure, reusable builders: session mounts
//these at its own routes when OAuth runs attached to the app; AI's
//standalone HTTP/SSE entrypoint (task 00009) imports the same functions
//so a separately-run MCP server advertises identical metadata without
//duplicating this contract. "Advertise only configured supported
//capabilities" (configuration.md): never list OpenID Connect, client
//credentials, implicit/password grants, confidential-client
//authentication or offline_access.

export type OAuthIssuerMetadata = {
  issuer: string,
  authorization_endpoint: string,
  token_endpoint: string,
  registration_endpoint?: string,
  revocation_endpoint: string,
  response_types_supported: string[],
  grant_types_supported: string[],
  code_challenge_methods_supported: string[],
  token_endpoint_auth_methods_supported: string[],
  scopes_supported: string[],
  authorization_response_iss_parameter_supported: true
};

export type OAuthProtectedResourceMetadata = {
  resource: string,
  authorization_servers: string[],
  scopes_supported: string[],
  resource_name: string,
  resource_documentation: string,
  bearer_methods_supported: string[]
};

function wellKnownPath(suffix: string, url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `/.well-known/${suffix}${path}`;
}

/**
 * The RFC 8414 well-known path for the configured issuer, derived from
 * the issuer URL's own path component (empty for a bare origin).
 */
export function issuerMetadataPath(issuer: string): string {
  return wellKnownPath('oauth-authorization-server', issuer);
}

/**
 * The RFC 9728 well-known path for one configured resource, derived
 * from that resource URL's own path component.
 */
export function resourceMetadataPath(resource: string): string {
  return wellKnownPath('oauth-protected-resource', resource);
}

export const ROOT_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

/**
 * Builds the RFC 8414 authorization server metadata document. Lists
 * `code`/`refresh_token` grant types (refresh only ever issued when the
 * client's own allowed grant types include it - that check lives at
 * issuance time, not here), S256, public-client auth method `none`,
 * and `iss` support on return, matching events.md/design.md exactly.
 */
export function buildIssuerMetadata(
  config: NormalizedOAuthSessionConfig
): OAuthIssuerMetadata {
  return {
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}${config.base}/authorize`,
    token_endpoint: `${config.issuer}${config.base}/token`,
    ...(config.registration.enabled ? {
      registration_endpoint: `${config.issuer}${config.base}/register`
    } : {}),
    revocation_endpoint: `${config.issuer}${config.base}/revoke`,
    response_types_supported: [ 'code' ],
    grant_types_supported: [ 'authorization_code', 'refresh_token' ],
    code_challenge_methods_supported: [ 'S256' ],
    token_endpoint_auth_methods_supported: [ 'none' ],
    scopes_supported: Object.keys(config.scopes),
    authorization_response_iss_parameter_supported: true
  };
}

/**
 * Builds the RFC 9728 protected-resource metadata document for one
 * configured resource.
 */
export function buildProtectedResourceMetadata(
  resource: OAuthResourceConfig,
  config: NormalizedOAuthSessionConfig
): OAuthProtectedResourceMetadata {
  return {
    resource: resource.resource,
    authorization_servers: [ config.issuer ],
    scopes_supported: resource.scopes,
    resource_name: resource.name,
    resource_documentation: resource.description,
    bearer_methods_supported: [ 'header' ]
  };
}
