# Task 00001B: Answer A Valid Key That Sees No Tools

## Task Summary

Side quest of [Task 00001](00001-harden-key-verification.md). A verified key
whose scopes match no tool gets a 500, "Resolved MCP tool registry is empty.",
on connect. The key is valid, so a server error is the wrong answer. The
behavior predates this spec and was left alone in task 1.

Approved by the user on 2026-10-05 with the recommended choice: connect normally and list zero tools; stdio keeps failing loudly when the whole registry is empty.

## Implementation Steps

1. `src/plugin.ts`: let `createMcpServer` return a server with no tools for a
   verified or public network caller instead of `null`.
2. `src/scripts/http.ts` and `src/scripts/sse.ts`: stop treating an empty
   per-caller registry as an error.
3. `src/scripts/stdio.ts`: keep failing when the whole registry is empty.
4. Update the tests that assert the 500.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with all four coverage numbers
  above 90%.
- `yarn build` in the package.

## Acceptance Criteria

A short transcript showing a valid key with no matching scopes connecting and
receiving an empty tool list.

## Implementation Notes

All four steps are done, in `packages/stackpress-ai`.

- `src/plugin.ts`: `createMcpServer` returns `null` only for an `invalid` caller
  or for no caller (stdio) with an empty registry. Any other caller gets a server,
  even when it sees no tool.
- The SDK registers its `tools/list` and `tools/call` handlers only when the first
  tool is registered, so an empty server answered `tools/list` with "Method not
  found" and advertised no `tools` capability. `createMcpServer` therefore
  registers and removes one throwaway tool (public SDK calls only) so the handlers
  and capability exist with nothing listed. Found by running the real SDK client,
  not by reading the code.
- `src/scripts/http.ts` and `src/scripts/sse.ts`: `_createServer` keeps a guard for
  a factory that returns nothing, since a custom factory can, but the message is
  now "No MCP server was created for this caller." An empty per-caller registry no
  longer reaches it. The refusal of a bad key is untouched: it happens before the
  factory is called, in both modes and in SSE.
- `src/scripts/stdio.ts`: unchanged. It calls the factory with no caller, so an
  empty registry still throws "Resolved MCP tool registry is empty.".
- `README.md`: Outside AI tools, Known limits, What changed.

Tests changed deliberately, one by one:

- `tests/plugin.test.ts` "should register the factory and skip transports that do
  not attach": asserted `factory({ kind: 'public' })` is `null`. It now asserts a
  server for `public`, `null` for `invalid`, `null` for no caller.
- `tests/plugin.test.ts` "should return null when no tools are configured": kept,
  renamed to say "and no caller is given".
- `tests/live.test.ts` "should answer 500 over http / sse when the registry
  resolves empty": these used a factory that returns `null`, which is still a 500
  but no longer "an empty registry". Renamed to "the factory makes no server" and
  the message assertions changed to the new text.
- Unchanged and still true: `tests/stdio.test.ts` and the stdio case in
  `tests/events.test.ts` (stdio fails when the registry is empty).

Added: `createMcpServer` tests for public and verified callers who see nothing and
for a refused caller; in `tests/live.test.ts`, real HTTP (stateful and stateless)
and SSE connections through the real SDK client for a valid key with no matching
scope and for a public caller, each asserting `listTools()` is `[]`, and a case
showing a bad key is still 401 and a call to a lacking tool still 403.

## Verification Notes

Node 22.23.2, Yarn 1.22.22.

- Before (start of this task, as given): 700 tests; 96.5 / 91.78 / 96.66 / 97.17
  (statements / branches / functions / lines).
- After both side quests: `yarn test` in `packages/stackpress-ai`: 725 passing,
  0 failing; 96.5 / 91.83 / 96.55 / 97.2. (The 25 added tests are for both side
  quests.)
- The first run after the source change failed one test, the plugin factory test
  above, which asserted the old behavior; it was changed as listed.
- `yarn build` in the package and at the repository root: passed.
- Live: `evidence/00001B-empty-tool-list.md`, real requests to `templates/blog`
  (see the file for how). A valid key with no matching scope initializes (200),
  lists `{"tools":[]}`, is refused a call (403), and a wrong secret is 401.
- Not run live: SSE and stateless HTTP (covered by the live socket tests only);
  the blog's `mcp` config has no SSE section.

## Acceptance Notes

Accepted by the user on 2026-10-05 ("I think we're good now").
