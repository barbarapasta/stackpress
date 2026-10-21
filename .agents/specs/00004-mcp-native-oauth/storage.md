# Database Contract And Existing-Key Upgrade

Frozen contract for G-001/G-003/G-004, accepted 2026-09-29. Production code must satisfy this contract
on PGlite, PostgreSQL, MySQL and SQLite under Node 22. The [database proof](../../../proofs/mcp-oauth-store/README.md)
shows a feasible design and an existing Inquire defect; it is not a production
implementation. Model names below are the accepted schema contract.

## Inquire Comes First

Current shared adapters do not exclusively own the native connection during a
transaction. Fix this in Inquire before enabling OAuth stores. The callback must
receive a connection reserved until commit/rollback finishes. All statements in
that callback use that connection. For pools, reserve/release a real connection;
for a shared embedded resource, serialize every native query and transaction,
including queries made outside a transaction. Wrapping only OAuth calls is unsafe.

Keep the existing transaction entry point if possible. Reject unsupported nested
transactions before BEGIN; never roll back another transaction. Ensure errors,
failed commits and cancellation release ownership in a finally path. PGlite's
queue is scoped to the native resource; do not permit several processes to open
the same unsupported local store. SQLite concurrency must also work across
independent processes using native database locking, not merely a JavaScript lock.

The corrected Inquire package version must be pinned and verified before the
Stackpress implementation consumes it. No release number is invented here.
Regression tests include overlapping transactions, outside queries, connection
affinity, rollback after real SQL failure, ownership release and nested calls.
Reuse the P-001 four-engine race cases against production adapters and stores.

## Stored Records

| Model | Required contents and indexes |
| --- | --- |
| `OAuthClient` | Stable internal ID, unique exact public client ID, kind document/registered, registered-client metadata only, created/last-used/unused-expiry dates; document identities do not retain fetched bodies; no client password |
| `OAuthClientDocument` | Unique document URL hash, validated metadata and HTTP validators/freshness/last-use; bounded cache separate from live client identity; never cache errors or no-store bodies |
| `OAuthPending` | Random internal reference, hashed browser binding, checked authorization fields, profile once known, selected approval, factor receipt, expiry, pending/completed/denied state |
| `OAuthGrant` | Stable noncredential ID, profile/client/resource, scope set, approved API descriptor fingerprints, approval date, immutable final deadline, access lifetime ceiling, unique nullable read-ID hash, nullable full-key hash/access expiry until issued, generation, lockVersion, revision, active/cancelled state |
| `OAuthCode` | Unique code hash, grant/client/resource, exact redirect, S256 challenge, expiry, consumed timestamp; grant index |
| `OAuthRefreshToken` | Unique token hash, grant/client/resource, generation, issued/consumed dates, final expiry; preserve consumed history until deadline |
| `OAuthLegacyBinding` | Kind app/session, hashed legacy ID, immutable source-record incarnation, exact resource, active flag, optional expiry; unique kind/ID-hash/resource combination |
| `OAuthFactorUse` | Unique verified-factor ID plus incarnation, last accepted TOTP counter, profile and update date; atomic counter advance; no factor secret |
| `OAuthRateBucket` | Hashed limiter key, window boundary, count and expiry; unique key/window; shared atomic updates |

Keep lockVersion separate from token generation; revision advances on changes
that invalidate access or catalog state. Hashes clear on cancellation; expiry
may remain for management history. Document clients use only currently valid
cache data or a fresh checked fetch; no-store data lives only in that request.
Store minimal safe approval labels separately, never as a bypass for metadata
validation. Active grants retain identity references but not stale document bodies.

Use JSON fields for bounded scope/membership/metadata snapshots through supported
schema serialization, with ordinary indexed lookup columns. Relationships connect
to the existing Profile without copying API models. Generated admin pages for
these records follow the same rule as the existing Auth, Application and Session
records: only roles the app's access rules allow can reach them, and they are not
added to the admin menu by default. Those pages must not display hash columns. No
MCP tools or API routes may expose these records unless an app configures them
([amendment A-001](decisions.md#amendment-a-001--admin-access-to-oauth-records)). Internal
record IDs and `grantId` are distinct from access read IDs.

New access IDs use `oauth_` followed by 32 random bytes encoded as unpadded base64url;
secrets also contain 32 random bytes. Full keys are `id:secret`. Refresh tokens use
`oauthr_` plus 32 random bytes; codes use 32 random bytes. Use CSPRNG only. Store
SHA-256 hashes of high-entropy credentials, domain-separated by credential kind;
store a hash of the full access value as well as the read-ID lookup hash. Compare
secret hashes in constant time. There is no recoverable plaintext token column.
Database exposure is not made harmless by hashing; authorization metadata stays
private. Do not reuse browser session seed as a token secret or hashing key.

The `oauth_` namespace selects the OAuth verifier. Malformed/unknown/expired/new
keys never fall through to legacy lookup; a supplied bad secret never becomes an
ID-only read. Validate namespace collisions during upgrade and prevent creating
conflicting legacy IDs thereafter. New key issuance and refresh replace both ID
and secret. Clear current access hashes on cancellation. Keep spent-code/refresh
hashes and bindings until the final grant deadline so older replay stays detectable.

## Atomic Operations

1. Approval: validate current browser/person/client/policy/factor, then atomically
   consume the pending request and create the grant plus single-use code. No token
   exists yet. Repeated form POST cannot create another grant/code.
2. Code exchange: locate the code-to-grant reference outside the transaction.
   Inside it, the grant lockVersion UPDATE is the first table operation, then
   re-read and validate code/client/redirect/resource/PKCE and current account,
   client admission, grant state/deadline and exchange policy. Consume the code
   and issue access plus optional refresh in one transaction.
3. Refresh: locate the token-to-grant reference outside the transaction; make
   the grant UPDATE its first table operation, then re-read all mutable
   state, check current account/policy/deadline, consume the old token, rotate both
   access parts and insert the next refresh row in one transaction. Scope may
   narrow; membership and deadline cannot grow.
4. Reuse: only a real bound token/code with valid required client/proof inputs
   can cause cancellation. An authenticated code replay or refresh reuse cancels
   that grant's chain. Commit cancellation, then return invalid_grant; throwing
   inside the callback must not undo the cancellation. Guesses/mismatches cannot
   cancel another person's approval. Recognize used-code replay until the grant
   deadline even after the short code expiry; an unused expired code is simply
   rejected. Recheck binding after the lock; the preliminary lookup is not authority.
5. Disconnect/revoke: take that same grant lock, cancel it and clear active key
   hashes atomically. Competing refresh cannot restore cancelled access.

Use the tested portable first-row UPDATE lock, not PostgreSQL-only SQL. Enforce
uniqueness and conditional state updates in the database. Check expiry inside
the transaction using one trusted server clock; instances must have bounded clock
skew. Verify access against authoritative current storage and current account
state, not a positive cache that survives disconnect. Perform a final check before
the business event. Cancellation cannot undo an event already started.

Retry only a transaction known to have rolled back for a transient deadlock/busy
error, with at most three attempts and bounded backoff. Do not retry an unknown
commit outcome or transparently replay issuance after a lost HTTP response. A
lost code/refresh response may require fresh approval; no hidden grace period or
recoverable token copy is added. Access expiry is min(now + allowed access duration,
original final deadline). Code, pending, client, rate and cache cleanup is bounded;
never remove live-grant dependencies or replay history early. Account deletion
cancels dependent grants before cleanup. Grant expiry works without a cleanup job.

Change notifications may be delayed and are not authorization. AI rechecks each
request using shared storage. For distributed tool-list notifications, persist a
monotonic grant revision and have each process watch/poll revisions (at most five
seconds between polls); also compare current account/policy state and expiry for
bound connections so changes outside the grant row invalidate catalog snapshots.
This background check uses stable grant references, not captured token authority.
Coalesce generic list-change signals. Send no protected
payload through this channel. Store failure refuses protected calls; a missed
notification cannot retain access. No unbounded protected replay stream is added.

## Upgrade Existing MCP Keys Explicitly

Existing API Application/Session records, ordinary API behavior and login replies
stay in place. When MCP OAuth is off, legacy MCP behavior remains unchanged.
When OAuth is enabled, old keys intended for that service need an explicit
`OAuthLegacyBinding`; this is the accepted migration for source G-013's rule
against permanently accepting keys with no service address. The user accepted
this enabling-time compatibility change when freezing the plan on 2026-09-29.

API owns an operator-only migration adapter: validate the selected real legacy
records and submit kind, hashed ID and exact resource to session. It must support
a dry-run and report selected counts/invalid records without secrets. No automatic
first-use binding and no public migration route. Before enabling OAuth, operators
bind selected keys and test representative app/user reads and writes.

Add a hardened legacy validation path in API for OAuth-enabled MCP: check the
real record's secret, active state, expiry, current person/application and scopes,
then ask session to verify its exact active binding. Current legacy handlers do
not already provide all these checks; production tests must establish them. Session never imports API.
Bindings copy no secret or scope, and cannot outlive the original key. Bind the
source row's immutable incarnation, not only its ID; deletion/recreation must
invalidate the binding even if an ID is reused. Use a separate migration-owned
incarnation record if legacy created timestamps cannot guarantee that identity. Unbound
keys are refused at OAuth-enabled MCP; existing ordinary API routes continue
using their existing legacy rules. Existing app keys stay app identities and
cannot become user approvals. OAuth connected-client pages list new grants only;
legacy key management remains in its existing interface. Removing a binding
ends that key's MCP access, while revoking the original key ends its legacy access.
