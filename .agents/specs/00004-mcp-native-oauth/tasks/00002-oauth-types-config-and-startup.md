# 00002 — Add shared OAuth types, settings and startup checks

Status: verified.
Owner: stackpress-session; shared type declarations in stackpress-ai and stackpress-api.
Stage: 1.
Depends on: None. This task can be prepared independently.
Journeys: J01, J02.
Contracts: [configuration](../configuration.md), [events](../events.md), [design](../design.md).

## Task Summary

Establish the accepted public contracts and optional service lifecycle without exposing an unfinished OAuth service.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Record current package tests, coverage and public imports. Add focused session/oauth types for settings, identity, policies, operations, event inputs/results and OAuthService; preserve nearby TypeScript/import conventions.
2. Add optional session.oauth, mcp.oauth, mcp.sse.oauth and per-endpoint API settings exactly as specified. Keep API type session and MCP type user; reject app/public API opt-in, oauth:true and ALL methods.
3. Validate every default, duration, limit, URL, scope, duplicate and fixed-data rule in configuration.md. Use exact configured issuer/resources, never incoming Host or untrusted forwarded headers.
4. Register the optional service during config, fixed events during listen, and trusted operation/tool definitions during route. Expose oauth-finalize and idempotent finalize after all registration completes; resolve policy listeners then, not by import order.
5. Freeze the registry after finalization. Refuse requests with 503 until finalization succeeds. Check schema/database capability, route collisions and required listeners; keep generation-only bootstrap usable before schema generation.
6. Add the selected public type exports and direct AI-to-session dependency; keep raw stores/scripts private and AI out of the default aggregate plugin. Runtime handlers arrive in later tasks; do not register permissive stubs.

## Verification Process

- Test invalid settings, exact numeric defaults, missing/false settings, unsupported caller types, non-JSON fixed data and route/resource conflicts.
- Test delayed listener registration, repeated finalization, mutation after finalization, absent schema and required dependencies; unfinished runtime capabilities must fail closed.
- Compile changed packages in both module formats with declarations and verify selected type imports. Keep existing exports and OAuth-off boot behavior working.
- Use test-only substitutes for unfinished stores/policies; label them as such and ensure the runtime does not select them. Production integration is completed in tasks 00006/00008/00009/00010.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

Baseline (recorded before editing): `stackpress-session` and `stackpress-api`
had no `tests/` directory at all at HEAD (a71d683) — no suite, 0 tests, no
coverage baseline to preserve. `stackpress-ai` had an existing suite: 32
passing, 67.04% statement coverage (measured in an isolated detached
worktree at HEAD, see Verification Notes).

New files (session, owner of this task):
- `packages/stackpress-session/src/oauth/types.ts` — settings
  (`OAuthSessionConfig`/`NormalizedOAuthSessionConfig` and every nested
  settings type), `McpOAuthConfig`, `ApiOAuthEndpointConfig`, `OAuthIdentity`,
  approval/access policy input/result types, all fixed-event input/result
  DTOs from events.md, `OAuthApiOperationDescriptor`,
  `OAuthMcpResourceDescriptor`, and the `OAuthService`/`OAuthPlugin`
  interface.
- `packages/stackpress-session/src/oauth/config.ts` — `normalizeOAuthConfig`:
  validates and defaults every field in configuration.md (issuer HTTPS/no
  credentials-query-fragment with a loopback-only `development` exception,
  `base` distinct from the existing `/auth/oauth`, resource/scope
  cross-references and duplicates, policy, clients.allowed incl. empty-deny,
  registration/clientMetadata/limits numeric bounds, codeSeconds 1-600,
  pendingSeconds 1-1800, browserOrigins as bare origins). Throws
  `StackpressSessionException` (code 500) on any invalid value.
- `packages/stackpress-session/src/oauth/OAuthService.ts` — the registry +
  idempotent `finalize()`. `registerApiOperation`/`registerMcpResource`
  reject unknown resources, duplicate IDs, `method: 'ALL'`, non-JSON fixed
  data (`assertJsonSafe`), and same-route mcp/sse collisions; both refuse
  once `finalized` is true (registry freeze). `canonicalize()` produces the
  stable fingerprint (sorted keys, preserved array order) used for the API
  operation fingerprint. `finalize()` resolves `ctx.listeners` only when
  called (not at plugin-registration time) so it does not depend on import
  order; it fails closed (503, listing every missing reason) when the
  app-supplied `policy.approval`/`policy.access` listeners, the `database`
  plugin, or any of the 9 fixed OAuth runtime event listeners are absent.
  Concurrent finalize() calls collapse into one run; a failed attempt can be
  retried once the app registers what was missing.
- `packages/stackpress-session/src/oauth/events/finalize.ts` — the
  `oauth-finalize` handler a bootstrap resolves explicitly.
- `packages/stackpress-session/src/oauth/plugin.ts` — wires the above:
  `config` validates + `ctx.register('oauth', ...)`; `listen` registers only
  `oauth-finalize` (no other fixed events — no runtime handlers exist yet,
  per instruction not to register permissive stubs). No-ops entirely when
  `session.oauth` is absent/false, preserving OAuth-off boot behavior.

Edited files:
- `packages/stackpress-session/src/plugin.ts`, `src/types.ts` — wire the
  oauth plugin into the package root plugin; re-export oauth types through
  the existing `export type * from './types.js'` barrel (flows to
  `src/index.ts` automatically).
- `packages/stackpress/src/session/types.ts`, `src/session/index.ts` — the
  configuration.md-required forwarding of the selected oauth types through
  the existing `stackpress/session/types` and `stackpress/session` barrels.
- `packages/stackpress-ai/package.json` — added a direct `stackpress-session`
  dependency (design.md: "AI declares a direct session dependency for these
  types"). `stackpress-ai` was **not** added to the aggregate plugin
  (`packages/stackpress/src/plugin.ts` untouched) — it still is not part of
  the default aggregate.
- `packages/stackpress-ai/src/types.ts` — `McpConfig.oauth`/`sse.oauth:
  McpOAuthConfig`; `AuthContext` gained the `{ kind: 'oauth', identity:
  OAuthIdentity }` variant (identity plumbing only; no verification logic —
  that is task 00009).
- `packages/stackpress-ai/src/plugin.ts` — new exported
  `registerOAuthResources(ctx)`, called from a new `ctx.on('route', ...)`
  hook (design.md: "AI registers resources/tool definitions" during route).
  Registers the configured `mcp.oauth`/`mcp.sse.oauth` resource with
  `ctx.plugin('oauth')`, throwing if `mcp.oauth` is set without
  `session.oauth` configured. Route-collision/unknown-resource checks live
  in `OAuthService.registerMcpResource`, so both surfaces enforce one rule.
- `packages/stackpress-api/src/types.ts` — `ApiEndpoint.oauth?:
  ApiOAuthEndpointConfig | boolean` (the `| boolean` exists only so a
  misconfigured literal `true` type-checks far enough to be rejected with a
  clear error instead of a TS error).
- `packages/stackpress-api/src/plugin.ts` — new exported
  `registerOAuthOperation(endpoint, ctx, oauthIds)`, called per endpoint
  inside the existing `route` handler. Rejects `oauth: true`, non-`session`
  endpoint types, `method: 'ALL'`, missing `oauth.operation`, empty
  `oauth.resources`, and duplicate operation IDs across the endpoint list
  (`oauthIds` is a per-route-registration `Set` local to that `route` call);
  registers the trusted `{ id, surface: 'api', method, route, event,
  resources, scopes, data }` descriptor with `ctx.plugin('oauth')`.

No storage/runtime handlers were added anywhere (task scope excludes them;
`OAuthService.finalize()` intentionally fails until tasks 00003+ register the
9 fixed protocol events, matching "unfinished runtime capabilities must fail
closed").

## Verification Notes

Environment: Node v22.23.2, Yarn 1.22.22, run from this worktree
(`/home/solution-team/.paseo/worktrees/0m6vr1k2/icky-snail`).

Compile (both module formats, `--noEmit`), for every changed package plus the
aggregate `stackpress` package that forwards the new types — all clean, no
errors:
```
(cd packages/stackpress-session && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
(cd packages/stackpress-ai      && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
(cd packages/stackpress-api     && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
(cd packages/stackpress         && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
```
Full `yarn build` (tsc + cjs/esm package.json stamping) passed for
`stackpress-session`, `stackpress-ai`, `stackpress-api`.

Tests (`yarn test` = `nyc ts-mocha`), current worktree, after the build above:
- `stackpress-session`: **79 passing**, 0 failing. Coverage over the files
  the suite touches (`src/oauth/**`, plus `src/Exception.ts` transitively):
  97.48% statements / 97.52% branch / 100% funcs / 98.69% lines. No suite
  existed before this task, so there is no "after vs before" delta for this
  package — this is the whole coverage baseline for `stackpress-session`.
- `stackpress-ai`: **39 passing** (32 pre-existing + 7 new: 6 in a new
  `tests/oauth.test.ts` for `registerOAuthResources`, 1 added to
  `tests/plugin.test.ts` for the new `route` hook), 0 failing. Package-wide
  coverage 67.78% statements (before: 67.04%, measured in an isolated
  `git worktree add --detach /tmp/sp-baseline HEAD` build of the untouched
  `packages/stackpress-ai`, then `git worktree remove --force
  /tmp/sp-baseline`, no shared stash used). The delta is essentially flat:
  the new oauth code paths are fully covered by the new tests; the
  package-wide number stays dominated by pre-existing, unrelated untested
  transport scripts (`src/scripts/http.ts`, `src/scripts/sse.ts`,
  `src/events/*`) that this task does not touch.
- `stackpress-api`: **10 passing** (all new; the package had no `tests/`
  directory before this task), 0 failing, targeting the new
  `registerOAuthOperation` export directly (every branch: no-op, `oauth:
  true`, wrong endpoint type incl. both `app` and `public`, `method: 'ALL'`,
  missing `operation`, duplicate ID, empty `resources`, missing oauth
  plugin, success, and a propagated registration error). Package-wide nyc
  coverage is 14.38% because nyc also instruments (but the tests do not
  exercise) the pre-existing `cors`/`session`/`app`/`open`/webhook route
  handlers and `helpers.ts`/pages/views, none of which this task changes.

Contract-specific checks exercised directly in the above suites: exact
numeric defaults (accessSeconds 900, renewalSeconds 604800, codeSeconds 60,
pendingSeconds 600, policy.timeoutMs 5000, registration/clientMetadata/limits
defaults) with their documented ranges; missing/false `session.oauth`
(plugin no-ops, OAuth-off boot untouched); unsupported caller types
(`app`/`public` API oauth opt-in, `oauth: true`, `method: 'ALL'` all
rejected); non-JSON fixed data (`assertJsonSafe` rejects functions, `NaN`,
nested `undefined`); route/resource conflicts (duplicate API operation ID,
duplicate/undeclared resource, same-route mcp/sse collision); delayed
listener registration (finalize resolves `ctx.listeners` only when called,
not at plugin-registration time — tested by registering the missing
listeners after a failed attempt and retrying); repeated finalization
(idempotent, and concurrent calls collapse into one run); mutation after
finalization (`registerApiOperation` throws once finalized); absent
schema/database and required dependencies (finalize fails closed on a
missing `database` plugin and on missing fixed OAuth runtime listeners,
listing every missing reason in the thrown exception's `errors`).

**Not run in this pass** (out of this task's scope, owned elsewhere per
sprint.md's task-ownership table): live database/schema checks across
PGlite/PostgreSQL/MySQL/SQLite (task 00003+), the blog example's full test
(task 00010), real MCP/native-client journeys (00011/00012). No storage or
runtime protocol handler exists yet, so `OAuthService.finalize()` cannot
succeed against a real app today — that is expected per this task's
contract ("unfinished runtime capabilities must fail closed"), not a defect.

## Blocker for orchestrator review

`stackpress-ai` (67.78%) and `stackpress-api` (14.38%) do not meet the
sprint-wide ">90% coverage for every changed package" rule at the
whole-package level; sprint.md is explicit that low *existing* coverage does
not remove the requirement. Both packages had this gap in pre-existing,
untouched code before this task (measured baselines above: ai was 67.04%
before touching it at all; api had zero tests before this task touched it).
The code this task actually added/changed
(`registerOAuthResources`/`registerOAuthOperation` and the full
`stackpress-session/src/oauth/**` module) is covered at ~97-100%. Closing the
package-wide gap would mean writing a full test suite for pre-existing,
unrelated `stackpress-api` route/page/view/helper code and `stackpress-ai`
transport scripts — substantial work outside "types, config, and startup
checks." Leaving `Status: started` rather than `verified` pending an explicit
call: either this task's exit bar is judged against the code it changed (in
which case it is ready to move to `verified`), or a follow-up task must
backfill full package coverage for `stackpress-ai`/`stackpress-api` before
00002 can close. `stackpress-session` (97.48%) meets the bar outright since
its whole package is this task's oauth module.

## Blocker Resolution

Resolved by the orchestrator on 2026-09-29. The package-wide coverage gap was
opened as the required side task
[00002A](00002A-ai-api-package-coverage.md), which is now verified. The
orchestrator re-ran the suites under Node 22 in this worktree:
`stackpress-session` 79 passing, 97.48% statements; `stackpress-ai` 90
passing, 95.71%; `stackpress-api` 78 passing, 98.97%. The aggregate
`stackpress` package change is only `export type` re-exports. It has no
runtime statements to measure and is checked by the cjs/esm `tsc --noEmit`
runs above. Note for later tasks: package `test` scripts use an unquoted
`tests/**/*.test.ts` glob. Bash expands it without globstar, so once a
package has both top-level and nested test files, some files can silently
drop from a run (see 00002A).

## Acceptance Notes

No visual acceptance is required. Finish at verified once the checks pass;
do not mark accepted merely because tests pass.
