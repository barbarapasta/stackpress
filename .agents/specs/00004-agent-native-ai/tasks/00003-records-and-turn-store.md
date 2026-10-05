# Task 00003: Records And Turn Store

## Task Summary

Add the stored records the agent needs and a store over them: threads, turns,
actions, and usage. Decisions: DEC-002, DEC-004, DEC-015, GAP-007, GAP-019.
Journeys: J-002, J-003, J-007, J-008, J-009.

Model and field names below are proposed. Record any change in Implementation
Notes.

## Implementation Steps

1. Add `packages/stackpress-ai/schema.idea`, following the conventions in the
   `stackpress-api` and `stackpress-session` schema files, and list it in the
   package `files`:
   - `AgentThread`: owner profile, title, chosen model, active flag, created and
     updated times.
   - `AgentTurn`: thread, role, text, tool calls, tool results, file
     references, provider, model, the provider's raw reply, input and output
     tokens, created time.
   - `AgentAction`: thread, turn, acting profile, tool name, event, input,
     status, result, error, the app's operation identifier, the action it
     reverses, irreversible flag, expiry, created and updated times.
   - `AgentUsage`: profile, day, input tokens, output tokens, turn count.
2. `templates/blog/schema.idea`: add the `use` line for the package schema.
3. `src/scripts/store.ts`, a store over the generated model events, the way the
   package already reads applications and sessions through events:
   - create a thread, list a person's threads, and load one thread only for its
     owner.
   - append a turn. Stored turns are never edited or deleted.
   - create a pending action, approve it, decline it, and mark it done, failed,
     or undone. Approving an action that is already settled returns the stored
     outcome and changes nothing.
   - expire pending actions when a new message arrives in the thread or the
     configured time has passed.
   - add usage for a person and day, and read a person's usage for today.
4. Tests for the store with the package's context stub: owner isolation, append
   only, pause and resume, repeated approval, both expiry rules, usage totals.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with coverage above 90%.
- `yarn blog generate` succeeds and the generated client compiles.
- The development database accepts the new tables through the template's
  normal push command.

## Acceptance Criteria

The generated admin list of agent actions in `templates/blog`, showing who did
what and when.

## Implementation Notes

All four steps are done. Every proposed model name is kept. Field names are kept
except where listed under "Deviations".

- `packages/stackpress-ai/schema.idea` (new, in `files`): `AgentThread` (profileId,
  title, model, active, created, updated), `AgentTurn` (threadId, role, text,
  toolCalls, toolResults, files, provider, model, raw, inputTokens, outputTokens,
  created), `AgentAction` (threadId, turnId, profileId, tool, event, input, status,
  result, error, operation, reverses, irreversible, claim, expires, created,
  updated), `AgentUsage` (profileId, day, inputTokens, outputTokens, turns, created,
  updated). Status is an enum (pending, approved, declined, done, failed, undone,
  expired). `Profile` gets the reverse relations. The package gains a
  `stackpress-session` dependency and three dev dependencies for the tests
  (`@electric-sql/pglite`, `@stackpress/inquire`, `@stackpress/inquire-pglite`),
  all already in `yarn.lock`.
- `templates/blog/schema.idea`: the `use` line. `src/scripts/store.ts` (new, exported from `scripts/index.ts` and the package
  index): `createStore(ctx, { approvalTtl, now })`. A plain object of functions, no
  module-level state. Reads and plain writes go through the generated events
  (`agent-thread-create|detail|search|update`, `agent-turn-create|search`,
  `agent-action-create|detail|search`, `agent-usage-create|detail`), like
  `application-detail`. Methods: `createThread`, `listThreads`, `getThread`,
  `appendTurn`, `listTurns`, `createAction`, `getAction`, `listActions`,
  `approveAction`, `declineAction`, `completeAction`, `markUndone`,
  `expirePending(threadId?)`, `addUsage`, `getUsage`. No method edits or deletes a
  turn; a test pins the method list. `appendTurn` and `createAction` throw
  `Thread not found.` for anyone but the owner; the other calls return null or empty.
- Atomic claim. The generated `update` event cannot do it: it takes only the id as
  its filter, reads rows, merges, then writes, and the update builder's promise
  swallows errors. So the claim is one guarded SQL statement run through the
  `database` plugin's engine (`ctx.plugin('database').query(sql, values)`, the
  inquire engine, the same plugin the generated events use):
  `UPDATE agent_action SET status='approved', claim=<token> WHERE id=? AND
  status='pending' AND (expires IS NULL OR expires > now)`. No driver reports
  affected rows through the engine, so the winner is read back: the call whose
  random token is on the row is the only one with `claimed: true`, and it gets the
  token to settle the action. Every other call gets the stored record. `decline`,
  `completeAction` (needs the claim token and status `approved`), `markUndone`
  (status `done`) and both expiry rules use the same guarded form, so none of them
  can overwrite a state that changed in between.
- Usage: the row id is `<profileId>:<YYYY-MM-DD>` (UTC), so the primary key makes
  creation single-winner, and each addition is `UPDATE agent_usage SET
  input_tokens = input_tokens + ?, ...`, which adds in the database.
- Expiry (GAP-019): `appendTurn` with role `user` expires the pending actions of
  that thread before the turn is written; `approvalTtl` (milliseconds, a plain
  argument, not read from config) sets `expires` on new actions; `expirePending()`
  with no thread expires everything past its time, and `approveAction` settles a
  past-due approval as expired itself.
- `README.md`: Agent Records section, Migration line.

Deviations and things found:

- Relation field `thread` on `AgentTurn` and `AgentAction` is named `agentThread`.
  The generated store joins a relation by its table name but selects it by the
  relation name, so any relation whose name differs from its table's breaks: the
  generated admin list for agent actions answered 500 `missing FROM-clause entry
  for table "thread"` (the join was `INNER JOIN "agent_thread"` with no alias while
  the select used `"thread"."id"`). Existing models do not hit it because their
  relation names equal their table names. Naming the relation like the table fixes
  it. The generator was left alone, as the task is limited to this package.
- Generated JSON columns hold objects only: an array or scalar was stored as `{}`
  (seen live: `toolCalls` of `[...]` came back `{}`). `toolCalls`, `toolResults` and
  an action's `result` are therefore boxed as `{ "value": ... }` on write and
  unboxed by the store on read. The admin view shows the box. `input` is an object
  (tool arguments) and is stored as is.
- `raw` is a `Text` column, not JSON, so it is exactly as given. A string is stored
  as is; an object is stored as its `JSON.stringify` text and read back as that
  string. A test checks odd whitespace, key order, `1.0`, and unicode.
- The generated datetime columns keep whole seconds, so turns made in one second
  cannot be ordered by `created`. Turn and action ids are made by the store in
  time order (time, a per-store counter, random). Order is exact inside one store
  and across stores whose writes are 1 ms or more apart; two stores writing one
  thread inside one millisecond could order by the random part. Appends to a thread
  are serial and each takes several round trips, so I judged this acceptable, and
  a test says so.
- `claim` is a column so the claim survives across servers. The store never returns
  it; the generated admin routes do (shown in the evidence).
- The generated admin routes for `AgentTurn` still include update and remove, so an
  admin can edit or delete a turn there. "Never edited or deleted" holds for the
  store, not for those routes; this is for the admin-route task to decide.
- The pushed DDL has no default for the integer and boolean columns, so the store
  always sends them. `AgentUsage.id` is the profile and day, with no `cuid()`.


## Verification Notes

Run with Node 22.23.2 and Yarn 1.22.22.

- `yarn test` in `packages/stackpress-ai`. Before: 155 passing, 96.54% statements,
  92.21% branches, 95.09% functions, 97.18% lines. After: 198 passing, 0 failing,
  96.92% statements, 93.23% branches, 96.03% functions, 97.46% lines. 43 tests
  added in `tests/store.test.ts`; no existing test changed. `store.ts` is 99.12 /
  97.22 / 100 / 99.09; the uncovered line is the guard for a row that vanishes
  between the claim and its read-back.
- The store tests run over an in-memory PGlite database with the real inquire
  engine and the pushed tables. A small harness in the test file stands in for the
  generated model events over it, because those live in an application's generated
  client. The store's guarded statements are real SQL.
  Covered: owner isolation, append only, exact raw reply, pause and resume through
  a second store, repeated approval writing nothing, eight simultaneous approvals
  from eight stores giving one claimed (the row's claim is the winner's), approve
  against decline, settling only by the claim holder and only once, both expiry
  rules, usage totals, twelve simultaneous additions all counted, error paths.
- Limit of that proof: PGlite runs one connection, so the simultaneous tests prove
  the guarded statement and the token read-back give one winner, not that two real
  connections cannot interleave. That rests on a single `UPDATE ... WHERE
  status='pending'` being atomic in the database, which the SQL engines guarantee
  (inferred, not run against Postgres or MySQL here).
- Against the real generated events (throwaway script, deleted): two simultaneous
  approvals gave `claimed` true and false; an approve racing a decline left
  `approved`; three simultaneous usage additions totalled 30 / 6 / 3; a user message
  expired the pending action; a past-due approval was refused. This found the JSON,
  whole-second and relation-name problems above.
- `yarn build` in the package: succeeds, CJS and ESM. `yarn build` at the repository
  root: exit 0, run before the final whitespace-only edits; the package build was
  rerun after them.
- `yarn blog generate`: succeeds. `yarn blog push`: creates `agent_thread`,
  `agent_turn`, `agent_action`, `agent_usage` and their indexes in the development
  PGlite database. `yarn blog generate:client` also succeeds (it wrote
  `templates/blog/client-source`, which is gitignored and was removed afterwards).
- "The generated client compiles": the JavaScript conversion that the blog loads
  succeeds, and the blog served it. A strict `tsc -p templates/blog/tsconfig.json`
  over `client-source` does not pass: 626 errors, 198 in the four agent models and
  428 in existing models, with the same codes (unused imports in generated tests,
  `FieldProps` missing from `stackpress-view/client`, `ScalarInput`, `skip` of
  `{}`). I did not run it before this task, so "existing models fail the same way"
  is observed now, not shown to be unchanged.
- `git diff --check`: clean (untracked files checked separately). The workspace
  validator: warnings only, the same two older references; none new.
- Acceptance: [evidence/00003-agent-actions.md](evidence/00003-agent-actions.md) and
  [evidence/00003-seed-agent-actions.ts](evidence/00003-seed-agent-actions.ts). Form:
  the real data response of `GET /admin/agent-action/search?json`, 8 rows written
  through the store, with who, what, status and when. Not a screenshot: Chromium
  exists, but the blog's pages could not render here (`react-shiki` is not installed
  in this checkout, so the dev server dies in Vite; production pages need a view
  build). The file says so and has the commands to open the page later.
- Cleanup: server (port 3412), temporary config, throwaway scripts and
  `client-source` removed; no `.env` created. `push` drops every table, so
  `templates/blog/.build` was copied first and restored (`diff -rq` identical); it
  has no agent tables until the next `yarn blog push`. `blog-client` in the
  template's `node_modules` was regenerated and includes the agent models.
- Not verified: the store against Postgres, MySQL or SQLite (only PGlite); the
  blog's page UI; sign-in through the form (the evidence session came from the
  session plugin); the blog's own test suite.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
