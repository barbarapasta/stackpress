//modules
import type { Method } from '@stackpress/lib/types';

//--------------------------------------------------------------------//
// Config Types (session.oauth)

export type OAuthResourceConfig = {
  resource: string,
  name: string,
  description: string,
  scopes: string[]
};

export type OAuthScopeConfig = {
  name: string,
  description: string
};

export type OAuthPolicyConfig = {
  approval: string,
  access: string,
  timeoutMs?: number
};

export type OAuthClientsConfig = {
  allowed?: string[]
};

export type OAuthRegistrationConfig = {
  enabled?: boolean,
  bodyBytes?: number,
  redirects?: number,
  unusedSeconds?: number,
  maxUnused?: number
};

export type OAuthClientMetadataConfig = {
  timeoutMs?: number,
  bodyBytes?: number,
  maxEntries?: number,
  maxAgeSeconds?: number
};

export type OAuthFactorLimitConfig = {
  attempts?: number,
  source?: number
};

export type OAuthLimitsConfig = {
  windowSeconds?: number,
  registration?: number,
  authorization?: number,
  token?: number,
  factor?: OAuthFactorLimitConfig,
  clientMetadata?: number
};

//ie. session.oauth
export type OAuthSessionConfig = {
  issuer: string,
  base?: string,
  resources: OAuthResourceConfig[],
  scopes: Record<string, OAuthScopeConfig>,
  policy: OAuthPolicyConfig,
  clients?: OAuthClientsConfig,
  registration?: OAuthRegistrationConfig,
  clientMetadata?: OAuthClientMetadataConfig,
  limits?: OAuthLimitsConfig,
  accessSeconds?: number,
  renewalSeconds?: number,
  codeSeconds?: number,
  pendingSeconds?: number,
  browserOrigins?: string[],
  development?: boolean
};

//fully defaulted/validated shape used internally once startup validation
//has run; every optional field on OAuthSessionConfig is required here.
export type NormalizedOAuthSessionConfig = {
  issuer: string,
  base: string,
  resources: OAuthResourceConfig[],
  scopes: Record<string, OAuthScopeConfig>,
  policy: Required<OAuthPolicyConfig>,
  clients: OAuthClientsConfig,
  registration: Required<OAuthRegistrationConfig>,
  clientMetadata: Required<OAuthClientMetadataConfig>,
  limits: {
    windowSeconds: number,
    registration: number,
    authorization: number,
    token: number,
    factor: Required<OAuthFactorLimitConfig>,
    clientMetadata: number
  },
  accessSeconds: number,
  renewalSeconds: number,
  codeSeconds: number,
  pendingSeconds: number,
  browserOrigins: string[],
  development: boolean
};

//--------------------------------------------------------------------//
// MCP/API Settings (declared here so both packages share one shape)

//ie. mcp.oauth and mcp.sse.oauth; resolve everything else from the
//session service so the app cannot substitute a weaker verifier.
export type McpOAuthConfig = {
  resource: string
};

//ie. api endpoint.oauth on an existing `type: 'session'` route
export type ApiOAuthEndpointConfig = {
  operation: string,
  resources: string[]
};

//--------------------------------------------------------------------//
// Identity Types

export type OAuthCredential = 'read' | 'full';

export type OAuthIdentity = {
  profileId: string,
  clientId: string,
  grantId: string,
  resource: string,
  scopes: string[],
  expires: Date,
  deadline: Date,
  credential: OAuthCredential
};

//--------------------------------------------------------------------//
// App Policy Types

export type OAuthSafeProfile = {
  id: string,
  roles: string[]
};

export type OAuthFactorAvailability = {
  available: boolean
};

export type OAuthApprovalPolicyInput = {
  phase: 'approval',
  profile: OAuthSafeProfile,
  client: { id: string, name?: string },
  resource: string,
  scopes: string[],
  operations: string[],
  factor: OAuthFactorAvailability
};

export type OAuthApprovalPolicyResult = {
  allowed: boolean,
  scopes?: string[],
  operations?: string[],
  accessSeconds?: number,
  renewalSeconds?: number,
  requireFactor?: boolean
};

export type OAuthAccessPhase = 'exchange' | 'verify' | 'refresh';

export type OAuthGrantSummary = {
  grantId: string,
  clientId: string,
  resource: string,
  scopes: string[],
  operations: string[],
  deadline: Date
};

export type OAuthAccessPolicyInput = {
  phase: OAuthAccessPhase,
  profile: OAuthSafeProfile,
  client: { id: string, name?: string },
  grant: OAuthGrantSummary
};

export type OAuthAccessPolicyResult = {
  allowed: boolean,
  scopes?: string[]
};

//--------------------------------------------------------------------//
// Fixed Library Event DTOs

export type OAuthSurface = 'mcp' | 'api';

export type OAuthClientRegisterInput = {
  redirect_uris: string[],
  client_name?: string,
  token_endpoint_auth_method?: string,
  grant_types?: string[],
  response_types?: string[]
};

export type OAuthClientRegisterResult = {
  client_id: string,
  client_id_issued_at: number,
  redirect_uris: string[],
  grant_types: string[],
  response_types: string[],
  token_endpoint_auth_method: string
};

export type OAuthAuthorizationStartInput = {
  client_id: string,
  redirect_uri: string,
  response_type: string,
  state?: string,
  code_challenge: string,
  code_challenge_method: string,
  resource?: string,
  scope?: string
};

export type OAuthAuthorizationStartResult = {
  pending: string,
  client: { id: string, name?: string },
  resource: string,
  scopes: string[],
  operations: string[]
} | {
  redirect: string
};

export type OAuthAuthorizeInput = {
  pending: string,
  profileId: string,
  scopes: string[],
  operations: string[],
  factorReceipt?: string,
  approve: boolean
};

export type OAuthAuthorizeResult = {
  redirect: string
};

export type OAuthCodeExchangeInput = {
  client_id: string,
  code: string,
  redirect_uri: string,
  code_verifier: string,
  resource?: string
};

export type OAuthTokenResult = {
  access_token: string,
  token_type: 'Bearer',
  expires_in: number,
  scope: string,
  refresh_token?: string
};

export type OAuthRefreshInput = {
  client_id: string,
  refresh_token: string,
  resource?: string,
  scope?: string
};

export type OAuthTokenVerifyInput = {
  token: string,
  resource: string,
  surface: OAuthSurface,
  method: Method,
  requiredCredential: OAuthCredential,
  operation?: string
};

export type OAuthRevokeInput = {
  client_id: string,
  token: string,
  token_type_hint?: string
};

export type OAuthGrantsListInput = {
  profileId: string
};

export type OAuthGrantsListItem = {
  grantId: string,
  client: { id: string, name?: string },
  resource: string,
  scopes: string[],
  operations: string[],
  issued: Date,
  expires: Date,
  deadline: Date,
  active: boolean
};

export type OAuthGrantRevokeInput = {
  profileId: string,
  grantId: string
};

export type OAuthGrantRevokeResult = {
  revoked: true
};

export type OAuthCleanupInput = {
  batchSize: number,
  now: Date
};

export type OAuthCleanupResult = {
  removed: number
};

//--------------------------------------------------------------------//
// Trusted Operation Registry

//saved at API route registration; `route` is the configured template,
//never caller input.
export type OAuthApiOperationDescriptor = {
  id: string,
  surface: 'api',
  method: Method,
  route: string,
  event: string,
  resources: string[],
  scopes: string[],
  data: Record<string, unknown>
};

export type OAuthMcpTransport = 'mcp' | 'sse';

//saved when AI registers its standalone or attached listener address.
export type OAuthMcpResourceDescriptor = {
  surface: OAuthMcpTransport,
  route: string,
  resource: string
};

//--------------------------------------------------------------------//
// Service Interface

//ie. ctx.plugin<OAuthPlugin>('oauth')
export type OAuthService = {
  readonly config: NormalizedOAuthSessionConfig,
  readonly finalized: boolean,
  registerApiOperation(descriptor: OAuthApiOperationDescriptor): void,
  registerMcpResource(descriptor: OAuthMcpResourceDescriptor): void,
  finalize(): Promise<void>,
  assertFinalized(): void
};

export type OAuthPlugin = OAuthService;
