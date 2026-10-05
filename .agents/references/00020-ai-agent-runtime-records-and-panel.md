# AI Agent Runtime, Records, And Panel

Use this reference for the built-in agent in `stackpress-ai`: the `agent` config
section, one turn, approval and undo, the events and chat routes, the stored
records and their guards, the browser panel, the package's import paths, and
what has and has not been proven. Tools, callers, and MCP access are in
[AI Tools, Callers, And MCP Access](00019-ai-tools-callers-and-mcp-access.md).

## `agent` Config

The agent activates only when an `agent` section exists. `AgentConfig` is in
`src/types.ts`.

| Key | Meaning |
| --- | --- |
| `providers` | provider (`anthropic`, `openai`, `openrouter`) to `{ key }`, where `key` names an environment variable; the key itself never goes in config or to the browser |
| `model` | default model identifier; should be one of `models` |
| `models` | `{ provider, model, title? }[]`, the picker; model identifiers are configuration |
| `instructions` | text appended to the agent's own instructions |
| `limit` | input plus output tokens per person per UTC day; no limit when unset |
| `approvalTtl` | milliseconds a pending approval stays valid; unset, it ends only when the person sends a new message |
| `steps` | model calls per turn, default 8 |
| `base` | mount path of the chat routes, default `/agent` |

`providers`, `model`, and `models` are required in the type but the runtime tolerates
their absence (an unusable agent answers unavailable). Nothing validates at
start-up that `model` is in `models`; if it is not, a
message is answered as unavailable. Provider keys are read from the environment
when a call needs one. A missing key is refused with a fixed message before
anything is stored or an SDK loads.

## Who The Agent Acts As

`person()` (`src/scripts/agent.ts`) derives the caller only from the request's
verified session: `ctx.plugin('session').load(req).data()`, with `data.id` as
the profile id. No session, an unverified token, no id, no session plugin, or a
call from a job all mean no person and a 401. Nothing in a body, page hint, or
tool input can set it. The agent reads neither `type` nor `scopes` for a person
and offers every tool marked `agent: true` to every signed-in person; the tool's
event decides what that person may do.

## One Turn

`runTurn` (`src/scripts/turn.ts`) refuses before storing anything or calling a
provider, in this order: person, input, thread owner, model, key and adapter,
daily limit. It then stores the message and loops: send the stored transcript
and the agent tools to the adapter, store the reply and its usage, run the tools
the model asked for through `callTool` as the person. The limit is checked
before every provider call, including those after an approval.

- Calls run in order. The first that needs approval becomes a pending action
  and stops the step; later calls are answered "not run". Every call gets a
  result because providers reject a call without one.
- A bad input, an invented tool name, or a tool not offered is handed back to
  the model as a failed result, with no action logged.
- Nothing is held in memory across a pause. The transcript is rebuilt from
  stored turns, and a result that depended on an approval is read from its
  action, so any server can resume and no turn is edited.
- A provider's own error text goes to the runtime log only; the person sees fixed
  text. Page hints are cut to a fixed size, labelled as hints, never stored, and
  never used for a decision.
- Files are references only: up to 20 strings of up to 500 characters. The
  package never stores file contents.

## Approval, Decline, And Undo

A tool needs approval when it is `irreversible`, or when it writes
(`method !== 'GET'`) and declares no `inverse` (`needsApproval`). Everything
else runs at once and is logged. Approve, decline, and undo each re-check the
sign-in and load the action for its owner only; another person's action answers
like a missing one. Each is claimed first (one guarded `UPDATE`) so a double
click runs the tool once, and a repeat returns the stored record.

Undo exists only for a done action whose tool still names a registered `inverse`;
an approved irreversible action has none. It runs the declared inverse with the original action's stored input, as the
person, with no second approval. The inverse receives `undoing(req)`. If the app
refuses, the original stands and the reason comes back. An action left
`approved` by a server that stopped mid-run stays approved, and an undo that
stops after claiming leaves the original `undone` with no inverse run.

## Events And Routes

Eight events, named in `AGENT_EVENTS` (`src/events/helpers.ts`): `ai-turn`,
`ai-approve`, `ai-decline`, `ai-undo`, `ai-threads`, `ai-thread`, `ai-start`,
`ai-new`. An app may also listen for `ai-context` (`CONTEXT_EVENT`) to enrich
page hints; it receives a new request with the person's session and only
`url` and `items`. A turn event accepts only a request that carries a person's
session, so a scheduled job needs a session built for it. A callback attached
with `watch(req, sink)` receives each progress report as it happens.

Routes are registered during `route` under `agent.base` and each adapts a
request to one event: `GET /start`, `GET /threads`, `GET /threads/:threadId`,
`POST /threads`, `POST /turn`, and `POST /actions/:actionId/{approve,decline,undo}`.
A write needs a signed-in person, then a valid anti-forgery token; without the
`csrf` plugin every write is refused 503. A write streams when `Accept` is
`text/event-stream` or `stream` is set: the page sets a Web stream body and
writes `data: {event}` lines. A refusal is always a plain JSON error with its
status and a reason. The app's access lists must allow `/agent/**`.

## Stored Records

`stackpress-ai/schema.idea` (shipped in `files`, not in `exports`) declares
`AgentThread`, `AgentTurn`, `AgentAction`, `AgentUsage`, and reverse relations on
`Profile`; an app adds `use "stackpress-ai/schema.idea"`, regenerates, and
pushes. `createStore` (`src/scripts/store.ts`) reads and plainly writes through
the generated events and makes claims with single guarded `UPDATE` statements on
the `database` plugin, reading the winner back by a token.

- Turns are append only in the store; actions are the audit log; usage is one
  row per person and UTC day, incremented in the database.
- `guardRecords` (`src/events/guard.ts`) registers listeners at priority 1000,
  above the generated listeners at 0, that answer 403 and stop the queue for
  every generated write on turns, actions, and usage except create, and for
  thread purge. Create is allowed only while the store runs it, marked by an
  `AsyncLocalStorage` scope. Generated admin pages call those events, so they
  cannot edit or delete the log. A listener above priority 1000 would run first.
- Generated JSON columns are typed object-only, so the store boxes arrays and
  scalars as `{ value }` and unboxes on read; the admin view shows the box.
- The package's tests ran the concurrency proofs on the in-memory PGlite
  database only. One winner on Postgres or MySQL is inferred from a single
  guarded `UPDATE` being atomic and was not run there.

## Providers

One `Adapter` contract (`src/adapters`): `send` takes system text, tools, and a
neutral transcript and returns text, tool calls, a stop reason, usage, and an
adapter-owned `raw` record. History is append only; a reply is replayed
unchanged to the model that wrote it and rebuilt from neutral fields for any
other. No provider keeps conversation state: OpenAI requests set `store: false`
and send the whole transcript. SDKs load lazily, so an app installs only the
SDK of the provider it uses (`@anthropic-ai/sdk`, `openai`, also used for
OpenRouter; optional peers).

**Evidence:** only OpenRouter has run against a live provider. The Anthropic and
OpenAI adapters ran only against canned replies through the real SDKs; their
real services have not accepted the OpenAI `store: false` request or the
Anthropic fallback beta header.

## Panel And Styles

`stackpress-ai/client` is a browser-safe entry (reaches only `react`,
`react/jsx-runtime`, and `r22n`; never import the package root from browser
code). `AgentPanel` takes `signedIn`, `context`, `starters`, `onRefresh`, and
optionally `upload`, `url`, `base`, `stream`, `signInUrl`, `defaultOpen`.
`stackpress-ai/styles.css` is the panel stylesheet and is added to the app's
`cssFiles`. The default `onRefresh` reloads the page once when a run ends with a
finished action, keeping the panel's place in `sessionStorage`. The panel
supplies no upload route. The panel was driven in a real browser against the
blog template only; file attach, a dark theme, Firefox/Safari, and a screen
reader were not.

## Import Paths

`package.json` `exports` is an explicit list with no wildcards; a surface test
pins it. Public: `.`, `adapters`, `client`, `events`, `events/{index,http,sse,stdio}`,
`scripts`, `scripts/{index,http,sse,stdio}`, `helpers`, `plugin`, `transform`,
`types`, and `styles.css`. Other source files, `pages/`, and `package.json` are
not importable. The root is server-only: the plugin, `createMcpServer`,
`contributeTool`, `caller`, `undoing`, `createRuntime`, `watch`, `createStore`,
`AGENT_EVENTS`, `CONTEXT_EVENT`, and the public types. `react`, the two SDKs,
and `ts-morph` (needed by `transform`) are optional peer dependencies.

**CommonJS caveat:** in `stackpress-ai`, `schema`, `sql`, `view`, and `admin`,
`src/plugin.ts` uses `import.meta.url` behind a `typeof __dirname` test and
`tsc` emits it unchanged into `cjs/plugin.js`, which plain Node 22 cannot parse
(`require` throws `Cannot use 'import.meta' outside a module`). Anything that
imports `plugin.js`, including the root and `events`/`scripts` barrels through
the stdio entries, is affected. Plugins load in the server through `tsx`.

## Source Anchors And Authority

Anchors: `packages/stackpress-ai/{package.json,schema.idea,README.md,styles.css}`,
`src/{plugin,index,types}.ts`, `src/scripts/{agent,turn,approval,store,records,threads}.ts`,
`src/events/`, `src/pages/`, `src/adapters/`, `src/client/`, and
`templates/blog/{config/common.ts,plugins/app/agent.ts}` as the demonstrated
reference app. Source and tests are authority; the README is a benchmark.
