# AI Tools, Callers, And MCP Access

Use this reference for the `mcp` config section, the tool contract shared by
outside MCP callers and the built-in agent, the caller record, key verification,
and how an event receives a caller's session. The built-in agent itself is in
[AI Agent Runtime, Records, And Panel](00020-ai-agent-runtime-records-and-panel.md).

## Activation

`stackpress-ai` is loaded by name and is not in the aggregate plugin. Its plugin
activates when an `mcp` or an `agent` config section exists, and each half
registers only for its own section. Under `mcp` it registers the `mcp` factory
plugin and the `mcp-stdio`, `mcp-http`, and `mcp-sse` events during `listen`
(CLI event names are in [CLI And Plugin Contracts](00009-cli-and-plugin-contracts.md)).
The `idea` transform and the generated-client tool listener run under either
section.

## `mcp` Config

| Key | Default/effect |
| --- | --- |
| `name`, `title` | `'Stackpress AI Server'` |
| `version` | string literal default in `plugin.ts`, not read from the manifest |
| `description` | optional server description |
| `host`, `port` | inherit `server.host`/`server.port` |
| `route` | `'/mcp'` |
| `mode` | `'stateful'`, or `'stateless'` |
| `messages` | `'/messages'` for legacy SSE |
| `sse` | optional `host`, `port`, `route`, `key` overrides; enables SSE |
| `tools` | serializable tool definitions, the final override of any contribution |

Same host and port as the main server attaches the routes to it; different
values create a dedicated listener. `McpConfig` and `ToolConfig` are in
`packages/stackpress-ai/src/types.ts`.

## Tool Contract

A `ToolConfig` has a required `event`, optional `name` (inferred from the event),
`title`, `description`, `method` (default `GET`; `GET|POST|PUT|PATCH|DELETE`),
JSON Schema `input`/`output`, `type`, `scopes`, fixed `data`, and `mode`
(`event` or `plugin`, where `plugin` asks a resolver event for defaults).
Four fields matter to the built-in agent: `agent` (offered to it only when
`true`), `inverse` (name of the tool that undoes this one), `irreversible`, and
`operation` (dotted path into the event results holding the app's own
identifier; default key `operation`).

`type` defaults to `public`. A contributed or configured tool that omits `type`
is visible to unauthenticated MCP callers, including a write. Name `user` or
`app` and `scopes` deliberately. A tool needs every listed scope.

## Plugins Contribute Tools

Registry assembly (`collectTools`, `src/scripts/tools.ts`) resolves the
`ai-tools` event every time the registry is built. A plugin listens to it and
calls `contributeTool(ctx, tool | tool[])`, which throws outside that event.
Contributions merge with `mcp.tools` by name before normalization, so a
configured entry overrides only the fields it sets. Two contributions of one
name throw. The generated per-model tools (`search`, `detail`, `create`,
`update`) still come from the transform and attach through `listen`.

An event name containing `:` is an Ingest expression pattern. A listener on
`blog:desktop-open-latest-posts` also answers `blog-site-info`, so a tool event
named in that style can be answered by an unrelated listener. Use hyphenated
names without a colon for events a tool will call.

## Shared Execution Path

`callTool` (`src/scripts/tools.ts`) is the one place a tool runs, for MCP and
for the agent. It validates input against the tool's JSON Schema (a bad input
returns code 400), builds a request with `ctx.request({ data, method })`,
records the caller, resolves the tool's event, and returns
`{ code, status, results, error }`. It does not decide whether the caller may
use the tool; the transport or agent does that first.

- `failed(result)` is code of 400 or more, or an error message. An event that
  nobody answered comes back with code `0`.
- MCP turns a failed result into an MCP result with `isError: true`. It treats
  code `0` with no error as success with a null result. The agent treats code
  `0` as failed (`execute`, `src/scripts/turn.ts`). The two surfaces disagree.
- Identity fields `profileId`, `applicationId`, and `sessionId` are stripped from
  input for every caller and then written only from the caller record
  (`withToolData`, `src/helpers.ts`). Fixed config `data` is trusted.
- A tool with no `input` schema receives `{}`, never the SDK's request extras.

## Caller Record

Every tool event receives one `Caller`, kept apart from its input: `kind`
(`public`, `app`, `user`, or `person`), optional `profileId`, `sessionId`,
`applicationId`, `roles`, and `scopes`. Read it with `caller(req)` from
`stackpress-ai`. The record is stored in a `WeakMap` keyed by the request the
event receives, so tool input cannot reach it, and it exists only after the key
or sign-in was checked. `person` is the signed-in user the built-in agent acts
as; it has `roles` when known and empty `scopes`.

An inverse tool's event additionally receives `undoing(req)`: the action it is
undoing (stored input, result, operation identifier) and the id of the undo
action. It is set only while an undo runs and is `undefined` otherwise.

The `WeakMap`s live on `globalThis` under `Symbol.for('stackpress-ai.tools')`.
A server can load the package as CJS while a plugin imports it as ESM; module
level state would then be two copies and a contribution would be lost.

## Carrying A Session Into An Event

Resolving an event with plain data builds a request with no session
(`Router._resolveEvent` in Ingest). An event that reads its caller from the
session refuses it, so a caller's session must be carried in a new request built
for the purpose. For a `person` caller `callTool` builds
`ctx.request({ data, method, session, url })` where `session` is a copy of the
origin request's session data and `url` keeps the origin path but drops its
query, because Ingest copies a URL's query into request data. The origin request
itself is never forwarded, so its body, headers, and query cannot become input.
The copy is the whole session, including the anti-forgery token entry.
`Session.token(req)` reads only that session entry
([Session And Language Contracts](00013-session-language-contracts.md)), which is
why the session has to travel. An application boundary may need more, such as a
request method, a path, or an anti-forgery token; fitting it was not run
against a real application.

## Key Verification

A bearer token is `id` or `id:secret`. A presented key resolves as an
application first, then as a user session. It is refused (`invalid`) unless the
record is known, `active` is not `false`, `expires` is absent or in the future
(an unreadable expiry fails closed), and the secret matches, on every method.
A request with no key is `public`. An invalid key never downgrades to public.
A tool is visible only when the caller owns every required scope; `invalid`
sees nothing, public tools included.

- HTTP and SSE answer `401` with `WWW-Authenticate: Bearer` (JSON-RPC code
  `-32001`) for an invalid key, and `403` (`-32002`) for a call to a registered
  tool the caller lacks, checked against the full registry before the transport
  runs. An unregistered name still reaches the SDK and is reported as not found.
- The key is resolved again on every request or message. When it dies the
  session's transport is closed. A request inside a session must present the
  same key the session opened with, or it is `401`.
- A valid caller that sees no tools connects and gets an empty `tools/list`; the
  server registers and removes one tool to switch the SDK's tool handlers on.
  Only a refused caller, or stdio with an empty registry, gets no server.
- stdio is unfiltered trusted local use: no key is presented or checked.
- Checking that a key was issued for this server's address is left to each
  application.
- A live session's call handlers keep the scopes captured when it opened; only
  key liveness and the 403 check use the fresh record (`registerCallTools`).
- The secret comparison is plain string equality (`secretAllowed`,
  `src/helpers.ts`), not a constant-time comparison.

## Source Anchors And Authority

Anchors: `packages/stackpress-ai/src/{plugin,helpers,types}.ts`,
`src/scripts/{tools,http,sse,stdio}.ts`, `README.md` (public description), and
`tests/{tools,registry,http,sse,live}.test.ts`. The key rules were also run
against the blog template over HTTP; SSE and stateless HTTP were covered by
socket tests only. Source and tests are authority; the README is a benchmark.
