# Task 00005: Turn Runtime

## Task Summary

Build the agent turn workflow on tasks 2, 3, and 4 and expose it as events
behind `agent` config. Decisions: DEC-001, DEC-002, DEC-012, GAP-017, GAP-018,
GAP-019. Journeys: J-001 to J-005, J-008 to J-010.

## Implementation Steps

1. `src/types.ts`: add `AgentConfig`: providers and their environment key
   names, default model, models offered in the picker, instructions, per-person
   daily token limit, approval expiry, and step limit.
2. `src/scripts/turn.ts`, the reusable mechanism, promoted from the prototype
   loop:
   - resolve the person from the request's session; refuse a request with no
     verified person.
   - refuse before any provider call when the person is at the daily limit.
   - expire pending approvals in the thread, store the message, and build the
     transcript from stored turns.
   - offer only tools marked for the agent.
   - run the loop with the chosen adapter up to the step limit, storing every
     turn with its usage.
   - a reversible tool runs through `callTool` with a `person` caller and is
     logged with its result and the app's operation identifier.
   - an irreversible tool, or a write tool with neither an inverse nor an
     irreversible mark, creates a pending action and pauses the turn.
   - a failed event is logged and returned to the model as a failed tool
     result.
   - file references pass through to tools unchanged; file contents are never
     stored.
3. `src/scripts/approval.ts`: approve, decline, and undo. Each loads the thread
   for its owner only. Approve reruns the sign-in check, runs the stored action
   once, and resumes the loop. Decline records the refusal and resumes with no
   action. Undo runs the inverse tool with the stored inputs and links the two
   actions.
4. `src/events/`: one event adapter each for turn, approve, decline, undo, and
   listing or loading threads, registered during `listen` only when `agent`
   config exists.
5. `src/plugin.ts`: activate when `mcp` or `agent` config exists; keep the MCP
   transports behind `mcp`.
6. Tests with the stub adapter for every journey step marked implementable in
   J-001 to J-005 and J-008 to J-010.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with coverage above 90%.
- Each implementable journey step has at least one named test.
- `yarn build` in the package.

## Acceptance Criteria

Acceptance: not applicable. The workflow has no visible output until the routes
in task 6.

## Implementation Notes

Done 2026-10-05. All six steps are done; proposed file names are kept. All changes are in
`packages/stackpress-ai`.

**Files.** New: `scripts/{agent,turn,approval,threads}.ts` (`agent.ts` holds the runtime object,
person check, model choice, tools offered and transcript builder), `events/{turn,approve,
decline,undo,threads,thread,helpers}.ts`, tests `workflow`, `runtime`, `agent-events`, and test
helpers `harness.ts` (the store test's database harness moved here) and `flow.ts`. Changed:
`types.ts`, `store.ts`, `plugin.ts`, both `index.ts`, `README.md` (one section).

**Events.** `ai-turn`, `ai-approve`, `ai-decline`, `ai-undo`, `ai-threads`, `ai-thread`
(`AGENT_EVENTS`). None is a prefix of another or contains a colon, which Ingest reads as a
pattern. A refusal answers with its status code, `errors.reason` and, for the limit,
`errors.resetsAt`; anything else answers `results` with `ok: true`, `status` and `events`.

**Config as built** (`agent`): `providers` (provider to `{ key }`, the environment variable
name, never the key), `model` (default id), `models` (`{ provider, model, title? }`, the
picker; the default must be in it), `instructions?`, `limit?` (input plus output tokens per
person per UTC day; none if unset), `approvalTtl?` (ms), `steps?` (default 8). A model not in
the list is refused (400); a stored one no longer offered falls back to the default. Keys are
read from the environment at call time.

**Progress events** (`AgentEvent`, on `type`): `thread`, `text`, `action-start`,
`action-waiting` (`expires`), `action-done` (`result`, `operation?`, `undoable`),
`action-failed` (`error`, `code?`), `action-declined`, `action-undone` (`undoActionId`),
`usage`, `error` (`status`, `message`, `retryAfter?`, `resetsAt?`), `finished` (`status`:
`done`, `waiting`, `steps`, `length`, `refusal`, `limit`, `unavailable`, `busy`, `failed`,
`settled`). `watch(req, fn)` attaches a callback that gets them as they happen; the same list
is in `result.events`. A callback that throws never stops the run.

**Pause with nothing in memory.** The assistant turn and a tool turn holding a result for
every call are both stored at the pause; the waiting call's result carries its action id. The
transcript is never stored, only rebuilt from stored turns, and a result with an action id is
read from that action as it stands. So approving changes only the action, no turn is edited,
and any server can resume. A call whose result never arrived (a crash) is answered as failed
when the transcript is built, so the provider never sees a call without a result.

**Several tools, one needing approval.** Calls run in order. Those before the first one that
needs approval run and are logged; that one becomes a pending action and the step stops;
every call after it is answered as not run, since it may depend on the one waiting, and the
model can ask again. Every call has a result in the stored tool turn.

**Operation identifier.** New optional `ToolConfig.operation` is a dotted path into the event's
results (default key `operation`). A string or number there (cut to 255) is stored on the done
action; nothing is invented when the event returns none.

**Decisions where the task was open.**

- Person: `ctx.plugin('session').load(req).data()`, which verifies the token against the
  session seed; the profile id is `data.id`. No session, unverified token, no id, or no
  session plugin is refused (401), a job included. A `GUEST`-only role still counts.
- A thread or action of someone else answers like a missing one (404), so ids cannot be
  probed. `ai-turn` refuses in this order: person, input, thread owner, model, key and
  adapter, limit; only then is the thread created and the message stored.
- Missing key: refused 503 with fixed text before anything is stored or the SDK loads. A key the
  provider rejects mid-run ends the run `unavailable` with the same text; the provider's message
  goes only to the runtime's `log` (console by default).
- Limit: checked before every provider call. After an approval the tool still runs; the model is
  not called if the person is at the limit.
- Reversible tools and reads go through the same claim as an approval, so each runs once; reads
  are logged with no undo. Tools offered are exactly those with `agent: true`.
- A bad input, a made-up tool name, or a tool not offered is handed back to the model as a
  failed result, with no action logged and before any approval is asked for. An event nobody
  answered (code 0) is logged as failed.
- Files are references only: up to 20 strings of up to 500 characters, else refused. Stored on
  the user turn, named to the model as `[Attached files: ...]`; tools get what the model passes.
- Page context goes into that run's system text, cut to 4000 characters and labelled as hints;
  never stored, never used for a decision. After an approval the turn continues without it.
- Undo runs the inverse with the stored input only; it need not be marked `agent`. `ai-thread`
  returns user and assistant turns without `raw` or tool data, and each action with `undoable`.
- Plugin: active when `mcp` or `agent` exists. Under `agent` it registers the runtime as the
  `agent` plugin and the six events in `listen`; the transports and `mcp` factory only under
  `mcp`. The `idea` transform and generated client tool listener run under either.
- The only shared state is a `WeakMap` of callbacks on `globalThis`, as `tools.ts` does it, so
  two loaded copies agree; a test checks.

**Deviations.** (1) The store gained `claimDecline`, `claimUndo` and `releaseUndo`: without
them a double click on Decline continues the turn twice and a double click on Undo runs the
inverse twice, because `declineAction` and `markUndone` do not say who won. Each is one
guarded `UPDATE` with a token read back, like approval; existing methods are unchanged and the
runtime no longer calls those two. (2) `ToolConfig.operation` was added. (3) `models` carries a
provider per entry.

**Limits.** An action left `approved` by a server that stopped mid-run stays approved (it may
have run, so nothing reruns it); an undo that stops after claiming leaves the original
`undone` with no inverse run. CSRF (J-001.2) is a route check for task 6. The forwarded
request keeps the origin path and drops its query (task 2); whether an app's boundary accepts
that is still the P-001 pilot check.

## Verification Notes

- `yarn test` in `packages/stackpress-ai`. Before: 266 passing, 97.54 / 93.78 / 97.02 / 97.95
  (statements / branches / functions / lines). After: 387 passing, 0 failing, 98.12 / 93.64 /
  97.42 / 98.46. 121 tests added: `workflow` 53, `runtime` 50, `agent-events` 13, and 5 in
  `store.test.ts` for the new store methods. No test changed except that `store.test.ts` imports
  its database harness from `harness.ts`.
- The tests use a real Ingest server, the real session plugin with real signed tokens, the real
  store over PGlite, and a stub model.
- Mutation check, reverted afterwards (`diff -r` of `src` against a copy was empty): breaking
  each of these made tests fail: calls after a gate still run; no limit pre-check; irreversible
  runs unapproved; failed event logged done; no key check; provider text in a result; person from
  the body; undo without claim; repeat decline continues; tool offered without `agent`; limit not
  checked per step; waiting result not read from its action. One survivor is equivalent (a claim
  token exists only when claimed).
- `yarn build` in the package and at the repository root: exit 0. `git diff --check`: clean.
  Validator: only the two older warnings.

**Journey step to test** (`tests/workflow.test.ts` unless noted; titles shortened, each under
its journey's describe).

| Step | Test |
| --- | --- |
| J-001.1 | `step 1: loads the thread with its messages and actions for its owner`; `step 1: hands the page context to the model as a hint` |
| J-001.2 | `step 2: checks sign-in, then stores the message under the person` (limit: J-008.1, refusals: J-009.1; the anti-forgery token is task 6) |
| J-001.3 | `step 3: sends the transcript and only the agent tools; text arrives as generated` |
| J-001.4 | `step 4: runs the tool on a new request with the person's session and only the tool arguments` |
| J-001.5 | `step 5: commits as the person and logs the action with the app's operation identifier`; `step 5: reads the identifier from the path a tool names` |
| J-001.6 | `step 6: the reloaded thread shows the finished action the panel refreshes from` (runtime half; the panel is task 7) |
| J-002.1 | `step 1: stores the turn as waiting ...`; `step 1: treats a write with no inverse and no irreversible mark the same way`; `stops at an approval when several tools are requested, and answers every call` |
| J-002.2 | `step 2: approval reruns the sign-in check, runs the tool once as the person, shows Done with no Undo, and continues` |
| J-002.3 | `step 3: a decline records the refusal, tells the model, and continues with no action`; `answers every call too when the person declines the one that waited` |
| J-002.4 | `step 4: another server finds the stored turn, and a repeated approval runs nothing`; `step 4: simultaneous approvals run the tool once ...`; `step 4: simultaneous declines continue the turn once` |
| J-002.5 | `step 5: a new message expires the pending approval ...`; `step 5: an approval expires when the configured time passes`; `step 5: loading a thread shows an overdue approval as expired`; `step 5: an approval that never expires by time still expires on a new message` |
| J-003.1 | `step 1: runs the inverse with the stored inputs through the person's session, with no second approval` |
| J-003.2 | `step 2: the card shows Undone when the event commits`; `step 2: shows the reason when the app refuses because the record changed` |
| J-003.3 | `step 3: the log links the undo to the original action` |
| J-004.1 | `step 1: logs a 403 and returns it to the model as a failed tool result`, likewise 404 and 409 |
| J-004.2 | `step 2: the agent explains the refusal and the turn ends`; `step 2: the step limit stops a model that keeps retrying` |
| J-005.2 | `step 2: offers no sign-in, password, verification, or guest tool, and says so`; `step 2: a tool the model makes up never runs and is not logged` |
| J-008.1 | `step 1: refuses before any provider call, says when the limit resets, and costs nothing`; `step 1: a refused message does not start a thread`; `step 1: counts usage per person and resets the next day` |
| J-009.1, J-009.2 | `step 1: refuses a message, an approval, a decline, and an undo, with no provider call and no tool run` (signed out, tampered, expired, another person; it then signs the owner in again and approves, which is J-009.2); `step 1: an approval sent by another person is refused and leaves the action pending`; `step 1: writing to someone else's thread is refused ...` |
| J-010.2 | `step 2: carries file references on the turn and passes them to the tool unchanged`; `step 2: refuses files that are not plain references` |
| J-013.3 | (`runtime.test.ts`) `step 3: reports itself unavailable without a key, before storing anything or calling a provider`; `step 3: a key the provider rejects is reported as unavailable without the provider's text` |
| J-014 | (`runtime.test.ts`) `refuses a call from a job that has no session, and runs nothing`; `refuses a request with no session at all, ...` |

**Not verified.** No real provider was called. Claims ran on PGlite only; one winner on a
multi-connection database is inferred from a single guarded `UPDATE` being atomic. `listen` ran
against a stub server and the events against a real server registered by the test; the blog was
not started with an `agent` section. HTTP streaming, the anti-forgery check and the panel are
tasks 6 and 7.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
