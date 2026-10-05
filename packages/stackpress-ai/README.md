# Stackpress AI

AI features for a Stackpress app, in two halves that share one set of tools.

 - **A door for outside AI tools.** An MCP server (Model Context Protocol, the standard way AI clients such as Claude Desktop call tools) that offers your app's events as tools. Outside callers present a key.
 - **A built-in agent.** A chat the signed-in people of your app use. It talks to a model provider (Anthropic, OpenAI or OpenRouter), calls your tools as the person who is chatting, asks that person before doing anything that cannot be undone, and keeps a log of what it did.

Each half has its own config section, `mcp` and `agent`. The plugin turns on when either exists and each half registers only for its own section. A **tool** is one of your app's events, offered by name with an input schema. Tools are described once and both halves use them.

This package is not part of the aggregate `stackpress` plugin. An app loads it by name. The sections below follow what you do: turn the agent on, give it tools, then look up how it behaves.

## Where things are imported from

Import the server-side API from the package root, and the other parts from their own paths. Nothing here is promoted through the `stackpress` aggregate package, so install `stackpress-ai` and import it by name.

| Import | Environment | What it is for |
| --- | --- | --- |
| `stackpress-ai` | server only | The plugin (default export) and `createMcpServer`. `contributeTool`, `caller` and `undoing` for tools. `createRuntime` and `watch` for the agent runtime, `createStore` for its records, and `AGENT_EVENTS` and `CONTEXT_EVENT` for the event names. The shared types of config, callers, tool results, adapters and records. |
| `stackpress-ai/client` | browser safe | `AgentPanel` (also the default export), the pieces it is built from, and their types. It reaches only `react` and `r22n`. |
| `stackpress-ai/styles.css` | browser | The panel's stylesheet. Add it to `cssFiles`. |
| `stackpress-ai/adapters` | server only | `createAdapter` (also the default export), the provider chooser a runtime option `connect` can call, and `ProviderError` with `toProviderError`, the error the adapters throw. |
| `stackpress-ai/types` | types only | Every type of the package, including those not re-exported from the root. |
| `stackpress-ai/scripts` | server only | The lower level workflow functions (`runTurn`, `approve`, `decline`, `undo`, `listThreads`, `loadThread`), the tool registry (`collectTools`, `callTool`, `loadRegistry`) and the MCP transport entries `http`, `sse` and `stdio`. |
| `stackpress-ai/scripts/http`, `/sse`, `/stdio` | server only | The MCP transports, including `McpHttpServer` and `McpSseServer`. |
| `stackpress-ai/events` and `/events/http`, `/sse`, `/stdio` | server only | The event listeners the plugin registers, for an app that wires them itself. |
| `stackpress-ai/helpers` | server only | The key, tool and request helpers of the MCP server. |
| `stackpress-ai/plugin` | server only | The plugin and `createMcpServer`, as before. |
| `stackpress-ai/transform` | build time | The generator the `idea` event adds for generated tools. It is not meant to be imported by an app. |
| `stackpress-ai/schema.idea` | file | The agent records, loaded by a `use` line in the app's schema, not imported. |

The paths `stackpress-ai/scripts/index` and `stackpress-ai/events/index` keep working and are the same as `stackpress-ai/scripts` and `stackpress-ai/events`. No other file under `scripts`, `events` or `client` can be imported by path. Both provider SDKs are optional: an SDK is needed only when its provider is chosen, and nothing else in the package loads it.

## Turn the agent on

This walkthrough adds the agent to an existing Stackpress app that already loads the `stackpress` plugin, has a `database`, and has people who sign in. `templates/blog` is the finished example. Each step names the blog file to compare with.

1. **Install.** Add the package and the SDK of the provider you will use. `openai` serves both OpenAI and OpenRouter; `@anthropic-ai/sdk` serves Anthropic. An SDK that is not installed is only needed when its provider is chosen.

   ```bash
   yarn add stackpress-ai
   yarn add @anthropic-ai/sdk
   ```

2. **Load the plugin.** List it after `stackpress` in the `plugins` of the app's `package.json` (blog: `templates/blog/package.json`).

   ```json
   "plugins": [
     "./plugins/app/plugin",
     "./plugins/store/plugin",
     "stackpress",
     "stackpress-ai"
   ]
   ```

3. **Add the records.** The agent keeps its threads, messages, actions and usage in four tables. Add the package's schema next to the app's other `use` lines (blog: `templates/blog/schema.idea`), then generate and push.

   ```idea
   use "stackpress/stackpress.idea"
   use "stackpress-ai/schema.idea"
   ```

   ```bash
   yarn generate
   yarn push
   ```

   On an app that already holds data, `push` created only the four `agent_*` tables and left the other rows alone, because it diffs against the revision it recorded earlier. With no recorded revision it builds every table from scratch. Back up before you push.

4. **Add the config.** Put an `agent` section in the app's config (blog: `agent` in `templates/blog/config/common.ts`). A config file that lists its sections by hand, as the blog's `develop.ts` and `production.ts` do, needs `agent: common.agent` added too.

   ```ts
   export const agent = {
     //the name of the environment variable that holds the key, never the key
     providers: { anthropic: { key: 'ANTHROPIC_API_KEY' } },
     //the model used until a person picks another
     model: 'claude-opus-5-5',
     //the models offered in the picker. The default has to be one of them
     models: [
       {
         provider: 'anthropic' as 'anthropic',
         model: 'claude-opus-5-5',
         title: 'Claude Opus 5.5'
       }
     ],
     //input plus output tokens one person may use per UTC day
     limit: 200000
   };
   ```

5. **Set the key.** Put the key in the server's environment under the name the config gives. The blog's `dev`, `push` and `populate` scripts read a `.env` file; its `serve` script does not, so set the variable in the shell or the host's settings.

   ```bash
   export ANTHROPIC_API_KEY=your-key-here
   ```

6. **Allow the routes.** If the app sets `session.access`, the chat routes need an entry for each role that may use the agent, or the global access check refuses them before they run (blog: the `/agent/**` lines in `common.ts`).

   ```ts
   session: { access: { USER: [ { method: 'ALL', route: '/agent/**' } ] } }
   ```

7. **Mount the panel.** Add `stackpress-ai/styles.css` to `cssFiles` in each config that has them (blog: `build.ts`, `develop.ts`, `client.ts`). Then draw the panel inside a `LayoutPanel` (blog: `plugins/app/views/home.tsx`).

   ```tsx
   import { AgentPanel } from 'stackpress-ai/client';

   <AgentPanel signedIn={Boolean(session?.id)} />
   ```

8. **Give it a first tool.** The agent can use only tools that say `agent: true`. Offer one of the app's events from a plugin (blog: `plugins/app/plugin.ts` and `plugins/app/agent.ts`).

   ```ts
   import { contributeTool } from 'stackpress-ai';

   server.on('listen', async _ => {
     server.on('ai-tools', ({ ctx }) => {
       contributeTool(ctx, {
         name: 'profile_find',
         description: 'Finds profiles by a text query.',
         type: 'user',
         scopes: [ 'profile-read' ],
         method: 'GET',
         event: 'profile-search',
         agent: true,
         input: {
           type: 'object',
           properties: { q: { type: 'string' } },
           additionalProperties: false
         }
       });
     });
   });
   ```

Start the app, sign in, and open the panel. With no key set, the panel shows "The agent is unavailable" (the route answers `503` with "The agent is unavailable right now.") and the rest of the server keeps running. A person who is not signed in sees a sign-in prompt and no request is made.

**The blog differs from a plain app in one way.** When no provider key is set, the blog answers with a small scripted offline model so the chat can be tried without an account. That model lives in the blog (`plugins/app/agent.ts`), not in this package. A plain app with no key reports the agent unavailable. A message of the form "Publish `<article id>` and delete comment `<comment id>`" makes the offline model publish, then ask to delete, which waits for approval. Anything else gets a note that no provider is set.

## Contribute a tool

A plugin offers one of its own events as a tool by listening for `ai-tools`, which is resolved each time the tool list is built. No `mcp.tools` entry is needed. A configured entry in `mcp.tools` with the same name overrides the fields it sets, and two contributions with the same name are an error. The tool list and the `403` check read the same merged list.

| Field | Meaning |
| --- | --- |
| `event` | The event to run. Required. |
| `name`, `title`, `description` | What the model sees. The name is derived from the event when absent. |
| `method` | Request method the event is run with. Defaults to `GET`. |
| `input`, `output` | JSON Schema. Input is validated before the event runs. |
| `type` | `public`, `app` or `user`: who may see the tool over MCP. Defaults to `public`. |
| `scopes` | Scopes an MCP caller needs, all of them. |
| `data` | Fixed values merged into the input. Config is trusted. |
| `agent` | Offer the tool to the built-in agent. Off unless `true`. |
| `inverse` | Name of the tool that reverses this one. See below. |
| `irreversible` | The tool cannot be reversed. See below. |
| `operation` | Dotted path into the event's results that holds your own identifier for what changed. Defaults to `operation`. |
| `mode` | `plugin` asks the event for the tool definition instead of reading it from config. |

`type` and `scopes` decide only what MCP callers see. The default `public` would show a write tool to callers with no key, so give a tool `type: 'user'` and a scope unless it is meant to be public. The agent does not read them: it checks that a person is signed in, offers the tools marked `agent: true`, and runs the event as that person. Whether this person may do this is decided by the event, so a tool event should check.

A tool event name that contains `:` is read by Ingest as a pattern. A listener named `blog:something` also answers any event that starts with `blog`, so give a tool event a name that is not a prefix match for another listener.

A tool event that fails (it throws, or answers a status of 400 or more) is returned to an MCP client as an error result, and to the agent as a failed tool result.

## The caller record

Before a tool event runs, the system records who is calling and keeps that apart from the tool's input. This is the **caller record**. The event reads it with `caller(req)`:

```ts
import { caller } from 'stackpress-ai';

server.on('app-site-info', ({ req, res }) => {
  res.results({ who: caller(req)?.kind }); //public, app, user, or person
});
```

| Field | Meaning |
| --- | --- |
| `kind` | `public` (no key), `app` (an application key), `user` (a user key) or `person` (a signed-in browser user, from the agent). |
| `profileId`, `sessionId`, `applicationId` | Set when the kind has them. |
| `roles` | The person's roles, for `person`. |
| `scopes` | The scopes of the key. Empty for `person`. |

The record is built only after the key or sign-in was verified, and input can never set or change it. Input that carries `profileId`, `applicationId` or `sessionId` has them removed, and then an `app` caller gets its `applicationId` written in and a `user` caller gets all three. This stops a model or client from claiming to be someone else by passing an id.

For a `person`, the event is run on a new request that carries that person's session and only the tool arguments. The request they came in on is never forwarded, so its body, headers and query cannot reach the event. The new request keeps the original path and drops the query. It also still carries the whole session, including the anti-forgery cookie.

## Reversible and irreversible tools

The agent acts for a person, so what it does is logged and, when it cannot be taken back, confirmed first. Every run of a tool by the agent is an **action** with a status.

 - A tool with an `inverse` runs at once. The action card shows Undo. An **undo** runs the inverse tool with the input that was stored, with no second approval, and tells its event what it is undoing (below). The inverse does not need `agent: true`. An inverse that needs only the original's input should take the same input, and then it needs nothing else.
 - A tool with `irreversible: true` pauses before it runs. The person sees the tool and its input, and chooses Approve or Decline. It shows no Undo afterwards.
 - A tool that writes (any method but `GET`) and declares neither an inverse nor irreversibility is treated as irreversible and waits for approval.
 - A `GET` tool runs at once and is logged with no Undo.

```ts
{ name: 'article_publish', event: 'article-update', method: 'PUT',
  data: { status: 'PUBLISHED' }, agent: true, inverse: 'article_unpublish' }
```

An inverse that needs more than the stored input, such as the id of what the original created, a fresh operation identifier, or the record's current state, reads the **undoing record** from the request its event receives. Like the caller record it is kept apart from the input, built only by an undo, and unreachable from tool input, the page context or the message. `undoing(req)` returns it during an undo and `undefined` on any other call, so the same event can tell the two apart.

```ts
import { undoing } from 'stackpress-ai';

server.on('receipt-void', ({ req, res }) => {
  const told = undoing(req);
  if (!told) return res.setError('Only an undo voids a receipt.', {}, [], 409);
  const { receipt } = told.original.result as { receipt: string };
  res.results({ voided: receipt, operation: `void-${told.undoActionId}` });
});
```

The record holds `original`, the action being undone (`id`, `tool`, `input`, `result` as the log returns it, and its `operation` identifier or `null`), and `undoActionId`, the id of the action the undo is logged as. That action exists before the inverse runs, so derive the inverse's own operation identifier from it. An undo is claimed once, so a double click runs the inverse once, with one record. If the app refuses and the person tries again, the retry is a new undo action with a new id. The inverse's own `operation` is captured on the undo action the same way as for any action. The input is still the original's stored input. The package supplies nothing else: reading the record's current revision, building the app's own request and deciding whether the undo is still allowed stay in the inverse's event.

The pause is stored in the database, not held in memory, so any server can resume it. An approval is valid until the person sends a new message in the thread or `approvalTtl` passes. When the model asks for several tools in one step they run in order until the first one that needs approval; that one waits and the rest are answered as not run, since they may depend on it.

Approving, declining and undoing each run once, even on a double click or from two servers at the same moment. A repeat finds the action already settled and does nothing.

| Status | Meaning |
| --- | --- |
| `pending` | Waiting for the person. |
| `approved` | Approved and claimed; the tool is running or ran. |
| `declined` | The person refused. |
| `done` | The tool ran. A reversible one can be undone. |
| `failed` | The event failed or refused. The reason is stored. |
| `undone` | The inverse ran. |
| `expired` | A new message arrived or the time passed before the person answered. |

Two stops leave a mark you should know about. If a server stops while it runs an approved action, the action stays `approved` and is not rerun, because it may already have run. If a server stops right after an undo was claimed, the original can show as `undone` without the inverse having run. The undo of `article_publish` in the blog sets the article to `DRAFT`, not to what it was before, because the `article-update` event returns the updated article and not the earlier status, so there is nothing for the record to carry. The blog's `sample_receipt_issue` and `sample_receipt_void` show the record in use.

## Providers, keys and models

`agent.providers` maps each provider (`anthropic`, `openai`, `openrouter`) to the **name** of the environment variable that holds its key. The key is read from the server environment at call time, never stored, never sent to the browser and never in an error body. One key serves the whole deployment; there are no per-person keys. The other keys of the section (`instructions`, `limit`, `approvalTtl`, `steps`, `base`) are in the [config reference](../../docs/config-reference.md#agent).

`agent.models` is the list the picker shows. Each entry has a `provider`, the provider's own `model` identifier, and an optional `title`. Identifiers are configuration, so use the ones your account offers. A message that names a model not on the list is refused with `400`. A thread keeps the model that last answered it; a stored model that is no longer offered falls back to `agent.model`. Nothing checks at start-up that `agent.model` is on the list; if it is not and no other model applies, every message is answered as unavailable.

Each conversation is stored only in your database and sent to the provider in full on each request. Nothing is kept on the provider's side by design: OpenAI requests ask not to store anything and send no previous-response id. Each provider's own log retention under your account terms is separate and is not changed by this.

**What has been run.** Only the OpenRouter connection has run against a live provider. The Anthropic and OpenAI connections have been tested against canned replies through the real SDKs, and have not been accepted by their own services. That includes the OpenAI `store: false` request and the Anthropic fallback beta header, which follow the providers' documentation but are unproven.

A turn is refused with `503` and the fixed text "The agent is unavailable right now." when no key is set for the chosen provider, or when that provider's SDK is not installed. The reason is written to the server log. A key the provider rejects while a turn runs ends the turn as unavailable the same way. Provider text never reaches the person.

## The daily limit

`agent.limit` is the number of tokens (input plus output) one person may use per UTC day. Without it there is no limit. The count is kept in the person's `AgentUsage` row for the day and is checked before every provider call. At the limit a message is refused with `429` and the body keeps `errors.resetsAt`, the time the day rolls over. A tool the person already approved still runs at the limit; the model is not called after it. `GET /agent/start` reports what is left.

`agent.steps` (default 8) is how many model calls one turn may make, so a model that keeps retrying stops.

## Stored records

`schema.idea` in this package defines four models. They are not part of the aggregate `stackpress` schema.

| Model | Holds |
| --- | --- |
| `AgentThread` | One conversation, private to its owner. |
| `AgentTurn` | One message. Append-only: the store has no way to edit or delete one. The provider's reply is kept exactly as given so it can be replayed to the model that wrote it. |
| `AgentAction` | The log of what the agent did for a person: the tool, the event, the input, the status, the result, your `operation` identifier, which action an undo reverses, and when. |
| `AgentUsage` | Tokens used per person per day. |

`createStore(ctx, { approvalTtl, now })` reads and writes them through the generated model events. Approving is one guarded `UPDATE` that moves a row from `pending` to `approved` and writes a token; exactly one call finds its own token on the row and runs the tool, and every other call gets the stored record. Declining, undoing, expiry and each usage addition are guarded statements in the same way. The store keeps no module-level state.

**Only the store changes these records.** An app that uses this schema also gets generated model events and admin pages for the tables. While the plugin is active it registers guards on those events, ahead of the generated listeners and whichever plugin registers first. A guarded event answers `403` with "Agent records can only be changed through the agent store." and never reaches the generated code, so an admin page, or any plugin that emits the event, cannot change a turn or rewrite the action log.

| Model | Refused | Left open |
| --- | --- | --- |
| `AgentTurn`, `AgentAction`, `AgentUsage` | `update`, `remove`, `restore`, `purge`, `upsert`, `batch`, and `create` from anywhere but the store | `detail`, `search`, `get` |
| `AgentThread` | `purge` only, which would empty the whole table | everything else |

A thread is left editable because its title and active flag belong to the person, not to the audit log, and the store itself updates it. The admin lists and detail pages still load. Only `createStore` can create a turn, an action or a usage row: it marks its own create call in the async context of that call, which a request, its data or its headers cannot carry, so a made-up row sent through the generated `create` event or the admin create page is refused. The mark is shared across the CJS and ESM copies of the package.

Two things to know:

 - The guards are code in the same process. A plugin that reaches into the global symbol registry for this package's store, or that listens ahead of the guards with a higher priority, can still bypass them. They stop requests, admin pages and the generated events; they are not a sandbox against code you installed. An app that does not turn on `agent` or `mcp` has no guards, so it should not use this schema.
 - The concurrency behaviour was tested on the built-in test database (PGlite) only. That one winner holds on Postgres and MySQL follows from a single `UPDATE ... WHERE status = 'pending'` being atomic there. It was not run there.

The generated columns store JSON objects only, so a list or a single value is stored as `{ "value": ... }` and unboxed on read. The admin view shows the box. Ids are time-ordered because the generated datetime columns keep whole seconds.

## Events

The agent is a set of events. Resolve them with a request that carries the person's session. Who the person is comes only from the verified session of that request. A request with no verified person is refused, and a background run with no signed-in person is not supported.

| Event | Input (besides the request's session) | Does |
| --- | --- | --- |
| `ai-turn` | `message`, `threadId`, `model`, `files`, `context` | Send a message and run the model. |
| `ai-approve` | `actionId` | Run a pending action once, then continue the turn. |
| `ai-decline` | `actionId`, `reason` | Refuse a pending action, then continue the turn. |
| `ai-undo` | `actionId` | Run the inverse of a done action. |
| `ai-threads` | `skip`, `take` | List the person's threads. |
| `ai-thread` | `threadId` | Load a thread's messages and actions. |
| `ai-start` | none | The models on offer and the person's remaining allowance. |
| `ai-new` | `model` | Start an empty chat, or hand back the one that was never used. |
| `ai-tools` | none | Plugins listen to contribute tools. |
| `ai-context` | `url`, `items` | The app may listen to replace page context. See the chat routes. |

`watch(req, onEvent)` (from `stackpress-ai`) attaches a callback to a request. It receives each report as it happens: `thread`, `text`, `action-start`, `action-waiting`, `action-done`, `action-failed`, `action-declined`, `action-undone`, `usage`, `error` and `finished`. The same list is in the result's `events` for a caller that does not stream. A turn ends with a `finished` status of `done`, `waiting`, `steps`, `length`, `refusal`, `limit`, `unavailable`, `busy`, `failed` or `settled`.

Files are references only. A message may carry up to 20 strings of up to 500 characters that name files your app stored. They are saved on the message, named to the model, and passed to tools as the model gives them. The package never stores file contents.

## Chat routes

When `agent` config exists the plugin registers these routes under `agent.base` (default `/agent`). Each is a page that adapts the request to one event and decides nothing the event does not.

| Method | Path | Event |
| --- | --- | --- |
| `GET` | `/agent/start` | `ai-start`, plus an anti-forgery token |
| `GET` | `/agent/threads` | `ai-threads` |
| `GET` | `/agent/threads/:threadId` | `ai-thread` |
| `POST` | `/agent/threads` | `ai-new` |
| `POST` | `/agent/turn` | `ai-turn` |
| `POST` | `/agent/actions/:actionId/approve` | `ai-approve` |
| `POST` | `/agent/actions/:actionId/decline` | `ai-decline` |
| `POST` | `/agent/actions/:actionId/undo` | `ai-undo` |

**Anti-forgery.** `GET /agent/start` answers `csrf: { name, token }` and sets the token cookie through the `csrf` plugin, which the aggregate `stackpress` plugin loads. Every `POST` must send the token back in the body under that name, or in an `X-CSRF-Token` header. If the `csrf` plugin is not registered, every `POST` is refused with `503`.

**Streaming.** A `POST` that sends `Accept: text/event-stream` (or `stream: true`) gets `text/event-stream`, one `data: {event}` line per report. Any other request gets one JSON answer whose `results.events` holds the same list. A refusal is always a plain JSON error, never a stream. A reader that leaves does not stop the turn; what was stored is what a reload shows. A host that buffers output may hold the stream back; that was not tried.

**Page context.** A message may carry `context: { url, items: [] }`. It is cut to short plain values and given to the model as a hint. If the app listens for `ai-context` (it receives `url`, `items` and the person's session), what it answers replaces them. Nothing reads context to decide what a person may do.

**Refusals**, in order: `401` not signed in, `403` bad anti-forgery token (reason `csrf`), then the event's own: `400` invalid input or model, `404` a thread or action that is missing or not the person's, `429` at the daily limit, `503` no provider key or no `csrf` plugin. The body is `{ code, status, error, errors: { reason } }`. Provider error text is never in it.

## Chat panel

A plain panel for these routes ships as the browser-safe `stackpress-ai/client` entry. It draws a button and, once opened, a panel docked to the right edge (a full-height sheet on a narrow screen). It carries no brand of its own, and an app that wants another look can build its own on the same routes. Its words go through `r22n`, so put it inside a `LayoutPanel` or any `R22nProvider`. Its styles read the app's theme variables (`--bg-first`, `--default`, `--info`) and fall back to plain colors without them.

```tsx
<AgentPanel
  signedIn={Boolean(session.id)}
  context={[ { type: 'article', id: article.id, label: article.title } ]}
  starters={[ 'Publish this article' ]}
/>
```

| Prop | What it does |
| --- | --- |
| `signedIn` | `false` shows a sign-in prompt and makes no request. |
| `context` | Items the page is about, each a string or an object with a `label`. They show as chips the person can remove, and a removed one is not sent. The page address is a chip too. All of it is a hint. |
| `url` | The page address sent as a hint. Defaults to the browser's. |
| `starters` | Prompts offered on an empty chat. |
| `upload` | `(file) => Promise<string \| { ref, name? }>`. Turns a picked file into a reference your app stored. The panel never uploads; without this there is no attach control. |
| `onRefresh` | Called after an action finished so the page shows the change. Defaults to reloading the page; the panel keeps its place across the reload. |
| `base`, `stream`, `signInUrl`, `defaultOpen` | The routes' mount path, whether to ask for a stream, where to sign in (default `/auth/signin`), and opening at once. |

The panel only asks. Approve, decline and undo are requests, and what the routes answer is what it shows. Undo appears only on a card the server says can be undone. Its logic is in plain modules (`createClient`, `applyEvent`, `createPanel`) that the components only draw, so an app can build another panel from them. The entry reaches only `react` and `r22n`.

## Outside AI tools (MCP)

The `mcp` section turns on the door. Tools come from `mcp.tools` and from `ai-tools` listeners. Streamable HTTP is served on the app's own host and port at `mcp.route` (default `/mcp`) unless `mcp.host` or `mcp.port` differ. The `mcp-http`, `mcp-sse` and `mcp-stdio` events start the transports from the command line. See the config reference for every key.

```ts
mcp: {
  name: 'Blog MCP',
  tools: [
    {
      name: 'article_search',
      type: 'app',
      method: 'GET',
      event: 'article-search',
      scopes: [ 'articles.read' ],
      input: { type: 'object', properties: { q: { type: 'string' } } }
    }
  ]
}
```

A request either presents no key or presents a key. No key is a public caller. A presented key is verified and is never downgraded to public:

 - the key is `id` or `id:secret` in an `Authorization: Bearer` header
 - `app` keys are looked up through `application-detail`, then `user` keys through `session-detail`
 - the record must exist, must not have `active` set to `false`, and must not be past `expires`
 - the secret must be present and match the stored secret, for every method including `GET`
 - a key that fails any check is `invalid`, and an `invalid` caller sees and calls nothing, not even `public` tools
 - a tool needs every scope in its `scopes` list, not just one
 - `public` tools need no key

**Live connections.**

 - Streamable HTTP and SSE answer `401` with `WWW-Authenticate: Bearer` for an `invalid` key, on connect and on every later request or message post.
 - Streamable HTTP resolves the key on every request in both `stateful` and `stateless` mode, so a key that dies mid-session ends that session: its transport is closed and the request is answered `401`.
 - SSE resolves the key on connect and on each message post, and closes the session when its key dies.
 - A request inside a session must present the same key the session was opened with, otherwise it is answered `401`.
 - A `tools/call` naming a registered tool the caller lacks is answered `403` before the transport runs. A name that is not registered at all still reaches the SDK.
 - Authenticated transports register only the tools visible to that caller, so `tools/list` and `tools/call` stay in sync.
 - stdio is unfiltered on purpose: it is trusted local use by the operator who starts the process, and no key is presented.
 - Checking that a key was issued for this server's address is left to each application.

A verified or public caller who sees no tool still connects. A valid key whose scopes match no tool, or a caller with no key when every tool needs a scope, gets a normal connection and an empty `tools/list`, over Streamable HTTP in both modes and over SSE. A refused key is still `401`, and a call to a tool the caller lacks is still `403`. stdio still fails with "Resolved MCP tool registry is empty." when no tool is registered at all, because there that means the server is misconfigured.

## Known limits

 - Only OpenRouter has run against a live provider. See Providers.
 - The stricter key rules are a breaking change with no compatibility switch. See What changed.
 - A write tool with no inverse and no irreversibility is treated as irreversible. See Reversible and irreversible tools.
 - A server that stops mid-action can leave `approved` or `undone` without the work done. See Reversible and irreversible tools.
 - Background runs with no signed-in person are not supported.
 - Concurrency was tested on the built-in test database only.
 - The blog's production server stops on a request for a route that does not exist, because its error page view is never built. It does this with or without the agent. With the `agent` section removed, a request to `/agent/start` is such a request.

## What changed for existing users

This is a breaking change with no compatibility flag. Before upgrading, make sure every key you issue has a secret, an `active` value that is not `false`, and an `expires` in the future, and that clients send the full `id:secret` token.

Key handling:

 - An unknown key used to resolve to a `public` caller and now resolves to `invalid` and is answered `401`.
 - An inactive or expired key used to be accepted and is now `invalid`.
 - A key with a missing or wrong secret used to be accepted and was only hidden from non-`GET` tools; it is now `invalid`. `GET` tools used to skip the secret and now require it, so `requiresSecret()` returns `true` for every method.
 - A tool with several `scopes` used to be allowed when the caller held any one of them and now needs all of them.
 - A call to a tool the caller lacks a scope for used to fail inside the MCP result and is now a real `403`.
 - A valid key whose scopes match no tool used to get a `500` on connect ("Resolved MCP tool registry is empty.") and now connects and lists no tools. A request that reaches an HTTP or SSE transport without a server now fails with "No MCP server was created for this caller."
 - The generated model events of the agent records now refuse edits, deletes and outside creates with a `403`. A plugin that wrote to `AgentTurn`, `AgentAction` or `AgentUsage` through them has to use `createStore`.
 - A stateful HTTP session or an SSE session used to keep working after its key died and is now closed on the next request or message post.

Tool calls:

 - A tool event that fails used to be returned to the MCP client as a success with the failed event's results; it is now an error result.
 - Tool input can no longer carry `profileId`, `applicationId` or `sessionId`. They are removed and written from the caller.
 - A tool event now receives a request built with the tool's `method`, not a plain data object, and a tool that declares no `input` no longer receives the MCP request extras as input.
 - Two config entries with the same tool name used to register twice and are now merged into one tool.
 - An undo now tells the inverse's event what it is undoing, through `undoing(req)`. An inverse that ignores it behaves as before.

Code:

 - `AuthContext` gains an `invalid` kind, so code that switches on `auth.kind` should handle it.
 - `withToolData` in `stackpress-ai/helpers` takes a `Caller` instead of an `AuthContext` (use `callerFromAuth`). `requiresSecret` is still exported there and now returns `true` for every method; nothing in the package calls it any more.
 - `McpHttpServer` and `McpSseServer` take an optional trailing `registry` loader used for the `403` check, and `McpSseServer._handleSseConnection` now receives the resolved `auth`.
 - The package now lists `schema.idea` in its files and depends on `stackpress-session`. An app that wants the agent records adds the `use` line above.
