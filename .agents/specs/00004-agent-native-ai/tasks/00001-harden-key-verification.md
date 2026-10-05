# Task 00001: Harden Key Verification

## Task Summary

Make `stackpress-ai` refuse bad keys instead of treating them as public callers,
as accepted in DEC-003. This is a breaking change and ships with a migration
note. Journey: J-011.

## Implementation Steps

1. Record a baseline: with Node 22, run `yarn install` at the root and
   `yarn test` in `packages/stackpress-ai`; note the result and coverage.
2. `src/types.ts`: add an `invalid` kind to `AuthContext`.
3. `src/helpers.ts`:
   - `resolveListAuth`: no key stays `public`; a presented key that is unknown,
     inactive, expired, or whose secret does not match resolves to `invalid`.
   - add a liveness check: `active` is not false and `expires` is absent or in
     the future.
   - `hasRequiredScopes`: require every listed scope, not any.
   - `secretAllowed`: require the secret on every method, reads included.
     Keep `requiresSecret` exported and make it true for all methods.
   - `toolAllowed`: an `invalid` caller is never allowed.
4. `src/scripts/http.ts`:
   - refuse an `invalid` caller with 401 and `WWW-Authenticate: Bearer` in both
     stateful and stateless modes.
   - stateful mode: resolve the key again on every request; when it is no
     longer valid, close that session's transport and answer 401.
   - for a `tools/call` naming a tool the caller lacks a scope for, answer a
     real 403 before the transport runs. Check against the full registry,
     because the per-caller registry no longer contains that tool.
5. `src/scripts/sse.ts`: apply the same refusals on connect and on each message
   post, and close the session when its key dies.
6. `src/scripts/stdio.ts`: leave unfiltered for local operators and say so in a
   comment.
7. Tests in `tests/registry.test.ts`, `tests/http.test.ts`, `tests/sse.test.ts`,
   and `tests/stdio.test.ts`: update the cases that assert the old rules and add
   one case per refusal on each network transport.
8. `README.md`: rewrite the Authorization and Live Transport Auth sections and
   add a migration note listing each changed behavior.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with coverage above 90%.
- `yarn build` in the package emits CJS and ESM without errors.
- `git diff --check`.

## Acceptance Criteria

A readable transcript of requests against `templates/blog` showing a valid key
listing and calling a tool, an unknown key refused with 401, an expired key
refused with 401, and a key missing a scope refused with 403.

## Implementation Notes

All eight steps are done. Everything is in `packages/stackpress-ai`.

- `src/types.ts`: `AuthContext` gains `{ kind: 'invalid' }`; new `ToolRegistry`
  type, a loader for the full registry before per-caller filtering.
- `src/helpers.ts`:
  - `resolveListAuth` keeps no key as `public` and returns `invalid` for a
    presented key that is unknown, inactive, expired, or has a missing or wrong
    secret. A found but dead application does not fall through to the session
    lookup.
  - New `isLive`: `active` is not `false` and `expires` is absent or in the
    future. An unreadable `expires` fails closed. It accepts a `Date`, an ISO
    string, or a number, since records may come back from SQL in any of them.
  - `hasRequiredScopes` now needs every listed scope. `secretAllowed` always
    needs the secret. `requiresSecret` stays exported and returns `true`; it has
    no internal caller now and is kept for the public `helpers` subpath.
  - `toolAllowed` returns false for `invalid`, public tools included.
  - New helpers: `sameCaller`, `findForbiddenCall`, `loadRegistry`,
    `sendUnauthorized`, `sendForbidden`.
- `src/scripts/http.ts`:
  - `invalid` is answered 401 with `WWW-Authenticate: Bearer` in both modes. In
    stateful mode the key is resolved on every request. When it is invalid the
    session's transport is closed and the request is answered 401.
  - Added beyond the task text: a request inside a session must present the same
    key the session was opened with (`sameCaller`), otherwise 401 and the session
    stays open. Without this, a request with no `Authorization` header resolves
    to `public`, which is not `invalid`, and would have reused a privileged
    session.
  - A `tools/call` for a registered tool the caller lacks is answered 403 before
    the transport runs, checked against the full registry, in both modes. A name
    that is not registered still reaches the SDK. Batches are handled.
  - `McpHttpServer` takes an optional trailing `registry` loader, wired from
    `mcp.tools` config in `http()` and `attachHttpToServer()`.
- `src/scripts/sse.ts`: same 401 on connect and on every message post, the same
  session close when the key dies, the same `sameCaller` and 403 checks.
  `_handleSseConnection` now receives the resolved `auth` so the key is resolved
  once per connect.
- `src/scripts/stdio.ts`: unchanged behaviour, with a comment saying it is
  unfiltered on purpose for local operators.
- Refusal bodies are JSON-RPC errors (401 code -32001, 403 code -32002) on both
  transports. A key that fails does not say which check failed.
- `README.md`: Authorization and Live Transport Auth rewritten, plus a Migration
  section listing each changed behavior.
- Tests: `registry`, `http`, `sse`, `plugin`, `transform` updated and extended, with fixtures
  that used `expires: new Date()` moved to future dates. Added `tests/live.test.ts`
  (real HTTP and SSE transports over sockets with the real MCP SDK client and
  server) and `tests/events.test.ts`. `stdio.test.ts` is unchanged: stdio has no
  new behavior, and starting the real transport would take over the test
  process's stdin and stdout.

Known and left alone:

- A verified key that sees no tools at all still gets a 500 from the registry
  guard ("Resolved MCP tool registry is empty.") on connect. That behavior
  predates this task.
- The root `yarn build` runs `ai` before `api`, but `ai` imports `stackpress-api`
  types, so a clean root build fails at `ai`. Building `api` first works. Not
  touched.
- A session's tool handlers keep the scopes captured when it opened. Only key
  liveness and the 403 check use the fresh record on each request.

## Verification Notes

Run with Node 22.23.2 and Yarn 1.22.22 from nvm.

- Baseline (step 1, before any change): `yarn install` at the root, then a root
  build, then `yarn test` in `packages/stackpress-ai`: 32 passing, 0 failing.
  Coverage was already below the target: 67.04% statements, 58.8% branches,
  58.15% functions, 68.84% lines.
- Final `yarn test` in `packages/stackpress-ai`: 109 passing, 0 failing, stable
  across three consecutive runs. Coverage, all four above 90%: 96.14% statements,
  92.1% branches, 94.7% functions, 96.86% lines. Earlier in the task the count
  was 88 passing with 83.94% branches and 88.74% functions; the 21 added tests
  cover older plumbing and no source behavior changed to make them pass: the
  `dispatch` wrapper, start and shutdown errors, the error-after-headers path,
  the attach guards through a real Node server, tool normalization early
  returns, the stale-auth tool refusal and null results through an in-memory MCP
  client, plugin `listen` variants, and repeat client generation.
- Left uncovered on purpose: the stdio transport's `connect` to
  `StdioServerTransport` (`scripts/stdio.ts` 23-24, `events/stdio.ts` 17),
  because starting it would take over the test process's stdin and stdout. The
  remaining uncovered lines are in `scripts/sse.ts` (the promiser stubs in the
  attach path and its attach guards) and a few single branches in `helpers.ts`,
  `plugin.ts`, and `transform/`; none is a refusal path.
- `yarn build` in `packages/stackpress-ai`: succeeds, CJS and ESM.
- `git diff --check`: clean. Untracked new files were checked separately for
  trailing whitespace.
- `python3 .agents/scripts/validate-agent-workspace.py`: warnings only, and none
  for this task (two older reference files are over 200 lines). The evidence file
  is 194 lines.
- Acceptance transcript: [evidence/00001-key-refusals.md](evidence/00001-key-refusals.md).
  It was produced against the real `templates/blog` app: `yarn blog generate`,
  `yarn blog push`, three seeded application keys, and `stackpress serve` on
  port 3411 through a temporary config that only changed the port. That config
  was deleted afterwards. Every response in it came from a `curl` call. The two
  `tools/list` bodies are trimmed to the tool names, which the transcript states.
  Not in the transcript: a key dying mid-session and anything over SSE (the
  blog's `mcp` config does not enable it). Both are covered by `tests/live.test.ts`.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
