# 00010 — Package the feature and document a complete blog example

Status: verified (2026-10-15). Setup/upgrade docs and a working templates/blog
example are in place; a real browser walkthrough with screenshots could not be
captured this session (environment limitation, recorded below) and acceptance
has not been delegated — see Acceptance Notes.
Owner: session/AI/API package manifests and README files, aggregate type forwarding, templates/blog.
Stage: 5.
Depends on: [00007](00007-approval-factor-and-connections-pages.md), [00008](00008-api-shared-access-and-legacy-upgrade.md), [00009](00009-mcp-http-sse-and-current-identity.md)
Journeys: J01, J02; setup supporting J03–J14.
Contracts: [configuration](../configuration.md), [design](../design.md), [verification](../verification.md), [journeys](../journeys.md).

## Task Summary

Make the accepted feature usable from a clean consuming app, with clear setup, migration and recovery instructions.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Finish selected root/type/facade exports, CJS/ESM/declarations, explicit OAuth view subpaths and packaged oauth.idea/schema loading. Keep private classes/scripts/models private and AI opt-in.
2. Add the blog example using native library code and generated models, exact resource/API memberships, required policy listeners and explicit serving oauth-finalize after config/listen/route.
3. Demonstrate ordinary and stronger-check accounts, public/protected tools and approved API reads/writes. Keep example scopes/roles illustrative and no Resourcing-specific imports or logic.
4. Document clean/repeated generation, isolated migration, all defaults/limits, attached/standalone and older SSE settings, proxy/browser rules, client introduction and permitted customization.
5. Document legacy migration dry-run, which keys stop working without bindings, shared disconnect/expiry, explicit native permission recovery, new-grant reconnect and uncertain-write/lost-token-response recovery.
6. Prepare package/upgrade notes without publishing or changing outside databases. Follow the repository public-surface workflow and coordinated dependency/version rules; do not infer a release number.

## Verification Process

- Build CJS/ESM/types under Node 22/Yarn; pack locally and test imports from a clean consumer, including schema and view paths plus aggregate forwarding.
- Generate blog models twice and run its actual available full-test workflow on an isolated database. Record discovered commands; missing suites are not passes.
- Run documented setup and migration steps against the packaged candidate. Check settings match exact frozen names, finalization is serving-only and no private schema becomes exposed.
- Render/read the README/setup/upgrade instructions and verify the runnable example matches them. Real native clients and production journeys follow tasks 00011/00012.

## Acceptance Criteria

Review the rendered setup and upgrade documentation with the working blog example. A maintainer must be able to identify required settings, schema steps, policy events, the old-key migration, explicit reapproval steps and the remaining release limits without reading this conversation.

## Implementation Notes

Built 2026-10-15 in this worktree (uncommitted), against 00007/00008/00009's
already-verified work and Inquire d5f5a07 (unpublished, root `resolutions`
block, unchanged). Docs are at `docs/oauth.md` (setup) and
`docs/oauth-upgrade.md` (migration/recovery/release limits), linked from
`docs/README.md` and `docs/session.md`.

**Step 1 (exports).** Confirmed already satisfied by 00002/00007/00009 (no
new export surface needed): `stackpress-session/package.json` already has
`./oauth/views/*`, `./oauth/metadata` CJS/ESM/typesVersions entries and
`oauth.idea` in `files`; `packages/stackpress/src/session/{types,index}.ts`
already forward every selected OAuth type through `stackpress/session/types`
and `stackpress/session`. Rebuilt `stackpress-session`, `stackpress-api`,
`stackpress-ai` and `stackpress` (all were stale from before this spec's
work - `packages/stackpress/cjs/types.d.ts` had zero OAuth exports before the
rebuild); `npm pack --dry-run` on `stackpress-session` confirms both
`oauth.idea` and `schema.idea` are packaged.

**Step 2-3 (blog example).** Edited `templates/blog/schema.idea` (adds `use
"stackpress-session/oauth.idea"`; confirmed Profile/Auth dedupe - `yarn
generate` run twice back to back, no diff), `templates/blog/config/common.ts`
(`session.oauth` with 3 scopes `articles.read`/`articles.write`/
`comments.write` matching the existing `mcp.tools` scope vocabulary exactly
so an approved grant satisfies both surfaces identically - J09; `mcp.oauth`;
a new OAuth-opted-in `GET /api/articles/:id` endpoint; two new GUEST
`session.access` entries for the two non-native browser pages signed-out
visitors must still reach, per 00007's handoff note), new
`templates/blog/plugins/app/oauth.ts` (the two required policy listeners -
demonstrates "ordinary" vs "stronger-check" accounts via role-based scope
narrowing: ADMIN/MANAGER may approve `articles.write`/`comments.write`, an
ordinary USER may only approve `articles.read`), wired into
`templates/blog/plugins/app/plugin.ts`. `templates/blog/config/develop.ts`/
`production.ts` call `server.resolve('oauth-finalize')` and throw on a
non-200 result; `develop.ts`'s bootstrap is shared by every `stackpress`
command pointed at it (`generate`/`migrate`/`populate`/`push`/`query`/
`purge`/`emit`/`develop`), so it's guarded to `process.argv[2] in
['develop','serve']` only - confirmed `yarn generate`/`migrate`/`populate`
all still pass with the guard in place. No Resourcing-specific imports/logic.

**Real defect found and fixed**: `packages/stackpress-session/src/oauth/
events/finalize.ts` never called `res.results(...)`/`res.setError(...)`, so
`server.resolve('oauth-finalize')` - the exact mechanism configuration.md
documents ("the serving app bootstraps explicitly resolve that event and
fail on a non-200 result") - always returned the untouched default
`{code:0,...}` on success and a plain uncaught throw on failure, never a
checkable `{code:200}`/`{code:503,...}`. This was never caught earlier
because every existing test calls `oauth.finalize()` directly on the plugin
instance (`ctx.plugin('oauth').finalize()`, as `tests/oauth/browser-app.ts`
does), not through `resolve('oauth-finalize')`. Root-caused by instrumenting
the real event-emitter path end to end (confirmed the listener registers
correctly; `queue.run()` genuinely executes the handler; the handler itself
just never touched `res`). Fixed: `finalize.ts` now calls
`res.results({finalized:true})` on success and
`res.setError(Exception.upgrade(e).toResponse())` on failure (preserving
`OAuthService.finalize()`'s own `503` + per-reason `errors` list), matching
every other fixed event's `res.results`/`res.setError` pattern. Updated
`tests/oauth/finalize.test.ts` to assert on `res` instead of only the thrown/
not-thrown shape. `yarn test` in `stackpress-session`: 687 passing, 0
failing, 91.04%/91.95% stmt/line coverage (was 91.0%/735 tests per 00007A;
test count differs because 00007A's count includes PG/MySQL container runs
not repeated here, not because anything was removed). No other package's
source changed.

**New finding, recorded as a release limit (`docs/oauth-upgrade.md`), not
fixed**: `yarn push` (via `stackpress-sql/src/scripts/install.ts`'s outer
`database.transaction()` wrapping each generated model's own
`Create`-builder transaction) throws `"Nested transactions are not
supported."` against PGlite with the d5f5a07 Inquire build, on **any**
schema - reproduced on the unmodified pre-oauth blog schema too, so not an
oauth.idea-specific regression. Worked around for this task's own
verification by calling the generated `scripts.install(engine)` directly
(bypassing `stackpress-sql`'s transaction wrap) in a throwaway script, never
committed. Out of this task's package scope to fix (`stackpress-sql`/
Inquire, not `stackpress-session`/templates/blog); documented so 00011 does
not assume `yarn push` works against PGlite until this is addressed upstream.

**2026-10-15 follow-up (orchestrator review of 00012):** this step's
"approved ordinary API reads/writes" requirement had only ever been
demonstrated with a single `GET /api/articles/:id` route - no write route
existed to approve or refuse. Added a `PATCH /api/articles/:id` counterpart
(`config/common.ts`, event `article-update`, `oauth.operation:
'articles.update'`, `scopes: ['articles.write']`), documented in
`docs/oauth.md`'s API opt-in example. No other example behavior changed.

## Verification Notes

Node 22 (`nvm use 22`), Yarn, this worktree, 2026-10-15. Inquire d5f5a07
(unpublished local build) throughout; root `resolutions` block unchanged.

- `yarn build` in `stackpress-session`, `stackpress-api`, `stackpress-ai`,
  `stackpress`: all pass, CJS+ESM+declarations emitted.
- `npx tsc --noEmit -p templates/blog/tsconfig.json`: zero errors from any
  file this task touched. One pre-existing, unrelated error remains
  (`plugins/app/plugin.ts`'s `contributeDesktopMenu` HttpServer/Server
  generic mismatch - present before this task's changes, confirmed via
  `git diff`, not touched).
- `stackpress-session`: `yarn test` - 687 passing, 0 failing, 48 pending
  (PostgreSQL/MySQL adapter cases that `this.skip()` without a container,
  same convention every prior task used; not re-run here since no adapter-
  facing code changed - 00011 covers all four databases). Coverage
  91.04%/83.79%/92.89%/91.95% (stmt/branch/func/line), above the 90% bar.
- `templates/blog`: `yarn generate` run twice in a row (idempotent, Profile/
  Auth dedupe confirmed by identical `node_modules/blog-client/{Profile,
  Auth}` output and no diff on the second run); `yarn migrate` logs 18
  `CREATE TABLE` statements including all nine `oauth_*` tables with no
  foreign keys between them (matches 00003's storage design); generated
  `node_modules/blog-client/admin.js` registers `OAuthClient`/`OAuthGrant`/
  etc. admin routes, but `templates/blog/config/common.ts`'s `admin.menu`
  was not changed, so none of them appear in the default menu (A-001); no
  `FullKeyHash`/`ReadIdHash`/other hash-named identifier appears in any
  generated OAuth admin view/page file (`grep` across
  `node_modules/blog-client/OAuthGrant/admin/{views,pages}`); `yarn push`
  fails with the pre-existing nested-transaction issue above - worked
  around with a throwaway direct-`scripts.install()` script (not committed)
  to provision the PGlite database for the checks below; `yarn populate`
  succeeds against that database.
- With the database provisioned and `yarn dev:start` running (`PORT`/`HOST`
  env overrides added to `common.ts` for this): `GET /` returns 200 HTML;
  `GET /.well-known/oauth-authorization-server` returns the full RFC 8414
  document with the correct issuer/authorize/token/register/revoke URLs,
  `S256`, `none` auth method, and the three configured scopes;
  `GET /.well-known/oauth-protected-resource` returns 200. No
  `OAuth failed to start` error on boot (confirms `oauth-finalize` now
  reports 200 with both policy listeners registered, matching the finalize
  fix above). Server and all child processes stopped; `.build`,
  `node_modules/.vite` and the regenerated `node_modules/blog-client`
  removed afterward (regenerable, disposable per AGENTS.md).
- **Not captured**: real browser screenshots of the signin → `/authorize`
  approve → `/connections` flow. Attempted via the public-dev-server skill
  (reserved+activated port 3004, confirmed `curl` 200/discovery-correct
  through the proxy with `allowedHosts`/`middlewareMode` merged into Vite's
  dev config); the Paseo browser-automation host then either disconnected
  or left the tab permanently unpainted across repeated attempts, most
  likely Vite dev-mode's HMR WebSocket not completing a handshake through
  the reverse proxy - a dev-server/infra interaction, not an OAuth defect
  (the same URL serves correct HTML/JSON to `curl` throughout). Not
  fabricated. Task 00007's own task file already has 25 real screenshots of
  every page/state in this exact flow, reviewed and left pending user
  acceptance; this task's own component-level UI is unchanged from that
  work. Recommend: either accept 00007's screenshots as the already-covered
  visual evidence for the pages themselves, or retry this task's own
  screenshot capture with the production build (`yarn build && yarn serve`,
  no Vite dev/HMR involved) in a follow-up session.

## Acceptance Notes

Not reviewed. Present `docs/oauth.md`, `docs/oauth-upgrade.md` and the
working `templates/blog` example (setup/generate/migrate/populate/dev:start,
per the docs) for explicit user acceptance; acceptance has not been
delegated. The browser-screenshot gap above should be disclosed to the user
before any acceptance decision.
