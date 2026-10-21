//modules
import Create from '@stackpress/inquire/Create';

//Table/column names for the nine private OAuth models (storage.md).
//These are hand-written `Create` builders, not generated CRUD: no
//Store/Actions class exists for these tables, so no generic admin/API/MCP
//surface can be wired to them (configuration.md/storage.md "no generated
//admin/API/MCP exposure"). Only the focused store methods in OAuthStore.ts
//touch these tables.
//
//No foreign keys are declared to Profile or between these tables. Several
//atomic operations (storage.md "Atomic Operations") require cancelling a
//grant and preserving its replay history explicitly, in a specific order,
//rather than relying on a database-level ON DELETE action; a declared FK
//would force one cascade/restrict policy that could violate that ordering
//(for example "Account deletion cancels dependent grants before cleanup").
//Referential integrity for these columns is enforced in OAuthStore.ts.
//Ordinary indexes still exist for every lookup/filter column below.
//
//Every `INTEGER` counter column below (generation, lock_version, revision,
//counter, count) is NOT NULL with no DB-level `default`, not `default: 0`:
//the installed Pgsql dialect (`field.default` truthy-checked in
//@stackpress/inquire's Pgsql dialect) silently drops a falsy default such
//as `0` or `false`, which would otherwise insert NULL into a NOT NULL
//column and fail at write time. OAuthStore.ts must always supply these
//columns explicitly on insert.
//
//`oauth_grant`, `oauth_pending`, `oauth_factor_use` and `oauth_rate_bucket`
//each carry a nullable `lock_token` column used only by OAuthStore.ts's
//`_claim()` helper to verify that *this* conditional UPDATE - not some
//other committed writer that coincidentally produced the same final
//value - is the one that actually matched its WHERE clause. None of
//Inquire's four adapters exposes affected-row counts through the public
//`engine.query()`/builder surface, so comparing the post-UPDATE value
//against a precomputed "expected" value is not sufficient by itself: two
//true concurrent callers computing the same expected value from the same
//stale read would otherwise both believe they won. See `_claim()` for the
//full explanation and the regression test this was found from.
//
//No `TEXT` column below (the JSON-encoded array columns: scopes,
//operations, approved_scopes, approved_operations,
//operation_fingerprints) carries a DB-level `default` either: real MySQL
//(confirmed against a disposable `mysql:8.4` container, not just a
//dialect-rendering quirk like the INTEGER issue above) rejects any
//`DEFAULT` clause on `TEXT`/`BLOB`/`JSON` columns outright with "BLOB,
//TEXT, GEOMETRY or JSON column '...' can't have a default value".
//OAuthStore.ts already always supplies these columns explicitly on
//insert, so removing the default changes nothing at the application
//level.
//
//Every `resource` column is `VARCHAR(512)`, not `VARCHAR(2048)` like
//`redirect_uri`/`state`: `oauth_legacy_binding`'s composite unique key
//(kind, legacy_id_hash, resource) must fit within MySQL/InnoDB's
//3072-byte index-key limit under `utf8mb4` (4 bytes/char); at length
//2048 the `resource` column alone would need 8192 bytes and MySQL
//refused to create the index ("Specified key was too long"), confirmed
//against the same disposable `mysql:8.4` container. 512 (2048 bytes in
//utf8mb4) comfortably fits the composite index alongside `kind` and
//`legacy_id_hash`. `redirect_uri`/`state` are never part of an index, so
//they keep the more generous 2048 limit.

export const OAUTH_CLIENT_TABLE = 'oauth_client';
export const OAUTH_CLIENT_DOCUMENT_TABLE = 'oauth_client_document';
export const OAUTH_PENDING_TABLE = 'oauth_pending';
export const OAUTH_GRANT_TABLE = 'oauth_grant';
export const OAUTH_CODE_TABLE = 'oauth_code';
export const OAUTH_REFRESH_TOKEN_TABLE = 'oauth_refresh_token';
export const OAUTH_LEGACY_BINDING_TABLE = 'oauth_legacy_binding';
export const OAUTH_FACTOR_USE_TABLE = 'oauth_factor_use';
export const OAUTH_RATE_BUCKET_TABLE = 'oauth_rate_bucket';
export const OAUTH_CLIENT_CAPACITY_TABLE = 'oauth_client_capacity';

function idField() {
  return {
    type: 'VARCHAR',
    length: 255,
    nullable: false,
    comment: 'Unique generated identifier.'
  } as const;
}

export function createOAuthClient() {
  const schema = new Create(OAUTH_CLIENT_TABLE);
  schema.addField('id', idField());
  schema.addField('client_id', {
    type: 'VARCHAR', length: 255, nullable: false,
    comment: 'Exact public client_id (registered client ID or client document URL).'
  });
  schema.addField('kind', {
    type: 'VARCHAR', length: 32, default: 'registered', nullable: false,
    comment: 'document or registered.'
  });
  schema.addField('metadata', {
    type: 'TEXT', nullable: true,
    comment: 'Registered-client metadata only; JSON encoded.'
  });
  schema.addField('created', {
    type: 'DATETIME', default: 'now()', nullable: false,
    comment: 'Generated timestamp when row was created.'
  });
  schema.addField('last_used', { type: 'DATETIME', nullable: true, comment: 'Last reference timestamp.' });
  schema.addField('unused_expires', { type: 'DATETIME', nullable: true, comment: 'Unused-client cleanup deadline.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey('oauth_client_client_id_unique', 'client_id');
  schema.addKey('oauth_client_kind_index', 'kind');
  schema.addKey('oauth_client_unused_expires_index', 'unused_expires');
  return schema;
}

export function createOAuthClientDocument() {
  const schema = new Create(OAUTH_CLIENT_DOCUMENT_TABLE);
  schema.addField('id', idField());
  schema.addField('url_hash', {
    type: 'VARCHAR', length: 64, nullable: false,
    comment: 'SHA-256 hash of the exact canonical client document URL.'
  });
  schema.addField('metadata', { type: 'TEXT', nullable: true, comment: 'Last validated client metadata document body; JSON encoded.' });
  schema.addField('etag', { type: 'VARCHAR', length: 255, nullable: true, comment: 'HTTP ETag validator.' });
  schema.addField('last_modified', { type: 'VARCHAR', length: 255, nullable: true, comment: 'HTTP Last-Modified validator.' });
  schema.addField('fresh_until', { type: 'DATETIME', nullable: true, comment: 'Cached-copy freshness deadline.' });
  schema.addField('last_used', { type: 'DATETIME', nullable: true, comment: 'Last served/revalidated timestamp.' });
  schema.addField('created', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp when row was created.' });
  schema.addField('updated', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp that is updated whenever the row has changed.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey('oauth_client_document_url_hash_unique', 'url_hash');
  schema.addKey('oauth_client_document_fresh_until_index', 'fresh_until');
  return schema;
}

export function createOAuthPending() {
  const schema = new Create(OAUTH_PENDING_TABLE);
  schema.addField('id', idField());
  schema.addField('binding_hash', { type: 'VARCHAR', length: 64, nullable: false, comment: 'Hash of the browser continuation cookie value.' });
  schema.addField('client_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Checked client_id.' });
  schema.addField('redirect_uri', { type: 'VARCHAR', length: 2048, nullable: false, comment: 'Checked exact redirect_uri.' });
  schema.addField('state', { type: 'VARCHAR', length: 2048, nullable: true, comment: 'Caller-supplied opaque state.' });
  schema.addField('code_challenge', { type: 'VARCHAR', length: 255, nullable: false, comment: 'PKCE S256 code_challenge.' });
  schema.addField('code_challenge_method', { type: 'VARCHAR', length: 16, default: 'S256', nullable: false, comment: 'PKCE challenge method.' });
  schema.addField('resource', { type: 'VARCHAR', length: 512, nullable: false, comment: 'Checked exact canonical resource URL.' });
  schema.addField('scopes', { type: 'TEXT', nullable: false, comment: 'Requested scope set; JSON encoded array.' });
  schema.addField('operations', { type: 'TEXT', nullable: false, comment: 'Requested API operation IDs; JSON encoded array.' });
  schema.addField('profile_id', { type: 'VARCHAR', length: 255, nullable: true, comment: 'Bound current profile once sign-in completes.' });
  schema.addField('approved_scopes', { type: 'TEXT', nullable: false, comment: 'Approved scope subset; JSON encoded array.' });
  schema.addField('approved_operations', { type: 'TEXT', nullable: false, comment: 'Approved operation subset; JSON encoded array.' });
  //task 00007: TEXT, not VARCHAR(255) - the stored value is the full
  //signed receipt from factor.ts (00005's setPendingFactorReceipt
  //handoff), which embeds the bound scope/operation selection and so
  //exceeds 255 characters for ordinary selections.
  schema.addField('factor_receipt', { type: 'TEXT', nullable: true, comment: 'Server-bound signed factor verification receipt.' });
  schema.addField('status', { type: 'VARCHAR', length: 16, default: 'pending', nullable: false, comment: 'pending, completed, or denied.' });
  schema.addField('lock_token', { type: 'VARCHAR', length: 64, nullable: true, comment: 'Internal-only CAS verification token; see OAuthStore.ts _claim().' });
  schema.addField('expires', { type: 'DATETIME', nullable: false, comment: 'Pending request expiry.' });
  schema.addField('created', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp when row was created.' });
  schema.addField('updated', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp that is updated whenever the row has changed.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey('oauth_pending_binding_hash_unique', 'binding_hash');
  schema.addKey('oauth_pending_status_index', 'status');
  schema.addKey('oauth_pending_expires_index', 'expires');
  schema.addKey('oauth_pending_profile_id_index', 'profile_id');
  return schema;
}

export function createOAuthGrant() {
  const schema = new Create(OAUTH_GRANT_TABLE);
  schema.addField('id', idField());
  schema.addField('profile_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Profile that approved this grant.' });
  schema.addField('client_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Client this grant was approved for.' });
  schema.addField('resource', { type: 'VARCHAR', length: 512, nullable: false, comment: 'Exact canonical resource URL this grant covers.' });
  schema.addField('scopes', { type: 'TEXT', nullable: false, comment: 'Currently approved scope set; JSON encoded array.' });
  schema.addField('operation_fingerprints', { type: 'TEXT', nullable: false, comment: 'Approved API operation descriptor fingerprints; JSON encoded array.' });
  schema.addField('approved', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Timestamp the approval was granted.' });
  schema.addField('deadline', { type: 'DATETIME', nullable: false, comment: 'Immutable final deadline.' });
  schema.addField('access_seconds', { type: 'INTEGER', nullable: false, comment: 'Configured access lifetime ceiling at approval time.' });
  schema.addField('read_id_hash', { type: 'VARCHAR', length: 64, nullable: true, comment: 'Hash of the current read-only access ID.' });
  schema.addField('full_key_hash', { type: 'VARCHAR', length: 64, nullable: true, comment: 'Hash of the current full id:secret access key.' });
  schema.addField('access_expires', { type: 'DATETIME', nullable: true, comment: 'Current access expiry.' });
  schema.addField('generation', { type: 'INTEGER', nullable: false, comment: 'Token generation.' });
  schema.addField('lock_version', { type: 'INTEGER', nullable: false, comment: 'Optimistic lock version.' });
  schema.addField('lock_token', { type: 'VARCHAR', length: 64, nullable: true, comment: 'Internal-only CAS verification token; see OAuthStore.ts _claim().' });
  schema.addField('revision', { type: 'INTEGER', nullable: false, comment: 'Monotonic catalog revision.' });
  schema.addField('active', { type: 'BOOLEAN', default: true, nullable: false, comment: 'False once cancelled.' });
  schema.addField('created', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp when row was created.' });
  schema.addField('updated', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp that is updated whenever the row has changed.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey('oauth_grant_read_id_hash_unique', 'read_id_hash');
  schema.addKey('oauth_grant_profile_id_index', 'profile_id');
  schema.addKey('oauth_grant_client_id_index', 'client_id');
  schema.addKey('oauth_grant_full_key_hash_index', 'full_key_hash');
  schema.addKey('oauth_grant_active_index', 'active');
  schema.addKey('oauth_grant_deadline_index', 'deadline');
  return schema;
}

export function createOAuthCode() {
  const schema = new Create(OAUTH_CODE_TABLE);
  schema.addField('id', idField());
  schema.addField('code_hash', { type: 'VARCHAR', length: 64, nullable: false, comment: 'Hash of the single-use authorization code.' });
  schema.addField('grant_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Grant this code was issued for.' });
  schema.addField('client_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Client this code was issued to.' });
  schema.addField('resource', { type: 'VARCHAR', length: 512, nullable: false, comment: 'Exact canonical resource URL this code is bound to.' });
  schema.addField('redirect_uri', { type: 'VARCHAR', length: 2048, nullable: false, comment: 'Exact redirect_uri this code is bound to.' });
  schema.addField('code_challenge', { type: 'VARCHAR', length: 255, nullable: false, comment: 'PKCE S256 code_challenge this code is bound to.' });
  schema.addField('expires', { type: 'DATETIME', nullable: false, comment: 'Short code expiry.' });
  schema.addField('consumed', { type: 'DATETIME', nullable: true, comment: 'Exchange timestamp; preserved for replay detection until the grant deadline.' });
  schema.addField('created', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp when row was created.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey('oauth_code_code_hash_unique', 'code_hash');
  schema.addKey('oauth_code_grant_id_index', 'grant_id');
  schema.addKey('oauth_code_expires_index', 'expires');
  return schema;
}

export function createOAuthRefreshToken() {
  const schema = new Create(OAUTH_REFRESH_TOKEN_TABLE);
  schema.addField('id', idField());
  schema.addField('token_hash', { type: 'VARCHAR', length: 64, nullable: false, comment: 'Hash of the refresh token.' });
  schema.addField('grant_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Grant this refresh token belongs to.' });
  schema.addField('client_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Client this refresh token was issued to.' });
  schema.addField('resource', { type: 'VARCHAR', length: 512, nullable: false, comment: 'Exact canonical resource URL this refresh token is bound to.' });
  schema.addField('generation', { type: 'INTEGER', nullable: false, comment: 'Token generation at issuance.' });
  schema.addField('issued', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Issuance timestamp.' });
  schema.addField('consumed', { type: 'DATETIME', nullable: true, comment: 'Rotation timestamp; preserved for reuse detection.' });
  schema.addField('expires', { type: 'DATETIME', nullable: false, comment: 'Final refresh-token expiry, capped by the grant deadline.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey('oauth_refresh_token_token_hash_unique', 'token_hash');
  schema.addKey('oauth_refresh_token_grant_id_index', 'grant_id');
  schema.addKey('oauth_refresh_token_expires_index', 'expires');
  return schema;
}

export function createOAuthLegacyBinding() {
  const schema = new Create(OAUTH_LEGACY_BINDING_TABLE);
  schema.addField('id', idField());
  schema.addField('kind', { type: 'VARCHAR', length: 16, nullable: false, comment: 'app or session.' });
  schema.addField('legacy_id_hash', { type: 'VARCHAR', length: 64, nullable: false, comment: 'Hash of the bound legacy record ID.' });
  schema.addField('incarnation', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Immutable source-record incarnation reference.' });
  schema.addField('resource', { type: 'VARCHAR', length: 512, nullable: false, comment: 'Exact canonical resource URL this legacy key is bound to.' });
  schema.addField('active', { type: 'BOOLEAN', default: true, nullable: false, comment: 'False once the binding has been explicitly removed.' });
  schema.addField('expires', { type: 'DATETIME', nullable: true, comment: 'Optional binding expiry.' });
  schema.addField('created', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp when row was created.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey(
    'oauth_legacy_binding_kind_id_resource_unique',
    ['kind', 'legacy_id_hash', 'resource']
  );
  schema.addKey('oauth_legacy_binding_active_index', 'active');
  return schema;
}

export function createOAuthFactorUse() {
  const schema = new Create(OAUTH_FACTOR_USE_TABLE);
  schema.addField('id', idField());
  schema.addField('factor_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'The verified factor\'s stable identifier.' });
  schema.addField('incarnation', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Incarnation reference of the factor source record.' });
  schema.addField('profile_id', { type: 'VARCHAR', length: 255, nullable: false, comment: 'Profile this verified factor belongs to.' });
  schema.addField('counter', { type: 'INTEGER', nullable: false, comment: 'Last accepted TOTP counter.' });
  schema.addField('lock_token', { type: 'VARCHAR', length: 64, nullable: true, comment: 'Internal-only CAS verification token; see OAuthStore.ts _claim().' });
  schema.addField('updated', { type: 'DATETIME', default: 'now()', nullable: false, comment: 'Generated timestamp that is updated whenever the row has changed.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey(
    'oauth_factor_use_factor_incarnation_unique',
    ['factor_id', 'incarnation']
  );
  schema.addKey('oauth_factor_use_profile_id_index', 'profile_id');
  return schema;
}

export function createOAuthRateBucket() {
  const schema = new Create(OAUTH_RATE_BUCKET_TABLE);
  schema.addField('id', idField());
  schema.addField('key_hash', { type: 'VARCHAR', length: 64, nullable: false, comment: 'Hash of the limiter key.' });
  //named `window_start`, not `window`: `window` is a reserved word in the
  //SQL standard (window functions) and in MySQL 8.0.2+; an unquoted raw
  //WHERE clause referencing it fails at the dialect level (reproduced
  //directly against real PGlite - see storage-tables.test.ts history).
  schema.addField('window_start', { type: 'DATETIME', nullable: false, comment: 'This bucket\'s window start boundary.' });
  schema.addField('count', { type: 'INTEGER', nullable: false, comment: 'Current request/attempt count within the window.' });
  schema.addField('lock_token', { type: 'VARCHAR', length: 64, nullable: true, comment: 'Internal-only CAS verification token; see OAuthStore.ts _claim().' });
  schema.addField('expires', { type: 'DATETIME', nullable: false, comment: 'Bounded cleanup eligibility.' });
  schema.addPrimaryKey('id');
  schema.addUniqueKey('oauth_rate_bucket_key_window_unique', ['key_hash', 'window_start']);
  schema.addKey('oauth_rate_bucket_expires_index', 'expires');
  return schema;
}

//Task 00004 addition: a tiny, private, single-row-per-kind counter
//table so "reserve unused-client capacity atomically, not COUNT then
//insert" (storage.md) can actually be implemented. None of Inquire's
//four adapters exposes an affected-row count or a portable advisory
//lock through the public query-builder surface - the exact constraint
//`_claim()` already documents for grant locking - so a COUNT(*) over
//`oauth_client` followed by a separate INSERT cannot be made atomic
//portably; a dedicated counter row that every reservation/release goes
//through with the same `_claim()` CAS pattern can. Not one of
//storage.md's nine named models: it holds no identity, credential or
//approval data, only an internal capacity gauge, so it carries no
//admin/API/MCP exposure to restrict (nothing generates a Store/Actions
//layer or admin page for it - it is created with a hand-written
//`Create` builder exactly like the other nine, never through
//`oauth.idea`).
export function createOAuthClientCapacity() {
  const schema = new Create(OAUTH_CLIENT_CAPACITY_TABLE);
  schema.addField('id', {
    type: 'VARCHAR', length: 32, nullable: false,
    comment: 'Capacity bucket key: the OAuthClient kind (document or registered).'
  });
  schema.addField('count', { type: 'INTEGER', nullable: false, comment: 'Current reserved unused-client count for this kind.' });
  schema.addField('lock_token', { type: 'VARCHAR', length: 64, nullable: true, comment: 'Internal-only CAS verification token; see OAuthStore.ts _claim().' });
  schema.addPrimaryKey('id');
  return schema;
}

export function createAllOAuthTables() {
  return [
    createOAuthClient(),
    createOAuthClientDocument(),
    createOAuthPending(),
    createOAuthGrant(),
    createOAuthCode(),
    createOAuthRefreshToken(),
    createOAuthLegacyBinding(),
    createOAuthFactorUse(),
    createOAuthRateBucket(),
    createOAuthClientCapacity()
  ];
}
