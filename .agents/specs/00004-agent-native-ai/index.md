# Agent-Native Stackpress AI

This spec owns the plan to grow `stackpress-ai` from an MCP server package into
an agent-native layer: hardened key handling, plugin-registered tools, a shared
tool execution path, a built-in agent that acts as the signed-in user, and a
pilot on the OfficePress Operations Approvals app.

## Load Map

- [Brief](brief.md): user goal as written, accepted direction, scope, non-goals,
  and completion criteria.
- [Status](status.md): freeze state, phase plan, blockers, and next action.
- [Decisions And Gaps](decisions.md): accepted decisions and every open Gap with
  its assumption and owner. Load before proposing design or tasks.
- [Research](research.md): source findings for the article, `stackpress-ai`,
  Ingest streaming, provider contracts, schema shipping, lifecycle order, and
  release policy.
- [OfficePress Research](research-officepress.md): findings from OfficePress
  repositories and the agent design file. Load for the pilot app, the existing
  workarounds, and the panel design.
- [User Journeys](journeys.md): the signed-in person's journeys through chat,
  approval, undo, refusals, context, history, limits, and file attach. Load
  before planning tasks or acceptance checks.
- [Integration Journeys](journeys-integration.md): outside AI tools with a key,
  a plugin registering a tool, operator setup, and the deferred background run.
- [Implementation Sprint](tasks/sprint.md): the ordered implementation tasks,
  their verification, and what the user reviews for each. Load before
  implementing.
- [Task Status](tasks/status.md): the status and next action of each task, with
  links to the task files.
- [Proofs](proofs.md): results of the three prototypes for session-forwarded
  tool calls, streaming and resume, and provider parity.

## Authority

Current `stackpress-ai` source and the accepted context in
[Interfaces And Experience](../../context/interfaces-and-experience.md) and
[Extension And Contribution](../../context/extension-and-contribution.md) own
framework behavior and placement. OfficePress application repositories own their
own events, authorization, interface, and planning records; this spec treats
them as evidence and as the pilot consumer, not as files it may change.

Frozen on 2026-10-04. Do not change Frozen Spec Files without the user's
permission to reopen.
