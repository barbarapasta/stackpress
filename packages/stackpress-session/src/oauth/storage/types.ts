//Internal row shapes for the nine private OAuth tables. These are not
//exported from the package's public `types.ts`/`index.ts` barrel: they
//back OAuthStore.ts only (storage.md "no generated admin/API/MCP
//exposure" applies to the whole private runtime, not only the schema).

export type OAuthClientRow = {
  id: string,
  clientId: string,
  kind: 'document' | 'registered',
  metadata: Record<string, unknown>,
  created: Date,
  lastUsed: Date | null,
  unusedExpires: Date | null
};

export type OAuthClientDocumentRow = {
  id: string,
  urlHash: string,
  metadata: Record<string, unknown>,
  etag: string | null,
  lastModified: string | null,
  freshUntil: Date | null,
  lastUsed: Date | null,
  created: Date,
  updated: Date
};

export type OAuthPendingStatus = 'pending' | 'completed' | 'denied';

export type OAuthPendingRow = {
  id: string,
  bindingHash: string,
  clientId: string,
  redirectUri: string,
  state: string | null,
  codeChallenge: string,
  codeChallengeMethod: string,
  resource: string,
  scopes: string[],
  operations: string[],
  profileId: string | null,
  approvedScopes: string[],
  approvedOperations: string[],
  factorReceipt: string | null,
  status: OAuthPendingStatus,
  expires: Date,
  created: Date,
  updated: Date
};

export type OAuthGrantRow = {
  id: string,
  profileId: string,
  clientId: string,
  resource: string,
  scopes: string[],
  operationFingerprints: string[],
  approved: Date,
  deadline: Date,
  accessSeconds: number,
  readIdHash: string | null,
  fullKeyHash: string | null,
  accessExpires: Date | null,
  generation: number,
  lockVersion: number,
  revision: number,
  active: boolean,
  created: Date,
  updated: Date
};

export type OAuthCodeRow = {
  id: string,
  codeHash: string,
  grantId: string,
  clientId: string,
  resource: string,
  redirectUri: string,
  codeChallenge: string,
  expires: Date,
  consumed: Date | null,
  created: Date
};

export type OAuthRefreshTokenRow = {
  id: string,
  tokenHash: string,
  grantId: string,
  clientId: string,
  resource: string,
  generation: number,
  issued: Date,
  consumed: Date | null,
  expires: Date
};

export type OAuthLegacyBindingRow = {
  id: string,
  kind: 'app' | 'session',
  legacyIdHash: string,
  incarnation: string,
  resource: string,
  active: boolean,
  expires: Date | null,
  created: Date
};

export type OAuthFactorUseRow = {
  id: string,
  factorId: string,
  incarnation: string,
  profileId: string,
  counter: number,
  updated: Date
};

export type OAuthRateBucketRow = {
  id: string,
  keyHash: string,
  window: Date,
  count: number,
  expires: Date
};

export type OAuthTokenIssued = {
  grantId: string,
  accessId: string,
  accessSecret: string,
  accessExpires: Date,
  scopes: string[],
  refreshToken: string | null
};

export type OAuthCleanupCounts = {
  pending: number,
  codes: number,
  refreshTokens: number,
  grants: number,
  rateBuckets: number,
  legacyBindings: number,
  clients: number
};
