# Pilot Checklist: Hosting And The Database

Section 2 of the [pilot checklist](pilot-checklist.md). Follows
[the app's boundary](pilot-checklist-boundary.md); next:
[tools and the action inventory](pilot-checklist-tools.md).

## 2. Loading, hosting and the database

- [ ] **2.1 Records and the database upgrade.** Add
  `use "stackpress-ai/schema.idea"` to `schema.idea` and generate; confirm
  `yarn test:schema` and `yarn typecheck` still pass (the package's own check
  of the sample app's generated client found strict type errors across all its
  models, so compare with your baseline). **Warning:** the app's `yarn push`
  runs `setupStore` (`plugins/store/setup.ts`), which only creates an empty
  schema and refuses a database that already has tables ("Store setup conflict:
  generated schema or installed controls changed"). So the package's note that
  `push` adds just the four `agent_*` tables does not apply to Approvals. A
  database with data needs a reviewed upgrade script, like
  `plugins/store/participation-upgrade.ts` with
  `scripts/upgrade-participation.ts <signature>`.
  **Decision:** upgrade script versus rebuild of the pilot database.
  Pass when: a fresh database gets `agent_thread`, `agent_turn`, `agent_action`
  and `agent_usage`, a second `yarn push` is a no-op, and the chosen upgrade
  path takes a copy of a populated database to the same state with its rows
  kept. From: GAP-007, task 3 and task 8 notes.
- [ ] **2.2 The plugin loads under every real start-up.** Three paths, all
  must load it:
  1. `yarn dev` and `stackpress serve --b config/develop` read the `plugins`
     list in `package.json`; for `stackpress-ai` the framework follows the
     package's own `plugins` entry, `./cjs/plugin.js`, which plain Node cannot
     parse (`import.meta` in CommonJS; the same flaw exists in several Stackpress
     packages, including the published 0.10.8). It loads where the framework's
     own loader (`tsx`) is used. Add `"stackpress-ai"` after `"stackpress"`.
  2. Vercel: `config/vercel/handle.ts` and `config/vercel/build.ts` import and
     call each plugin by hand ("without runtime package discovery"), so the
     `plugins` list does not reach them. Add `import ai from 'stackpress-ai/plugin'`
     and `ai(server)` to both, after `stackpress(server)`, plus `agent`
     in the `config` object of `handle.ts` (it lists sections by hand). Check how
     the esbuild step in `scripts/vercel.ts` (`buildHandleIndex`, with its
     `external` list) treats `stackpress-ai`, `@modelcontextprotocol/sdk` and the
     provider SDK (`openai`, `@anthropic-ai/sdk`, loaded only when that provider
     is chosen); whichever stays external must be in the app's `dependencies`.
  3. Any script that `require`s the package in plain `node` fails; scripts
     started with `node --import tsx` are fine.
  Pass when: all three start, with no `import.meta` error, and a deployed
  preview answers `GET /agent/start` with 200, the model list and a `csrf`
  `{ name, token }` for a signed-in person. Unknown: none of this has run
  against Approvals. From: task 9 notes, brief.
- [ ] **2.3 Configuration and access.** Add an `agent` section to
  `config/common.ts` (and into the hand-listed sections of the develop,
  build and Vercel configs, and `config/production-guard.ts` if it lists
  required variables): `providers` maps a provider to the **name** of its key's
  environment variable, `model` is the default id, `models` is the picker list
  (the default must be on it; nothing checks that at start-up, and a mismatch
  makes every message answer "unavailable"), plus `limit`, `approvalTtl`,
  `steps`. Add `{ method: 'ALL', route: '/agent/**' }` to the ADMIN and USER
  lists in `session.access`, not GUEST. Do **not** add an `mcp` section: it
  would open the outside-tools door and activates a known 500 (section 6 of the [last file](pilot-checklist-acceptance.md)).
  Pass when: signed-out `GET /agent/start` is refused; a USER and an ADMIN get
  200; a GUEST is refused with the app's normal error page, not a crash; a
  missing key answers 503 "The agent is unavailable right now." and the rest of
  the app keeps serving; the app with no `agent` section behaves as before
  (run the app suites both ways). From: DEC-002, J-013.
- [ ] **2.4 Streaming on the real host, with a server built per request.**
  (a) Send a message to the deployed app with `Accept: text/event-stream`
  (for example `curl -N`, sending the token in the body) and confirm text
  arrives in pieces over time. (b) If the host buffers it, confirm the
  single-response form (no `Accept` header, no `stream` flag) returns the same
  events in `results.events`, and run the panel with `stream={false}`.
  (c) **Likely failure, read from source and not run:** `vercel.entry.ts`
  calls `releaseDatabase` as soon as `server.handle` resolves; the Node
  adapter starts piping a stream body without awaiting it; and the app's engine
  (`plugins/store/connect.ts`) answers any later query with "Database client
  already released". A streamed turn keeps writing to the database after the
  handler returned, so its later writes (assistant turn, action, usage) may
  fail. Show: stream a turn that calls a tool and pauses for approval, then read
  the database. Pass when: the turn rows, the action row and the usage row are
  all present and the card finished. If not, options: stream disabled (single
  response only), or an app change that delays the release until the stream
  ends. (d) Measure the longest single turn (up to `agent.steps`, default 8,
  model calls plus tools) against the platform's function time limit; a turn
  that pauses for approval ends and resumes in a new invocation. (e) Approve
  after a cold start, from a different instance: it must find the stored turn
  and run once. From: GAP-010, J-002, proof of streaming and resumable turns.
- [ ] **2.5 Concurrency on the real database server.** The package's guards
  were tested on an in-memory database with one connection only. The claim
  that exactly one of several simultaneous approvals runs the tool is a single
  guarded `UPDATE agent_action ... WHERE status = 'pending'` plus a token
  read-back; usage adds with `input_tokens = input_tokens + ?`. Show, on the
  PostgreSQL server the app really uses, over separate connections: eight
  simultaneous approvals of one pending action, and twelve simultaneous usage
  additions. Pass when: exactly one tool run and one receipt, and the usage
  total is exact. (The app also has a CockroachDB test script; the decision
  recorded there is PostgreSQL, so CockroachDB is out unless the owners say
  otherwise.) From: task 3 and task 5 notes.
- [ ] **2.6 Decision and live run: provider, model, and what may leave.**
  Only OpenRouter has run live. The Anthropic and OpenAI connections passed
  canned replies through the real SDKs only; the OpenAI `store: false` request
  and the Anthropic fallback beta header follow the documentation but no
  provider has accepted them. Choose the provider(s), model ids (identifiers are
  configuration; use ones the account serves), and the daily `limit`; set the
  key in the host's environment (the `serve` path does not read `.env`).
  **Also decide what Approvals content may be sent to a model provider:**
  tool results (requests, comments, participants) go to the provider and are
  stored in `agent_turn` and `agent_action`; provider-side retention is outside
  the package's control. Pass when: the chosen provider completes a real
  reversible-or-read run with tool use and usage recorded, and the owners have
  written down what content is allowed. From: DEC-002, DEC-004, DEC-015.
- [ ] **2.7 Decision: guard the package's own generated events and pages.**
  The app guards its own generated events (the `approval-generated-access-guard`
  list, the private-access lists). The four new models add events
  `agent-thread-*`, `agent-turn-*`, `agent-action-*` and `agent-usage-*`
  (`batch`, `create`, `detail`, `get`, `purge`, `remove`, `restore`, `search`,
  `update`, `upsert`) and admin pages under `/admin/agent-...`, which are behind
  the admin guard but let an admin edit or delete a stored turn or rewrite the
  action log. A blanket reject like the app's existing guards would break the
  agent: its store uses `agent-thread-create|detail|search|update`,
  `agent-turn-create|search`, `agent-action-create|detail|search` and
  `agent-usage-create|detail`. Options: the package rejects the others itself
  (the proposed side quest, not built; see section 6 of the [last file](pilot-checklist-acceptance.md)); the app guards the unused
  ones; or hide the pages and leave events alone. Pass when: every guarded
  operation answers 403 from an admin session, the store still works, and the
  admin list pages load or are gone by design. From: task 3 notes.
