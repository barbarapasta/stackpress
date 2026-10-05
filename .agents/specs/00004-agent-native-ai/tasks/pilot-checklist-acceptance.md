# Pilot Checklist: Panel, Journeys, Limits

Sections 4 to 7 of the [pilot checklist](pilot-checklist.md). Follows
[tools and the action inventory](pilot-checklist-tools.md).

## 4. The OfficePress panel

The package's plain panel (`stackpress-ai/client`, `AgentPanel`, styles in
`stackpress-ai/styles.css`) is a reference. Approvals builds its own to the
OfficePress design file (`officepress.pen`, in the OfficePress repository's
`.agents/resources/officepress-design/`) on the same routes, using the plain
pieces `createClient`, `createPanel`, `usePanel`, `applyEvent` and `fromThread`
from the same entry. The approved Approvals wireframe does not contain this
panel; record that as a decision gap in the pilot spec (item 0.1).

- [ ] **4.1 Header control and layout.** The agent button is the second of four
  36 px outlined circles ending the app header, in the order notifications,
  agent, theme, user. It opens a 400 px panel docked right under the header that
  pushes the page content; on a narrow screen it is a full-height sheet.
  Check the app's own shell (`plugins/approvals/views/ui/shell.tsx`, which
  changed after the branch the inventory was read from) to see which of the four
  controls exist. Pass when: measured in a browser at wide and narrow widths
  against the design file, with the page content reflowing rather than being
  covered. From: DEC-010.
- [ ] **4.2 Panel contents.** Header with the agent mark, the name
  `<App> Agent`, a status line, and New chat, History, Expand and Close
  controls. A context bar of removable chips. The thread: user and agent
  messages, follow-up chips, action cards (action name, a result line, Done or
  Running, Undo). The composer: Attach, a model picker, Send. An empty state
  with a greeting and four starter prompts. Included in the first trial: chat,
  context items, action cards, the approval click, undo, history, new chat, the
  model picker, file attach. Left for later: mention, voice, and the Agent tabs
  in notifications and settings. Pass when: each first-trial control works
  against the real routes and the later ones are absent. From: DEC-010.
- [ ] **4.3 Decision: two details the design cannot meet as drawn.** The
  composer line reads "Every action is logged and can be undone." Irreversible
  actions have no Undo (and under item 3.2 option (a) none do), so the wording
  needs the owners' decision. The picker defaults to "Auto"; the package has no
  automatic choice, only `agent.model` and the `agent.models` list, so "Auto"
  is either the default entry given that title or a new rule. From: DEC-010,
  DEC-012.
- [ ] **4.4 The page follows the agent.** The design says the page reflects
  agent changes as they happen. The plain panel reloads the page once after a
  run that finished an action and restores its place from `sessionStorage`; the
  `onRefresh` prop replaces that. Approvals' pages keep state in the address
  (`stableRequestPath`, queue filters). Pass when: after a Done card, the open
  request or queue shows the change without losing the selected request, the
  filters or the scroll position. From: R-011 (design file), J-001.6.
- [ ] **4.5 Context items and the app's themes.** Approvals pages declare the
  items the agent should know about (the open request's id and title, the queue
  view, the template) through the panel's `context` prop; an `ai-context`
  listener may enrich them. The panel must also follow the app's per-person
  themes (Standard and Routing Slip): the plain panel reads `--bg-first`,
  `--default` and `--info` and falls back to plain colours. Pass when: both
  themes pass a contrast check on the panel, and tampering with a context item
  (another person's request id) changes nothing the app permits. From: DEC-014,
  J-006.


## 5. One acceptance check per journey

Run each on the deployed host with the chosen provider. If no tool qualifies
as reversible after item 3.2, say so in the result of J-001 and J-003 instead of
substituting something else.

- [ ] **J-001 Reversible action from chat.** Ask for a reversible action (for
  example, "copy request X as a new draft"). Pass when: the card goes to Done
  with Undo, the app's receipt exists, `agent_action` holds the tool, status
  `done` and the `operationId`, and the page shows the draft.
- [ ] **J-002 Irreversible action with approval.** Ask the agent to submit a
  draft. Pass when: a waiting card shows the action and its inputs and nothing
  has run (no receipt); Approve runs it once with no Undo and the turn
  continues; Decline records the refusal and the agent says so; after a page
  reload, and after approving from a different server instance, the stored
  turn is found; a double click, or a second approval, runs nothing twice (one
  receipt); a new message, or `approvalTtl` passing, expires the pending card.
- [ ] **J-003 Undo.** Undo one finished action, then make one undo refuse
  (change the record first, so its revision moves). Pass when: the first card
  shows Undone and the log links the undo to the original; the second shows the
  app's reason. Blocked if item 3.2 is option (a).
- [ ] **J-004 The app refuses.** As a USER, ask for an admin action and for an
  action on someone else's request. Pass when: each answers the same status the
  page would (403 or 404), the card shows Failed with the app's reason, the log
  records the refusal, and nothing changed.
- [ ] **J-005 A personal security step.** Ask to reset a password, change an
  email, or sign out. Pass when: the agent has no such tool, says so, points to
  the account page, and nothing is logged.
- [ ] **J-006 Page context.** Remove a chip, confirm it is not sent; edit the
  context a request carries to name another person's request. Pass when: the
  removed chip is absent from the stored turn's context and the tampered one
  widens nothing.
- [ ] **J-007 History, new chat, model choice.** Pass when: History lists only
  the person's threads; another person's thread id answers 404 with the same
  text as a missing one; New chat starts empty with the current context; a
  model switch mid-thread answers from the next reply with earlier turns
  rebuilt (run it across two providers if two are configured).
- [ ] **J-008 Usage limit.** Set `agent.limit` low. Pass when: after reaching
  it the next message is refused with 429 and `resetsAt` before any provider
  call, `agent_usage` is unchanged by the refused message, and the panel shows
  the limit state with History still readable. Usage is counted per UTC day.
- [ ] **J-009 Sign-in ended or wrong person.** Use an expired token, a revoked
  person (item 1.6) and a different signed-in person. Pass when: a message, an
  approval and an undo are each refused with no provider call and no tool run;
  another person's approval is refused and the action stays pending; the owner
  signing in again can approve it.
- [ ] **J-010 Attach a file.** The chosen route of item 3.4, end to end. Pass
  when: the file is stored and attached once, the log holds the reference, and
  a made-up reference is refused.

From: J-001 to J-010 in this spec's journeys, and DEC-009, DEC-010, DEC-012.


## 6. Inherited limits and open choices

Known and left alone. Reproduction is given where it is not obvious.

- **Done, side quest 00001B.** A verified or public caller whose key sees no
  tool now connects and gets an empty tool list over Streamable HTTP (both modes)
  and SSE, where it used to get a 500. A refused key is still 401. stdio still
  fails when the whole registry is empty. It only matters if the `mcp` section is
  enabled, which this pilot should not do.
- **Done, side quest 00003B.** While the plugin is active, the package answers
  403 to the generated update, remove, restore, purge, upsert and batch events of
  `AgentTurn`, `AgentAction` and `AgentUsage`, and to a create from anywhere but
  its own store. A thread stays editable; only its purge is refused. The admin
  list and detail pages still load. Item 2.7 still describes the app's own
  guards, which the package no longer needs for these records.
- **Concurrency** was tested on an in-memory database only (item 2.5).
- **Provider coverage:** only OpenRouter has run live (item 2.6). A missing
  key, or a provider whose SDK is not installed, answers "unavailable".
- **CommonJS `import.meta`.** The package's CommonJS plugin entry cannot be
  loaded by plain Node; it predates this work and affects several Stackpress
  packages. Reproduce: `npm install stackpress-ai@0.10.8` (the published copy)
  and `node -e "require('stackpress-ai')"` gives `SyntaxError: Cannot use
  'import.meta' outside a module`. With the packed build and `ts-morph` installed, 8 of its 17 import
  paths fail the same way in plain Node, and all 17 load as ES modules (checked
  2026-10-05 in a clean directory). A fix
  would be a change across the packages.
- **Stuck marks.** If a server stops while running an approved action, the
  action stays `approved` and is never rerun (it may have run). If it stops right
  after an undo was claimed, the original shows `undone` though the inverse
  did not run. In Approvals the receipt can settle the truth by `operationId`;
  decide who reconciles. Show: kill the function mid-run and look at History.
- **Tool output** is cut at 20,000 characters (item 1.7). A refused action's
  stored text can carry the status appended ("... (409 Conflict)").
- **No background runs.** The turn event needs a signed-in person's session, so
  the app's Inngest jobs cannot call it.
- **The forwarded request carries the person's whole session**, including the
  anti-forgery cookie, so any tool event can read it. Agent calls refresh the
  person's `last_active_at` (every tool passes through `recordActorActivity`).
- **Minor:** a person who opens New chat and never sends leaves one empty row in
  History; turns written in the same millisecond by two servers can order by a
  random part; two store methods (`declineAction`, `markUndone`) have no caller.
  From: 00001B, 00003B, task notes 1 to 9.


## 7. What the Approvals spec links back to

The Approvals spec is the home for the application changes and their evidence.
Its brief and decision ledger should link to this spec so the agent's
requirements stay in one place:

- this spec folder, `.agents/specs/00004-agent-native-ai/` in the Stackpress
  repository (`stackpress/stackpress`; written on branch `stupid-bat`, so give
  the commit or release you actually installed);
- its decisions: the agent acts as the signed-in person; the pilot covers every
  action except identity steps; the panel follows the OfficePress design file;
  irreversible actions need one approval; no provider keeps conversation state;
  and the open gap about installing an unreleased package;
- this checklist (both parts), and the package README
  (`packages/stackpress-ai/README.md`, especially "Turn the agent on", "Known
  limits" and "Where things are imported from");
- the OfficePress findings file `research-officepress.md` and
  `proofs.md` (their "still unknown" paragraphs are items 1.2 and 2.4).

Results go in the Approvals spec's evidence, not in this spec, which is frozen.
A defect or missing feature in `stackpress-ai` found by the pilot becomes a
task in the Stackpress repository under its own spec workflow, linked from the
Approvals spec.
