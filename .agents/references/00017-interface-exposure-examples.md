# Interface Exposure Examples

Use these recipes to expose an existing Stackpress event through a handwritten
page, configured API endpoint, MCP tool, or the built-in AI agent. The event remains capability
authority; each interface adds its own input, identity, and output contract.

## Handwritten Page And View

Register data and view handlers during `route`:

```ts
import type { HttpServer } from 'stackpress/server';

export default function plugin(server: HttpServer) {
  server.on('route', () => {
    server.import.get('/', () => import('./pages/home.js'));
    server.view.get('/', '@/plugins/app/views/home');
  });
}
```

The page handler invokes the reusable capability and adds browser-safe config:

```ts
import { action } from 'stackpress/server';
import { setViewProps } from 'stackpress/view';

export default action(async ({ req, res, ctx }) => {
  req.data.set('status', 'PUBLISHED');
  await ctx.emit('article-search', req, res);
  setViewProps(req, res, ctx);
});
```

The React page reads the serialized response:

```tsx
import type { ServerConfigPageProps } from 'stackpress/view/client';
import { LayoutPanel, useResponse } from 'stackpress/view/client';

export function Body() {
  const rows = useResponse<Article[]>().results || [];
  return <main>{rows.map(row => (
    <a key={row.id} href={`/articles/${row.slug}`}>{row.title}</a>
  ))}</main>;
}
export function Head({ styles = [] }: ServerConfigPageProps) {
  return <><title>Articles</title>{styles.map(href => (
    <link key={href} rel="stylesheet" href={href} />
  ))}</>;
}
export default function Page(props: ServerConfigPageProps) {
  return <LayoutPanel {...props}><Body /></LayoutPanel>;
}
```

Import handlers establish data/status; view handlers render later by priority.
Keep snapshots serializable and free of secrets/native resources. Sanitize HTML
before using `dangerouslySetInnerHTML`. Verify SSR, hydration, keyboard behavior,
responsive layout, error/empty states, and authorization.

## API Endpoint Over An Event

```ts
api: {
  scopes: { articles: { name: 'Articles', description: 'Read articles' } },
  endpoints: [{
    method: 'GET',
    route: '/api/articles',
    type: 'app',
    scopes: ['articles'],
    event: 'article-search',
    cors: ['https://example.com'],
    data: { status: 'PUBLISHED' }
  }]
}
```

`public` skips app/session identity; `app` resolves application credentials and
scopes; `session` resolves user session and scopes. Non-GET app/session requests
also compare the supplied secret. Endpoint fixed data is merged before event
invocation.

Verify OPTIONS and actual CORS headers, unlisted origins, missing/malformed/
invalid credentials, inactive or expired identity behavior, scope denial,
request-vs-fixed-data precedence, event errors, status mapping, and output shape.
Configured endpoint scope does not authorize direct calls to the event elsewhere.

## MCP Tool Over The Same Event

```ts
mcp: {
  route: '/mcp',
  mode: 'stateful',
  tools: [{
    name: 'article_search',
    title: 'Search Articles',
    description: 'Find published articles.',
    type: 'public',
    method: 'GET',
    event: 'article-search',
    input: {
      type: 'object',
      properties: { q: { type: 'string' } }
    },
    data: { status: 'PUBLISHED' }
  }]
}
```

Load `stackpress-ai` explicitly. It activates when `mcp` or `agent` config
exists. Each registry build merges tools contributed by plugins (below) with
`mcp.tools` by name, normalizes them, converts JSON Schema to runtime
validation, filters listing and calls by `public`/`app`/`user` identity and
scopes, then runs the event through the one shared execution path. A tool's
`type` defaults to `public`: set `type` and `scopes` on every write.

A presented key must be known, active, unexpired, and secret-matching on every
method, and a tool needs every listed scope. A refused key answers `401`, never
public access. A call to a registered tool the caller lacks answers `403`. A
valid caller that sees no tools gets an empty list. A live session ends when
its key dies. stdio is unfiltered local use. Key checks do not make the event
safe on other edges.

A plugin can contribute the same tool without touching config:

```ts
import { contributeTool } from 'stackpress-ai';

server.on('listen', ({ ctx }) => {
  ctx.on('ai-tools', ({ ctx }) => contributeTool(ctx, {
    name: 'article_search', type: 'user', scopes: [ 'articles.read' ],
    method: 'GET', event: 'article-search'
  }));
});
```

The event reads who is calling with `caller(req)` (`public`, `app`, `user`, or
`person`), a record kept apart from input; input cannot set `profileId`,
`applicationId`, or `sessionId`. Resolve the event with a request, not plain
data, wherever its caller comes from the session.

Verify tool listing and calls for every identity class including a key that is
unknown, inactive, expired, or lacking its secret; scope denial and the empty
list; invalid payloads; fixed-data precedence; target event authorization; a
failed event reported as an error; stateful session reuse or stateless
isolation; and transport shutdown.

## The Built-In Agent Over The Same Event

Mark a tool `agent: true` to offer it to the built-in agent, which acts as the
signed-in person. The agent reads neither `type` nor `scopes` for that person,
so the event must authorize. A write with no `inverse` waits for the person's
approval (declare `irreversible: true` to say so); a tool with an `inverse` runs
at once and shows Undo, and the inverse's event can read `undoing(req)`. Verify
the event as a signed-in user and as a refused one, the approval and undo
paths, a repeated click, and that the person's own access still decides.
Agent config, approval, and records are in
[AI Agent Runtime, Records, And Panel](00020-ai-agent-runtime-records-and-panel.md).

## Cross-Surface Consistency

When one event is exposed through pages, API, MCP, and the agent, compare:

| Concern | Page | API | MCP | Built-in agent |
| --- | --- | --- | --- | --- |
| identity | session/request guard | public/app/session token | public/app/user key, verified every request | signed-in session only |
| validation | handler/generated action | endpoint + event | JSON Schema + event | JSON Schema + event |
| output | SSR snapshot/HTML | HTTP status/JSON | MCP tool result text/schema | progress events, stored thread |
| errors | error event/view | status envelope | `401`/`403`, tool error result | fixed text; app refusal shown on the action |
| policy | route permissions | endpoint scopes | tool visibility/scopes | `agent: true`, approval, daily limit, the event |

Do not assume these policies are synchronized automatically. Reuse the event for
mechanism, then test each adapter's caller and protocol contract independently.

## Source Anchors And Authority

Anchors: maintained blog/store app handlers/views, API plugin endpoint adapters,
AI tool registry/execution/transports and agent runtime, view rendering
contract, session authorization, and generated model events. Examples demonstrate current paths;
owning source contracts remain authority.
