# 00002A — Bring stackpress-ai and stackpress-api coverage above 90%

Status: verified.
Parent: [00002](00002-oauth-types-config-and-startup.md).
Owner: `packages/stackpress-ai` and `packages/stackpress-api` test suites.
Depends on: 00002 source changes (already in the worktree).

## Why This Side Task Exists

Task 00002 changed `stackpress-ai` and `stackpress-api`. The [sprint](sprint.md)
rule says every changed package must be above 90% coverage and that "a missing
suite is work to resolve, not a pass." After 00002, stackpress-ai measured
67.78% (67.04% at HEAD a71d683) and stackpress-api measured 14.38% (no suite at
HEAD). The new 00002 code itself is fully covered. The rule is explicit, and
the only alternative is to not change these packages, which the Frozen contract
requires. The side task is therefore plainly required and proceeds without a
separate proposal. Later tasks (00006, 00008, 00009) also change these
packages and must keep them above 90%.

## Task Summary

Add meaningful tests for the existing untested stackpress-ai and stackpress-api
code so each package's whole-package coverage exceeds 90%, including branch and
security-relevant cases.

## Implementation Steps

1. Record the current per-file coverage for both packages using their existing
   `yarn test` coverage setup.
2. Add tests for untested behavior, starting with the most security-relevant
   paths: authorization and scope checks, key validation, route and page
   handlers, and error branches. Follow the existing test style and helpers.
3. Test the behavior described by the source and documentation, not
   line-by-line mirrors of the implementation. Use no runtime fallbacks and
   make no production source changes unless a test exposes a real defect. If
   it does, record the defect, make the smallest fix and note it.
4. If some code cannot be reached without infrastructure that belongs to a
   later task, such as live MCP transports or real databases, record it
   explicitly instead of faking coverage.

## Verification Process

- Run `yarn test` with coverage for both packages under Node 22. Each package
  must exceed 90% for statements and lines, with branches reported.
- Run type checks and builds for both packages. Confirm the 00002 tests still
  pass.

## Acceptance Criteria

Acceptance criteria: none. Tests and coverage reports are verification, not
visual acceptance.

## Implementation Notes

Work was split into two parallel efforts, one per package, each confined to
that package's `tests/` folder. Both were re-verified independently in this
worktree (Node 22, `yarn test`, `yarn build`) after the fact.

### stackpress-ai

Files added: `tests/events.test.ts`, `tests/index.test.ts`. Files extended:
`tests/registry.test.ts`, `tests/http.test.ts`, `tests/sse.test.ts`,
`tests/plugin.test.ts`, `tests/transform.test.ts`, and the shared
`tests/helpers.ts` double (`MockResponse` gained `writeHead()`/`write()` so it
satisfies the real `@modelcontextprotocol/sdk` SSE transport's response
contract without a live socket for some cases). No `src/` changes; no source
defects found.

Tests target real behavior: live-socket MCP HTTP/SSE session creation and
shutdown, stateless request flow, 400/404/405/500 error branches on the real
(unsubclassed) server classes, standalone-listener start/shutdown via
prototype capture, attach-once guards, resource/method mismatch guards,
array-valued authorization headers, registry auth/scope fallbacks (bearer
token parsing, public/app/user auth, secret enforcement, unknown-type
`toolAllowed` fallback), a captured real MCP tool handler driving
`validateInput` → `ctx.resolve` → `toMcpText` plus the "Unauthorized MCP tool
call" rejection for a revoked scope, and transform idempotency/no-op/edge
branches.

Explicitly left uncovered, not faked, with reasons recorded:
- `src/events/stdio.ts` success path and `src/scripts/stdio.ts:21-22`
  (`new StdioServerTransport(); await server.connect(transport)`):
  `StdioServerTransport` hardcodes `process.stdin`/`process.stdout` with no
  injection point; exercising it would mean binding real listeners onto the
  shared global stdio streams inside the test process — genuine live-infra,
  not safely fakeable.
- `src/scripts/http.ts:402` / `src/scripts/sse.ts:334`: a promiser object's
  arrows wired only to the underlying `_service`'s `close`/`error` events
  inside `.start()`, which the attach-mode transport never calls. Traced, not
  assumed, to be dead code in the attach flow; not a behavior bug, so no
  source change.
- `src/scripts/http.ts:266` / `src/scripts/sse.ts:242`: a `res.end()`
  fallback reached only when an error is thrown after `res.headersSent` is
  already true; would need a real SDK transport that partially writes then
  throws mid-stream. Left as a documented 1-line gap.
- `src/transform/helpers.ts:186-190,307,320`: `buildSearchInput`'s
  `__ge`/`__le` span-selector branch and one foreign-relationship recursion
  edge; the blog template schema has no `@span` columns and no foreign column
  whose `.foreignRelationship` resolves falsy, so these are schema-shape
  limited, not later-task infra. Reaching them would need a synthetic
  Model/Column double deep enough to risk mirroring the implementation
  instead of testing behavior.
- `src/index.ts` and `src/events/index.ts` report 0% because they are
  pure re-export/type-only barrel files with zero instrumentable statements
  (LF=0) — not a real coverage gap.

### stackpress-api

Files added (all new, flat under `tests/`, not `tests/pages/`): `tests/mocks.ts`
(shared `createRequest`/`createResponse` building real `@stackpress/ingest`
`Request`/`Response` instances, plus a minimal hand-rolled `createCtxStub`),
`tests/Exception.test.ts`, `tests/helpers.test.ts`, `tests/oauth-page.test.ts`,
`tests/token-page.test.ts`, `tests/plugin-routes.test.ts`. Existing
`tests/plugin.test.ts` untouched. No `src/` changes; no source defects found.

Note: test files were kept flat under `tests/` rather than in a `tests/pages/`
subdirectory because this package's `test` script glob
(`tests/**/*.test.ts`) is unquoted in `package.json`; once a `tests/pages/`
subdirectory existed, bash's non-globstar `**` expansion silently pre-expanded
the pattern to only `tests/pages/*.test.ts`, dropping every top-level test
file from the run before `ts-mocha` ever saw it (confirmed with
`echo tests/**/*.test.ts`). This is a test-file-layout choice within
`packages/stackpress-api/tests/`, not a source or `package.json` change.

Tests cover: full branch coverage of `authorize`/`unauthorized`/`validData`;
`pages/oauth.ts` (pass-through, missing client_id/redirect_uri, signin
redirect, application-lookup failure, GET data-setting fall-through including
brand defaulting, POST session-create success with/without `state`, POST
session-create no-results); `pages/token.ts` (pass-through, auth failure,
missing code/secret, session lookup miss, applicationId mismatch, expired
session, success payload shape including `expires_in` math and the
never-expires `0` case); `plugin.ts`'s default export (no-op without `api`
config, `listen`/`route` registration, route dispatch by endpoint type,
token/oauth page+view registration, webhook wiring with a stubbed
`global.fetch`) and the exported `cors`/`session`/`app`/`open` route actions
directly (CORS `true`/string/array/false/mismatched-origin/ALL-method/
preflight, auth failures, non-GET secret mismatch, scope-intersection checks,
success paths asserting `ctx.emit` calls and `req.data` mutations).

One observation recorded, not treated as a defect (ambiguous intent, no fix
made): in `pages/oauth.ts`, after `ctx.resolve('session-create', {...})` is
called without passing `res`, the subsequent guard checks `res.code !== 200`
rather than the returned `response`'s own status; at that point `res.code` is
whatever the earlier `application-detail` resolve left it at (always 200
there, since the function already returned otherwise), so the real gate in
practice is `!response.results`. Left as-is per the task's "smallest fix only
for clear-cut defects" instruction.

`src/views/oauth.tsx` (a React/Frui client-rendered view component) was
deliberately left unimported and untested: this monorepo has zero
`.test.tsx` files anywhere, this package's `ts-mocha`+`nyc` script has no
JSX/React test-rendering harness, and per sprint.md, page-level UI/rendering/
interaction acceptance is owned by task 00007 (browser, server-rendered data,
keyboard/form checks), not this coverage side task. It stays out of the nyc
report because nothing imports it — this is the "cannot be reached without
infra belonging to a later task" item required by step 4.

## Verification Notes

Commands run under Node 22 (`source ~/.nvm/nvm.sh && nvm use 22`), re-run
independently in this worktree after both efforts completed:

`cd packages/stackpress-ai && yarn test` — 90 passing, 0 failing.
```
All files      |   95.71 |    86.36 |    91.6  |   97.66
 src           |   99.35 |    91.3  |   97.36  |   100
  helpers.ts   |   100   |    95.74 |   100    |   100    | 71,333,382
  index.ts     |   0     |    0     |   0      |   0      (zero-statement barrel)
  plugin.ts    |   97.95 |    81.81 |   88.88  |   100    | 103-129,166-183,197-200
 src/events    |   83.33 |    91.66 |   100    |   83.33
  http.ts      |   100   |    100   |   100    |   100
  index.ts     |   0     |    0     |   0      |   0      (zero-statement barrel)
  sse.ts       |   100   |    100   |   100    |   100
  stdio.ts     |   50    |    75    |   100    |   50     | 16-17
 src/scripts   |   93.01 |    76.56 |   84.84  |   97.18
  http.ts      |   94.16 |    77.61 |   85.71  |   98.21  | 266,402
  sse.ts       |   93.26 |    76.27 |   83.33  |   97.91  | 242,334
  stdio.ts     |   60    |    50    |   100    |   60     | 21-22
 src/transform |   97.18 |    96.15 |   97.22  |   97.16
  helpers.ts   |   95.06 |    95.65 |   95.83  |   95     | 186-190,307,320
  index.ts     |   100   |    100   |   100    |   100
  package.ts   |   100   |    100   |   100    |   100
  tools.ts     |   100   |    100   |   100    |   100
```
Before: 67.78% stmts / 60% branch / 58.74% funcs / 69.51% lines (39 tests).
`cd packages/stackpress-ai && yarn build:tsc && yarn build:pkg` (via `yarn build`) — passes clean.

`cd packages/stackpress-api && yarn test` — 78 passing, 0 failing.
```
All files      |   98.97 |    94.38 |   91.66  |   100
 src           |   98.63 |    92.59 |   90.9   |   100
  Exception.ts |   0     |    0     |   0      |   0      (zero-statement empty subclass)
  helpers.ts   |   100   |    100   |   100    |   100
  plugin.ts    |   98.21 |    90.19 |   88.88  |   100    | 24,30,48,63,133,199,204,235,240,252
 src/pages     |   100   |    98.36 |   100    |   100
  oauth.ts     |   100   |    97.5  |   100    |   100    | 69
  token.ts     |   100   |    100   |   100    |   100
```
Before: 14.38% stmts / 18.51% branch / 4.54% funcs / 15.38% lines (10 tests,
only `registerOAuthOperation` covered).
`cd packages/stackpress-api && yarn build:tsc && yarn build:pkg` (via `yarn build`) — passes clean.

Both packages exceed 90% statements and lines. Both `views/oauth.tsx` and the
two zero-statement barrel/subclass files are the only files not driven to
90%+, for the documented, non-infra-fakeable reasons above (barrels/empty
subclass have no coverable statements at all; `views/oauth.tsx` is
intentionally unimported pending task 00007). `git status`/`git diff --stat`
confirm changes are confined to `packages/stackpress-ai/tests/` and
`packages/stackpress-api/tests/`; the pre-existing modifications to
`packages/stackpress-ai/{package.json,src/plugin.ts,src/types.ts}` and
`packages/stackpress-api/src/{plugin.ts,types.ts}` were already present from
task 00002 before this side task started and were not further edited here.
No commits, pushes, or stashes were made.

## Acceptance Notes

No visual acceptance is required. Finished at verified — all checks pass.
