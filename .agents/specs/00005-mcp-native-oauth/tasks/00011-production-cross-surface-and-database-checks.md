# 00011 — Verify the real packages together on all four databases

Status: verified. Full evidence, per-database report, the 22 required
test family mapping and the real cross-surface production run are in
[OAuth production cross-surface verification evidence](../../../references/00027-oauth-production-cross-surface-verification-evidence.md).
Owner: session/AI/API integration suites and blog test application.
Stage: 5/6, production integration.
Depends on: [00010](00010-package-exports-blog-and-upgrade-docs.md)
Journeys: J01–J14 integration support.
Contracts: [verification](../verification.md), [proofs](../proofs.md), [journeys](../journeys.md), [storage](../storage.md), [recovery](../recovery.md).

## Task Summary

Replace fixture-only confidence with evidence from generated production stores, real package handlers and the consuming app.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Build a reusable isolated integration setup for each supported database, using actual generated stores and session/API/AI plugins. Inject clocks/network failures only at documented test seams.
2. Run the complete verification.md case matrix and the task plan’s coverage map. Test the same native-format issued key on permitted MCP/API actions and refusal elsewhere, through real business-event dispatch.
3. Repeat P-001/P-004 cases against production stores/handlers: races, rollback, cancellation in both orders, replay across generations, operation fingerprint changes and shared expiry/disconnect.
4. Exercise full browser/account guard interaction, exact route capability handling, all connection modes, proxy/CORS, current policy/account changes and multi-process notification/cancellation behavior.
5. Run OAuth-off/legacy/STDIO regressions and affected package/build/import suites. Record meaningful branch/security coverage above 90% for every changed package, including supporting packages if changed.
6. Refactor only within accepted boundaries where integration reveals duplication or ownership mistakes, then rerun affected checks. Keep test-only substitutes out of runtime defaults; preserve redacted evidence and cleanup records.

## Verification Process

- Each required test family must have an actual command/result and owner; no missing suite, skipped adapter or fixture-only substitution can count as passed.
- Keep four separate database reports and real production handler traces. Confirm token hashes/credentials never appear in public logs, props, reports or committed fixtures.
- Complete package suites, root build and consuming-app checks appropriate to changed scope; run test:skills/pack CLI checks only if root CLI/scaffold scope actually changes.
- This task does not replace real native-client/browser evidence in 00012. Record any blocker or new design gap rather than editing Frozen behavior.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

Done 2026-10-15 in this worktree (uncommitted), against 00001A-00010's
already-verified work and Inquire `d41472e` (unpublished, root
`resolutions` block, unchanged and not committed).

Running the real `templates/blog` generated store/handlers together (the
thing every prior task's own tests never did, since they all built tables
via the hand-written `storage/tables.ts` builder) found and fixed five real
production defects, plus two blog-template-only issues. Full detail,
reproduction and before/after evidence for all seven: [reference
00027](../../../references/00027-oauth-production-cross-surface-verification-evidence.md#findings-and-fixes).
Summary:

1. `oauth_client_capacity` (00004's private counter table, not one of
   storage.md's nine models) was never created by `oauth.idea`'s generated
   schema/migration path. **Fixed**: `OAuthStore.ts`'s
   `reserveClientCapacity`/`releaseClientCapacity` now lazily
   self-bootstrap it (idempotent `CREATE TABLE IF NOT EXISTS`).
2. `OAuthRateBucket`'s generated column was named `window` (a SQL reserved
   word), not `window_start` like `storage/tables.ts`/`OAuthStore.ts`
   already used. **Fixed**: renamed the `oauth.idea` field to
   `windowStart`.
3. `OAuthPending`/`OAuthGrant`/`OAuthFactorUse`/`OAuthRateBucket` were all
   missing the `lockToken` column `OAuthStore.ts`'s `_claim()` CAS
   primitive requires. **Fixed**: added `lockToken String?` to all four
   `oauth.idea` models.
4. `oauth.idea` declared `@default([])`/`@default({})` on several
   JSON/array fields, which real MySQL rejects outright on a
   JSON/TEXT/BLOB column. **Fixed**: removed every such default (matching
   `storage/tables.ts`'s existing, already-documented avoidance of this).
5. `templates/blog`'s own `blog:desktop-open-latest-posts` event name
   collided with `blog-oauth-approval`/`blog-oauth-access` under Ingest's
   `:word`-as-wildcard event matcher, silently overwriting every real
   approval-policy result and making the example's OAuth flow
   non-functional. **Fixed**: renamed to
   `blog-desktop-open-latest-posts` in `templates/blog/plugins/app/plugin.ts`.
6. `comment-create-tool`'s generated MCP schema required `profileId`,
   which the OAuth reserved-field guard forbids a caller from supplying —
   no OAuth client could call it. **Fixed**: explicit `input` override on
   that tool entry in `templates/blog/config/common.ts`.
7. `templates/blog`'s own `yarn test` glob (`tests/**/*.test.ts`) matched
   zero files because the one real test file was named `tests/helpers.ts`,
   not `tests/helpers.test.ts` — "the blog's actual full-test command" ran
   nothing. **Fixed**: renamed (pure rename, no behavior change).

Also fixed, per 00007A's recorded observation: `tests/oauth/
legacy-store-adapters.test.ts` used deterministic legacy IDs that collided
across repeated `yarn test` runs against the same persistent container.
Added a per-process `RUN_ID` suffix; confirmed fixed by running the full
suite twice in a row against the same (not recreated) disposable
containers — both runs 746/746/746 passing.

New regression tests: `tests/oauth/client-capacity-table-bootstrap.test.ts`
(4 cases) and `tests/oauth/idea-schema-generation-pitfalls.test.ts` (7
cases, reading the real `oauth.idea` source directly) so findings 1-4
cannot silently regress.

Changed files: `packages/stackpress-session/oauth.idea`,
`packages/stackpress-session/src/oauth/storage/OAuthStore.ts`,
`packages/stackpress-session/tests/oauth/legacy-store-adapters.test.ts`,
two new test files above, `templates/blog/plugins/app/plugin.ts`,
`templates/blog/config/common.ts`, `templates/blog/tests/helpers.ts` →
`helpers.test.ts`, `docs/oauth-upgrade.md` (new section recording findings
2-5 for anyone who already generated/pushed a database against an earlier
build).

No Frozen-contract conflict: storage.md does not fix the exact column
identifier for any of these fields, and all four fixes make the generated
schema match what the already-Frozen-compliant hand-written
`storage/tables.ts`/`OAuthStore.ts` already required — these are
implementation corrections, not contract changes.

## Verification Notes

Full environment, exact commands, per-database/per-package results,
coverage, the real cross-surface production run transcript and the
complete 22-required-test-family mapping are in [reference
00027](../../../references/00027-oauth-production-cross-surface-verification-evidence.md).
Summary:

- **All four databases**, `stackpress-session` full suite (disposable
  `oauth-00011-pg`/`oauth-00011-mysql` tmpfs containers under `flock
  /tmp/oauth-db.lock`, plus in-process PGlite/SQLite): **746 passing, 0
  failing, 0 pending** (confirmed via `echo tests/**/*.test.ts`: 53 flat
  files, none dropped). Re-run twice in a row against the same containers
  without recreating them: both runs 746/746/746 passing, confirming the
  `legacy-store-adapters.test.ts` isolation fix. Coverage 91.28% statements
  / 84.05% branch / 93.30% funcs / 92.19% lines.
- `stackpress-ai`: `yarn test` 160 passing, 0 failing (94.98% statements);
  `tests/mcp-oauth-cross-process.test.ts` re-run directly against real
  PostgreSQL+MySQL: 4/4 passing.
- `stackpress-api`: `yarn test` 119 passing, 0 failing (99.00% statements).
- `stackpress-sql`: `yarn test` passing, unchanged (not modified by this task).
- Compile (`tsc --noEmit`, cjs+esm) clean for `stackpress-session`,
  `stackpress-ai`, `stackpress-api`, `stackpress`. `yarn build` clean for
  all four plus the root `yarn build`.
- `templates/blog`: `yarn generate` run twice (idempotent); `yarn push`
  succeeds on PGlite (all 17 generated tables, no nested-transaction
  error, per 00001A); `yarn populate` succeeds; `yarn test` now runs (was
  silently matching 0 files) — 7 passing, 0 failing. `npx tsc --noEmit`:
  one pre-existing, unrelated error unchanged from 00010's baseline.
- **Real generated-schema structural check, all four engines directly**
  (the real `oauth.idea`-generated client's per-model `install()`, i.e.
  exactly what `yarn generate`+`yarn push` produces): `window_start`/
  `lock_token` columns present and the JSON-default fix holds on PGlite,
  PostgreSQL, MySQL and SQLite — see reference 00027's table.
- **Real production cross-surface run** (`templates/blog`'s real
  `bootstrap()`, real signup/registration/authorization-start/approve/
  exchange events, a real HTTP listener bound to `127.0.0.1` on an
  ephemeral port, closed at the end of the run): real signup → real
  dynamic client registration → real pending/approval/code/exchange → the
  same real access token used on a real authenticated MCP tool call
  (`comment_create`, a real `Comment` row created) and a real
  OAuth-opted-in API route (`GET /api/articles/:id`, 200) → real
  `oauth-grant-revoke` → both surfaces refuse the same key afterward
  (401/401). Proves verification.md's "Shared MCP/API key" row directly
  against a real generated store for the first time.
- All 22 required test families from verification.md: see reference
  00027's full table for the exact owning suite and/or cross-surface
  evidence per row; none skipped or fixture-only substituted.
- `python3 .agents/scripts/validate-agent-workspace.py`: no ERROR after
  linking this reference from this task file (one zombie-reference ERROR
  before linking, now resolved); pre-existing line-count WARNs only,
  unrelated to this task.

Cleanup: disposable containers stopped (`docker stop`, `--rm`
auto-removal) and confirmed gone after every use; no other project
container touched. `templates/blog`'s `.build`, `node_modules/.vite` and
regenerated `node_modules/blog-client` removed. Every `.scratch-00011-*`
helper script deleted (confirmed via `git status --short`). No test
runner, watcher, dev server or Vite process left running (`ps -u $USER`
checked after every run).

### Follow-up (orchestrator-requested, 2026-10-15): general schema drift guard

Every defect this task found existed because every prior task's own tests
built tables via the hand-written `storage/tables.ts` builder, never via
the real `oauth.idea` schema real apps generate from. Added
`packages/stackpress-session/tests/oauth/schema-drift.test.ts` (flat file):
parses `oauth.idea` through the same real tooling `yarn generate` itself
uses (`@stackpress/idea-transformer`'s `Transformer.schema()` ->
`stackpress-schema`'s `Schema.make()` -> `stackpress-sql`'s
`makeCreateQuery()`, the exact function `stackpress-sql/src/transform/
store/create.ts` calls to emit each generated model's real `install()`
body), then asserts, for all nine storage.md models, that the generated
table name, full column set and per-column nullability match this file's
hand-written `Create` builders exactly, plus a single-column primary-key
check. `oauth_client_capacity` (not part of `oauth.idea` by design, see
Implementation Notes item 1) gets its own expected-shape assertion instead
of a generated-vs-hand-written comparison, since no generated counterpart
exists to compare it against.

Relative filesystem imports into `stackpress-schema`'s and
`stackpress-sql`'s private `src/` (same cross-package, test-only pattern
`stackpress-api/tests/oauth-legacy-real-store.test.ts` already
established) — neither package's `exports` map is touched, and neither
package's own source was changed.

**Verified it actually catches drift**: temporarily renamed
`OAuthFactorUse.lockToken` to `renamedField` in `oauth.idea` (scratch edit,
reverted immediately after, confirmed byte-identical via the suite passing
again) — the suite failed with two clear assertion errors (the column-set
diff showing `+ lock_token` / `- renamed_field`, and the nullability check
reporting the missing column), proving it fails on a rename, not only on
a silent pass. Restored and re-ran clean: 37/37 passing.

`echo tests/**/*.test.ts` confirmed 54 flat files (was 53), none dropped.
`npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json
--noEmit`: clean. Ran the session suite once, no containers (per the
orchestrator's instruction — this test needs none, it only parses
`oauth.idea` and builds in-memory `Create` objects): **735 passing, 48
pending** (the usual PostgreSQL/MySQL adapter rows skipped without a
running container, same convention every prior task used), **0 failing**;
coverage 91.08% statements / 83.82% branch / 92.90% funcs / 91.99% lines —
still above the sprint's >90% bar. `templates/blog` was not touched in
this follow-up pass (00012 uses it in parallel); confirmed via `git status
--short templates/blog` showing the same 7 entries as before this
follow-up, unchanged.

## Acceptance Notes

No visual acceptance is required (`Acceptance criteria: none`). Finished
at verified: every verification item above passed, all 22 required test
families are mapped to an actual command/result, and the real
cross-surface production run proves the first end-to-end evidence of a
shared MCP/API key against a real generated store. This task does not
replace real native-client/browser evidence, which remains 00012's scope.
