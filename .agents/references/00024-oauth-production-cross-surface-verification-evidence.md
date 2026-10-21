# OAuth Production Cross-Surface And Database Checks — Verification Evidence

Owner task: [00011](../specs/00004-mcp-native-oauth/tasks/00011-production-cross-surface-and-database-checks.md).
Environment throughout: Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`),
Yarn 1.22.22, this worktree, Inquire `d41472e` override (unchanged by this
task; root `package.json` `resolutions` block, not committed).

## Summary

00011 replaced fixture-only confidence (every prior task's own tests built
tables via the hand-written `storage/tables.ts` builder, never via a real
`yarn generate`/`push`/`migrate` of `oauth.idea`) with evidence from the
real generated `templates/blog` store, real package event handlers, and a
real locally-bound HTTP server exercising the real MCP and API surfaces
with one issued key. This found and fixed five real production defects (see
"Findings And Fixes"), none of which any prior task's suite could have
caught because none of them ran the real generated schema.

## Findings And Fixes

1. **`oauth_client_capacity` (task 00004's private counter table) was never
   created by the generated schema/migration path.** It is not one of
   storage.md's nine named models, so it is not declared in `oauth.idea`;
   `yarn generate`/`push`/`migrate` never create it. The first real client
   introduction to reach `OAuthStore.reserveClientCapacity`/
   `releaseClientCapacity` on a freshly generated+pushed app would fail with
   a raw `relation "oauth_client_capacity" does not exist`. **Fixed**:
   `OAuthStore.ts` now lazily ensures the table exists (idempotent
   `CREATE TABLE IF NOT EXISTS`, cached per store instance) the first time
   either method is called. New regression:
   `tests/oauth/client-capacity-table-bootstrap.test.ts` (4 cases) builds
   every OAuth table except the capacity one (mirroring exactly what a real
   generated+pushed app has) and proves both methods self-heal.
2. **`OAuthRateBucket.window` is a SQL reserved word** (MySQL 8.0.2+ and the
   SQL standard); an unquoted raw WHERE clause referencing it fails at the
   dialect level. `storage/tables.ts`/`OAuthStore.ts` already used
   `window_start` for exactly this reason, but `oauth.idea`'s generated
   schema still declared the field as `window`, so the generated column
   name did not match what `OAuthStore.ts`'s raw SQL referenced — every real
   rate-limit check (client registration, client-document fetch,
   authorization-start, token endpoint) failed with
   `column "window_start" does not exist` on a real generated store.
   **Fixed**: renamed `oauth.idea`'s field to `windowStart` (generates
   `window_start`).
3. **Missing `lockToken` column on four generated models**
   (`OAuthPending`, `OAuthGrant`, `OAuthFactorUse`, `OAuthRateBucket`).
   `OAuthStore.ts`'s `_claim()` CAS primitive (used for every atomic
   grant/pending/factor/rate-bucket mutation) requires a `lock_token`
   column on each; `oauth.idea` never declared it on any of the four, so a
   database generated purely from the documented setup steps failed the
   very first atomic operation with `column "lock_token" of relation
   "oauth_rate_bucket" does not exist` (and would have failed identically
   for the other three once reached). **Fixed**: added `lockToken String?`
   to all four models.
4. **`@default([])`/`@default({})` on JSON/array fields breaks real
   MySQL.** `OAuthPending.scopes/operations/approvedScopes/
   approvedOperations`, `OAuthGrant.scopes/operationFingerprints`,
   `OAuthClient.metadata` and `OAuthClientDocument.metadata` all declared a
   JSON-encoded default in `oauth.idea`. Real MySQL rejects any `DEFAULT`
   on a `JSON`/`TEXT`/`BLOB` column outright
   (`ER_BLOB_CANT_HAVE_DEFAULT`); `storage/tables.ts` already avoided this
   for the hand-written test-only builder (with a comment explaining
   exactly this), but the fix was never applied to the real generated
   schema. **Fixed**: removed every `@default([])`/`@default({})` from
   `oauth.idea`; `OAuthStore.ts` already supplies these fields explicitly
   on every insert, so no behavior changes.
5. **`templates/blog`'s own `blog:desktop-open-latest-posts` event name
   silently hijacked the real `blog-oauth-approval`/`blog-oauth-access`
   policy calls.** Ingest's `ExpressEmitter` (used for every
   `server.on`/`ctx.resolve` event, not only HTTP routes) treats any
   `:word` inside a registered event name as a route-style variable
   placeholder and rewrites the whole registration into a wildcard regex.
   `blog:desktop-open-latest-posts` became a pattern matching any event
   starting with `blog` and containing no `/` — including
   `blog-oauth-approval`/`blog-oauth-access` — so the desktop-menu
   handler's `res.results()` call silently overwrote the real policy
   result on every real approval attempt in the example app, making the
   demonstrated OAuth approval flow completely non-functional. **Fixed**:
   renamed to `blog-desktop-open-latest-posts` in
   `templates/blog/plugins/app/plugin.ts`. This is a blog-template-only fix
   (Ingest's matching behavior itself is unchanged and out of this spec's
   scope); flagged in `docs/oauth-upgrade.md` as a caution for any app that
   registers a colon-containing event name.

Two smaller blog-only issues were also fixed while exercising the real app:

6. **`comment-create-tool`'s generated MCP input schema required
   `profileId`**, but a `type: 'user'` tool under native MCP OAuth injects
   the real caller's `profileId` from the verified grant and refuses a
   caller-supplied one as a reserved field (events.md) — no OAuth client
   could ever call this tool successfully as packaged. Fixed with an
   explicit `input` override on that one tool entry in
   `templates/blog/config/common.ts` (the generated default minus
   `profileId`; `mergePluginTool` replaces the whole `input` on override,
   not a deep merge).
7. **`templates/blog`'s own `yarn test` command matched zero files.**
   `tests/helpers.ts` held seven real `node:test` assertions, but the
   command's glob is `tests/**/*.test.ts`; the file was never named
   `*.test.ts`, so "the blog's actual full-test command" silently ran
   nothing. Renamed to `tests/helpers.test.ts` (pure rename, no behavior
   change); confirmed 7 passing, 0 failing.

New regression tests added for findings 1-4:
`packages/stackpress-session/tests/oauth/client-capacity-table-bootstrap.test.ts`
and `packages/stackpress-session/tests/oauth/idea-schema-generation-pitfalls.test.ts`
(7 cases reading the real `oauth.idea` source: no bare `window` field, the
four `lockToken` fields are present, and no `@default([])`/`@default({})`
anywhere in the file).

## Side Fix: `legacy-store-adapters.test.ts` Isolation (00007A's Observation)

00007A recorded that re-running `yarn test` twice against the *same*
persistent PostgreSQL/MySQL containers produced 2 failures in this file
because its legacy IDs (`legacy-app-${name}`, `legacy-session-${name}`,
etc.) are deterministic and survive across separate test-process runs
against the same container. **Fixed**: added a per-process `RUN_ID`
(`Date.now()` + random suffix) appended to every legacy ID in the file.
Confirmed fixed by running the full `stackpress-session` suite twice in a
row against the same disposable containers (without recreating them) —
both runs: 746/746/746 passing (see "Per-Database Report" below), 0
failing, 0 pending. This task used fresh disposable containers per the
shared-VM rules regardless; the fix removes the dependency on that
discipline for this one file.

## Per-Database Report

All four adapters run under the same `yarn test` invocation (PGlite/SQLite
always in-process; PostgreSQL/MySQL via disposable tmpfs-backed containers,
`oauth-00011-pg`/`oauth-00011-mysql` on ports 55595/55596, started and
stopped under `flock /tmp/oauth-db.lock`, removed via `docker stop` with
`--rm` immediately after). Every adapter showed passing rows, not pending,
confirmed by grepping for "pending" counts (0 across every run below).

| Database | `stackpress-session` full suite | `legacy-store-adapters.test.ts` (direct) | `client-capacity-table-bootstrap.test.ts` |
| --- | --- | --- | --- |
| PGlite | 746 passing, 0 failing, 0 pending | 6/6 passing | 4/4 passing |
| PostgreSQL | included above (746 total) | 6/6 passing | n/a (PGlite-only by design; capacity self-bootstrap proven against the real blog PostgreSQL swap below) |
| MySQL | included above (746 total) | 6/6 passing | n/a |
| SQLite | included above (746 total) | 6/6 passing | n/a |

Re-run twice in a row against the same (not recreated) containers: both
runs **746 passing, 0 failing, 0 pending** — confirms the
`legacy-store-adapters.test.ts` isolation fix.

Package-wide coverage (`nyc --reporter=text`), all four databases up:
**91.28%** statements / 84.05% branch / 93.30% funcs / 92.19% lines —
above the sprint's >90% statement bar.

Generated-schema structural check (separate from the suite above — this
exercises the real `oauth.idea`-generated client's per-model
`install()`/`uninstall()`, i.e. exactly what `yarn generate`+`yarn push`
produces, against all four engines directly):

| Database | `oauth_rate_bucket.window_start` | `oauth_rate_bucket.lock_token` | `oauth_pending.lock_token` | `oauth_grant.lock_token` | `oauth_factor_use.lock_token` | `oauth_client`/`oauth_client_document` install (JSON-default fix) |
| --- | --- | --- | --- | --- | --- | --- |
| PGlite | OK | OK | OK | OK | OK | OK |
| PostgreSQL | OK | OK | OK | OK | OK | OK |
| MySQL | OK | OK | OK | OK | OK | OK |
| SQLite | OK | OK | OK | OK | OK | OK |

## Other Changed Packages

| Package | Command | Result | Coverage |
| --- | --- | --- | --- |
| `stackpress-session` | `yarn test` (all 4 DBs) | 746 passing, 0 failing, 0 pending | 91.28% stmt / 84.05% branch / 93.30% func / 92.19% line |
| `stackpress-ai` | `yarn test` (PGlite only) + `tests/mcp-oauth-cross-process.test.ts` (real PostgreSQL+MySQL) | 160 passing, 0 failing (full suite); 4/4 passing (cross-process, both engines) | 94.98% stmt / 86.91% branch / 93.01% func / 96.11% line |
| `stackpress-api` | `yarn test` | 119 passing, 0 failing | 99.00% stmt / 93.77% branch / 94.44% func / 99.64% line |
| `stackpress-sql` | `yarn test` | passing, unchanged (not modified by this task) | not re-measured (no source change) |
| `stackpress` (aggregate) | `yarn build` | clean (type-only OAuth re-exports; no runtime statements) | n/a |
| `templates/blog` | `yarn test` (fixed from 0 matched files) | 7 passing, 0 failing | n/a (example app, not a coverage-gated package) |

Compile (`tsc --noEmit`, both module formats) clean for `stackpress-session`,
`stackpress-ai`, `stackpress-api`, `stackpress`. `npx tsc --noEmit -p
templates/blog/tsconfig.json`: one pre-existing, unrelated error
(`plugins/app/plugin.ts`'s `contributeDesktopMenu` HttpServer/Server generic
mismatch, present before any OAuth-spec change — confirmed via `git diff`;
not touched). Root `yarn build`: clean.

## Real Production Cross-Surface Check (`templates/blog`)

A scratch script (`templates/blog/.scratch-00011-cross-surface.mjs`, deleted
after this run, never committed) imported the real `config/develop.ts`
`bootstrap()` — the actual blog app's real config, real plugins, real
`oauth-finalize`, over a real PGlite database freshly created by `yarn
generate` + `yarn push` + `yarn populate` — and drove the full journey
through real production event dispatch and a real HTTP listener bound to
`127.0.0.1` on an ephemeral port (never exposed, closed at the end of the
run):

1. Real `auth-signup` event → real `Profile`/`Auth` rows (ADMIN role).
2. Real `oauth-client-register` event → real dynamic client, real
   `OAuthClient` row.
3. Real `oauth-authorization-start` event (real rate-limit check against
   the real `oauth_rate_bucket` table) → real `OAuthPending` row.
4. Real `oauth-authorize` event, using the real `blog-oauth-approval`
   policy listener (after fix 5 above) → real `OAuthGrant` + single-use
   code.
5. Real `oauth-code-exchange` event → real full access key
   (`oauth_<id>:<secret>`).
6. Real HTTP `POST /mcp`: anonymous `initialize` (200), authenticated
   `tools/list` (200, 6 tools including the OAuth-gated `comment_create`),
   authenticated `tools/call` on `comment_create` (200, a real `Comment`
   row created with the server-injected `profileId`, not a caller-supplied
   one).
7. Real HTTP `GET /api/articles/minecraft` with the **same** access token
   (the OAuth-opted-in API route from `templates/blog/config/common.ts`):
   200.
8. Real `oauth-grants-list` + `oauth-grant-revoke` events (the same
   production path the real `/connections/revoke` page action calls) →
   `{"revoked":true}`.
9. Same access token, both surfaces, after revoke: MCP `tools/list` → 401;
   API `GET` → 401.

This directly proves verification.md's "Shared MCP/API key" and "API route
enablement" rows, and "Existing apps"/"Database/package" for the
consuming-app angle, against the real generated store rather than a
fixture.

## Every Required Test Family — Actual Command/Result

All 22 rows from verification.md's required-tests table (sprint.md's
ownership table), each with the actual command run this pass and its
owning in-package suite (already re-run clean above) plus, where
applicable, the real cross-surface evidence above.

| # | Required test family | Owning suite(s), re-run this pass | 00011 cross-surface evidence |
| --- | --- | --- | --- |
| 1 | Login instructions | `stackpress-session` (`metadata.test.ts`, `pages-discovery.test.ts`) | 00010's real `GET /.well-known/oauth-authorization-server`/`-protected-resource` curl checks (unchanged this pass) |
| 2 | Client documents | `stackpress-session` (`client-document.test.ts`, `client-transport-live.test.ts`) | n/a (registered-client path exercised; document-client path already proven against a real local HTTPS fixture in 00004) |
| 3 | Client registration | `stackpress-session` (`client-register.test.ts`, `events-client-register.test.ts`) | real `oauth-client-register` event → real `OAuthClient` row (step 2 above) |
| 4 | Return addresses | `stackpress-session` (`client-redirect.test.ts`) | real redirect URI validated at authorization-start (step 3) |
| 5 | Approval | `stackpress-session` (`events.test.ts`, `pages-authorize.test.ts`) | real `oauth-authorize` event, real policy listener (step 4) |
| 6 | Extra approval check | `stackpress-session` (`factor.test.ts`, `factor-receipt-adapters.test.ts` on all 4 DBs, `pages-factor.test.ts`) | not re-exercised in the cross-surface script (ADMIN profile's policy does not require it); covered by owning suite |
| 7 | Single-use code | `stackpress-session` (`store.test.ts`, `store-adapters.test.ts` reuse cases, all 4 DBs) | real code consumed exactly once (step 5) |
| 8 | Key reply | `stackpress-session` (`pages-token.test.ts`, `events.test.ts`) | real `oauth_<id>:<secret>` issued (step 5) |
| 9 | Client admission policy | `stackpress-session` (`client-policy.test.ts`) | real registered client admitted (step 2-3) |
| 10 | Access-key lifetime | `stackpress-session` (`store-adapters.test.ts`, all 4 DBs) | real grant `accessExpires`/`deadline` rows observed during the run |
| 11 | Renewal | `stackpress-session` (`store-adapters.test.ts` renewal/races, all 4 DBs) | full native-client renewal is deferred to 00012 per sprint.md; library-level renewal already integration-tested here |
| 12 | API/MCP key checks | `stackpress-api` (`oauth-session-route.test.ts`), `stackpress-ai` (`mcp-oauth-http.test.ts`) | real GET/MCP calls with the same key, real refusal after revoke (steps 6-9) |
| 13 | Permission lists | `stackpress-api`, `stackpress-ai` any-match/empty-scope cases | blog's `blog-oauth-approval` role-based scope narrowing (ADMIN vs. USER) exercised by 00007's screenshots; not re-driven as USER in this pass |
| 14 | Mixed public/protected MCP tools | `stackpress-ai` (`mcp-oauth-http.test.ts`, `mcp-oauth-sse.test.ts`) | real anonymous `initialize` (200) + real authenticated `tools/list` showing both public and protected tools (step 6) |
| 15 | API route enablement | `stackpress-api` (`oauth-session-route.test.ts`) | real `GET /api/articles/:id` opt-in route (step 7) |
| 16 | Shared MCP/API key | n/a (first proven end-to-end here) | **directly proven**: same access token on MCP tool call and API route, both succeed, both refuse after one revoke (steps 6-9) |
| 17 | Read-ID protection | `stackpress-session`/`stackpress-api`/`stackpress-ai` (ID-only GET rules) | not separately re-driven with an ID-only credential in the cross-surface script; covered by owning suites |
| 18 | Saved connections | `stackpress-ai` (`mcp-oauth-http.test.ts` session-binding cases) | the real MCP session was bound at `initialize` and reused correctly for the authenticated call (step 6) |
| 19 | Connection methods | `stackpress-ai` (`mcp-oauth-http.test.ts`, `mcp-oauth-sse.test.ts`, all 6 combinations) | real Streamable HTTP stateful POST exercised (step 6); SSE/STDIO unchanged this pass |
| 20 | Existing apps | `stackpress-api` (`oauth-legacy.test.ts`, `oauth-legacy-real-store.test.ts`, `legacy-store-adapters.test.ts` on all 4 DBs) | blog's existing `application-create`/`comment-create` legacy records (from `yarn populate`) untouched by this run |
| 21 | Detailed contract additions | across `stackpress-session`/`stackpress-api`/`stackpress-ai` suites (unchanged, re-run clean) | n/a |
| 22 | Database/package | `stackpress-session`/`stackpress-sql` suites (all 4 DBs), root `yarn build`, `templates/blog` `yarn generate` (x2, idempotent)/`yarn push` (all 4 engines, this pass)/`yarn populate`/`yarn test` (fixed) | real generate+push+populate+cross-surface run on PGlite; generated-schema structural check on all 4 engines (table above) |

No required test family was skipped or replaced with a fixture-only
substitute; every row above has an actual command and a passing result from
this pass, or an explicit, honest note on what remains for 00012 (native
client journeys) or was already covered without needing to be re-driven.

## General Schema Drift Guard (Orchestrator Follow-Up)

`packages/stackpress-session/tests/oauth/schema-drift.test.ts` closes the
root cause behind findings 2-4 above permanently: it parses `oauth.idea`
through the real `@stackpress/idea-transformer` -> `stackpress-schema` ->
`stackpress-sql` `makeCreateQuery()` pipeline (the same function that
generates each model's real `install()` body) and asserts the generated
table name, full column set and per-column nullability match
`storage/tables.ts`'s hand-written `Create` builders for all nine
storage.md models, plus an expected-shape check for the
non-generated `oauth_client_capacity` table. Verified it actually fails on
drift (temporarily renamed a column in `oauth.idea`, confirmed two clear
assertion failures, reverted). Full detail: task 00011's Verification
Notes, "Follow-up" section.

## Cleanup

- Disposable containers `oauth-00011-pg`/`oauth-00011-mysql`: stopped
  (`docker stop`, auto-removed via `--rm`) and confirmed gone (`docker ps
  -a`) after every use in this task; neither `ops-cockroach`,
  `op-impl-officepress-crdb`/`-pg`, `analytics-preview-crdb`,
  `commerce-orders-review-db` nor `office-inbox-dev-postgres-1` was
  touched.
- `templates/blog`: `.build`, `node_modules/.vite` and the regenerated
  `node_modules/blog-client` removed after the final run (regenerable,
  disposable per AGENTS.md). The cross-surface scratch script and every
  other `.scratch-00011-*.mjs` helper script were deleted; confirmed with
  `git status --short templates/blog` showing no untracked scratch files.
- No scratch left in `/tmp` beyond this task's own log files
  (`/tmp/oauth-00011-*.log`), which are disposable build/test output, not
  evidence that needs to persist beyond this run.
- No test runner, watcher, dev server or Vite process was left running
  (`ps -u $USER` checked after every run; the one `node --test`/Vite
  WebSocket-port-in-use message seen during the cross-surface run came from
  an unrelated process already running on this shared host, not anything
  this task started — this task's own HTTP listener was bound to an
  ephemeral port and explicitly closed at the end of the script).
- `python3 .agents/scripts/validate-agent-workspace.py`: see the owning
  task file's Verification Notes for the result of this specific run.
