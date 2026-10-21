# 00008 — Connect ordinary API requests and migrate selected old MCP keys

Status: verified. All six implementation steps are done; the legacy-
binding store methods are proven on all four required adapters and the
hardened legacy validator is proven against a real store for revocation/
binding-removal/source-recreation. See Implementation Notes and
Verification Notes.
Owner: stackpress-api integration and session legacy-binding operations.
Stage: 4, API and upgrade.
Depends on: [00002](00002-oauth-types-config-and-startup.md), [00003](00003-oauth-schema-and-private-storage.md), [00005](00005-approval-key-lifecycle-and-policy.md)
Journeys: J02, J09–J13.
Contracts: [configuration](../configuration.md), [storage](../storage.md), [events](../events.md), [recovery](../recovery.md).

## Task Summary

Accept new keys only on approved user API routes and give old MCP keys an explicit, checked upgrade path.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Register stable API operation IDs and exact configured resources from type:session endpoints. Build deterministic fingerprints from method, route template, event, fixed data and scope requirements, including generated/parameterized routes.
2. Require current opt-in, exact resource, saved fingerprint membership and surface permission checks before dispatch. Reject duplicate IDs, ALL, non-JSON data and app/public user-OAuth opt-ins.
3. Classify oauth_ credentials once, call the session verifier with trusted method/requiredCredential/operation, and never fall back to legacy on a failed new key. Preserve GET ID-only rules and require the full key otherwise, including HEAD.
4. Preserve any-match scopes and API empty-list refusal. Reject reserved identity fields in caller/fixed data, inject the trusted profileId/oauth values last and never fabricate API Session/Application identities.
5. Add the hardened API-owned legacy validator for OAuth-enabled MCP: current record/secret/active state/expiry/person/application/scopes plus exact session-owned binding. Protect source incarnation and namespace collisions; a recreated ID cannot inherit access.
6. Provide an operator-only, repeatable migration adapter with dry-run and secret-free counts. Bind only selected validated records, preserve ordinary legacy API replies and OAuth-off MCP behavior; no first-use binding or public migration route.

## Verification Process

- Run API route enablement, Permission lists and Shared MCP/API key cases from verification.md through real handlers. Test each fingerprint field changing, new routes and unapproved same-host addresses.
- Test all key strengths, malformed/wrong-secret credentials, disabled/expired accounts and grants, no invalid-key fallback, app/user distinction and identity-field spoofing.
- Test migration dry-run/no writes, repeat runs, failure rollback, mismatched resources, source deletion/recreation, original key revocation and binding removal.
- Regression-test real existing API app/session handlers and reply formats. A dispatcher stub is not evidence of backward compatibility; task 00011 exercises both actual surfaces together.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

Built entirely on 00002's registration surface, 00003's schema/`OAuthStore.ts`
and 00005's `oauth-token-verify` event; no Frozen contract file was edited.

**Steps 1-4 (ordinary API OAuth dispatch), `packages/stackpress-api/src/plugin.ts`**:
- `registerOAuthOperation` (00002's function, extended): now also rejects
  fixed `endpoint.data` that sets a reserved field (`profileId`,
  `applicationId`, `sessionId`, `oauth`) at route-registration time, so a
  misconfigured route fails startup instead of leaking a bad fixed value
  into every request.
- `session()` (the existing `type: 'session'` route handler) now classifies
  the credential's `oauth_` namespace once, before any legacy lookup: an
  `oauth_`-prefixed ID is routed to the new `oauthSession()` handler and
  never falls through to `session-detail`, even on failure. A non-`oauth_`
  ID keeps the exact pre-existing legacy path untouched.
- New exported `oauthSession(endpoint, req, res, ctx, token)`: refuses
  outright when the route never opted in (`endpoint.oauth` absent/boolean -
  "New OAuth keys refused when the route setting is absent or disabled");
  rejects any reserved field already present in the caller-submitted
  request data (400, before anything trusted is injected); derives
  `requiredCredential` as `'read'` on GET and `'full'` otherwise (HEAD
  included, via the existing `authorize()` helper which already refuses a
  missing secret for every non-GET method); calls `oauth-token-verify`
  once per `endpoint.oauth.resources` entry, trying each configured
  resource in order and accepting the first one the real grant is actually
  bound to (every attempt still runs the full verifier - this never
  weakens the check, it only discovers which of several *configured*
  resources the valid grant is for, since a plain bearer token carries no
  resource indicator of its own); applies the existing any-match scope
  rule plus the empty-configured-scopes-denies rule; injects `profileId`
  and `oauth: { clientId, grantId, resource, scopes }` last, after
  `endpoint.data`, so neither can be overwritten by configured fixed data.
- `app()`: an `oauth_`-prefixed ID is refused immediately, without
  attempting the legacy `application-detail` lookup ("Existing app keys
  stay app identities and cannot become user approvals").
- `helpers.ts`: added `badRequest()` (400), parallel to the existing
  `unauthorized()` (401), for the reserved-field-in-request-data case.

**Steps 5-6 (hardened legacy validator + migration adapter)**:
storage.md requires session to own the `OAuthLegacyBinding` hashing/
storage ("session never imports API") while API owns the Application/
Session record checks. Two new session-private fixed events bridge them -
deliberately **not** added to events.md's nine-event table or to
`OAuthService.finalize()`'s required-listener list (same treatment as the
existing `oauth-cleanup`), since they are task 00008's own operator-only
internal protocol, not part of the client-facing one:
- `packages/stackpress-session/src/oauth/events/legacyBind.ts` /
  `legacyVerify.ts`, registered in `oauth/plugin.ts`'s `listen` handler.
  Both call two new, additive `OAuthStore.ts` methods:
  `createLegacyBinding` and `verifyLegacyBinding` (00003 had already
  reserved the `OAuthLegacyBindingRow` type, the `legacy-id` hash domain
  and the table/unique-key for exactly this, flagging the method itself as
  "task 00008's scope"). `createLegacyBinding` rejects an `oauth_`-
  namespaced legacy ID outright ("Validate namespace collisions"); is
  idempotent when re-run against the same still-matching record (repeatable
  migration); and rejects (rather than silently overwrites) a legacy ID
  whose stored `incarnation` no longer matches, so a deleted-and-recreated
  ID cannot inherit the old binding. `verifyLegacyBinding` reports a single
  boolean for every failure reason (missing/inactive/expired/incarnation-
  mismatch/namespace-collision), so an unbound key cannot be used to probe
  which case applies. **Design decision**: API submits the legacy record's
  *raw* ID over this trusted in-process call, not a pre-hashed value;
  session hashes it with the already-reserved `'legacy-id'` domain before
  storing. storage.md's "submit kind, hashed ID and exact resource" is read
  here as describing what ends up persisted (a hash), not which side must
  compute it - duplicating the hash algorithm across two packages would
  create exactly the kind of drift risk storage.md's domain-separation
  design otherwise prevents. **Accepted by orchestrator 2026-10-15**: a
  routine internal choice consistent with the contract, since the contract
  does not fix which package computes the hash and session already owns
  `OAuthLegacyBinding` storage. Not reopened.
- `packages/stackpress-api/src/legacy.ts`: new exported
  `verifyLegacyMcpKey(ctx, { kind, token, resource })`, for task 00009 to
  call from the MCP layer. Requires a full `id:secret` legacy key (legacy
  keys have no read-ID concept to extend); resolves `application-detail`/
  `session-detail`, checks secret/active/expiry itself (API's own
  record checks), then calls `oauth-legacy-verify` with the *incarnation*
  derived from the legacy record's own immutable `created` timestamp
  (chosen over a new migration-owned incarnation record, since
  Application/Session already carry an immutable creation date no update
  path changes - storage.md's fallback wording ["Use a separate
  migration-owned incarnation record if legacy created timestamps cannot
  guarantee that identity"] was judged unnecessary here). Returns a safe
  `LegacyMcpIdentity` (`kind`, `legacyId`, `applicationId`, optional
  `profileId`, `scopes`, `resource`) or `null` for every failure reason,
  never a fabricated `Session`/`Application` object.
- `packages/stackpress-api/src/migrate.ts`: new `oauth-legacy-migrate`
  fixed event (registered in `plugin.ts`'s `listen`, not a route - "no
  public migration route"), the operator-only migration adapter. Input
  `{ kind, resource, ids: string[], dryRun?, expiresInSeconds? }` -
  explicit selection only, never an implicit "migrate everything" default.
  For each `id`: resolves the real legacy record, rejects it as `invalid`
  if missing/inactive/expired (no secret ever leaves this function);
  `dryRun: true` reports `would_bind` without calling `oauth-legacy-bind`
  at all (no writes); otherwise calls `oauth-legacy-bind` with the raw ID/
  derived incarnation/resource and reports `bound`, or the specific
  `namespace_conflict`/`incarnation_mismatch` reason session returned, or
  a generic `invalid` for anything else. Output never contains a secret or
  hash, only `{ id, status }` per record plus aggregate counts.
  Repeatable: re-running against the same already-bound records succeeds
  again (session's `createLegacyBinding` is itself idempotent).
- `index.ts`/package exports: `verifyLegacyMcpKey` and the new
  `LegacyMcpIdentity`/`LegacyMigration*` types are exported from
  `stackpress-api`'s existing `.` entry point for task 00009 to import;
  no new subpath was needed.

No binding-removal *method* was added to `OAuthStore.ts` - per amendment
A-001, every OAuth model (including `OAuthLegacyBinding`) already gets a
role-gated, non-menu admin page, and deactivating a binding through that
existing generated surface (an ordinary `active = false` row update) was
judged sufficient rather than adding a second removal path. This is now
exercised directly (see Verification Notes) by performing that same real
`UPDATE` against the real table and confirming `verifyLegacyBinding`/
`verifyLegacyMcpKey` both then refuse the key - not merely argued
structurally.

## Verification Notes

Environment: Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`), Yarn
1.22.22, this worktree (`/home/solution-team/.paseo/worktrees/0m6vr1k2/icky-snail`),
Inquire d5f5a07 override (unchanged, per tasks/status.md's 2026-10-15
decision - not re-verified by this task).

Compile, clean on both module formats, no new errors introduced by this
task's files (confirmed by checking the only pre-existing `--noEmit`
errors in `stackpress-session` are in `src/oauth/pages/{register,revoke,
token}.ts`, untracked files that belong to task 00006's own in-progress
work running in parallel in this worktree, not touched by this task):
```
(cd packages/stackpress-api && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)   # exit 0, exit 0
(cd packages/stackpress-session && npx tsc -p tsconfig.cjs.json --noEmit; ...)  # 0 errors in any file this task touched
(cd packages/stackpress && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)       # exit 0, exit 0
```

**`stackpress-api` (`yarn test`), full package suite, this worktree:**
**119 passing, 0 failing.** Package-wide coverage (`nyc --reporter=text`):
**99.00% statements / 93.77% branch / 94.44% funcs / 99.64% lines** (before
this task: 78 passing / 87.06% statements, recorded in 00002/00002A). Every
file this task added or changed is individually above the sprint's 90% bar:
`legacy.ts` 97.43%/95.23%, `migrate.ts` 100%/91.42%, `plugin.ts` 98.65%/
90.22%, `helpers.ts` 100%/100%. `Exception.ts` (0%) is 00002A's
pre-existing untouched baseline. New test files, all flat under `tests/`
(confirmed with `echo tests/**/*.test.ts` before and after adding them -
bash's non-globstar `**` would silently drop every pre-existing flat test
file the moment any nested `tests/<dir>/*.test.ts` file exists, so nested
suites were deliberately avoided for this package):
`oauth-session-route.test.ts` (12 cases: oauth_ classification/no-fallback,
reserved-field 400, GET-read vs POST-full `requiredCredential`, multi-
resource trial-until-match, no-match refusal, empty/non-intersecting
scopes denied, one-match success with trusted-last injection, `app()`'s
oauth_ refusal, `registerOAuthOperation`'s new reserved-fixed-data check),
`oauth-legacy.test.ts` (13 cases covering every `verifyLegacyMcpKey`
mocked-resolver branch: malformed/empty token, unknown/wrong-secret/
inactive/expired app and session records, unbound vs bound, safe identity
shape), `oauth-migrate.test.ts` (10 cases: malformed input, unknown/
inactive/expired record, dry-run no-write + no-secret-in-output, real bind
with raw-ID forwarding, `namespace_conflict`/unrecognized-failure reason
mapping, multi-id mixed-status repeatability), and **new**
`oauth-legacy-real-store.test.ts` (4 cases, orchestrator-requested: a
test-only cross-package relative import - not a `stackpress-session/...`
package-specifier import, so it does not touch that package's `exports`
map - wires `verifyLegacyMcpKey`'s `oauth-legacy-bind`/`oauth-legacy-
verify` calls to the *real* session action handlers over a real
PGlite-backed `OAuthStore`, proving: (1) bind-then-verify end to end
through the real store, (2) **original key revocation** - deactivating the
mocked-but-otherwise-realistic Application record ends access even though
the real binding row is untouched, (3) **binding removal** - a real `UPDATE
... SET active = false` against the real `oauth_legacy_binding` row (the
same statement the generated A-001 admin page would issue) ends access even
though the legacy key itself is still valid, (4) **source deletion/
recreation** - the same legacy ID "recreated" with a new `created`
timestamp (a new incarnation) cannot inherit the original binding). All 78
pre-existing tests (`plugin.test.ts`, `plugin-routes.test.ts`,
`helpers.test.ts`, `token-page.test.ts`, `oauth-page.test.ts`,
`Exception.test.ts`) still pass unchanged, confirming the legacy `app()`/
`open()` paths and existing API reply formats are untouched by this task's
changes.

**`stackpress-session` (`yarn test`), full package suite, this worktree:
414 passing, 46 pending, 0 failing** (pending = the four-adapter suites'
PostgreSQL/MySQL cases gracefully skipped without a running container,
same convention as 00003/00005 - see the separate cross-adapter run
below for those). This task's two event files are both at 100%
(`legacyBind.ts`, `legacyVerify.ts`); `OAuthStore.ts`'s own package-
measured coverage is 90.93%/85.45% (includes 00003/00005's prior code,
not separately attributable, but `createLegacyBinding`/
`verifyLegacyBinding` are fully exercised - confirmed no "Uncovered Line
#s" fall inside either method's line range). New test files:
`tests/oauth/events-legacy.test.ts` (11 cases, real PGlite-backed
`OAuthStore` through the event handlers; not editing the shared
`store.test.ts`/`store-adapters.test.ts` 00005 is still extending):
malformed input (400), `oauth_`-namespace-collision rejection on both bind
and verify, successful bind, idempotent repeat-bind, incarnation-mismatch
rejection on a recreated legacy ID, verify-unbound/verify-bound/
verify-wrong-resource/verify-recreated-incarnation/verify-namespace-
collision.

**New, orchestrator-requested: `tests/oauth/legacy-store-adapters.test.ts`
- `createLegacyBinding`/`verifyLegacyBinding` on all four required
adapters.** Run directly against `store.createLegacyBinding`/
`verifyLegacyBinding` (6 cases per adapter: migration-table-queryable,
bind-then-verify, migration-adapter-path dry-run-then-repeatable-bind,
`oauth_`-namespace rejection, source deletion/recreation via incarnation
mismatch, binding removal via a real `active = false` `UPDATE`), separate
flat file from 00005's `store-adapters.test.ts`, own env-var prefix
(`OAUTH_00008_PG_*`/`OAUTH_00008_MYSQL_*`) and own disposable container
names/ports (`oauth-00008-pg`:55565, `oauth-00008-mysql`:55566) so a
concurrent run under the shared lock never collides with another task's
containers:
```
flock /tmp/oauth-db.lock bash -c '
docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=oauth_proof -p 127.0.0.1:55565:5432 --tmpfs /var/lib/postgresql/data --name oauth-00008-pg postgres:17-alpine
docker run -d --rm -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=oauth_proof -p 127.0.0.1:55566:3306 --tmpfs /var/lib/mysql --name oauth-00008-mysql mysql:8.4
'
# waited for both ready, then:
OAUTH_00008_PG_HOST=127.0.0.1 OAUTH_00008_PG_PORT=55565 OAUTH_00008_PG_DATABASE=oauth_proof OAUTH_00008_PG_USER=postgres \
OAUTH_00008_MYSQL_HOST=127.0.0.1 OAUTH_00008_MYSQL_PORT=55566 OAUTH_00008_MYSQL_DATABASE=oauth_proof OAUTH_00008_MYSQL_USER=root \
flock /tmp/oauth-db.lock npx ts-mocha -r tsx tests/oauth/legacy-store-adapters.test.ts
```
**Result with both containers up, under Node 22: 24 passing, 0 pending, 0
failing** - PGlite 6/6, PostgreSQL 6/6, MySQL 6/6, SQLite 6/6 (SQLite
targeted directly the same way 00003/00004/00005's orchestrator checks
did). Both containers stopped and confirmed removed afterward
(`docker ps -a` shows neither `oauth-00008-pg` nor `oauth-00008-mysql`);
neither `ops-cockroach`, `op-impl-officepress-crdb`/`-pg`,
`analytics-preview-crdb`, `commerce-orders-review-db` nor
`office-inbox-dev-postgres-1` was touched.

**Remaining honest notes (none blocking, none regressing any
already-verified task)**:
1. "Unapproved same-host addresses" and "new routes" fingerprint-mismatch
   cases from the Verification Process are already covered by 00002's
   `registerOAuthOperation`/`OAuthService.registerApiOperation` tests
   (unchanged by this task) plus this task's multi-resource trial test;
   no additional fingerprint-specific case was added here since this
   task's new code does not touch fingerprint computation.
2. Real end-to-end "regression-test real existing API app/session
   handlers... through actual surfaces" is explicitly deferred to task
   00011 per this task's own Verification Process wording ("A dispatcher
   stub is not evidence of backward compatibility"); this pass's
   regression evidence is the unchanged 78 pre-existing `stackpress-api`
   tests continuing to pass against the modified `plugin.ts`, plus the new
   real-store cross-package test proving the validator against a real
   session store end to end.

Cleanup: both disposable containers stopped and confirmed removed; no
other scratch directories were created by this task; `ps -u $USER` shows
nothing left running from this session; `docker ps -a` otherwise unchanged
from before this task started.

## Acceptance Notes

No visual acceptance is required. Finish at verified once the checks pass;
do not mark accepted merely because tests pass.
