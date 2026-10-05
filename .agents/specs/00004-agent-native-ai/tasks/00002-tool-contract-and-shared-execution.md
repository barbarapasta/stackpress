# Task 00002: Tool Contract And Shared Execution

## Task Summary

Give tools one contract and one execution path: plugins can contribute tools,
every tool event receives a caller record it can trust, and MCP and the later
agent run tools through the same function. Decisions: DEC-012, DEC-013, GAP-001,
GAP-002. Journeys: J-011, J-012.

Names below are proposed. Record any change in Implementation Notes.

## Implementation Steps

1. `src/types.ts`:
   - add a `Caller` type: `kind` of `public`, `app`, `user`, or `person`, plus
     profile, session, application, roles when known, and scopes.
   - extend `ToolConfig` with `inverse` (the name of the tool that reverses it),
     `irreversible`, and `agent` (offered to the built-in agent; default false).
2. `src/scripts/tools.ts`, the reusable mechanism:
   - `collectTools(ctx)`: resolve the contribution event `ai-tools`, merge the
     contributed tools with configured tools by name, and normalize them with
     the existing helpers. A config entry with the same name overrides the
     contributed fields. Two contributions with the same name are an error.
   - `callTool(ctx, tool, input, caller, origin)`: validate input, build the
     request, record the caller, resolve the tool's event, and return code,
     results, and error.
   - for a `person` caller, build a new request from the origin request's
     session data with only the tool arguments as data and the tool's method,
     as proved in P-001. Never forward the origin request itself.
   - keep the caller record apart from input in a lookup keyed by the request,
     read through an exported `caller(req)` helper.
3. `src/helpers.ts`: `withToolData` keeps writing `profileId`, `applicationId`,
   and `sessionId` for `app` and `user` callers and removes those fields from
   input for every other caller.
4. `src/plugin.ts`:
   - export `contributeTool(ctx, tool)`, following the desktop menu
     contribution helper.
   - `createMcpServer` builds its registry with `collectTools`.
   - `registerCallTools` calls `callTool` and maps a failed event to an MCP
     error result instead of returning it as success.
5. `templates/blog/plugins/app/plugin.ts`: contribute one small read tool so
   the registry can be seen working without an `mcp.tools` entry.
6. Tests: registry merge, override, and duplicate error; input cannot set
   identity fields; `caller(req)` returns the record; session forwarding carries
   the session and only the tool arguments; failed events map to MCP errors.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with coverage above 90%.
- Existing HTTP, SSE, stdio, registry, and transform suites still pass.
- `yarn build` in the package.

## Acceptance Criteria

A tool list from `templates/blog` showing the plugin-contributed tool while
`mcp.tools` contains no entry for it.

## Implementation Notes

All six steps are done. The proposed names are kept: `ai-tools`, `contributeTool`,
`collectTools`, `callTool`, `caller`, `Caller`. Source is in `packages/stackpress-ai`
except the one blog tool.

- `src/types.ts`: new `Caller` (`kind` of `public`, `app`, `user`, `person`; optional
  `profileId`, `sessionId`, `applicationId`, `roles`; `scopes`) and `ToolResult`
  (`code`, `status`, `results`, `error`). `ToolConfig` gains `inverse`,
  `irreversible`, `agent`. `ToolResolverServer.resolve` now accepts a request as
  well as a plain object and returns the response `code`, `status`, and `error`.
  New `ToolRequest` type.
- `src/scripts/tools.ts` (new), also exported from `scripts/index.ts`:
  - `collectTools(ctx)` resolves `ai-tools`, merges contributions with
    `mcp.tools` by name, and normalizes. Merging happens before normalization, so a
    config entry overrides only the fields it sets and a contributed `type` or
    `method` is not reset by a default. A duplicate contribution name throws
    `Tool "<name>" was contributed more than once.`, checked after names are
    inferred. Collections on one server are chained so concurrent registries
    cannot see each other's contributions.
  - `contributeTool(ctx, tool | tool[])` adds to the open collection and throws
    outside the `ai-tools` event. It is re-exported from `plugin.ts`.
  - `callTool(ctx, tool, input, caller, origin)` validates (a bad input returns
    `code` 400, it does not throw), builds the request with
    `ctx.request({ data, method })`, records the caller in a `WeakMap` keyed by that
    request, resolves the event, and returns `ToolResult`. For `person` it builds a
    new request from `origin.session.data` and only the tool arguments, as P-001
    proved. The origin request is never forwarded. The origin address keeps its
    path and drops its query, because Ingest copies a url's query string into the
    request data. A `person` with no origin returns 401. `callTool` does not decide
    whether the caller may use the tool; that check stays where it was
    (`toolAllowed`, and the transports' 403).
  - `caller(req)` reads the record. `failed(result)` is code of 400 or more, or an
    error message.
  - `loadRegistry` moved here from `helpers.ts` and now calls `collectTools`, so
    the per-caller listing and the 403 check share one source. `http.ts` and
    `sse.ts` import it from here.
- `src/helpers.ts`: `withToolData(tool, input, caller)` now takes a `Caller`.
  It strips `profileId`, `applicationId`, `sessionId` from input for every caller
  and then writes from the caller: `app` writes `applicationId`, `user` writes all
  three. Config `data` is trusted and kept. New `callerFromAuth(auth)` (returns
  null for `invalid`) and `resolveToolConfig`, the named-but-not-normalized half of
  `resolveTool`.
- `src/plugin.ts`: `createMcpServer` builds its registry with `collectTools`.
  `registerCallTools` calls `callTool`; a failed event is returned as an MCP result
  with `isError: true` and the event's error message, falling back to its status
  text, then to `Tool call failed`. The result of a successful event is unchanged.
- `templates/blog/plugins/app/plugin.ts`: an `ai-tools` listener contributes
  `blog_site_info` (public, GET). Its event `app-site-info` returns the MCP name and
  `caller(req).kind`.
- `README.md`: new Contributing Tools section and Migration entries.

Deviations and things found:

- Shared state lives in a store on `globalThis` under `Symbol.for('stackpress-ai.tools')`,
  not in plain module-level `WeakMap`s. The first blog run failed with
  "Tools can only be contributed while the ai-tools event resolves" because the
  blog plugin imports the package as ESM while the server loads it as CJS, which
  gives two copies of the module and two sets of `WeakMap`s. Unit tests did not
  catch it, since they use one copy. A test now loads a second copy of the module
  and checks both directions.
- `registerCallTools` had a latent bug: for a tool with no `input` schema the MCP
  SDK passes the request extras as the first handler argument, and they were merged
  into the event's data (visible as `sendRequest` and other keys). It now passes `{}`
  when the tool declares no input.
- `withToolData` and `loadRegistry` are public through the `helpers` subpath, so
  moving or re-typing them is a breaking change. Both are listed in the README
  Migration section; `loadRegistry` was added by task 00001 and is not released.
- The tool event used to receive a plain data object. It now receives a request
  built with the tool's `method`.
- Two config entries with the same name used to register twice (the SDK would then
  throw on the duplicate); they are now merged into one tool.
- The blog's existing event `blog:desktop-open-latest-posts` is read by Ingest as a
  pattern and answers any event that starts with `blog`. The first blog tool event
  was named `blog:site-info`, then `blog-site-info`, and both returned the desktop
  listener's result. The event is now `app-site-info`. The existing listener was
  left alone.
- Nothing produces a `person` caller yet. The mechanism is unit-tested against real
  Ingest requests only; no route or agent was added.
- `agent`, `inverse`, and `irreversible` are only types and pass-through fields. No
  code reads them yet.

## Verification Notes

Run with Node 22.23.2 and Yarn 1.22.22.

- `yarn test` in `packages/stackpress-ai`. Before (after task 00001): 109 passing,
  96.14% statements, 92.1% branches, 94.7% functions, 96.86% lines. After: 155
  passing, 0 failing, 96.54% statements, 92.21% branches, 95.09% functions,
  97.18% lines. 46 tests added. Existing tests changed: the shared stub `ctx` gained
  `request()` and records its resolves, one registry test passes `withToolData` a
  `Caller`, and `loadRegistry` is imported from its new home. The HTTP, SSE, live, stdio, registry,
  and transform suites pass unchanged in what they assert.
- New `tests/tools.test.ts` runs against a real Ingest server: registry merge,
  override by name, duplicate error, concurrent collections, the 403 check seeing
  a contributed tool, input unable to set identity fields for each caller kind,
  `caller(req)`, person session forwarding (session carried, origin body and query
  not leaked, origin request not forwarded, signed-out refused by the event),
  and two loaded copies of the module. Failed-event mapping is in `plugin.test.ts`.
- Left uncovered: the non-Error branch of the validation failure in `callTool`
  (`tools.ts` 113-118, the `String(error)` fallback), and the same stdio lines as
  task 00001.
- `yarn build` in the package: succeeds, CJS and ESM.
- Clean root build after the final source change: `packages/*/cjs` and `esm`
  removed, `yarn build` at the root, exit 0 (see task 00001A). `yarn build:desktop`
  was run afterwards to restore the desktop output.
- `git diff --check`: clean. Untracked new files were checked for trailing
  whitespace separately.
- `python3 .agents/scripts/validate-agent-workspace.py`: warnings only, the same
  two older reference files over 200 lines; none for this task. The evidence file
  is 102 lines.
- Acceptance transcript: [evidence/00002-contributed-tool.md](evidence/00002-contributed-tool.md).
  Against the real `templates/blog`: `yarn blog generate`, `yarn blog push`, and
  `stackpress serve` on port 3412 through a temporary config that only changed the
  port (3000 is taken here). `tools/list` and `tools/call` came from `curl`; the
  list is trimmed to the contributed tool's entry and says so. The same file shows
  the template's loaded `mcp.tools` and a `grep` of `config/`, neither naming the
  tool. Cleanup: server stopped, temp config deleted, no `.env` created. `push`
  drops and recreates the tables, so `templates/blog/.build` was copied first and
  restored afterwards.
- Not verified: a `person` caller end to end, since nothing produces one yet; the
  blog's own test suite was not run.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
