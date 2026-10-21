# 00004 — Validate client registration and safely read client documents

Status: verified.
Owner: stackpress-session OAuth client scripts, cache and shared request limits.
Stage: 2b.
Depends on: [00002](00002-oauth-types-config-and-startup.md), [00003](00003-oauth-schema-and-private-storage.md)
Journeys: J01, J03, J04, J06.
Contracts: [configuration](../configuration.md), [events](../events.md), [storage](../storage.md), [verification](../verification.md).

## Task Summary

Let compatible programs introduce themselves without giving them user access or allowing unsafe network requests.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Implement public-client registration for the accepted grant/response/authentication methods, body/field/redirect limits, exact client IDs and unused-client cleanup. Registration never issues an approval or user key.
2. Implement HTTPS document lookup at a non-root path, exact document client_id and return-address validation. Reject redirects, private/local/reserved targets, deceptive hostnames and malformed IPv4/IPv6 forms.
3. Bind the network connection to the checked DNS address. Enforce the full request timeout and decoded-byte ceiling, including compressed responses, without accepting a later unchecked address.
4. Respect HTTP freshness/revalidation/no-store and never cache errors or serve stale data on failure. Keep document bodies separate from durable identities and preserve live identity references without bypassing cache rules.
5. Apply one allowed-client policy to both introduction methods. Enforce source-first rate limits, shared counters and atomic client/cache capacity; unknown client IDs cannot create unlimited buckets.
6. Validate return addresses exactly except the allowed port difference on explicitly registered local-machine hosts. Treat localhost, 127.0.0.1 and ::1 as separate entries. Provide replaceable network and clock dependencies for focused tests.

## Verification Process

- Run every Client documents, Client registration, Return addresses and Client admission policy case in verification.md, including DNS changes, oversize expansion, no-store and identity-cache duplication.
- Test all source/client/factor limiter primitives as applicable: multi-process counting, changed untrusted client IDs, spoofed forwarding headers, capacity races, 429/Retry-After and 503 on store failure.
- Check registration-disabled metadata/route behavior, empty/omitted allowed-client lists, active-reference retention and expiry of unused document identities.
- Use deterministic network failures plus real local fixtures in tests; no private-network bypass may be enabled in production document fetching.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

Scope decision: this task builds the reusable, directly-testable
mechanisms configuration.md/storage.md require for client introduction.
It does not wire an `oauth-client-register` HTTP route or the actual
`/register`/authorization-time document fetch into a protocol page -
sprint.md's required-test ownership table lists "Client registration"
under both this task and [00006](00006-oauth-protocol-routes-and-browser-guard.md),
and 00006 is the task that adds discovery/protocol routes. 00006 calls
`registerClient`/`fetchClientDocument` below from its route handlers
rather than reimplementing validation/SSRF-safety/rate-limiting itself.

New files, all under `packages/stackpress-session/src/oauth/clients/`
(none exported through the package's public barrels - same private-
runtime treatment as `src/oauth/storage/**`):

- `network.ts` - SSRF address classification used before ever
  connecting a client-document fetch: `isDisallowedIpv4`/
  `isDisallowedIpv6` (private/loopback/link-local/reserved/
  documentation/multicast ranges, malformed octets, and "IPv4 written
  as IPv6" via mapped/compatible/6to4 forms, each unwrapped and
  re-checked against the IPv4 rules), `isDisallowedAddress` (family
  dispatch, rejects anything unparseable), `isIpLiteralHostname`, and
  the production `resolveHostname` (`dns.lookup(..., { all: true })`).
- `redirect.ts` - exact return-address matching (`validateReturnAddress`):
  scheme/host/path/query must match a registered entry exactly; the
  only relaxation is a different port, and only when the *registered*
  entry's host is one of the three literal local-machine spellings
  (`localhost`, `127.0.0.1`, `::1`), each treated as a distinct
  identity. `isAcceptableRegisteredRedirect` is the separate "is this a
  shape a client may register at all" check (HTTPS, or HTTP only on an
  explicit local-machine host), reused by both registration and
  client-document validation so there is exactly one such rule.
- `policy.ts` - `isClientAllowed`, the single `clients.allowed` check
  shared by both introduction methods. Deliberately **not** called
  from `register.ts`: events.md is explicit that registration creates
  no grant and an unlisted dynamically registered ID gets no access at
  *use* time, so the allowed-client check belongs at authorization time
  (00005/00006), not at the moment a fresh client_id is minted. It
  **is** called from `document.ts`, before any network fetch, since a
  document-URL client_id is checked at the same moment it is
  introduced and skipping a wasted outbound fetch for an ID that could
  never be approved is also a cheap SSRF-amplification guard.
- `rateLimit.ts` - `enforceRateLimit(store, stages, windowSeconds, now)`:
  shared windowed counters via `OAuthStore.incrementRateBucket`,
  checked stage-by-stage in caller-supplied order so a later
  (attacker-chosen client) stage is never reached once an earlier
  (source) stage has already refused - this is what keeps an unknown
  client ID from allocating its own bucket (configuration.md: "Enforce
  source limits before allocating attacker-chosen client buckets";
  "unknown client IDs cannot create unlimited buckets"). Bucket keys
  are hashed with the existing `rate-limit` domain from `ids.ts` before
  they ever reach storage. A store failure maps to `store_unavailable`
  (503), never to skipping the limit.
- `transport.ts` - the one place in this task that may open a real
  network connection. `OAuthTransport` is an injectable function type;
  `drainCapped`/`decodeResponseBody` are pure, directly testable helpers
  that enforce the decoded-byte ceiling on the *decompressed* output
  (so a small gzip/deflate/br body cannot expand past the configured
  limit), and `defaultTransport` is the production `https.request`
  wiring: `host` is the already-checked `address` (never re-resolved),
  `servername`/`Host` stay the original hostname for TLS/virtual-host
  correctness, one `timeout` option spans connect through body, and no
  redirect is ever followed (the caller treats any non-200/304 status,
  including every 3xx, as a failure).
- `document.ts` - `fetchClientDocument(clientId, source, config, deps)`:
  admission check, then HTTPS/non-root-path/credential-free URL
  validation, then a DNS-pinned address check (an IP-literal hostname
  is checked directly without a DNS round trip), then a cache lookup
  that serves a still-fresh cached copy with **no** network call and
  **no** rate-limit charge, then (only on a cache miss or stale entry)
  the `clientMetadata` rate limit, the actual fetch (conditional
  `If-None-Match`/`If-Modified-Since` when a stale cached ETag/
  Last-Modified exists), 304 handling that extends freshness without
  re-validating the body, `Cache-Control: no-store`/`no-cache` handling
  that never persists a copy, and metadata-shape validation (`client_id`
  must equal the document's own URL exactly, `redirect_uris`/
  `grant_types`/`response_types`/`token_endpoint_auth_method` restricted
  to the same accepted public-client shape registration itself accepts).
  Any failure (bad status, malformed JSON, failed shape check, DNS/
  connect/timeout error) throws instead of ever falling back to a
  previously cached value - "never serve stale data on failure" is
  enforced by never having a stale-serving code path at all, not by a
  conditional check.
- `register.ts` - `registerClient(rawBody, source, config, deps)`:
  `registration.enabled` gate, body-byte limit checked before JSON
  parsing, `redirect_uris` count/shape/duplicate checks, the fixed
  accepted grant/response/auth-method shape (`authorization_code`
  optionally with `refresh_token`; response type exactly `["code"]`;
  auth method exactly `"none"`), an optional bounded `client_name`, the
  `registration` rate limit, and an unused-client capacity check before
  minting a fresh CSPRNG `oauthreg_`-prefixed client_id (`randomToken`
  from `ids.ts`, same generator family as access/refresh tokens, so
  "exact client IDs" means unguessable and CSPRNG-sourced, not merely
  unique). Returns exactly the events.md `oauth-client-register`
  result shape; never returns or stores a client secret, matching
  `token_endpoint_auth_method: 'none'`.
- `errors.ts` - `OAuthClientError` with a small machine-readable code
  vocabulary (`invalid_request`, `invalid_client_metadata`,
  `unsafe_target`, `fetch_failed`, `rate_limited` with
  `retryAfterSeconds`, `store_unavailable`, `registration_disabled`),
  kept separate from `OAuthStoreError` since these are request-shape/
  network-safety/rate-limit outcomes reached before any database
  transaction - 00005/00006 map both vocabularies to the events.md HTTP
  `error` field.

Edited file: `packages/stackpress-session/src/oauth/storage/OAuthStore.ts`
gained the additions this task needed and task 00003 did not:
`getClientDocumentByUrlHash` (returns a cached document row regardless
of freshness, so a stale entry can still be revalidated instead of only
ever being fresh-or-absent), `touchUnusedClient(clientId, kind,
metadata, unusedExpires, now)` (the shared create-or-refresh primitive
for both document and registered client identities), and - after
orchestrator review rejected the original COUNT-then-insert draft -
`reserveClientCapacity(kind, max)`/`releaseClientCapacity(kind)`, the
atomic reservation primitive storage.md actually requires ("Reserve
unused-client and cache capacity atomically, not COUNT then insert").

**`reserveClientCapacity`/`releaseClientCapacity`.** A new private
tenth table, `oauth_client_capacity` (`tables.ts`'s
`createOAuthClientCapacity()`, added to `createAllOAuthTables()`): one
row per `kind` (`document`/`registered`) holding a `count` and the same
`lock_token` CAS column every other contended table in this file
already uses. Not one of storage.md's nine named models - it holds no
identity/credential/approval data, only an internal capacity gauge, so
it is created the same hand-written way as the other nine and carries
no admin/API/MCP exposure to restrict. `reserveClientCapacity` uses the
exact `_claim()` CAS pattern `_withLockedGrant`/`incrementRateBucket`
already established: read the counter, and if `count < max`,
conditionally `UPDATE ... WHERE id = ? AND count = ?` verified by
`_claim()`'s fresh-token re-read, retrying on a lost race; the row's
first creation relies on its primary key the same way
`checkAndAdvanceFactor`'s first-use path does (a losing concurrent
insert fails with a constraint violation, caught and retried against
the now-existing row). `releaseClientCapacity` is the same shape in
reverse (floor at zero, best-effort - it runs after the fact and must
never block the caller's own outcome). Capacity reservation is not a
per-request hot path the way grant locking is, and genuinely needs to
survive many truly concurrent callers contending on one shared row near
the ceiling, so it gets a dedicated `CAPACITY_MAX_RETRIES = 50` (versus
the shared `MAX_LOCK_RETRIES = 3` every other `_claim()` caller uses)
plus a small jittered backoff between attempts - proven necessary by
the 20-concurrent-reservations-against-a-limit-of-5 regression below,
which reliably exhausted 3 retries before this change.

`document.ts`/`register.ts` now call `getClientByClientId` first
(document.ts only - a document client_id can legitimately repeat across
unrelated calls/users fetching the same document again, and refreshing
an already-tracked identity must not consume a second capacity slot for
the one identity it already holds; registration always mints a brand-
new CSPRNG client_id, so it has no such "already exists" case).
`reserveClientCapacity` runs only for a genuinely new identity; if the
following `touchUnusedClient` insert then fails for any reason, the
reserved slot is released in a `catch` before the error propagates, so
a failed creation never permanently leaks a reservation.

`OAuthStore.cleanup()` now also removes `oauth_client` rows whose
`unused_expires` has passed (previously cleanup never touched this
table at all) and calls `releaseClientCapacity` once per row removed,
so the atomic counter stays in sync with what cleanup actually deletes.
`OAuthCleanupCounts` gained a `clients: number` field (additive; no
existing test asserted the full shape via `deep.equal`, only individual
fields, so this does not break task 00003's cleanup tests). Per
storage.md's "Active registrations referenced by unexpired grants are
retained", task 00005's approval flow is expected to clear
`unused_expires` once a live grant references a client identity - noted
here so that transition does not silently leave a stale capacity
reservation once 00005 exists; 00005 should release the matching
capacity slot at that point rather than letting cleanup be the only
path that ever decrements it.

`countUnusedClients(kind, now)` is kept as an informational/diagnostic
read (not load-bearing for any gate) since a plain row-count scan and
the dedicated gauge can briefly disagree (for example immediately after
`releaseClientCapacity` but before cleanup has physically deleted the
expired row) without that disagreement affecting the correctness of the
reservation decision itself, which is made entirely through
`reserveClientCapacity`/`releaseClientCapacity` now.

**`transport.ts`.** `OAuthTransportRequest` gained an optional `ca?:
string | Buffer` field, forwarded to the underlying `https.request`
call. Production callers (`document.ts`) never set it, so a real
client-document fetch is verified against Node's default public CA
trust store exactly as before; it exists only so
`client-transport-live.test.ts` (below) can point `defaultTransport` at
a real local HTTPS server with a freshly generated self-signed
certificate without disabling TLS verification - the "real local
fixture" sprint.md's Verification Process calls for, as opposed to
weakening production code to make it testable.

## Verification Notes

Environment: Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`),
Yarn 1.22.22, this worktree
(`/home/solution-team/.paseo/worktrees/0m6vr1k2/icky-snail`), Inquire
d5f5a07 override (see tasks/status.md's 2026-10-15 decision; unchanged
by this task).

Compile (both module formats, `--noEmit`), clean:
```
(cd packages/stackpress-session && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
(cd packages/stackpress && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
```
`packages/stackpress-session && yarn build`: clean, no errors.

**Real PostgreSQL/MySQL containers, per orchestrator review.** Started
disposable, tmpfs-backed containers on the same ports/commands task
00003 used, under the shared lock:
```
flock /tmp/oauth-db.lock bash -c '
docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=oauth_proof -p 127.0.0.1:55555:5432 --tmpfs /var/lib/postgresql/data --name oauth-00004-pg postgres:17-alpine
docker run -d --rm -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=oauth_proof -p 127.0.0.1:55556:3306 --tmpfs /var/lib/mysql --name oauth-00004-mysql mysql:8.4
'
```
Waited for both to report ready, then ran the full suite under the same
lock; stopped both containers (`docker stop`, auto-removed via `--rm`)
and confirmed gone (`docker ps -a`) immediately after. Neither
`ops-cockroach`, `op-impl-officepress-crdb` nor the pre-existing,
unrelated `office-inbox-dev-postgres-1` container was touched.

Tests (`yarn test` = `nyc ts-mocha -r tsx tests/**/*.test.ts`), run from
`packages/stackpress-session`, confirmed with `echo tests/**/*.test.ts`
first that all 19 test files stay flat under `tests/oauth/` (no nested
subfolder), so none drop from the package's unquoted glob (00002A's
finding). **With both containers up: 246 passing, 0 failing, 12
pending.** The 12 pending are exclusively the SQLite adapter's share of
`store-adapters.test.ts` and the new `client-store-adapters.test.ts`
(5 + 7 = 12) across both files - both files' own `before` hooks skip
SQLite gracefully in this specific worktree because the installed
`better-sqlite3` native binary was compiled for a different Node ABI
(`NODE_MODULE_VERSION 127` vs. this Node's `137`; confirmed directly:
`node -e "require('better-sqlite3')"` throws that exact mismatch). This
is a pre-existing environment constraint, not introduced by this task:
the identical skip already existed in task 00003's `store-adapters.test.ts`
before any change in this pass (confirmed by running it first,
unmodified, with the containers up - same 7 SQLite cases pending).
Rebuilding a native module is out of this task's scope and risks the
shared VM's other sessions; recommend `npm rebuild better-sqlite3` (or
reinstalling it) be done once, outside a task's working time, by
whoever owns the environment, and re-run this file's SQLite rows then.
PGlite, PostgreSQL and MySQL all passed cleanly for every scenario
below, including the new ones.

Package-wide coverage (`nyc --reporter=text`), with both containers up:
**94.85%** statements / 89.79% branch / 97.01% funcs / 95.31% lines -
above the sprint's >90% statement bar, up from the previous pass's
92.76% mainly because of the real-HTTPS-fixture transport tests below.
Per-file: `policy.ts`/`rateLimit.ts` 100%; `redirect.ts` 96.87%;
`network.ts` 90.29%; `transport.ts` **96.55%** (was 60.34% before the
real-fixture tests; the one remaining uncovered line, 63, is
`drainCapped`'s `stream.on('error', ...)` path, not separately
exercised by a real-socket-error scenario); `document.ts` 86.23%;
`register.ts` 86.79%; `OAuthStore.ts` 94.39% package-measured (up from
88.34% - the capacity primitives' retry/backoff branches are now
exercised by the real concurrency regression below).

New/changed test files (all flat under `tests/oauth/`):
- `client-network.test.ts`, `client-redirect.test.ts`,
  `client-policy.test.ts`, `client-rate-limit.test.ts`,
  `client-transport.test.ts`, `client-document.test.ts` (15 cases),
  `client-register.test.ts` (12 cases) - unchanged from the prior pass
  except both fake stores now implement `getClientByClientId`/
  `reserveClientCapacity`/`releaseClientCapacity` instead of
  `countUnusedClients`, matching the real interface change; all cases
  still pass with the new atomic-capacity call shape.
- `client-store-helpers.test.ts` - unchanged (PGlite-only sanity check
  of `getClientDocumentByUrlHash`/`touchUnusedClient`).
- **`client-store-adapters.test.ts` (new)** - the capacity-race and
  rate-limit regressions the orchestrator review asked for, run across
  all four adapters via the same `runAdapterSuite` harness
  `store-adapters.test.ts` uses (same env-var overrides, so the same
  disposable containers cover both files): (1) **capacity race** - 20
  concurrent `reserveClientCapacity('document', 5)` calls on one shared
  counter row; asserts granted ≤ 5 (correctness), granted + denied +
  thrown = 20 (every attempt accounted for, nothing silently dropped or
  double-counted), and granted = 5 (liveness - the limit is actually
  reached, not under-granted from a lost update), then releases every
  granted slot and confirms the counter returns to exactly zero; (2)
  `document`/`registered` kinds tracked as independent counters; (3)
  **unknown-client-ID bucket limit** - `enforceRateLimit` against the
  *real* `OAuthStore.incrementRateBucket` with a source stage at its
  limit and an unknown/attacker-chosen client stage after it; asserts
  the client stage is never reached (mirrors the existing fake-store
  test in `client-rate-limit.test.ts`, now also proved against the real
  atomic primitive on every adapter); (4)/(5) `getClientDocumentByUrlHash`/
  `touchUnusedClient` round-trip on each real adapter. Passed on PGlite,
  PostgreSQL and MySQL; SQLite pending per the native-module note above.
- **`client-transport-live.test.ts` (new)** - the real-local-fixture
  check for `defaultTransport` the orchestrator review required. `before`
  generates a fresh self-signed certificate with the system `openssl`
  CLI (`req -x509 -newkey rsa:2048 ... -addext subjectAltName=DNS:localhost,IP:127.0.0.1`)
  into a `mkdtempSync`-created `/tmp/oauth-00004-tls-*` directory,
  starts a real `https.createServer` on `127.0.0.1` with it, and calls
  `defaultTransport` directly (not through a fake) with the server's
  certificate passed as the new test-only `ca` field - so TLS
  certificate verification runs for real rather than being disabled.
  Six cases: a real request succeeds and is verified against that CA;
  omitting `ca` makes the real handshake fail with `fetch_failed`
  (proves verification is not bypassed by default); a real gzip
  response decodes correctly end-to-end over real TLS; a real
  oversized-gzip response is still rejected by the decoded-byte
  ceiling; a real server that never responds is cut off by the
  configured timeout; a real non-2xx status (404) passes through
  without `defaultTransport` itself throwing. `after` closes the server
  and `rmSync`s the scratch directory; confirmed removed
  (`ls /tmp | grep oauth-00004` found nothing once the suite finished).

**Remaining honest gaps:**
1. SQLite rows in both multi-adapter files are pending in this specific
   worktree due to the native-module ABI mismatch described above - not
   a defect in this task's code, and not newly introduced by it
   (identical to task 00003's pre-existing SQLite skip in this same
   worktree). Recommend re-running once the environment's
   `better-sqlite3` binary is rebuilt for this Node version.
2. `drainCapped`'s `stream.on('error', ...)` branch (transport.ts line
   63) has no test forcing a raw socket error mid-stream (as opposed to
   a timeout or a non-2xx status, both of which are covered); a
   dedicated fault-injection test for that exact branch was not added
   this pass.
3. This task still does not wire an actual `/register` HTTP route, the
   `oauth-client-register` fixed event, or an authorization-time call
   into `fetchClientDocument` - by design (see Implementation Notes'
   scope decision); 00006 owns that wiring and must call
   `registerClient`/`fetchClientDocument` rather than re-implementing
   validation.
4. Task 00005's expected release of a client's capacity reservation
   when a live grant takes over `unused_expires` (so cleanup is not the
   only path that ever decrements the counter) is not implemented here,
   since no grant-to-client linkage exists yet in this task's scope -
   flagged in Implementation Notes for 00005 to pick up.

Orchestrator SQLite check (2026-10-15): the SQLite "env issue" came from running
under the wrong Node version. Under Node 22 the root `better-sqlite3` loads
(ABI 127). The orchestrator ran `npx ts-mocha -r tsx
tests/oauth/store-adapters.test.ts tests/oauth/client-store-adapters.test.ts -g
SQLite` from `packages/stackpress-session`: 12 passing, 0 failing. That covers
the 00003 store checks plus the 00004 capacity race, per-kind counters,
unknown-client bucket, document lookup and unused-client checks. All four
adapters now pass. Caution for later tasks: the adapter suites call
`this.skip()` when setup fails, so a broken driver shows as "pending", not as a
failure. Always confirm that adapter runs show passing, not pending.

## Acceptance Notes

No visual acceptance is required. Finish at verified once the checks pass;
do not mark accepted merely because tests pass.
