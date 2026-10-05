# Task 00008: Reference App Wiring And Documentation

## Task Summary

Make `templates/blog` the working example and write the documentation a
developer or operator needs. Journeys: J-012, J-013.

## Implementation Steps

1. `templates/blog/config/common.ts`:
   - add an `agent` section that reads its provider key from the environment
     and falls back to the stub model when no key is set.
   - allow the agent routes for the roles that may use the agent.
2. `templates/blog/plugins/app/plugin.ts`: contribute sample tools over the
   template's existing events. Include one reversible tool with its inverse and
   one irreversible tool, so approval and undo can both be shown.
3. `packages/stackpress-ai/README.md`: describe the two config sections, key
   rules, contributing a tool, the caller record, reversible and irreversible
   tools, providers and keys, the daily limit, and the migration note from
   task 1. Update the package description, which still says MCP only.
4. `docs/config-reference.md`: add the `mcp` and `agent` sections.
5. Run every command the documentation shows and fix any that do not work as
   written.

## Verification Process

- The template generates, builds, and serves with the agent on and with the
  `agent` section removed. With it removed, behavior matches the baseline.
- A missing provider key reports the agent as unavailable and does not stop
  the server.
- Documented commands run as written.

## Acceptance Criteria

The rendered documentation for turning the agent on and for contributing a
tool, read as a developer would read it.

## Implementation Notes

Done 2026-10-05. Steps 3, 4 and 5 are done. Steps 1 and 2 were done during task 00006 (blog `agent`
config, `/agent/**` access, the four sample tools in `plugins/app/agent.ts`) and the panel was mounted
in task 00007. No source behavior changed. Files changed by this task: `packages/stackpress-ai/README.md`,
`docs/config-reference.md`, and the `description` in `packages/stackpress-ai/package.json`.

**README.** Rewritten as one document (384 lines) in the order a reader needs it: what the package is and
its two halves; a "Turn the agent on" walkthrough in nine steps (install, load the plugin, schema line,
generate and push, config, key, routes, panel, first tool) that points at the blog's files; contributing
a tool; the caller record; reversible and irreversible tools with approval and undo; providers, keys and
models; the daily limit; stored records; events; chat routes; chat panel; outside AI tools (MCP) with the
key rules; known limits; what changed for existing users. Every true statement of the old README was kept
and moved. Removed as stale: the "Current Status" section (it described the state before this work), the
sentence "The panel comes later", and the `Migration` heading (its list is now "What changed for existing
users", grouped, with one added line from task 00002 that two config entries of one name now merge). Not
copied: the reason a registry check reads the full registry (internal), and the old one-line statements
about HTTP and SSE auth, which were restated in the live-connection list.

**Config reference.** `mcp` and `agent` sections in the shape of the neighbouring sections (a "Use ..."
sentence, a key table, the source type, an example, "What It Affects"), and both added to the top-level list.

**Package description.** Now says it is an MCP server and a built-in chat agent.

**Things the documentation says that the task notes did not.**

- With a recorded revision, `push` on an app that already has data created only the four `agent_*` tables
  and left the rows alone. Earlier notes (tasks 2, 3, 6) and the briefing say `push` drops every table. That
  is what it did on a fresh database or with no `.build/revisions`. The README says both and still says to
  back up first.
- The scaffold's panel text is "The agent is unavailable"; the route text is "The agent is unavailable
  right now." The walkthrough gives each where it belongs.
- Nothing checks at start-up that `agent.model` is in `agent.models`. If it is not, a message is answered
  as unavailable. The README says so.
- The agent checks only that a person is signed in. It does not read `type` or `scopes` for a person; the
  tool's event decides what that person may do. The README says so in "Contribute a tool".

**Disagreements between task notes and code.** None that changed what the documentation says, except:
task 5's notes count six agent events and the plugin now registers eight (task 6 added `ai-start` and
`ai-new`, and says so). Task 1's note that a verified key seeing no tools gets a 500 is taken from the notes
and from the code (`Resolved MCP tool registry is empty.` is thrown from the transports' server factory);
I did not reproduce it, so the README says "a server error" and no status code.

**Found, not fixed.**

- The blog's production server stops on any request for a route that does not exist, with or without the
  agent (task 00003A's missing error view). Reproduced here with `GET /nothing-here-xyz` on the blog with the
  `agent` section removed. It also means that with `agent` removed but the panel still mounted, the panel's
  first request to `/agent/start` stops the server. The README lists this under Known limits and does not
  fix it.
- `skills/stackpress-app-scaffold/assets/template/plugins/store/populate.ts` fails as written: the signup
  needs a phone (`normalizePhone` reads `undefined`), the default `ADMIN_PASS` of `admin` is shorter than the
  password rule, and `__STACKPRESS_APP_NAME__` is a placeholder that the create command may not fill. I worked
  around it in a throwaway copy only. Reproduce: copy the template, fill the placeholders, `yarn push`,
  `yarn populate`.
- The blog's `package.json` does not list `@anthropic-ai/sdk` or `openai`. I infer they are found today because the
  workspace installs the package's dev dependencies at the root, and that a blog installed on its own with a
  real key would answer unavailable; I did not try that. The README's step 1 tells an app to install the SDK it uses.


## Verification Notes

Run 2026-10-05 with Node 22.23.2 and Yarn 1.22.22, in this checkout.

**Suites and builds (run).**

- `yarn test` in `packages/stackpress-ai`: 688 passing, 0 failing, 96.5 / 91.78 / 96.66 / 97.17
  (statements / branches / functions / lines), the same as before this task.
- `yarn build` at the repository root: exit 0, 86 s on the first run and 53 s on the last, after all edits.
- `git diff --check`: clean. `python3 .agents/scripts/validate-agent-workspace.py`: "OK, warnings only", the
  same two older line-count warnings (`references/00010`, `references/00014`).

**Every sample and command in the documentation.**

| Where | Sample | How it was checked |
| --- | --- | --- |
| README step 1 | `yarn add stackpress-ai`, `yarn add @anthropic-ai/sdk` | NOT CHECKED. The package is not published with the agent, and installing would change `yarn.lock`. The SDK names and ranges are from `package.json`. |
| README step 2 | `plugins` array | Run. A throwaway app made from the scaffold template loaded `stackpress-ai` through it and served. |
| README step 3 | `use` lines, `yarn generate`, `yarn push` | Run on that app, both from nothing and as an upgrade of an app with data (rows kept, four tables added). |
| README step 4 and config reference `agent` | `agent` section | Type-checked with `tsc` as an `AgentConfig` and as a section of `Config`; the app served with it. |
| README step 5 | `export ANTHROPIC_API_KEY=...` | Not run with a real key. Run with no key set (the unavailable path below). The `.env` remark is from `templates/blog/package.json`. |
| README step 6 | `session.access` entry | Type-checked; run: the routes answered once the entry was in the access lists. |
| README step 7 | `AgentPanel` mount, `cssFiles` line | Type-checked in the throwaway app. Rendered in the blog: the home page HTML held the panel. Not rendered in the throwaway app. |
| README step 8 and caller sample | `contributeTool` and `caller(req)` | Type-checked; the throwaway app's registry listed `profile_find` with `agent: true` and type `user` (a script calling `collectTools`). The caller sample is the blog's `app-site-info` event: the MCP `tools/call` on the blog answered `caller: "public"`. |
| README reversible snippet | `article_publish` tool object | Type-checked as a `ToolConfig`; the blog's tool of the same shape ran (publish, undo, approve) over HTTP. |
| README and config reference `mcp` | `mcp` section | Type-checked as `McpConfig` and as a section of `Config`. The blog's own `mcp` section served `initialize`, `tools/list` and `tools/call` over `/mcp`. |
| README panel | `AgentPanel` with `context` and `starters` | Type-checked. The blog's article page uses the same props. |
| Chat routes, status and refusal text | `401`, `403`, `503`, `200` bodies | Run with `curl` against the throwaway app (signed out `401`; no token `403`; token and no key `503` for JSON and for `Accept: text/event-stream`; threads still answered afterwards) and against the blog (start, a turn on the offline model, undo, approve). |
| Config reference tables | defaults and keys | Read from `types.ts`, `scripts/http.ts`, `scripts/sse.ts`, `scripts/turn.ts`, `helpers.ts`. Not run key by key. |

The throwaway app was `templates/zz-plain` (a copy of `skills/stackpress-app-scaffold/assets/template` with the
steps applied), served from a temporary config with no view engine on port 3481. It was removed afterwards.

**The task's own verification.**

- Template generates, builds, serves with the agent on: `yarn blog generate`, `yarn blog push`,
  `yarn blog populate`, `yarn blog build` (159 s) all exit 0; served in production mode from a temporary config
  on port 3491 (access for `/logo.png` and `/icon.png` added, as in 00003A). Signed in through the real
  username form. Home, an article, the admin search, the panel in the page, `/agent/start`, a turn on the offline
  model, publish then undo, a waiting delete then approve, and the MCP list and call all answered.
- With the `agent` section removed (a second temporary config, port 3492, run after the first was stopped
  because both use one PGlite directory): sign-in, home, article, admin search and the MCP `tools/list` and
  `tools/call` gave the same status codes and the same output as with the agent on, except that the agent
  routes did not exist. `/agent/start` there stops the production server (see Implementation Notes: it does so
  for any unknown route, so it is the baseline, not caused by the agent). The panel is still mounted in the blog
  views, so with `agent` removed the panel itself needs removing too.
- A plain app with no provider key: the throwaway app returned `503` "The agent is unavailable right now." and
  logged `No key is set for the "anthropic" provider.`; the server kept answering `/agent/threads` after. Tasks
  00005 and 00006 cover the same path in tests.
- Evidence reused, not rerun: panel behaviour in a real browser (signed out, unavailable, limit, narrow screen,
  approval, undo) is task 00007's `00007-panel.md`; the recorded chat session is task 00006's
  `00006-chat-session.md`; the live OpenRouter run is task 00004's `00004-live-smoke.md`.

**Cleanup.** Servers stopped by the pid that owned each port; `templates/blog/config/zz-on.ts` and `zz-off.ts`
removed; `templates/blog/.build` copied first and restored (`diff -rq` identical; the restored database has no
agent tables or seed rows until the next `yarn blog push`); `templates/zz-plain` removed; no `.env` was created
and `.env.openrouter` was not read.

**Not verified.** The two commands marked NOT CHECKED above. Anthropic and OpenAI against their own services
(documented as untested). The agent against a real provider other than OpenRouter. Postgres and MySQL (PGlite
only; the README says so). `yarn blog dev` (other sessions hold Vite's ports). A blog installed outside the
workspace with a real key. The "server error on connect" for a key that matches no tool (from the notes and the
code; not reproduced). The rendered look of the README on a Markdown host: I read the tables and code fences in
the file but did not render it.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
