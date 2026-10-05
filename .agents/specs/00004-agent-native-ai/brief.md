# Brief

## User Goal

Preserved as written on 2026-10-03:

> I want to expand stackpress-ai package to use agent native architecture. This
> will extend our back-office apps (officepress) to become an agent powered
> applications.

Starting point supplied by the user:
https://www.builder.io/blog/agent-native-architecture

## Accepted Direction

Recorded from the user's answers on 2026-10-04. Full wording and status live in
[Decisions And Gaps](decisions.md).

| Topic | Direction |
| --- | --- |
| Who the agent acts as | The signed-in user, not a separate agent account. |
| Model provider key | One provider API key per deployment, kept on the server. |
| Stricter key checks | Ship as the new default, accepting the breaking change. |
| Model providers | Anthropic, OpenAI, and OpenRouter. Only an OpenRouter key is available for testing. |
| Chat panel ownership | Runtime, tools, and log in `stackpress-ai` with a plain panel; OfficePress builds its own panel to its design file. |
| Pilot app | Operations Approvals, checked out at `/home/solution-team/projects/operations-approvals/`. |
| Pilot coverage | "You must do all the actions available there." |

## In Scope

1. Port the key-verification hardening that OfficePress Resourcing carries as a
   local override into `stackpress-ai` source with tests.
2. Let plugins register their own tools, and give tool events a defined caller
   identity instead of loose identifiers.
3. Extract one tool execution path shared by the MCP transports and the built-in
   agent.
4. Add a built-in agent runtime behind a new `agent` config section: provider
   adapters for Anthropic, OpenAI, and OpenRouter, a chat endpoint, and
   signed-in-user authorization.
5. Add governed execution: confirmation for flagged tools, an action log,
   optional per-tool undo, and a per-person usage limit.
6. Ship a plain reference chat panel and a page-context contract.
7. Pilot the result on Operations Approvals, covering every action the app
   offers a signed-in person, and record acceptance evidence.

## Non-Goals

- Do not expand generated CRUD tool coverage; see DEC-007.
- Do not put OfficePress styling or layout into `stackpress-ai`.
- Do not build a scheduler, automation engine, agent-to-agent protocol,
  workspace memory, or skills store in this spec.
- Do not add per-user provider keys.
- Do not change OfficePress application repositories from this spec. Pilot
  changes are planned under the pilot app's own spec workflow; see GAP-011.
- Do not commit, push, publish, or open a pull request without a separate user
  request.

## Source Material

- the Builder.io agent-native architecture article;
- `packages/stackpress-ai` source, tests, and README;
- `packages/stackpress-api`, `stackpress-session`, `stackpress-admin`,
  `stackpress-sql`, and `stackpress-view` source where they shape access;
- accepted Stackpress context, especially interfaces, extension, and
  compatibility guidance;
- OfficePress organization repositories, read on 2026-10-04 with the user's
  access; most are private;
- the local Operations Approvals checkout named above;
- the OfficePress design file `officepress.pen`, supplied by the user for the
  agent button and panel.

## Completion Criteria

- A presented key that is unknown, inactive, expired, or missing its secret is
  refused, and a tool requires every listed scope.
- A plugin can contribute a tool without editing `mcp.tools` config, and its
  event receives a defined caller.
- MCP calls and built-in agent calls run through the same execution code.
- A signed-in user can ask the built-in agent to perform an allowed action and
  the target app event authorizes it as that user.
- Flagged tools wait for approval, every agent action is logged against the
  person, and usage limits are enforced.
- The same conversation loop passes against all three providers, with live runs
  recorded for each provider whose key the user supplies.
- The Approvals pilot meets its recorded acceptance checks.
- Changed packages pass their tests above the 90% coverage target for new work.
