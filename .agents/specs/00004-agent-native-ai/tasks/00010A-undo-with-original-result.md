# Task 00010A: Let An Inverse See What It Is Undoing

## Task Summary

Side quest of [Task 00010](00010-pilot-handoff.md). An undo runs the inverse
tool with the original action's stored input and nothing else. That is enough
for the sample blog app. It is not enough for an application whose every change
needs a fresh operation identifier and the record's current revision, or whose
undo needs something only the original's result holds, such as the id of the
thing it created. Operations Approvals is such an application, so none of its
actions could have a working undo.

Approved by the user on 2026-10-05 ("Fix it now"). The change is additive: an
inverse that needs only the stored input keeps working unchanged.

Names below are proposed. Record any change in Implementation Notes.

## Implementation Steps

1. When the runtime runs an inverse for an undo, record what is being undone
   against the request the inverse event receives, apart from its input, the
   way the caller record is kept: the original action's id, tool name, stored
   input, stored result, and operation identifier, plus the id of the new undo
   action so an application can derive a stable operation identifier from it.
2. Export a reader, `undoing(req)`, from the same place `caller(req)` comes
   from. It returns that record inside an undo and nothing otherwise.
3. Tool input can never set or reach that record, as with the caller record.
4. The inverse still receives the original's stored input as its input, so
   existing inverses need no change.
5. Capture the inverse's own operation identifier on the undo action, the same
   way a normal action's is captured.
6. In `templates/blog`, change the sample `article_unpublish` inverse to restore
   the status the article had before, read through `undoing(req)`, instead of
   always setting it to draft. This needs the publish result to carry the
   earlier status; if the template's event does not return it, record that and
   leave the sample as it is.
7. Tests: the record reaches the inverse event with the original's result; it
   is absent on a normal tool call; input cannot forge it; two loaded copies of
   the package agree; an inverse that ignores it behaves as before.
8. Update the README section on reversible tools and the pilot checklist item
   on undo to describe the new behavior.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with all four coverage numbers
  above 90%.
- `yarn build` in the package and at the repository root.
- The blog still generates, builds, and serves, and an undo there still works.

## Acceptance Criteria

A short recorded session against the reference app showing an action, its undo,
and the inverse event reporting what it was told it was undoing.

## Implementation Notes

Done 2026-10-05. Steps 1 to 5, 7 and 8 are done. Step 6 was not done as written, see below.

**The record.** `undoing(req)` returns `Undoing` (`types.ts`): `undoActionId` and
`original` (`id`, `tool`, `input`, `result?`, `operation` or `null`). It is kept like the caller
record: a `WeakMap` keyed by the request the event receives, in the store on `globalThis` under
`Symbol.for('stackpress-ai.tools')`, beside `callers`. A store made by an earlier copy of the
package lacks the new map, so it is added when missing. `callTool` takes the record as a new
optional last argument and sets it, so only code that calls it can; `execute` passes it through.
`undo()` is the only caller that does. `undoing` is exported from the package root, from
`scripts` and from the module `scripts/tools.ts`, beside `caller`. `tests/surface.test.ts` and the
README import table list it. Input cannot reach it: it is never read from data, and `withToolData`
is unchanged. The reader returns `undefined` for any request `callTool` did not give a record.

**The undo action's id.** It was already known: `undo()` logs the inverse with `createAction`
before it runs it, after `claimUndo` has been won. So no change to the flow was needed. The record
is built from that row's id and the original as `getAction` returns it (result unboxed, not the
storage wrapper). Only the call that wins the claim gets there, so a double click still runs the
inverse once with one record. A retry after the app refused is a new undo action, so a new id.

**Inverse's operation identifier.** No code change: `execute` already stores `operationOf(tool,
result)` for every action, inverse included. A test pins it. `undo.operation` in the response
and the stored row carry it.

**Step 6 (blog `article_unpublish`).** Not done. `article-update` is the generated event; it
returns `results[0]`, the updated row, which has the new status (`PUBLISHED`), not the earlier
one. Nothing carries the earlier status, so the sample still sets `DRAFT`, and the README says why.
Instead a permanent sample pair was added: `sample_receipt_issue` (reversible; its event makes a
receipt number and an operation identifier) and `sample_receipt_void` (its inverse; the event
reads `undoing(req)`, reports it, and returns `void-<undoActionId>` as operation). Tool entries
in `plugins/app/agent.ts` with comments, events in `plugins/app/plugin.ts`, and one branch in the
offline model ("issue a receipt for X"). They store nothing.

**Not changed.** The claim and its limits from task 5 (a server stopping after the claim).
`callTool` has a sixth argument but nothing else about it changed. No type or event of the agent
changed. README: the reversible tools section, import table, one Migration line.
Checklist: item 3.2 and three inventory rows in `pilot-checklist-tools.md`.


## Verification Notes

Node 22. Tests ran in `packages/stackpress-ai`.

- `yarn test`. Before: 725 passing, 96.5 / 91.83 / 96.55 / 97.2 (statements / branches /
  functions / lines). After: 739 passing, 0 failing, 96.51 / 91.8 / 96.56 / 97.2. Added: 9 in
  `tests/undoing.test.ts` (real server, session plugin and store; `ledger` events in
  `harness.ts`), 4 reader tests and 2 two-copy tests in `tools.test.ts`; the harness's `ran` log
  also records `undoing`, and the surface test lists the new name. Existing tests assert what
  they did.
- Mutation check, reverted (`diff -r` empty): not passing the record to the inverse, using the
  original's id as the undo id, and letting input set the record each made tests fail.
- `yarn build` in the package and at the repository root: exit 0.
- Blog (00003A recipe, port 3472, `.build` backed up and restored, temporary config and server
  removed): `generate`, `push`, `populate`, `build` (176 s) passed; it served and signed in; the
  new pair and the old publish undo both worked. Evidence:
  [evidence/00010A-undo-session.md](evidence/00010A-undo-session.md), from a script over HTTP.
- Read, not changed: the Approvals app needs a UUID `operationId`; an undo action id is not one.

- Built `cjs` and `esm` loaded in one Node process (a throwaway script, removed): a record set
  through either copy's `callTool` is read by both copies' `undoing`; with none given, both read
  nothing.

**Not verified.** No real provider, and no run of the Approvals app.

## Acceptance Notes

Accepted by the user on 2026-10-05 ("I think we're good now").
