# OAuth Schema And Private Storage — Verification Evidence

Detailed verification evidence for spec `00004-mcp-native-oauth` task
`00003-oauth-schema-and-private-storage.md`, split out under the 500-line
Agent File limit. Load this file when you need the exact commands,
environment, per-adapter results, coverage numbers, or the amendment
A-001 generated-output evidence behind that task's verification claims;
the task file itself keeps only the summary and current status.

## Environment

Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`), Yarn 1.22.22, this
worktree (`/home/solution-team/.paseo/worktrees/0m6vr1k2/icky-snail`).
Added `@stackpress/inquire-pg`/`-mysql2`/`-sqlite3` and their drivers
(`pg@8.23.1`, `mysql2@3.24.6`, `better-sqlite3@12.11.1`) as
`devDependencies` of `packages/stackpress-session`, then ran
`yarn install` from the repo root; the root `resolutions` block supplied
the corrected d5f5a07 build for all five `@stackpress/inquire*` packages
(confirmed: `node_modules/@stackpress/inquire/{cjs,esm}/Lock.js` present
for all of them). Disposable containers for the two server-based
adapters: `docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust -e
POSTGRES_DB=oauth_proof -p 127.0.0.1:55555:5432 --tmpfs
/var/lib/postgresql/data postgres:17-alpine` and `docker run -d --rm -e
MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=oauth_proof -p
127.0.0.1:55556:3306 --tmpfs /var/lib/mysql mysql:8.4`, both started and
later `docker stop`ped (removed automatically via `--rm`) under `flock
/tmp/oauth-db.lock`; neither `ops-cockroach`,
`op-impl-officepress-crdb/-pg` nor any other pre-existing container was
touched. PGlite and SQLite need no server (in-memory).

## Idea Parse/Compose/Normalize

(storage.md "Run first and repeated generation, including both schema
includes")
- `Transformer.load('packages/stackpress-session/oauth.idea')` then
  `.schema()`: composes cleanly, returns all 9 OAuth models plus
  `Profile` and `Auth` (from the `use "stackpress-session/schema.idea"`
  include), 11 models total, no parse error.
- Dedup check: a scratch app schema with **both**
  `use "stackpress-session/oauth.idea"` and
  `use "stackpress-session/schema.idea"` (the two-direct-includes case
  configuration.md calls out) composes to the same 11 models, `Profile`/
  `Auth` present once each — confirms the merge-by-name dedup in
  `@stackpress/idea-transformer`'s `Transformer.schema()` handles the
  double include.
- `stackpress-schema/Schema.make(config)` over the composed schema:
  completes without throwing for all 9 OAuth models (exercises
  `makeModel`/`makeFieldset`/column-attribute parsing for every field
  type used — `String`, `String[]`, `Hash?`, `Integer`, `Boolean`,
  `Datetime`, `Datetime?`), including the `@label`/`@list.*`/`@view.*`
  decorators added for amendment A-001 (see below).
- Found and fixed one real `.idea` syntax defect while verifying:
  optional array fields (`String[]?`) are not accepted by the parser
  ("Unexpected token ?"); changed `OAuthPending.approvedScopes`/
  `approvedOperations` to non-nullable `String[] @default([])` instead
  (status/pending-vs-decided is already tracked by the `status` column,
  so this loses no information).

## Real-Database Migration/Constraint Checks (PGlite Only)

New test file `packages/stackpress-session/tests/oauth/storage-tables.test.ts`,
run against a real in-memory `PGlite()` instance (nothing written to
disk) via the corrected `@stackpress/inquire-pglite`/`@stackpress/inquire`
d5f5a07 build:
- All 9 `Create` builders from `tables.ts` run cleanly against a fresh
  database (clean first generation).
- Re-running one of the same `Create` builders a second time against the
  now-materialized schema is a clean no-op (repeat-generation stability)
  — confirmed this is because the installed Pgsql dialect emits
  `CREATE TABLE IF NOT EXISTS`
  (`node_modules/@stackpress/inquire/esm/dialect/Pgsql.js:199`), not
  because errors were swallowed.
- `oauth_client.client_id` unique constraint: second insert with a
  duplicate `client_id` throws.
- `oauth_grant.read_id_hash` nullable-unique constraint: two rows with
  `read_id_hash IS NULL` coexist (standard SQL unique-ignores-NULL
  semantics), then setting the same non-null hash on both throws on the
  second `UPDATE`.
- Found and fixed the Pgsql falsy-default dialect issue described in
  the task's Implementation Notes by reproducing it directly: inserting
  into `oauth_grant` without explicit `generation`/`lock_version`/
  `revision` values failed with `null value in column "generation" ...
  violates not-null constraint` until the table definition stopped
  relying on `default: 0` and the test started supplying those columns
  explicitly.

## Four-Adapter Atomic-Operation Verification

New test file `tests/oauth/store-adapters.test.ts` runs the same
condensed scenario set — migration, approval+exchange, reuse-and-cancel,
refresh/rotation, a true-concurrency race (two parallel `exchangeCode`
calls on the same code), a forced real-SQL-failure rollback, and cleanup
— against all four real adapters in one file: PGlite (in-memory), real
PostgreSQL and MySQL (the disposable containers above), and real SQLite
(`better-sqlite3`, in-memory). All skip gracefully (`this.skip()` in
`before`) rather than failing `yarn test` when the PG/MySQL containers
aren't running, so the default `yarn test` run (no Docker needed) still
passes cleanly with those two suites reported `pending`.

Result with both containers up, under `flock /tmp/oauth-db.lock`: **28
passing, 0 failing, 0 pending** — all seven scenarios green on all four
adapters. The Inquire dialect findings (Pgsql falsy default, MySQL TEXT
default, MySQL composite-index length, MySQL DATETIME format) were each
found and fixed by this run failing first, not by inspection alone.
`tests/oauth/store.test.ts` (PGlite only, the full scenario matrix
including every error/edge branch) separately proves the concurrency-bug
regressions described in the task's Implementation Notes.

## Idea Generation Through The Real Pipeline

In a scratch directory under `/tmp/oauth-00003-generate` (deleted after
each check — not `templates/blog`, which belongs to 00010), with a
one-line schema `use "stackpress-session/oauth.idea"`:
- First generation (schema+sql transforms only) succeeds, produces 451
  files, compiles the composed schema through `stackpress-schema/
  Schema.make` with no error, and includes `OAuthClient`/`OAuthGrant`/
  etc.'s `Store`/`Actions`/`Schema`/column/event files — ordinary
  per-model output, the same as any other model (Profile/Auth
  included).
- Repeated generation (same inputs, same transforms, run a second time
  against a fresh output directory): identical file count (451 both
  runs), no error — repeat-generation stability confirmed.
- Second generation run with `stackpress-view` and `stackpress-admin`'s
  transforms also registered (the exact set `packages/stackpress/src/
  plugin.ts`'s aggregate wires up, minus `stackpress-ai`, which is
  correctly not part of the default aggregate per task 00002's notes):
  succeeded, and produced full admin routes/pages/views for
  `OAuthClient`/`OAuthGrant` (and, by the same unconditional per-model
  loop, every other OAuth model). This is the evidence behind amendment
  A-001 — see "Amendment A-001 Verification" below for the follow-up
  check once the schema was updated with safe-field decorators.

## Amendment A-001 Verification

After the user's decision (A-001, decisions.md) relaxed the original
"no generated admin exposure" rule to "treated like Auth/Application/
Session — reachable by role, out of the default menu, no hash columns
displayed", `oauth.idea` was updated to add `@label`/`@list.*`/`@view.*`
decorators to every column that holds no credential material, while
every column that holds a hash of a credential, a raw PKCE/receipt
value, or an unvalidated metadata blob keeps **zero** `@list.*`/
`@view.*`/`@field.*`/`@filter.*` decorators at all: `urlHash`,
`bindingHash`, `codeChallenge` (both the `OAuthPending` and `OAuthCode`
copies), `factorReceipt`, `readIdHash`, `fullKeyHash`, `codeHash`,
`tokenHash`, `legacyIdHash`, `keyHash`, and both `metadata` columns
(`OAuthClient`, `OAuthClientDocument`). No model anywhere carries
`@field.*`/`@filter.*` at all — deliberately stricter than A-001
requires: letting an admin create/edit an OAuth row through a raw
generated form would let them fabricate or mutate grant/token state
without going through `OAuthStore.ts`'s hashing/locking/approval logic,
a materially worse risk than an existing Auth/Application/Session edit
form, so no create/update form or search filter is offered for any
OAuth model.

**(a) No hash column renders in generated admin views — verified
directly.** Regenerated the schema+sql+view+admin pipeline against the
updated `oauth.idea` in a fresh `/tmp/oauth-00003-generate` scratch app
(deleted after this check). `grep -rniE` across every `OAuth*/admin/`
file for `readIdHash|read_id_hash|fullKeyHash|full_key_hash|codeHash|
code_hash|tokenHash|token_hash|legacyIdHash|legacy_id_hash|keyHash|
key_hash|bindingHash|binding_hash|urlHash|url_hash|codeChallenge|
factorReceipt` matched only `codeChallengeMethod` (the safe method-name
string "S256", not the raw challenge value) in `OAuthPending`'s search/
detail views — nothing else, across all nine models. Separately
confirmed the safe columns actually do render (so the absence of hashes
is because they are excluded, not because nothing renders at all):
`OAuthGrant/admin/views/search.tsx` and `detail.tsx` both reference
`row.profileId`/`row.clientId`/`row.resource` through generated
`ProfileIdListFormat`/`ClientIdListFormat`/`ResourceListFormat` (and
the `View` equivalents in `detail.tsx`). Also confirmed zero `Field.`
usages in every `OAuthGrant/admin/views/{create,update}.tsx` and zero
`Filter.` usages in `search.tsx` — no create/update form fields, no
search filters, matching the deliberate no-`@field`/`@filter` choice
above.

**(b) MCP tools stay closed unless listed in `mcp.tools` — verified by
reading the actual runtime gate, not inferred.**
`packages/stackpress-ai/src/plugin.ts`'s `createMcpServer` builds the
registry exclusively from `buildTools(ctx, ctx.config.path('mcp.tools',
[]))` — an app-authored array, defaulting to empty, with zero automatic
population from any generated per-model file. `stackpress-ai` does have
its own generation-time transform (`packages/stackpress-ai/src/
transform/tools.ts`) that, like admin's, loops every model
unconditionally and writes a per-model `tools/*.ts` file plus a root
`tools.ts` exporting a `listen(emitter)` function — but that function
registers **internal resolver events** on the emitter (the same
"internal domain capability" pattern as every other generated model),
not MCP-visible tools; nothing calls it unless the app explicitly loads
`stackpress-ai` and wires it up, and nothing feeds its output into
`mcp.tools` automatically. `stackpress-ai` is still not part of the
default aggregate plugin (confirmed again, consistent with task 00002's
notes), so a typical app generating `oauth.idea` through the standard
`stackpress` aggregate never even runs this transform.

**(c) No API route exists for OAuth models without config — verified
by reading the actual runtime gate.** `packages/stackpress-api/src/
plugin.ts`'s `route` listener reads `const { endpoints = [] } =
ctx.config('api') || {}; if (!endpoints.length) return;` — routes are
built exclusively from the app's own `api.endpoints` array. There is no
per-model loop anywhere in `stackpress-api` analogous to admin's; this
guarantee does not depend on which models exist in the schema at all.

## Package-Level Build And Full Suite

From `packages/stackpress-session`:
- `yarn build` (`tsc -p tsconfig.cjs.json` + `tsc -p tsconfig.esm.json` +
  package.json stamping): clean, no TypeScript errors, both before and
  after the amendment A-001 `oauth.idea` decorator changes (`oauth.idea`
  is not imported by any TypeScript source, only read by the generation
  pipeline, so this rebuild is a regression check, not a dependency of
  the decorator change).
- `yarn test` (`nyc ts-mocha -r tsx tests/**/*.test.ts`), **with both
  disposable containers running**: **164 passing, 0 failing** (was 79
  after task 00002; this task adds 85 new tests across 6 new files, all
  flat under `tests/oauth/` — one path segment below `tests/`, confirmed
  with `echo tests/**/*.test.ts` in this package's `bash`, no
  `globstar`, before adding any of them, per the sprint note from task
  00002A about files silently dropping from that unquoted glob at two
  levels of nesting). **Without the containers** (the normal case for
  anyone running `yarn test` without Docker): **150 passing, 0 failing,
  14 pending** (the PostgreSQL/MySQL adapter suites skip cleanly).
- Coverage (`nyc --reporter=text`), with both containers running:
  package-wide **97.16%** statements / 94.08% branch / 98.47% funcs /
  97.52% lines. `src/oauth/storage/OAuthStore.ts` itself: 94.94%
  statements / 89.36% branch (comfortably above the sprint's >90%
  statement bar; the uncovered lines are a handful of deep bounded-retry-
  exhaustion branches in `_withLockedGrant`/`checkAndAdvanceFactor`/
  `incrementRateBucket` that require deliberately starving three
  consecutive lock attempts to hit, not exercised separately from the
  true-concurrency tests that already prove the lock mechanism itself).
  `ids.ts`/`tables.ts`/`json.ts`/`errors.ts`: **100%** each.
  `src/Exception.ts` (0%, pre-existing, untouched) remains the only file
  below the package-wide number, per task 00002's established baseline
  treatment. `src/oauth/OAuthService.ts`/`config.ts`'s 2 pre-existing
  uncovered lines are likewise untouched by this task.
- `oauth.idea` added to `packages/stackpress-session/package.json`
  `files`; not separately re-verified with `npm pack --dry-run` this
  pass (time-boxed; recommend doing so alongside 00010's packaging
  checks).

## Cleanup Performed

Both disposable containers stopped (auto-removed via `--rm`) and
confirmed gone (`docker ps -a`); no scratch directories left under
`/tmp` (`oauth-00003-generate` — regenerated and deleted twice, once per
verification pass — and `oauth-00003-repeat`, and the earlier parse-
check scratch dirs, were all removed after use); no stray Node/mocha
processes left running under this agent.

## Remaining Gaps, Honestly Recorded

1. `OAuthStore.ts` has no method to create an `OAuthLegacyBinding` row —
   that is explicitly API's migration adapter (storage.md "Upgrade
   Existing MCP Keys Explicitly"), owned by task 00008, not this one;
   `cleanup()`'s legacy-binding removal path was still verified directly
   against a hand-inserted fixture row.
2. `ExchangeCodeInput.renewalSeconds` is accepted but deliberately never
   read inside `exchangeCode` (the refresh token's expiry is correctly
   derived from the grant's own `deadline`, set once at approval time
   and never recalculated at exchange time — storage.md's deadline is
   "immutable" by design). Kept on the input type, with a doc comment
   explaining why, rather than removed, only so callers do not need two
   different input shapes between approval and exchange.
3. `npm pack --dry-run` for the new `oauth.idea` `files` entry was not
   run this pass (noted above); recommend bundling it with 00010.
4. Generated admin pages for OAuth models exist but are not restricted
   to a specific role list from within this task — A-001 says they are
   "reachable only by roles the app's access rules allow", which is the
   app's own `session.access` configuration, not something
   `stackpress-session/oauth.idea` or `OAuthStore.ts` controls. Whoever
   writes the real consuming app (00010's blog example) must configure
   that access rule explicitly; this is recorded here so it is not
   silently assumed to already be in place.
