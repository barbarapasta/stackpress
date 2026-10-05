# Implementation Sprint

## Status

Accepted by the user on 2026-10-04. Task files and their status are tracked in
[Task Status](status.md).

## Scope Shape

Ten ordered tasks in `packages/stackpress-ai`, with `templates/blog` as the
reference app. The planning layers map as follows:

- foundation: caller record, tool definition fields, adapter contract, records
  (tasks 2, 3, 4);
- placeholders: a stub model adapter and fixtures inside tasks 4 and 5, kept as
  permanent test doubles rather than a separate layer;
- reusable units: key checks, tool registry and execution, adapters, turn store
  (tasks 1 to 4);
- composition and layouts: plugin wiring and the panel shell, merged into tasks
  6 and 7 because the package has one route group and one panel;
- workflows: the turn runtime (task 5);
- primary outputs: chat routes and the plain panel (tasks 6, 7);
- real logic replacing placeholders: live providers through config (task 4
  smoke, task 8 wiring);
- refactor and surface: exports, packaging, coverage (task 9).

## Preconditions

- Use Node 22 and Yarn from the repository root; this machine also has Node 24.
- Run `yarn install` and record a passing baseline for `stackpress-ai` tests
  before the first change.
- No commit, push, publish, or pull request without a separate user request.

## Acceptance Policy

Acceptance is something the user can look at without reading code: a rendered
screen, a recording, a readable document, or visible command behavior. Tests,
builds, and type checks are validation. A task with nothing meaningful to look
at records `Acceptance: not applicable`.

## Task 1: Harden Key Verification

Planned output: DEC-003 in `helpers.ts` and the HTTP and SSE transports.
Unknown, inactive, expired, or secretless keys are refused; the secret is
required on every method; a tool needs every scope; real 401 and 403 answers; a
dead key ends its connection. Migration note for the breaking change.

Verification: unit tests for each refusal on both transports; existing suite
updated; coverage above 90%.

Acceptance: a readable transcript of requests against the reference app
showing a good key working, a bad key refused, and a missing scope refused.

## Task 2: Tool Contract And Shared Execution

Planned output: the caller record (DEC-013); tool definition fields for inverse
and irreversible (DEC-012); the tool contribution event and registry merge
(GAP-002); one execution function used by MCP and later by the agent, building
a new request with the caller's session for signed-in callers (GAP-001).

Verification: unit tests for registry merge and override, caller record
isolation from input, and session forwarding; MCP suites still pass.

Acceptance: a tool list from the reference app showing a tool that a plugin
contributed without any `mcp.tools` entry.

## Task 3: Records And Turn Store

Planned output: package `schema.idea` with thread, turn, action, and usage
models (GAP-007); a store for creating threads, appending turns, pausing,
resuming, listing by owner, and summing usage. Raw provider replies are stored
with each assistant turn and history is append-only (DEC-004, DEC-015).

Verification: generation compiles; store tests cover owner isolation, pause and
resume, repeated approval, and expiry (GAP-019).

Acceptance: the generated admin list of agent actions in the reference app,
showing who did what and when.

## Task 4: Provider Adapters

Planned output: the adapter contract and adapters for Anthropic, OpenAI, and
OpenRouter, promoted from the P-003 prototype to typed package code with
streaming, typed errors, refusal handling, and no provider-side storage
(DEC-015); a stub adapter for tests. Provider SDKs load only when configured.

Verification: canned-reply tests through the real SDKs; a live smoke run
through OpenRouter; live Anthropic and OpenAI runs when their keys exist.

Acceptance: the visible output of the live smoke run.

## Task 5: Turn Runtime

Planned output: the agent turn workflow as events behind `agent` config:
message, model loop, tool execution through task 2, approval pause and resume
(J-002), undo (J-003), refusals (J-004), usage limit (J-008), owner checks
(J-009), and file references (GAP-017). Requests without a person's session are
refused (GAP-018).

Verification: workflow tests with the stub adapter for every journey step
marked implementable.

Acceptance: not applicable. The workflow has no visible output until the routes
in task 6.

## Task 6: Chat Routes

Planned output: routes for sending a message with streaming and the
single-response fallback, approving, declining, undoing, history, and new chat;
sign-in, anti-forgery, and limit checks; page context intake and the enrichment
event (DEC-014).

Verification: route tests on a long-lived server and a server built per request;
auth, status, and error mapping per the access-surface evidence class.

Acceptance: a recorded request session against the reference app with the stub
model: streamed reply, approval pause, resume, and undo.

## Task 7: Plain Reference Panel

Planned output: a plain panel using existing view conventions: chat, context
chips, action cards, approval click, undo, history, new chat, model picker, and
file attach by reference (DEC-010 first-trial list). No OfficePress styling
(DEC-005).

Verification: render and interaction tests; SSR and hydration checks; keyboard
and narrow-screen checks.

Acceptance: screenshots or a recording of the panel in the reference app doing
a reversible action, an approved irreversible action, and an undo.

## Task 8: Reference App Wiring And Documentation

Planned output: `templates/blog` enables `agent` config and registers sample
plugin tools, one reversible with an inverse and one irreversible; README,
configuration reference, and the migration note are updated.

Verification: the template generates, builds, and serves; documented commands
run as written.

Acceptance: the rendered documentation for turning the agent on.

## Task 9: Public Surface, Packaging, And Coverage

Planned output: exports and type mappings for new subpaths following the
package public surface workflow; CJS and ESM builds; pack contents; coverage
above 90% for the package.

Verification: build, pack inspection, CJS and ESM imports, type resolution,
full package suite, root build.

Acceptance: not applicable. Packaging has no meaningful visual output.

## Task 10: Pilot Handoff

Planned output: a packed local build and a pilot checklist for Operations
Approvals covering the app boundary, hosting, file upload, and every action in
R-012. The pilot itself is specified in the Approvals repository under its own
workflow (DEC-006, GAP-011).

Verification: the packed build installs into a clean consumer.

Acceptance: the pilot checklist as a readable document.

## Ordering Rationale

Task 1 is independent, ships a security fix alone, and lets Resourcing drop its
local override. Task 2 fixes the contract everything else calls. Tasks 3 and 4
are independent of each other and feed task 5. Routes need the runtime, and the
panel needs the routes. Wiring, packaging, and handoff close the sprint.

## Closeout

After all tasks are accepted, run the context promotion review recorded in
[Status](../status.md) through the KB maintenance workflow, and update the
configuration catalog and exposure examples to the new behavior. The version
number for the breaking change is left to the main author.
