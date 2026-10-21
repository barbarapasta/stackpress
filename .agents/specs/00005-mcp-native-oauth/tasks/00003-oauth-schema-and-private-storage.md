# 00003 — Add the optional schema and private database operations

Status: verified. All six implementation steps are done and verified on
all four required adapters (PGlite, PostgreSQL, MySQL, SQLite), including
the amendment A-001 generated-admin-exposure checks. See Implementation
Notes and [verification evidence](../../../references/00025-oauth-schema-storage-verification-evidence.md).
Owner: stackpress-session oauth.idea and focused OAuth store code.
Stage: 2b.
Depends on: [00001](00001-inquire-transaction-ownership.md), [00002](00002-oauth-types-config-and-startup.md)
Journeys: J01, J02, J04, J05, J11, J13.
Contracts: [storage](../storage.md), [configuration](../configuration.md), [events](../events.md), [decisions amendment A-001](../decisions.md#amendment-a-001--admin-access-to-oauth-records).

## Task Summary

Create the nine private record types and safe database operations on the corrected Inquire dependency.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Consume and pin the corrected, verified Inquire dependency using the repository’s coordinated dependency process. If no consumable corrected build exists, record the blocker before enabling production stores.
2. Define OAuthClient, OAuthClientDocument, OAuthPending, OAuthGrant, OAuthCode, OAuthRefreshToken, OAuthLegacyBinding, OAuthFactorUse and OAuthRateBucket with the frozen fields, uniqueness and lookup indexes.
3. Include the existing profile schema without duplicate models. Use supported JSON serialization for bounded snapshots and ordinary indexed columns for lookup; add no generated admin/API/MCP exposure for private records beyond what amendment A-001 permits.
4. Keep generation, lockVersion and notification revision distinct. Support nullable unissued access values, secret-free display summaries and source/factor incarnation references.
5. Build focused store methods using the reserved transaction connection. Preliminary code/token lookup happens outside the transaction; the grant UPDATE is its first table operation, followed by fresh validation reads.
6. Provide bounded cleanup and shared counter/capacity primitives. Preserve active-client references and replay history until the grant deadline. Separate cached documents from durable identity so no-store data is not saved elsewhere.

## Verification Process

- Run first and repeated generation, including both schema includes, and compile generated code. Check clean migrations in isolated databases for each of the four adapters.
- Test unique/nullable keys, concurrent first-use rows, atomic count/capacity reservations, rollback after real SQL failure and transaction connection identity.
- Check cleanup boundaries, JSON round trips, deletion/incarnation handling and lack of generated public exposure beyond amendment A-001. Do not claim model annotations alone prevent leakage: inspect generated outputs.
- Keep field names and public/private exports aligned with the frozen contract. Record actual schema/dependency versions and per-adapter results.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

**2026-10-15 update, by 00007.** `oauth_pending.factor_receipt` was
`VARCHAR(255)`, but 00005's `setPendingFactorReceipt` stores the full
HMAC-signed factor receipt (`factor.ts`'s `createFactorReceipt` output),
which exceeds 255 characters for any ordinary scope/operation selection. In
the real browser 2FA-to-approval path this truncated the stored value and
broke receipt verification with a raw 500. 00007 widened the column to
`TEXT` in this task's `src/oauth/storage/tables.ts` and `Text?` in
`oauth.idea`, and added `tests/oauth/factor-receipt-adapters.test.ts` — one
case (a realistic multi-scope/multi-operation receipt over 255 characters,
saved then read back and verified) run against all four adapters the same
way `store-adapters.test.ts` is, confirmed to fail against the old
`VARCHAR(255)` size and pass against the widened `TEXT` column on every
engine: PGlite/SQLite pass directly (2 passing, 2 pending without
containers); re-run with disposable PostgreSQL/MySQL tmpfs containers
(`oauth-00007a-pg`/`oauth-00007a-mysql`, same pattern as prior tasks, under
`flock /tmp/oauth-db.lock`) showed all four passing as part of the
package's full `yarn test` run (735 passing, 0 failing with containers up;
see [00007A](00007A-session-package-coverage.md)'s Verification Notes).
This is a column-size correction, not a storage.md contract
change (storage.md does not fix a specific column type); existing deployed
apps that already migrated with the old `VARCHAR(255)` size will need a
follow-up migration, which 00010/00011 should cover when they verify schema
upgrade paths.

**Step 1 (Inquire dependency).** Not redone here; already satisfied by task
00001/status.md. The root `package.json` `resolutions` block pins all five
`@stackpress/inquire*` packages to the local tested build
`file:/home/solution-team/projects/inquire/.handoff/*-0.10.8-d5f5a07.tgz`
(commit d5f5a07). Confirmed in this worktree's `node_modules` that the
installed `@stackpress/inquire` (v0.10.8) actually contains the fix
(`node_modules/@stackpress/inquire/{cjs,esm}/Lock.ts` compiled output
present). **The published/upstream Inquire version is still pending**
(per tasks/status.md's 2026-10-15 decision); this task continues against
that unpublished local build, not a release, and 00011 must re-run once a
published version replaces the override.

**Step 2-3 (schema).** New file `packages/stackpress-session/oauth.idea`:
the nine models from storage.md (`OAuthClient`, `OAuthClientDocument`,
`OAuthPending`, `OAuthGrant`, `OAuthCode`, `OAuthRefreshToken`,
`OAuthLegacyBinding`, `OAuthFactorUse`, `OAuthRateBucket`) with the exact
fields/uniqueness/lookup semantics storage.md specifies. `use
"stackpress-session/schema.idea"` includes the existing Profile/Auth models
without duplicating them (verified: composing `oauth.idea` alone, and
composing both `oauth.idea` and `schema.idea` directly in one app schema,
both dedupe to one `Profile`/`Auth` entry — see the linked verification
evidence). Composite uniqueness (`OAuthLegacyBinding`
kind+legacyIdHash+resource, `OAuthFactorUse` factorId+incarnation,
`OAuthRateBucket` keyHash+window) is not expressible in `.idea` column
syntax (only single-column `@unique` exists there); it is declared
instead in the hand-written table builders via
`Create.addUniqueKey(name, [cols])`, the same place AuthStore.ts already
does this for its own tables. Added `oauth.idea` to
`packages/stackpress-session/package.json` `files` (configuration.md:
"Package oauth.idea and add its exact schema export").

**Admin exposure, per amendment A-001.** The first pass of this task left
every column in `oauth.idea` fully undecorated, on the theory that no
`@field`/`@list`/`@view`/`@filter` metadata would give the generated
admin/view transforms nothing to render. Generation verification (see
"Resolved by amendment A-001" below) proved that theory wrong: Stackpress
builds a reachable admin page for every model regardless of column
decoration, with no per-model opt-out. The user resolved this with
amendment A-001 (decisions.md): OAuth admin pages are treated like the
existing Auth/Application/Session pages — reachable by role, out of the
default menu, no hash columns displayed. `oauth.idea` now carries
`@label`/`@list.*`/`@view.*` on every column that holds no credential
material, and **zero** decorators of any kind on every column that holds
a hash of a credential, a raw PKCE/receipt value, or an unvalidated
metadata blob: `urlHash`, `bindingHash`, both `codeChallenge` columns,
`factorReceipt`, `readIdHash`, `fullKeyHash`, `codeHash`, `tokenHash`,
`legacyIdHash`, `keyHash`, and both `metadata` columns. No model anywhere
carries `@field.*`/`@filter.*` — deliberately stricter than A-001
requires, since a generated create/update form would let an admin
fabricate or mutate grant/token state without going through
`OAuthStore.ts`'s hashing/locking/approval logic at all. MCP tool
exposure stays `mcp.tools`-config opt-in and API route exposure stays
`api.endpoints`-config opt-in, both confirmed unaffected by anything in
this schema (see verification evidence).

**Step 5 (schema/primitives).** New files, all under
`packages/stackpress-session/src/oauth/storage/`:

- `ids.ts` — CSPRNG id/secret/code/refresh-token/pending-binding
  generation (`oauth_`/`oauthr_` prefixes, unpadded base64url, 32 raw
  bytes per storage.md), domain-separated SHA-256 hashing
  (`hashWithDomain`, one hash per credential kind so a leaked/reused hash
  from one kind can't be replayed as another), constant-time hash
  comparison (`hashesEqual`, never throws on mismatched length), full-key
  split (`splitFullKey`) that rejects anything not exactly one `:` between
  two non-empty parts (storage.md: "a supplied bad secret never becomes an
  ID-only read"), and `isOAuthNamespace` for routing `oauth_` lookups to
  this verifier before any legacy check.
- `tables.ts` — hand-written `@stackpress/inquire` `Create` builders for
  all nine tables (`oauth_client`, `oauth_client_document`,
  `oauth_pending`, `oauth_grant`, `oauth_code`, `oauth_refresh_token`,
  `oauth_legacy_binding`, `oauth_factor_use`, `oauth_rate_bucket`),
  mirroring the field/comment shape of the existing `AuthStore.create()`
  but **not** implementing the rest of the generated `StoreInterface`/
  `ActionsInterface` (selectors/joins/paths/where/scalarize/generic
  create/update/delete) — a full generic CRUD layer on these tables would
  itself be unmanaged write access bypassing `OAuthStore.ts`; only the
  focused atomic methods below sit on top of these tables. Deliberately
  **no foreign keys** are declared between these tables or to `Profile`:
  storage.md's atomic operations require cancelling a grant and
  preserving its replay history in a specific explicit order ("Account
  deletion cancels dependent grants before cleanup"), and a declared FK
  would force one single `ON DELETE` cascade/restrict policy that could
  violate that ordering; referential integrity for these columns belongs
  in the store methods instead. Plain indexes exist for every
  lookup/filter column.
- **Four confirmed Inquire adapter findings**, found while proving the
  four-adapter migration/constraint checks (real, reproducible, not
  storage.md/configuration.md contract conflicts, not regressions of
  task 00001's fix, so not reopened there; each has a minimal
  reproduction in the linked verification evidence for the Inquire
  author): (1) the Pgsql dialect truthy-checks `field.default`, silently
  dropping a falsy default like `0`; worked around by declaring the
  five affected `INTEGER` counter columns `NOT NULL` with no DB default
  at all, since `OAuthStore.ts` always supplies them explicitly on
  insert; (2) real MySQL rejects any `DEFAULT` on `TEXT`/`BLOB`/`JSON`
  columns outright, so the JSON-encoded array columns no longer declare
  one either, same reasoning; (3) MySQL's `utf8mb4` + InnoDB 3072-byte
  index-key limit rejected `oauth_legacy_binding`'s composite unique key
  when `resource` was `VARCHAR(2048)`, so every `resource` column (not
  `redirect_uri`/`state`, never indexed) is now `VARCHAR(512)`; (4) the
  installed `@stackpress/inquire-mysql2` adapter's `Connection.format()`
  converts every `Date` to `.toISOString()`, which real MySQL's
  `DATETIME` literal syntax rejects — fixed **transparently** with a
  `withMysqlDateSafety()` `Proxy` wrapper around the `Engine`, applied
  only when `engine.dialect.name === 'mysql'`, so none of
  `OAuthStore.ts`'s 30+ call sites needed to become dialect-aware; also
  requires the real mysql2 connection to be constructed with
  `{ timezone: 'Z' }` in whichever later task builds the production
  bootstrap (00006/00011), flagged there as required, not optional.

**Step 5-6: `OAuthStore.ts`.** New file
`packages/stackpress-session/src/oauth/storage/OAuthStore.ts`, built
directly on `@stackpress/inquire`'s `Select`/`Insert`/`Update`/`Delete`
builders and `engine.transaction()` only — never
`@stackpress/inquire/Lock` or anything else specific to the local
d5f5a07 build, so this file keeps working unmodified once the CTO
publishes their own upstream fix. Implements every operation in
storage.md's "Atomic Operations" list:

- `approvePending` (storage.md #1): atomically consumes an `OAuthPending`
  row and creates the `OAuthGrant` + single-use `OAuthCode` together.
  Repeated form POSTs on the same pending row get `conflict`, not a
  second grant/code.
- `exchangeCode` (storage.md #2): locates the code-to-grant reference
  outside the transaction; the grant's lock claim is the first table
  operation inside it; re-reads and validates client/redirect/resource/
  expiry/grant-state before issuing access + an optional refresh token.
- `refreshGrant` (storage.md #3): same shape as code exchange; narrows
  scope on request, never grows it; rotates both access parts and
  inserts the next refresh row in one transaction.
- Reuse detection (storage.md #4): replaying an already-consumed code or
  an already-rotated refresh token cancels the grant's whole chain,
  **committed** even though the overall call reports `invalid_grant` -
  implemented by returning a `{ reused: true }` marker from inside the
  transaction callback instead of throwing (throwing would roll back the
  cancellation along with everything else).
- `cancelGrant`/`disconnectGrant`/`revokeByFullKey`/`revokeByRefreshToken`
  (storage.md #5): take the same grant lock, cancel it, and clear the
  active key hashes atomically. A wrong secret never revokes; an unknown
  token is reported as if it succeeded (events.md: unknown tokens don't
  reveal account/client existence); another profile's grant and a
  missing grant both report the same `'not_found'`/`false` signal.
- `checkAndAdvanceFactor`/`incrementRateBucket`: the shared atomic
  counter/capacity primitives (`OAuthFactorUse`, `OAuthRateBucket`).
- `cleanup`: bounded batch cleanup across all nine tables, preserving
  live-grant dependencies and replay history until the owning grant's
  deadline, per storage.md.
- Client/document helpers (`upsertRegisteredClient`, `getClientByClientId`,
  `touchClientLastUsed`, `getFreshClientDocument`, `saveClientDocument`)
  keep `OAuthClientDocument`'s bounded cache separate from live
  `OAuthClient` identity, per storage.md.

**The portable first-row UPDATE lock, and a real concurrency bug found
and fixed while proving it.** The first implementation locked a grant by
setting `lock_version = lockVersion + 1 WHERE id = ? AND lock_version = ?`
and then re-reading the row to check `lockVersion === expected`. This is
**unsound**: none of Inquire's four adapters exposes an affected-row
count through the public `engine.query()`/builder surface (confirmed by
reading all four `Connection.query()` implementations), so when two
truly concurrent callers read the *same* stale `lock_version` and both
compute the *same* `+1` target, the loser's blocked UPDATE re-evaluates
its WHERE clause against the winner's already-committed row, matches
nothing, writes nothing - but the loser's post-UPDATE re-read still sees
the winner's value, which is indistinguishable from its own success. A
new regression test exercising exactly this ("two truly concurrent
exchanges of the exact same code", "two truly concurrent attempts with
the exact same counter") caught it. Fixed by adding a nullable
`lock_token` column to `oauth_grant`/`oauth_pending`/`oauth_factor_use`/
`oauth_rate_bucket` and a shared `_claim()` helper: every conditional
UPDATE also writes a fresh random token, and success is proven by
re-reading *that exact token* back, not by matching a value a concurrent
racer could have produced too. See `OAuthStore.ts`'s `_claim()` doc
comment for the full explanation. This is recorded prominently because
it is exactly the kind of mistake storage.md's "concurrent first-use
rows" verification requirement exists to catch, and the first version
of this file would have silently passed casual testing.

**A second cleanup bug found by testing, not by reasoning:** the first
`cleanup()` only removed a code/refresh token once *both* it was
consumed *and* its grant had expired, so an unconsumed code/refresh
token belonging to an already-expired grant was never reclaimed (dead
weight forever, since `exchangeCode`/`refreshGrant` both already reject
on `grant.deadline <= now` regardless). Fixed: once a grant's own
deadline has passed, all of its codes/refresh tokens - consumed or not -
are reclaimable together, not only the already-consumed ones.

## Resolved By Amendment A-001

The original "no generated admin/API/MCP exposure" rule in storage.md/
configuration.md proved unenforceable: generation verification (first
with `oauth.idea` fully undecorated) showed `stackpress-admin` builds a
reachable admin page — routes, search/detail/create/update/export/
import pages and views — for every model in the schema with no
per-model opt-out, regardless of column decoration, because
`stackpress-admin/src/plugin.ts`'s `route` listener calls
`model.admin(ctx)` for every model present in the generated client with
no allowlist check. The user resolved this as amendment A-001
(decisions.md, approved 2026-10-15): OAuth records are treated like the
existing Auth, Application and Session records, which admins can
already open and edit. Generated admin pages for OAuth models may exist;
they must be reachable only by roles the app's access rules allow, must
not be added to the default admin menu, and must not display hash
columns. MCP tool exposure stays closed unless an app lists a tool in
`mcp.tools`; API route exposure stays closed unless an app configures
`api.endpoints` — both already true by construction, not changed by
A-001. Maintainer packages (`stackpress-admin`/`-schema`/`-sql`/`-view`/
`-ai`) were not changed, per the user's explicit instruction.

`oauth.idea` was updated accordingly (see "Admin exposure, per amendment
A-001" above), and the generated-output checks were re-run against the
updated schema to confirm (a) no hash/credential column renders in any
generated OAuth admin view, (b) the MCP tools registry stays empty of
any OAuth tool unless an app's own `mcp.tools` config lists one, and (c)
no API route exists for an OAuth model without `api.endpoints` config.
All three passed; the full generated-file evidence is in the linked
verification evidence, not repeated here.

**Note for later tasks (00004-00009):** the generic generated per-model
Store/Actions/Events these nine tables also receive (the same unconditional
per-model codegen every Stackpress model gets, now additionally wired to
reachable - if hash-free and role-gated - admin pages per A-001) must
never be used as the implementation of the real `oauth-*` protocol event
handlers. Those handlers must call `OAuthStore.ts`'s methods directly;
resolving or re-exposing the generic generated per-model events for
these tables would bypass every hashing/locking/approval guarantee this
task built.

## Verification Notes

Full environment, commands, per-adapter results, coverage numbers and
the amendment A-001 generated-output evidence are in
[OAuth Schema And Private Storage — Verification Evidence](../../../references/00025-oauth-schema-storage-verification-evidence.md).
Load that file for the exact `docker run` commands, the four-adapter
`store-adapters.test.ts` results (28 passing, 0 failing on all four
adapters with containers up), the full package suite (164 passing with
containers, 150 passing / 14 gracefully skipped without), coverage
(97.16% package-wide, every new file ≥92% statements), and the
reproduction evidence behind the Inquire findings and the A-001 checks.

Summary: every Verification Process item now passes, including the
four-adapter migration/constraint/concurrency/rollback checks and the
amendment A-001 generated-output checks ((a) hash columns never render,
(b) MCP tools stay closed by default, (c) API routes stay closed by
default). Remaining honestly-recorded gaps (none blocking): `OAuthStore.ts`
has no `OAuthLegacyBinding` creation method (explicitly task 00008's
scope, API's migration adapter); `ExchangeCodeInput.renewalSeconds` is
accepted but deliberately unused (documented in the type itself); `npm
pack --dry-run` for the new `oauth.idea` `files` entry was not run this
pass (recommend bundling with 00010); and the app-level `session.access`
role restriction amendment A-001 calls for is the consuming app's own
configuration, not something this task's schema/store code controls —
whoever builds 00010's blog example must configure it explicitly.

## Acceptance Notes

No visual acceptance is required. Finish at verified once the checks pass;
do not mark accepted merely because tests pass.
