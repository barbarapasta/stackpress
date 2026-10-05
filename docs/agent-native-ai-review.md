# Agent-native AI feature review

Reviewed 2026-10-05 on `stupid-bat`, HEAD `9516c31`.
Scope: commits `f6f51a2`, `9a7f0f8`, and `9516c31`, against `a71d683`.

The initial read-only review found the issues below at HEAD `9516c31`. The user
authorized their repair on 2026-10-05. Corrections and fresh verification are
recorded under [task 00010B](../.agents/specs/00004-agent-native-ai/tasks/00010B-review-corrections.md).
The findings below preserve the original evidence; they describe the reviewed
commit, not the final corrected code. The accepted product decisions remain
unchanged.

## Correction outcome

All eight confirmed findings are corrected in the working tree. Sonnet 5.5
agents implemented the changes; the primary agent reviewed the combined code
and reran verification. The user authorized committing these corrections on 2026-10-05. Nothing is
pushed, and the pilot application was not edited.

| Finding | Corrected behavior |
| --- | --- |
| Blog permission bypass | App-owned events enforce the same admin route access for publishing, removing comments and undo. External user keys also require current profile roles; app/public callers are refused. |
| Stale work after a new message | A stored message token fences replies, proposals and claims across runtimes. A thread gate prevents accepting a cancellation message while an approved or automatic write still runs. |
| Concurrent daily allowance | A durable per-person slot atomically rechecks usage before admission and counts tokens before release, against the day the call began. One response may still exceed the remaining allowance. |
| Changed approval action | Approval requires the stored execution-contract digest to match the offered tool. Changed or missing digests require a fresh proposal. |
| Undo invisible to the model | Both immediate and gated tool results link their actions; rebuilt transcripts include the inverse outcome without changing stored turns or provider raw replies. |
| History stops at 1,000 | Turn and action histories paginate to completion. Thread turn identifiers increase across stores even with frozen or differing clocks. |
| Unanswered MCP action succeeds | Shared failure mapping rejects code zero while preserving successful code 200 with a null result. Real MCP transport tests cover both. |
| Inconsistent public types | Root and types entries expose the same public server contracts. Source, built declarations and a packed consumer are checked; private/client types retain their own boundaries. |

The coding-standard pass removed the unused unreleased `declineAction` and
`markUndone` APIs, their redundant tests and the unreleased WeakMap compatibility
line. It corrected type/value import order within existing groups, the blog's
Node import group, three trailing blank lines, and misleading public-type
comments. Previously released `requiresSecret` remains for compatibility.
No new production `any` or TypeScript suppression was introduced.

Busy refusals now survive the routes and client as `busy`, preserving entered
text and waiting approval cards for retry. The offline blog model reports
failed operations honestly. Publishing also returns its previous status, which
undo restores.

## Correction verification

- Node 22 and Yarn; clean root CJS/ESM build passes.
- Full AI suite: **777 passing**, no failures or skipped declaration proof.
  Coverage: statements **96.09%**, branches **91.23%**, functions **96.59%**,
  lines **96.85%**. All four package totals meet the required target.
- Clean and repeat schema generation and real generated-handler tests:
  **28 passing**. The optional desktop package also builds.
  Fixtures use isolated PGlite databases and force offline adapters, regardless
  of the machine's provider environment. They leave the blog database alone.
- The four public-type tests check source and built root/types entries. A
  separate consumer of the packed package compiles those paths under strict
  NodeNext resolution and rejects an internal root type. Its dependency links
  reuse already installed packages; this is not a fresh registry installation.
- All **17 executable ESM export paths** load from that packed consumer.
  Packing twice produces identical bytes; the pilot fingerprint is updated.
- A scoped strict type check of the changed blog files reports only the
  pre-feature `contributeDesktopMenu` generic mismatch at `plugin.ts:48`.
  It is documented as baseline debt, not claimed as a passing strict check.
- Full feature-range whitespace and agent-workspace checks pass; the validator
  retains one existing preferred-length warning for reference 00010.
- Mutation checks reported by the implementing agents detect disabled claim,
  admission, reply and ordering fences, and disabled blog authorization. The
  primary agent reran the unmutated combined suites.

The coordination checks use PGlite, not deployed Postgres/MySQL or Vercel.
No live provider call or new browser session was needed for these corrections;
previous direct-provider and accessibility evidence limits remain. Locks are
never stolen automatically: a stopped worker or failed usage write can require
operator reconciliation and clearing that specific holder after work ends.
The updated schema adds `AgentLock` and action token/digest columns, so an
existing installation must regenerate and migrate before using this build.
Native Node CommonJS still rejects the inherited `import.meta` in the plugin;
this was reproduced from the packed build and is not hidden by the ESM proof.

## Authority and method

Repository requirements come from `AGENTS.md`,
[Extension and Contribution](../.agents/context/extension-and-contribution.md),
[Contributor Source Patterns](../.agents/references/00018-contributor-source-patterns.md),
and the [public surface workflow](../.agents/workflows/stackpress-package-public-surface.md).
Behavior was checked against spec 00004's accepted decisions and task contracts.
Nearby source was used to establish conventions, not to excuse known defects.

Sonnet 5.5, medium reasoning, auto mode performed a separate read-only standards
review. The primary reviewer checked its findings against source and rejected
unsupported suggestions, including removing the required `react-shiki` peer,
calling the identity WeakMaps a violation, and treating agreed prototypes as an
unauthorized layout change. No formatter or lint rules were invented.

Reproductions used real Ingest sessions, isolated PGlite databases and scripted
model replies. The permission reproduction also used the blog's real generated
Article update handler and its actual tool definitions and access rules.
No running blog instance, existing database, external app or provider key was used.

## P1: Blog tools bypass the user's normal permissions

Sources: [blog tools](../templates/blog/plugins/app/agent.ts:39),
[tools offered to the model](../packages/stackpress-ai/src/scripts/agent.ts:327),
and [session access](../templates/blog/config/common.ts:605).

Current behavior: USER has access to `/agent/**` but no article admin access.
The agent offers every `agent: true` tool and publishing invokes `article-update`
directly. Generated SQL events validate data and access the database; they do
not run the route's authorization checks. The MCP `type` and `scopes` settings
do not authorize a built-in person caller. Carrying the session is insufficient.

Reproduction: a USER session could not access the article admin update route
(`mayAdmin: false`), but its agent turn returned `done` and the isolated
article's stored status changed from `DRAFT` to `PUBLISHED`.

Test gap: the browser evidence uses an administrator. The application test
command runs zero tests. Framework tests with deliberately guarded fixture
events do not prove that these generated blog events enforce authorization.

Suggested change: expose app-owned operations that enforce the same permission
and record rules as the corresponding UI action. Use them for publish,
unpublish and comment removal, including undo. Test USER/MANAGER refusal and
ADMIN success with actual handlers; do not merely check a fake handler.
DEC-001 requires the agent to act within the person's existing access.

## P1: A newer message does not reliably invalidate older work

Sources: [new message](../packages/stackpress-ai/src/scripts/turn.ts:158)
and [approval creation](../packages/stackpress-ai/src/scripts/turn.ts:444).

Current behavior: messages and model/tool execution have no durable per-thread
coordination. Appending a user message expires approvals that already exist,
but an older in-flight model reply can create a fresh pending approval later.
It can also execute reversible writes after the newer message has arrived.

Reproduction: hold the model reply for "Cancel REQ-1"; send "Do not cancel it;
ignore my earlier message"; release the old reply. The old cancellation still
creates a `pending` action. Approving it succeeds and runs `request-cancel`.

Test gap: expiry tests address pending actions that exist before the new
message. They do not interleave a new message with an unfinished provider call.

Suggested change: add durable thread execution coordination and a turn revision
or cancellation check before creating or executing actions. A stale run must
not create actionable approval cards. Verify across separate runtime instances,
including message/approval races. A process-local mutex would not cover hosts
that construct a fresh server for each request. GAP-019 promises invalidation
when a newer message arrives.

## P1: Concurrent requests bypass the daily allowance

Sources: [limit check](../packages/stackpress-ai/src/scripts/turn.ts:222),
[usage recording](../packages/stackpress-ai/src/scripts/turn.ts:255),
and [usage lookup](../packages/stackpress-ai/src/scripts/agent.ts:428).

Current behavior: allowance is read before each provider call and charged only
after the response. Concurrent calls can all observe the same unused allowance.
Atomic usage increments count the spend but do not prevent the calls.

Reproduction: with a limit of 10 and two simultaneous chats by the same person,
both provider calls start and return `done`; recorded usage is 20. This is
separate from the ordinary possibility that one reply exceeds the remaining
allowance. More simultaneous calls expand the bypass.

Test gap: existing limit checks are sequential; concurrency tests verify usage
addition, not admission of provider calls.

Suggested change: coordinate admission durably per person across threads and
runtime instances, or reserve allowance atomically and reconcile usage.
Recheck after acquiring the right to call the provider. DEC-002 requires a
per-person daily limit; retain an explicit policy for a single call's overshoot.

## P2: Approval can execute a different event from the recorded proposal

Source: [approval execution](../packages/stackpress-ai/src/scripts/approval.ts:63).

Current behavior: approval reloads the current tool by name and runs its current
configuration. It does not compare that configuration to the action's saved
`event` or bind static tool data to the proposal the person reviewed.

Reproduction: propose `request_cancel` for `request-cancel`, then change the
registry's event for that name to `request-poke`. Approving runs `request-poke`,
while the stored action identifies `request-cancel`.

Test gap: tests handle a removed tool, but not a retained name whose operation
changed, as can happen during a deployment or a plugin configuration update.

Suggested change: bind proposals to their execution contract and reject changed
contracts with a fresh-approval requirement. At minimum compare the saved event;
also account for static data, method and other operation-changing fields.

## P2: Undo is invisible to subsequent model requests

Sources: [automatic tool results](../packages/stackpress-ai/src/scripts/turn.ts:483)
and [action refresh](../packages/stackpress-ai/src/scripts/agent.ts:534).

Current behavior: reversible calls store a tool result without its action id.
Undo writes action records but adds no model-visible conversation event.
Even results that carry an action id treat `done` and `undone` identically.

Reproduction: issue a receipt and undo it. Stored actions correctly show
`ledger_add: undone` and `ledger_void: done`. Rebuilding the transcript still
says the entry was created, with no notice or result of the void.

Test gap: current undo tests prove the inverse ran and records were linked.
They do not verify what the next provider request knows about that undo.

Suggested change: associate all executed tool results with their action records
and supply model-visible undo outcomes when rebuilding the transcript. Preserve
append-only history and valid tool-call/result pairing. Verify both automatically
run and approval-gated reversible actions.

## P2: Long chats permanently omit new messages

Source: [turn lookup](../packages/stackpress-ai/src/scripts/store.ts:350).

Current behavior: `listTurns` takes the oldest 1,000 rows in ascending order.
It supplies both the panel history and model transcript. Newer messages and
results silently disappear from that input once the cap is reached.
`listActions` uses the same oldest-first cap.

Reproduction: seed 1,000 turns, then send a new message. The run returns `done`
and stores its reply, but the provider request contains none of the new message.
The database contains 1,002 turns afterward.

Test gap: store tests cover order and ownership with short histories.

Suggested change: paginate to obtain the complete transcript as specified, or
introduce an explicit bounded-history policy that retains the newest message
and complete tool-call/result groups. Never silently replay only the oldest
prefix. DEC-015 specifies sending the full locally stored conversation.

## P2: Shared tool execution reports an unanswered MCP action as success

Sources: [failure predicate](../packages/stackpress-ai/src/scripts/tools.ts:179)
and [MCP result](../packages/stackpress-ai/src/plugin.ts:132).

Current behavior: an unanswered event produces code 0 and no error. `failed`
accepts it, so MCP returns successful text `null`. The built-in agent separately
rejects code 0. The shared mechanism therefore leaves the two surfaces with
different failure semantics.

Reproduction: register a tool for an event with no listener. The MCP callback
returns `{"content":[{"type":"text","text":"null"}]}` without `isError`.

Test gap: failure coverage verifies explicit error responses and the agent's
missing-handler branch, but not this MCP path.

Suggested change: normalize an unanswered event into a failure in shared
execution and assert both MCP and agent behavior. Preserve valid successful
responses whose result is legitimately null.

## P2: Public shared types do not follow the required export contract

Sources: [root exports](../packages/stackpress-ai/src/index.ts:74),
[runtime types](../packages/stackpress-ai/src/scripts/agent.ts:34),
and [store types](../packages/stackpress-ai/src/scripts/store.ts:20).

Current behavior: `AgentRuntime`, `RuntimeOptions`, `Sink`, `AgentStore`,
`Approval`, `NewAction`, `NewTurn` and `Outcome` are root public but absent from
`stackpress-ai/types`. `ToolRequest`, `ResolvedResponse` and `ProviderOptions`
are defined in `types.ts` and used in public contracts but omitted from the
root's shared-type exports. The claim that all types remain available from
`stackpress-ai/types` is therefore false.

Required rule: shared public types must be defined or re-exported from
`src/types.ts` and exported with `export type` from `src/index.ts`.

Suggested change: align both type barrels and the documented classification,
keeping genuinely subpath-specific/private types private. Add consumer type
checks for both promised import locations; runtime `Object.keys` cannot verify
an erased type export.

## Coding-standard cleanup

- Task 00009 explicitly requires removing dead code. `declineAction` at
  `scripts/store.ts:460` and `markUndone` at `:517` have no production caller;
  only tests use them. Remove these unreleased alternate state-transition APIs
  or justify an intended public use. Keep the previously released
  `requiresSecret` export for compatibility.
- Group the newly added `node:crypto` import under `//node` in
  `templates/blog/plugins/app/plugin.ts:5`; it currently sits among module
  imports. Normalize type/runtime import ordering using the existing package
  convention. Keep two-space indentation, single quotes and ESM `.js` suffixes.
- The committed-range `git diff --check` fails on blank lines at EOF in three
  pilot checklist files. A clean worktree alone did not prove this check passed.
- There is no repository-wide lint configuration defining an 80-column hard
  limit, a classes-only rule, or 90% coverage for every individual file. These
  must not be presented as CTO requirements. Large closures and repeated casts
  deserve targeted clarity improvements, not a wholesale rewrite on preference.

## Initial review verification and limits

- Node.js 22 and Yarn used throughout.
- `yarn ai test`: 739 passing. Coverage: statements 96.51%, branches 91.80%,
  functions 96.56%, lines 97.20%. This meets the package target.
- `yarn build`: root build passes, including CJS/ESM compilation.
- `yarn test`: server 13, schema 69 and SQL 23 tests pass. Their existing
  coverage is below the new-work target; these packages' source was not changed
  by this feature, so that is recorded as existing coverage debt.
- `yarn blog test`: exits successfully but discovers zero tests. It supplies no
  application regression protection for the new tools or access rules.
- The isolated reproductions above all completed and confirmed the findings.
  Scripts and command logs are in `/tmp/stackpress-ai-review-*` on this host.
- AgentPanel statement coverage is 47.82%; hooks coverage is 58.20%. Earlier
  browser evidence exists. A low individual-file figure does not violate the
  package target, but browser focus and effect regressions lack suite coverage.
- Agent-workspace validator passes with an existing preferred-length warning
  for reference 00010 (208 lines). Feature-range whitespace check fails as noted.
- Plain Node 22 `require('stackpress-ai')` still throws on `import.meta` in
  built `cjs/plugin.js`. This is an inherited, documented cross-package defect,
  not a new source-style violation. A successful TypeScript build does not
  demonstrate native CommonJS importability.
- No live provider calls or fresh browser run were made during this review.
  Direct Claude/OpenAI live support and hosting-platform behavior retain their
  existing evidence limits. Approvals was not changed or used for reproduction.
