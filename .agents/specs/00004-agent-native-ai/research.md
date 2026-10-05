# Research

## R-001: Agent-Native Architecture Article

Status: Complete on 2026-10-03.

Source: https://www.builder.io/blog/agent-native-architecture, read 2026-10-03.

Findings: The article names five principles: agent and interface parity, one
shared action model, shared state and context, protocol readiness, and governed
execution. It adds later-stage items: stored workspace instructions, automations,
observability, and team readiness. Its test is whether a person and an agent can
run the same workflows through the same actions, data, and permissions.

Affected: brief scope, DEC-007, DEC-008.

## R-002: Current stackpress-ai Behavior

Status: Complete on 2026-10-03.

Sources: `packages/stackpress-ai/src`, tests, and README.

Findings:

- Tools are built only from `mcp.tools` config (`src/plugin.ts:41`), and the
  plugin does nothing when `mcp` config is absent (`src/plugin.ts:123`).
- A tool call resolves its event with plain merged data (`src/plugin.ts:105`).
- Generated tools cover four operations (`src/transform/helpers.ts:9`); generated
  `search` and `detail` default to public.
- An unknown key resolves to a public caller (`src/helpers.ts:242`). No expiry or
  active check exists.
- Any one matching scope is enough (`src/helpers.ts:467`), and `GET` tools skip
  the secret (`src/helpers.ts:354`).
- A stateful HTTP session is reused without rechecking its key
  (`src/scripts/http.ts:285`).
- The stdio transport builds the server with no caller filter
  (`src/scripts/stdio.ts:13`).
- The package contains no model provider client, chat endpoint, or interface.

Affected: GAP-002, GAP-003, GAP-004, DEC-003.

## R-006: Response Streaming Through Ingest

Status: Complete on 2026-10-04.

Sources: published `@stackpress/ingest` 0.10.8 `http/Adapter.js` and
`whatwg/Adapter.js`.

Findings: The Node dispatcher pipes a `Readable` or `ReadableStream` response
body to the socket, and the WHATWG dispatcher passes a `ReadableStream` through.
A route can therefore stream by setting a stream body with an event-stream
type. P-002 exercised the Node path; the WHATWG path is read from source only.

Affected: GAP-010.

## R-007: Provider Tool-Calling Contracts

Status: Complete for the adapter contract on 2026-10-04.

Sources: the Anthropic API reference bundled with the coding agent's Claude API
skill (cached 2026-09-25); OpenAI function-calling guide at
developers.openai.com; OpenRouter tool-calling guide and public model list. All
read 2026-10-04.

Findings:

- Anthropic: Messages API through the official SDK. A reply is appended to the
  history unchanged, thinking blocks included; all tool results of one step go
  back in one user message; the stop reason is checked before content, and a
  declined request can be retried server-side with the default fallback. On the
  current default model, thinking cannot be disabled and a forced tool choice
  is rejected, so tools are steered by prompt with strict schemas.
- OpenAI: the Responses API is the recommended surface and newer models require
  it for tool calling. Tool calls arrive as output items answered by call
  identifier, and reasoning items must be passed back with the tool output. The
  SDK ships a helper that converts output items to input items.
- OpenRouter: an OpenAI-style chat completions endpoint reached with the OpenAI
  SDK pointed at OpenRouter's address. The tool list must be sent on every
  request. One key reaches models from several providers.
- Model identifiers seen on 2026-10-04: `claude-opus-5-5` on the Anthropic API;
  `gpt-6.1-sol` and `gpt-6-astra` in OpenAI examples; `anthropic/claude-opus-5.5`
  and `openai/gpt-6.1-sol` on OpenRouter. Identifiers are configuration, not
  constants.

Not verified: provider streaming, and whether the OpenAI adapter can run without
conversation state being stored on the provider side.

Affected: DEC-004, GAP-015, GAP-016, P-003.

## R-008: How Packages Ship Models

Status: Complete on 2026-10-04.

Sources: `packages/stackpress-api/schema.idea`,
`packages/stackpress-session/schema.idea`, `packages/stackpress/stackpress.idea`.

Findings: A package ships a `schema.idea` in its published files. The aggregate
composes them with `use` lines and apps `use "stackpress/stackpress.idea"`.
`stackpress-ai` is loaded explicitly, so an app would add its own `use` line.

Affected: GAP-007.

## R-009: Lifecycle Order For Tool Registration

Status: Complete on 2026-10-04.

Sources: `packages/stackpress-server/src/Terminal.ts`,
`packages/stackpress-ai/src/plugin.ts`, `packages/stackpress-desktop/src/plugin.ts`.

Findings: Bootstrap resolves `config`, then `listen`, then `route`. The tool
registry is built each time `createMcpServer` runs, which is after every plugin
has registered its listeners. A contribution event resolved while building the
registry therefore reaches every plugin regardless of plugin order. The desktop
package already collects plugin contributions into a registry.

Affected: GAP-002.

## R-010: Release Policy For A Breaking Change

Status: Complete on 2026-10-04.

Sources: the coordinated release policy resource and the release workflow.

Findings: The release set is always published together at one exact version.
Release notes place migration notes and breaking changes above maintenance
details. Neither source states which version step a breaking change takes.

Affected: GAP-005.

## OfficePress Findings

R-003, R-004, R-005, R-011, and R-012 are in
[OfficePress Research](research-officepress.md): load for the organization
survey, the Resourcing workarounds, the pilot app, the agent design file, and
the Approvals action inventory.
