# Config Reference

This page documents the app-facing Stackpress config surface. Use it when you are shaping `config.ts` or another bootstrap module and need to know what each config area is for.

## Import Pattern

Stackpress config is usually a plain object passed into a server instance:

```ts
import { server as http } from 'stackpress/http';
import type { Config } from 'stackpress/types';

const config: Config = {
  server: {
    mode: 'development'
  }
};

const app = http();
app.config.set(config);
```

## Top-Level Config Areas

The public Stackpress config type includes these top-level areas:

- `brand`
- `terminal`
- `server`
- `client`
- `cookie`
- `admin`
- `api`
- `email`
- `language`
- `database`
- `view`
- `auth`
- `session`
- `mcp`
- `agent`

Not every app needs every area. Most apps start with `server`, then add `client`, `database`, and `view` as the project grows.

## `server`

Use `server` to control server runtime behavior.

### Common Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `build` | `string` | General build-file location. Stackpress itself does not use it directly. |
| `cwd` | `string` | Defaults to `process.cwd()`. Used by server scripts and the view layer. |
| `mode` | `string` | Defaults to `'production'`. Common values are `'development'` and `'production'`. |
| `host` | `string` | Defaults to `127.0.0.1` for serve-style command flows. |
| `port` | `number` | Defaults to `3000` for serve-style command flows. |
| `process` | `string` | Development child-process container name. Defaults to `STACKPRESS_CHILD`. |

The source type is `ServerConfig` from `packages/stackpress-server/src/types.ts`.
Use this section when configuring runtime mode, local serve defaults, or shared
paths that server and view commands need.

### Example

```ts
server: {
  cwd: process.cwd(),
  mode: 'development',
  host: '127.0.0.1',
  port: 3000,
  process: 'STACKPRESS_CHILD'
}
```

### What It Affects

- server bootstrap behavior
- environment-sensitive runtime choices
- command flows such as `develop` and build-oriented scripts

## `client`

Use `client` to control generated client output.

### Common Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `build` | `string` | Generated client output directory. |
| `lang` | `string` | Defaults to `js`. Use `ts` when the generated client should be readable TypeScript. |
| `module` | `string` | Module name used when Stackpress imports generated client code into memory. |
| `package` | `string` | Package name written into generated client `package.json`. |
| `revisions` | `string` | Optional serialized idea revision directory used with push/migrate history. |
| `tsconfig` | `string` | TypeScript config used for generated client compilation. |
| `prettier` | `object` | Prettier option subset passed to generation formatting. |

The source type is `ClientConfig` from `packages/stackpress-schema/src/types.ts`.
`module` and `package` are required by the public type, while `build`,
`revisions`, `lang`, `tsconfig`, and `prettier` tune generation output.

```ts
import path from 'node:path';

client: {
  lang: 'ts',
  module: 'client-source',
  package: 'client-source',
  build: path.join(process.cwd(), 'client-source')
}
```

### What It Affects

- `stackpress generate`
- readable client inspection workflows
- how generated client code is resolved and imported

## `database`

Use `database` to control schema migrations, schema defaults, and populate behavior.

### Common Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `seed` | `string` | Required. Used to encrypt and decrypt database data. |
| `migrations` | `string` | Optional directory for generated create/alter migration files. |
| `schema.onDelete` | `'CASCADE' \| 'SET NULL' \| 'RESTRICT'` | Relation delete behavior used by generated database schema rules. |
| `schema.onUpdate` | `'CASCADE' \| 'SET NULL' \| 'RESTRICT'` | Relation update behavior used by generated database schema rules. |
| `populate` | `{ event: string; data: Record<string, any> }[]` | Events emitted by `stackpress populate`. |

The source type is `DatabaseConfig` from `packages/stackpress-sql/src/types.ts`.
Use `populate` for event-shaped seed data, not for raw SQL statements.

```ts
database: {
  seed: process.env.DATABASE_SEED || 'change-me',
  migrations: path.join(process.cwd(), '.build/migrations'),
  schema: {
    onDelete: 'CASCADE',
    onUpdate: 'RESTRICT'
  },
  populate: [
    {
      event: 'article-create',
      data: {
        title: 'Hello World',
        slug: 'hello-world'
      }
    }
  ]
}
```

### What It Affects

- `stackpress push`
- `stackpress populate`
- `stackpress query`
- generated migration output
- default schema behavior for generated SQL

## `view`

Use `view` to control rendering behavior and shared page props.

### Common Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `noview` | `string` | Defaults to `json`. Request-data flag used to disable template rendering. |
| `base` | `string` | Defaults to `/`. Used by Vite and development mode to determine project root behavior. |
| `props` | `Record<string, unknown>` | Shared view props. |
| `notify` | `NotifierOptions` | Frui notifier settings. |
| `engine` | `Partial<ReactusConfig>` | Reactus settings. If missing, Reactus-backed rendering is disabled. |

The source types are `ViewConfig` from `packages/stackpress-view/src/types.ts`
and `packages/stackpress-view/src/client/server/types.ts`.

```ts
view: {
  base: '/',
  props: {
    appName: 'Example'
  },
  noview: 'json',
  engine: {
    assetPath: path.join(process.cwd(), 'public/assets')
  }
}
```

### What It Affects

- page rendering behavior
- `setViewProps(...)`
- values exposed under `res.data.view`

## `brand`

Use `brand` to define shared brand-facing values injected into the view layer.

### Common Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `name` | `string` | Brand or app name exposed to view props. |
| `logo` | `string` | Logo URL or path used by layouts. |
| `icon` | `string` | Icon URL or path used by layouts and metadata. |
| `favicon` | `string` | Browser favicon URL. |

The source type is `BrandConfig` from `packages/stackpress-view/src/client/server/types.ts`.

```ts
brand: {
  name: 'Example App',
  logo: '/logo.png',
  icon: '/icon.png',
  favicon: '/favicon.ico'
}
```

### What It Affects

- values exposed under `res.data.brand`
- shared layout and document rendering behavior

## `language`

Use `language` to define locale and translation behavior.

### Common Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `key` | `string` | Request/session key used to store the selected locale. |
| `locale` | `string` | Default locale. |
| `languages` | `Record<string, string \| { label: string; translations: Record<string, string> }>` | Supported locales and translation maps. |

The source type is `LanguageConfig` from `packages/stackpress-language/src/types.ts`.

```ts
language: {
  key: 'locale',
  locale: 'en_US',
  languages: {
    en_US: 'English'
  }
}
```

### What It Affects

- values exposed under `res.data.language`
- translation and language helpers in the view layer

## `session` And `auth`

Use these sections when your app introduces authentication or session-aware behavior.

### `session` Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `key` | `string` | Session cookie name. |
| `seed` | `string` | Required. Used to generate session IDs and tokens. |
| `access` | `Record<string, Array<string \| { method: string; route: string }>>` | Role-to-permission whitelist. |

### `auth` Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `base` | `string` | Base auth route path. |
| `redirect` | `string` | Route used after successful auth flows. |
| `2fa` | `object` | Two-factor auth settings placeholder. |
| `captcha` | `object` | Captcha settings placeholder. |
| `email.name` | `string` | Sender display name for auth email flows. |
| `email.address` | `string` | Sender email address for auth email flows. |
| `roles` | `string[]` | Roles assigned to new signups. |
| `menu` | `{ type?: string; target?: string; name: string; icon?: string; path: string }[]` | Static signin menu entries. |
| `password` | `{ min?: number; max?: number; upper?: boolean; lower?: boolean; number?: boolean; special?: boolean }` | Password policy settings. |

The source types are `SessionConfig` and `AuthConfig` from
`packages/stackpress-session/src/session/types.ts` and
`packages/stackpress-session/src/auth/types.ts`.

These areas usually become relevant only after the app has adopted the session/auth layer.

## `api`

Use `api` when your app exposes OAuth, REST, or webhook configuration through the Stackpress API layer.

### Shape

| Key | Type | Default / Notes |
| --- | --- | --- |
| `expires` | `number` | Optional session/application expiration window. Defaults to never expiring when omitted. |
| `webhooks` | `ApiWebhook[]` | External calls emitted when configured events happen. |
| `scopes` | `Record<string, ApiScope>` | Named OAuth/API scopes. |
| `endpoints` | `ApiEndpoint[]` | REST-style endpoints backed by Stackpress events. |

`ApiScope` has `icon?`, `name`, and `description`. `ApiEndpoint` has
`method`, `route`, `type`, `event`, `data`, and optional `name`,
`description`, `example`, `scopes`, `cors`, and `priority`.

`ApiWebhook` has `event`, `uri`, `method`, `validity`, and `data`. The source
type is `ApiConfig` from `packages/stackpress-api/src/types.ts`.

### Example

```ts
api: {
  scopes: {
    'articles.read': {
      icon: 'file',
      name: 'Read Articles',
      description: 'Allows reading published article data.'
    }
  },
  endpoints: [{
    method: 'GET',
    route: '/api/articles',
    type: 'public',
    event: 'article-search',
    data: {}
  }]
}
```

## `admin`

Use `admin` when your app exposes generated admin behavior.

### Shape

| Key | Type | Default / Notes |
| --- | --- | --- |
| `name` | `string` | Admin section name shown in admin layout. |
| `base` | `string` | Base route for generated admin pages. |
| `menu` | `{ name: string; icon?: string; path: string; match: string }[]` | Static admin menu items. |

The source type is `AdminConfig` from `packages/stackpress-admin/src/client/types.ts`.

### Example

```ts
admin: {
  name: 'Admin',
  base: '/admin',
  menu: [{
    name: 'Articles',
    icon: 'file',
    path: '/admin/article/search',
    match: '/admin/article/**'
  }]
}
```

## `mcp`

Use `mcp` when your app should offer its events as tools to outside AI clients over the Model Context Protocol. The `stackpress-ai` plugin must be loaded. The MCP transports register only when this section exists.

### Common Keys

| Key | Type | Default / Notes |
| --- | --- | --- |
| `name` | `string` | Server name sent to clients. Defaults to `Stackpress AI Server`. |
| `title` | `string` | Display title. Defaults to `Stackpress AI Server`. |
| `description` | `string` | Optional description sent to clients. |
| `version` | `string` | Server version sent to clients. Defaults to the package version. |
| `route` | `string` | Streamable HTTP route. Defaults to `/mcp`. |
| `mode` | `'stateful' \| 'stateless'` | HTTP session mode. Defaults to `'stateful'`. |
| `host` | `string` | Defaults to `server.host`. When host and port match the main server, the route is attached to it. |
| `port` | `number` | Defaults to `server.port`. |
| `messages` | `string` | SSE message route. Defaults to `/messages`. |
| `sse` | `{ host?: string; port?: number; route?: string; key?: string }` | Enables the legacy SSE transport. Host, port and route default to the `mcp` values. `key` is an internal name for the attached routes and rarely needs setting. |
| `tools` | `ToolConfig[]` | Tools served from config. Plugins can add more with the `ai-tools` event. |

A tool has `event` (required) and optional `name`, `title`, `description`, `method` (defaults to `GET`), `input` and `output` (JSON Schema), `type` (`public`, `app` or `user`; defaults to `public`), `scopes` (a caller needs all of them), `data`, `mode`, `inverse`, `irreversible`, `agent` and `operation`. The last four matter to the built-in agent; see [stackpress-ai](../packages/stackpress-ai/README.md).

The source types are `McpConfig` and `ToolConfig` from `packages/stackpress-ai/src/types.ts`.

### Example

```ts
mcp: {
  name: 'Blog MCP',
  route: '/mcp',
  mode: 'stateful',
  tools: [{
    name: 'article_search',
    type: 'app',
    method: 'GET',
    event: 'article-search',
    scopes: [ 'articles.read' ],
    input: { type: 'object', properties: { q: { type: 'string' } } }
  }]
}
```

### What It Affects

- the MCP routes and the `mcp-http`, `mcp-sse` and `mcp-stdio` events
- which tools a caller sees, by key, type and scopes
- a presented key is checked on every request: it must exist, be active, be unexpired and match its secret, or the request is answered `401`

## `agent`

Use `agent` when your app should have the built-in chat agent. The `stackpress-ai` plugin must be loaded and `stackpress-ai/schema.idea` added to the app's idea file. The agent turns on only when this section exists, and it registers the chat routes under `base`.

### Shape

| Key | Type | Default / Notes |
| --- | --- | --- |
| `providers` | `Record<'anthropic' \| 'openai' \| 'openrouter', { key: string }>` | Required. `key` is the name of the environment variable that holds the provider's key, not the key. |
| `model` | `string` | Required. The default model identifier. It has to be in `models`. |
| `models` | `{ provider: string; model: string; title?: string }[]` | Required. The models the picker offers. |
| `instructions` | `string` | Extra text added to the agent's instructions. |
| `limit` | `number` | Reported input plus output tokens per person per UTC day. With a limit, durable admission permits one provider call per person at a time. A single reply may exceed the remaining allowance; subsequent calls are refused. No limit when unset. |
| `approvalTtl` | `number` | Milliseconds a pending approval stays valid. When unset it ends only when the person sends a new message. |
| `steps` | `number` | Model calls one turn may make. Defaults to `8`. |
| `base` | `string` | Mount path of the chat routes. Defaults to `/agent`. |

The source type is `AgentConfig` from `packages/stackpress-ai/src/types.ts`.
Keys are read from the environment each time they are needed. With no key set for the chosen provider, a message is answered `503` and the rest of the server keeps running. If the app sets `session.access`, add `/agent/**` for the roles that may use the agent.

### Example

```ts
agent: {
  providers: { anthropic: { key: 'ANTHROPIC_API_KEY' } },
  model: 'claude-opus-5-5',
  models: [{
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    title: 'Claude Opus 5.5'
  }],
  limit: 200000,
  approvalTtl: 1000 * 60 * 30
}
```

### What It Affects

- the `ai-*` events and the chat routes under `base`
- the five agent tables added by `stackpress-ai/schema.idea`
- which models a person can pick and how many tokens they may use per day

## `email`

Use `email` when your app needs framework-level email delivery settings.

### Shape

`EmailConfig` is a Nodemailer transport config union. It can be a
`TransportOptions` object, JSON transport options, sendmail options, SES
options, SMTP pool options, SMTP options, stream transport options, or a
connection string.

The source type is `EmailConfig` from `packages/stackpress-email/src/types.ts`.
Sender identity for auth email flows lives under `auth.email`, not under the
general `email` transport block.

### Example

```ts
email: {
  host: process.env.SMTP_HOST,
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}
```

## `cookie`

Use `cookie` to define shared cookie behavior such as cookie options passed into session or response flows.

### Shape

| Key | Type | Default / Notes |
| --- | --- | --- |
| `domain` | `string` | Cookie domain. |
| `expires` | `Date` | Absolute expiration date. |
| `httpOnly` | `boolean` | Prevents browser JavaScript access when true. |
| `maxAge` | `number` | Relative lifetime in seconds. |
| `path` | `string` | Defaults to `/` in the HTTP and WHATWG adapters. |
| `partitioned` | `boolean` | Partitioned cookie flag. |
| `priority` | `'low' \| 'medium' \| 'high'` | Cookie priority flag. |
| `sameSite` | `boolean \| 'lax' \| 'strict' \| 'none'` | SameSite behavior. |
| `secure` | `boolean` | Sends cookie only over HTTPS when true. |

The source type is `CookieOptions` from `@stackpress/lib/types`, re-exported
through Ingest and consumed by Stackpress as `CookieConfig`.

### Example

```ts
cookie: {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}
```

## `terminal`

Use `terminal` when your app exposes or customizes terminal behavior directly through the Stackpress terminal layer.

### Shape

| Key | Type | Default / Notes |
| --- | --- | --- |
| `label` | `string` | Label used in verbose terminal output. |
| `idea` | `string` | File path of the main idea file, commonly `schema.idea`. |

The source type is `TerminalConfig` from `packages/stackpress-server/src/types.ts`.

### Example

```ts
terminal: {
  label: 'APP',
  idea: 'schema.idea'
}
```

## Related

 - [CLI Reference](./cli-reference.md)
 - [View](./view.md)
 - [Types](./types.md)
