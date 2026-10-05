# Pilot Checklist: The App's Boundary

Section 1 of the [pilot checklist](pilot-checklist.md). Everything that writes
depends on it. Next: [hosting and the database](pilot-checklist-hosting.md).

## 1. The app's boundary (blocks every write)

What the app does, read from source (not run). Every Approvals command event
(`approval-workflow-command`, `approval-invitation-command`,
`approval-template-command`) is wrapped by `protectedAction` in
`plugins/users/boundary.ts`. It verifies the signed token (`verifyActorSession`
in `plugins/users/authority.ts`, HS256 against the session seed, requiring
`id`, `roles` and `authEpoch`), re-reads the person (`currentActor`: profile
active, `user_access_state.state` ACTIVE, `auth_epoch` equal to the token's),
and then requires a valid anti-forgery token whenever the method is not GET or
HEAD, **or** the wrapper was declared `mutation: true`, which all three command
events are. It also takes row locks using `requestId`, `templateId` or
`invitationId` from the input and, if absent, from the request path.
What the agent sends: a new request with the person's session cookie entries
and only the tool's arguments, at the original chat route's path without its
query (`/agent/turn`, `/agent/actions/<id>/approve`, `/agent/actions/<id>/undo`).
The anti-forgery check compares the token held in the session with a `csrf`
field in the request data; the agent's request has the session half and no
data half, so a command should be refused with a 403 (`FORBIDDEN`); this is the
prediction item 1.2 tests.

- [ ] **1.1 Prove reads get through.** In a disposable database (a fresh local
  PGlite `DATABASE_URL`, never the staging or live one) with a seeded person,
  register a scratch tool for event `approval-workflow-read`, method `GET`, and
  call it as a person. Fastest: `collectTools` and `callTool` from
  `stackpress-ai/scripts` with `{ kind: 'person', profileId, roles, scopes: [] }`
  and a request carrying a session made by the app's own `issueCurrentSession`
  (`plugins/users/session-issuer.ts`); the shape is in
  `packages/stackpress-ai/tests/tools.test.ts` ("person session forwarding").
  Fullest, with no provider key: drive `POST /agent/turn` with a scripted model
  passed through `createRuntime`'s `connect` option, as
  `templates/blog/plugins/app/agent.ts` does.
  Pass when: input `{ operation: 'WORKSPACE', view: 'OWNED' }` answers code 200,
  `status: 'OK'`, with the same rows the person's page shows; a signed-out and a
  tampered-token caller are refused. This works only if the tool's method is
  GET: reads are wrapped with no `mutation` flag. From: proof of session
  forwarding, task 2 notes.
- [ ] **1.2 Baseline: a write is refused.** Same setup, scratch tool for
  `approval-workflow-command`, method POST, input a valid `CREATE` (a UUID
  `operationId` and `creationId`, a complete `draft`).
  Pass when: the answer is 403 and no row appears in `request` or
  `request_command_receipt`. That confirms the boundary, not the package, is
  what refuses. If it unexpectedly commits, stop and tell the owners: the
  anti-forgery check is not doing what it appears to do. Changing the tool's
  method to GET does not help (`mutation: true`); `approval-template-command`
  and `user-access-command` also refuse any method but POST. From: proof of
  session forwarding, "still unknown" paragraph.
- [ ] **1.3 Decision: how a write passes the boundary.** The realistic options:
  1. *Accept the agent in the shared boundary.* In `protectedAction`, skip the
     anti-forgery check when `caller(req)?.kind === 'person'` (`caller` is
     exported by `stackpress-ai`). The record is written only by the package
     after it verified the session, and tool input cannot set it; the chat
     route already checked the token on the request that started the run. Cost:
     the app's core security file imports `stackpress-ai` and gains an
     exemption; every handler that checks the token itself instead of using
     `protectedAction` needs its own change (`user-access-command`, the email
     route, guest links, participant provisioning, the theme route); any
     in-process code that can mint a `person` caller bypasses the token.
  2. *Separate agent entry events.* New events (for example
     `agent-approval-command`) wrap the same domain functions
     (`executeApprovalCommand` and the like) behind a boundary variant that
     accepts a `person` caller instead of the token, leaving the existing
     events untouched. Cost: new event set, shared wiring to keep in step (post-commit
     notification scheduling, file cleanup after CANCEL live in the handler
     today), but it is also where items 1.5 and 1.6 and the route-only actions
     in the tools file get solved. A reading of the source, not a test: this
     fits the app's fail-closed design best; it is still the owners' call.
  3. *Package change.* Make the package copy the session's token into the
     forwarded request's data under `csrf.name`. The app's handlers already
     tolerate or strip that field. Cost: a change in `stackpress-ai` that does
     not exist and is not planned; every app's tool events would receive an
     extra field; strict validators that do not ignore it would refuse.
  4. *No agent writes.* The first trial offers read tools only, or the agent
     only prepares and the person submits through the app's own forms. Cost: the
     pilot would not exercise approval, undo or the action log.
  Pass when: the choice and its reasons are in the spec's decision ledger.
  From: brief, GAP-001, GAP-011.
- [ ] **1.4 Prove the chosen option with a real call.** Using the disposable
  database and the real events.
  Pass when all of these hold: the write commits and returns `operationId` and
  a `request.revision`; the same `operationId` replays with `replayed: true` and
  one receipt row; a stale `expectedRevision` answers 409 `CONFLICT`; after the
  person's `auth_epoch` is bumped (an admin `UPDATE_USER` access change, or
  `REMOVE_USER`) the same call answers 403; a signed-out caller is refused; a
  person acting on another person's request gets the same refusal as through
  the page; and, for option 1 or 2, an ordinary browser POST with no token is
  still refused. `plugins/users/tests/boundary-matrix.test.ts` passes with a new
  row for the agent path. From: GAP-001, J-001, J-004.
- [ ] **1.5 Method and path: nothing may depend on them.** The boundary and
  several handlers read the path. Show, for each tool that will exist, that its
  input carries every identifier the page route would have taken from the
  address (`requestId` for all but the CREATE family, `creationId`, `templateId`,
  `invitationId`), and that the boundary takes the same row locks as the page
  route does (compare the lock queries in a test).
  Pass when: no tool relies on the path, and each tool declares the method its
  event needs (reads GET, commands POST). Route handlers that read the path
  or the query string cannot be tools as they are; they are listed in [the tools file](pilot-checklist-tools.md).
  From: GAP-001, task 2 notes (the agent keeps the path, drops the query).
- [ ] **1.6 Decision: a revoked person and the model.** The agent's own check
  of who is chatting (`ctx.plugin('session').load(req).data()`) verifies the
  token's signature only. Approvals' check also compares `authEpoch` with
  current state, so a revoked or removed person's old token still passes the
  agent's check, and they can send messages (spending provider tokens against
  their own daily limit), list threads and re-read their own earlier transcripts,
  until a tool event refuses them. Options: (a) accept: the cost is bounded by
  `agent.limit` and old transcripts are the person's own, but review whether
  tool results held in them should still be readable; (b) register the app's
  existing `plugins/users/route-guard.ts` (it does `verifyActorSession`,
  `currentActor` and, for POST, the token check) on `/agent/**`, one line next
  to its `/admin/**` registrations at priority 3000; confirm it runs before the
  package's routes and that the package panel's token reaches it in the body
  field it reads (the package accepts body or `X-CSRF-Token` header; that guard
  reads the body); (c) change the package so the agent asks the app who the
  person is; no such hook exists today.
  Pass when: with the choice made, revoke a person as in item 1.4 and send
  `POST /agent/turn`: under (b) it is refused before any provider call and
  the usage row is unchanged; under (a) the measured cost is recorded.
  From: brief, task 5 notes.
- [ ] **1.7 Operation identifiers and revisions.** Every command needs a UUID
  `operationId`, creates need a UUID `creationId`, and every command on an
  existing request needs a positive `expectedRevision` from a prior read.
  **Decision:** who supplies the UUIDs: the model, as tool input (a model can
  invent or reuse one; a reused id with different intent is a conflict, a reused
  id with the same intent replays safely), or the app's tool wrapper, which
  generates one per run (option 2 of item 1.3 makes this natural). Also: the
  package cuts a tool's output at 20,000 characters, so a request-detail read
  must put `request.revision` early or the app must trim the output, or the
  model will not see the revision it needs.
  Pass when: a committed command's log row (`agent_action.operation`) equals the
  app's receipt `operationId`. Set the tool field `operation` to the path in the
  result (`operationId` for `approval-workflow-command`, whose success result
  carries it at the top level); the default path is `operation`, which no
  Approvals result has, and results of `user-access-command` carry no such id.
  And: the largest real request's detail read reaches the model with its
  revision intact. From: GAP-007, J-001, task 5 notes.
