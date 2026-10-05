# Decisions And Gaps

## Accepted Decisions

### DEC-001: The Built-In Agent Acts As The Signed-In User

The built-in agent has no account of its own. Tool calls run with the signed-in
person's access, and the target app event remains the final authority.

Status: Accepted by user, 2026-10-04.

### DEC-002: One Provider API Key Per Deployment

Each deployment loads one API key per provider from the server environment. The
key never reaches the browser. Usage is recorded per person and a configurable
per-person daily limit applies. Per-user provider keys are out of scope.

Status: Accepted by user; reconfirmed at Freeze, 2026-10-04.

### DEC-003: Stricter Key Verification Is The New Default

A presented key must be known, active, unexpired, and secret-matching on every
method. A tool requires every listed scope. A refused key answers unauthorized
instead of downgrading to public, and a live connection ends when its key dies.
This is a breaking change with no compatibility flag. The behaviors are ported
to the HTTP and SSE transports with real 401 and 403 answers; stdio stays
trusted local use. Checking that a key was issued for this server's address is
left to each application.

Status: Accepted by user, 2026-10-04, including the audience-check scope.

### DEC-004: Three Model Providers Behind One Adapter Contract

Support the Anthropic API, the OpenAI API, and OpenRouter. The conversation loop
is provider-neutral; each adapter translates. Each assistant turn stores neutral
fields plus the adapter's own record of the reply, history is append-only, and a
reply is replayed unchanged to the model that produced it and rebuilt from the
neutral fields for any other model. Model identifiers are configuration.

Evidence: P-003 and R-007.

Status: Accepted by user, 2026-10-04. The user confirmed "Codex" meant OpenAI
and added OpenRouter. Only the OpenRouter adapter has run live.

### DEC-005: Framework Owns The Runtime; OfficePress Owns Its Panel

`stackpress-ai` owns the agent runtime, tool registry and execution, action log,
and a plain reference panel. The OfficePress panel is built in OfficePress code.

Status: Accepted by user, 2026-10-04.

### DEC-006: Pilot On Operations Approvals

The pilot app is Operations Approvals at
`/home/solution-team/projects/operations-approvals/`. The user states the checked
out feature branch is finished; local refs show it merged into the main branch.
Pilot work uses a new branch from main in that checkout, and app changes are
planned under the app's own `.agents/specs/` as its rules require.

Status: Accepted by user, 2026-10-04. Install mechanics are GAP-011.

### DEC-007: Do Not Expand Generated CRUD Tools Here

Leave the generated `search`, `detail`, `create`, `update` tool set as it is.
Priority moves to plugin-registered tools, because OfficePress apps route work
through hand-written command and read events and reject direct generated model
events.

Status: Accepted research conclusion; presented 2026-10-04 without objection.

### DEC-008: No Scheduler In stackpress-ai

Expose an agent turn as an event an application job runner can call. Six of
seven surveyed apps already depend on a job runner.

Status: Accepted research conclusion; presented 2026-10-04 without objection.

### DEC-009: The Pilot Covers Every Action In Approvals

The agent must be able to perform every action available in Approvals. User
wording: "You must do all the actions available there." Sign-in, password
reset, email-change verification, and guest review are excluded: they prove a
person's identity or serve signed-out guests, and the agent acts under an
identity the person already proved.

Status: Accepted by user, 2026-10-04, including the exclusion.

### DEC-010: The OfficePress Panel Follows The OfficePress Design File

The agent button is the second of four 36 px header controls, in the order
notifications, agent, theme, user. It opens a 400 px panel docked right under
the header that pushes content, and a full-height sheet on mobile. The first
trial includes chat, context items, action cards, the approval click, undo,
history, new chat, the model picker, and file attach. Mention, voice, and the
notification and settings Agent tabs come later.

Status: Accepted by user, 2026-10-04.

### DEC-011: The Spec May Record OfficePress Findings

The user answered "Yes you may" when asked whether this spec may mention private
OfficePress repositories. Read as permission to keep the findings, which are
gathered in one file so they can be handled separately.

Status: Accepted by user; reconfirmed at Freeze, 2026-10-04.

### DEC-012: Irreversible Actions Need One Approval Click

A tool declares an inverse or declares itself irreversible. Reversible actions
show Undo. Irreversible actions pause for the person's approval before running
and show no Undo.

Status: Accepted by user, 2026-10-04.

### DEC-013: Tool Events Receive One Caller Record

Each tool event receives one caller record, kept apart from its inputs: who the
caller is, their roles when known, their scopes, and how they got in. The system
fills it in only after checking the sign-in or key. Tool input can never set or
override it.

Status: Accepted by user, 2026-10-04.

### DEC-014: Page Context Is A Hint

The panel sends the page address and app-declared context items, which the
person can remove. The server may enrich them through an app event. No
authorization decision uses browser-supplied context.

Status: Accepted by user, 2026-10-04.

### DEC-015: No Provider Keeps Conversation State

The conversation is stored only in the application's database and sent in full
on each request. Adapters must not rely on provider-side conversation storage.
Confirm the stateless option in current provider documentation during
implementation. Provider log retention under account terms is outside this
decision.

Status: Accepted by user, 2026-10-04.

## Open Gaps

None block implementation.

### GAP-011: How does the pilot install an unreleased package?

Question: Approvals installs published 0.10.8 packages, has no `stackpress-ai`,
and declares Node 24 while this repository targets Node 22.

Assumption to verify: Install a packed local build of the changed packages into
the pilot branch and run both suites on the app's Node version.

Status: Deferred to pilot planning with user approval at Freeze.

## Resolved Gaps

- GAP-001, carrying the signed-in user into an app event: build a new request
  with the caller's session and only the tool arguments. Proved by P-001. An app
  boundary can require more, as Approvals does with its anti-forgery token,
  request method, and path; fitting that is a pilot check.
- GAP-002, how plugins register tools: the registry resolves a contribution
  event each time it is built and config entries stay the final override.
  Resolved by R-009; the event name and merge rules are set in task 00002.
- GAP-003, the caller shape: recorded in DEC-013.
- GAP-004, hardening scope: recorded in DEC-003.
- GAP-005, the version number for the breaking change: left to the main author
  by the user on 2026-10-04. Deferred with user approval; not a Freeze blocker.
- GAP-006, what "Codex" means: OpenAI; see DEC-004.
- GAP-007, where records live: the package ships a `schema.idea` and the app
  adds a `use` line, per R-008. Each action stores the app's operation
  identifier. Model shapes are set in task 00003.
- GAP-008, irreversible actions: recorded in DEC-012.
- GAP-009, page context: recorded in DEC-014.
- GAP-010, streaming and resume: turn state lives in the database, streaming is
  used where the host allows it, with a single-response fallback. Proved by
  P-002. Behavior on the real hosting platform is a pilot check.
- GAP-012, where the agent control sits: recorded in DEC-010.
- GAP-013, actions that stay with the person: recorded in DEC-009.
- GAP-014, first-trial panel controls: recorded in DEC-010.
- GAP-015, how provider replies are stored for replay: recorded in DEC-004.
- GAP-016, provider-side storage: recorded in DEC-015.
- GAP-017, how a file reaches a tool call: the composer uploads through the
  app's own upload route, the turn carries only a file reference, and the tool
  receives the reference. The framework never stores file contents. Accepted by
  user, 2026-10-04; the upload route is a pilot item.
- GAP-018, whom a background run acts as: deferred. The turn event accepts only
  requests that carry a person's session. Accepted by user, 2026-10-04.
- GAP-019, how long a pending approval stays valid: until the person sends a
  new message in the thread or a configured time passes; the app's own checks
  still reject a stale command. Accepted by user, 2026-10-04.
