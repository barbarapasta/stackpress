# Native MCP/API OAuth Setup

Spec: [00004-mcp-native-oauth](../.agents/specs/00004-mcp-native-oauth/). This
feature lets a real person approve a native MCP client or a protected API route
to act as them, with its own approval screen, access/refresh keys and
connections list — separate from the existing Application/Session API keys
documented in [`api`](./config-reference.md#api). Both mechanisms can run side
by side; this page covers only the new one.

The runnable reference is [`templates/blog`](../templates/blog), which wires
every piece described here: `templates/blog/config/common.ts`
(`session.oauth`, `mcp.oauth`, the OAuth-enabled `/api/articles/:id` route),
`templates/blog/plugins/app/oauth.ts` (the two required policy listeners) and
`templates/blog/config/develop.ts`/`production.ts` (the `oauth-finalize`
bootstrap call). Treat the blog as the copy/paste starting point; this page
explains why each piece is there.

## 1. Add The Schema

`stackpress-session` packages a second schema file, `oauth.idea`, alongside
its existing `schema.idea` (Profile/Auth). Include it from your app's schema:

```idea
use "stackpress/stackpress.idea"
use "stackpress-session/oauth.idea"
```

`oauth.idea` itself `use`s `stackpress-session/schema.idea`, so Profile/Auth
are not duplicated even though `stackpress/stackpress.idea` already includes
them through `stackpress-api/schema.idea` — generation dedupes the repeated
include. Run `yarn generate` (or your app's equivalent) twice in a row to
confirm this for your own app; nothing should change on the second run.

This adds nine private tables (`OAuthClient`, `OAuthClientDocument`,
`OAuthPending`, `OAuthGrant`, `OAuthCode`, `OAuthRefreshToken`,
`OAuthLegacyBinding`, `OAuthFactorUse`, `OAuthRateBucket`). They get the same
generic per-model Store/Actions/Events every Stackpress model gets, **and**
(per [amendment A-001](../.agents/specs/00004-mcp-native-oauth/decisions.md#amendment-a-001--admin-access-to-oauth-records))
a generated admin page each, reachable by role but **not added to any admin
menu** and **never showing a hash/credential column** — the same treatment
already given to the existing Auth, Application and Session tables.

**Do not call the generic generated events for these nine models from your own
app code.** They bypass `OAuthStore`'s hashing, locking and approval
guarantees. Treat them as read-only admin-page backing only.

### Keeping the OAuth admin pages out of the menu

Nothing extra is required — the generated admin pages exist but are never
added to your `admin.menu` config, so a role that can reach `/admin` simply
never sees a link to them unless you add one yourself (`templates/blog` does
not). If you want them unreachable even by direct URL for every role, add
your own app-level transform that filters those nine models out before the
admin router sees them; the library does not do this for you, because the
first pass tried an undecorated-column-only approach and generation proved
that insufficient (see the amendment above).

### If you already generated `oauth.idea` before 2026-10-15

`oauth_pending.factor_receipt` was widened from `VARCHAR(255)` to `TEXT`
during this feature's own development, after a real browser 2FA-to-approval
run showed a signed factor receipt reliably exceeds 255 characters. If your
app's `.build/migrations` history was generated before that fix, re-run
`yarn generate` and `yarn migrate` (or your equivalent) once to pick up the
wider column before approving anything that requires a stronger-check factor;
otherwise `oauth-authorize` will fail with a raw 500 on that specific path.

## 2. Configure `session.oauth`

```ts
session: {
  seed: 'read-from-the-app-secret-store',
  oauth: {
    issuer: 'https://example.com',
    base: '/auth/oauth2',
    resources: [{
      resource: 'https://example.com/mcp',
      name: 'Example service',
      description: 'Tools and approved API operations',
      scopes: ['articles:read', 'articles:write']
    }],
    scopes: {
      'articles:read': { name: 'Read articles', description: 'Read your articles' },
      'articles:write': { name: 'Change articles', description: 'Change your articles' }
    },
    policy: {
      approval: 'example-oauth-approval',
      access: 'example-oauth-access'
    }
  }
}
```

Full field list, defaults and limits: see
[configuration.md](../.agents/specs/00004-mcp-native-oauth/configuration.md#session-settings).
A few points worth calling out:

- `issuer` must be an absolute HTTPS URL with no credentials/query/fragment.
  The one exception is `development: true` with a literal loopback/localhost
  host — used by `templates/blog`'s dev config so it can run on
  `http://127.0.0.1:<port>`. Never set `development: true` outside a local
  loopback deployment.
- `base` must differ from the existing API OAuth base (`auth.base`'s
  `/token`/`/oauth` pages); `templates/blog` uses `/auth/oauth2`.
- `clients.allowed`, `registration`, `clientMetadata` and `limits` all have
  library defaults; only set them when you need something different.
- Scope names are your own vocabulary. They only need to match the `scopes`
  you put on `api.endpoints[].oauth`/`mcp.tools[].scopes` entries that should
  be reachable through an approved grant — see step 4.

### The two required policy listeners

`policy.approval` and `policy.access` name two events **your app** must
register; Stackpress never hardcodes a role-to-permission mapping. See
[events.md](../.agents/specs/00004-mcp-native-oauth/events.md) for the exact
input/result shape. `templates/blog/plugins/app/oauth.ts` is a complete,
working example:

```ts
export function approval(input: OAuthApprovalPolicyInput): OAuthApprovalPolicyResult {
  const stronger = input.profile.roles.includes('ADMIN')
    || input.profile.roles.includes('MANAGER');
  //an ordinary account may only approve read access; only a stronger-check
  //account may approve write access
  return {
    allowed: true,
    scopes: stronger ? input.scopes : input.scopes.filter(s => s === 'articles.read'),
    operations: stronger ? input.operations : input.operations.filter(o => o === 'articles.detail')
  };
}

export function access(_input: OAuthAccessPolicyInput): OAuthAccessPolicyResult {
  return { allowed: true };
}
```

Both types import from `stackpress/session/types` (forwarded from
`stackpress-session/types`). Register them as ordinary events on `listen`,
same as any other app event:

```ts
server.on('listen', async () => {
  server.on('example-oauth-approval', action(async ({ req, res }) => {
    res.results(approval(req.data() as unknown as OAuthApprovalPolicyInput));
  }));
  server.on('example-oauth-access', action(async ({ req, res }) => {
    res.results(access(req.data() as unknown as OAuthAccessPolicyInput));
  }));
});
```

`access` is re-invoked independently on every exchange/verify/refresh — it is
not merely re-checking what `approval` already decided. Narrow `scopes` there
if your app wants to revoke privileges after the fact (for example when a
role changes) without waiting for the grant to expire.

### Session access rules

`session.access`'s existing broad `/auth/**` entry already covers
`${session.oauth.base}/**` for any role whose list includes it — native
protocol routes (`/token`, `/register`, `/revoke`, the well-known discovery
paths) never need an entry at all, since the global browser authorizer
recognizes them by address and skips the cookie check entirely for a
bearer-token caller. Only add explicit `GUEST` entries for the two
**browser** pages a signed-out visitor must still reach:

```ts
GUEST: [
  //...
  { method: 'GET', route: '/auth/oauth2/authorize' },   // redirects to signin
  { method: 'GET', route: '/auth/oauth2/connections' }  // redirects to signin
]
```

`/factor` and the POST approval/revoke actions never need a GUEST entry —
they require a signed-in profile by design.

## 3. Finalize On Boot

After `config`/`listen`/`route` have all resolved, explicitly resolve
`oauth-finalize` and fail startup on a non-200 result. This is what checks
that both policy listeners, the `database` plugin and all nine required
protocol events are actually registered — the whole feature refuses every
request with 503 until this succeeds.

```ts
await server.resolve('config');
await server.resolve('listen');
await server.resolve('route');
const oauth = await server.resolve('oauth-finalize');
if (oauth.code !== 200) {
  throw new Error(`OAuth failed to start: ${oauth.error || oauth.code}`);
}
```

**Only call this from a bootstrap that is actually about to serve
requests.** `templates/blog/config/develop.ts` is shared by every
`stackpress` command that points `--b` at it (`generate`, `migrate`,
`populate`, `push`, `query`, `purge`, `emit`, `develop`) because a single
file both builds the `Config` object and exports the `bootstrap()` the CLI
calls generically — finalizing against a database that `generate`/`migrate`
haven't created yet throws. Guard it:

```ts
if (['develop', 'serve'].includes(process.argv[2])) {
  const oauth = await server.resolve('oauth-finalize');
  if (oauth.code !== 200) {
    throw new Error(`OAuth failed to start: ${oauth.error || oauth.code}`);
  }
}
```

`config/production.ts`'s bootstrap is only ever reached by the `serve`
command, so it finalizes unconditionally. If your app's standalone AI
HTTP/SSE entrypoint runs separately from the serving app
(`stackpress-ai`'s own `http()`/`sse()` functions), it already calls
`finalize()` for you after its own `Terminal.bootstrap()`.

## 4. Opt An API Route Or MCP Tool In

Nothing is exposed by default. Both API and MCP opt-in are per-route/per-tool.

### API

```ts
api: {
  endpoints: [{
    method: 'GET',
    route: '/api/articles/:id',
    type: 'session',       //required: only a `session`-type route may opt in
    event: 'article-detail',
    scopes: ['articles.read'],   //checked against the OAuth grant's scopes
    oauth: {
      operation: 'articles.detail',  //stable ID; renaming it requires new approval
      resources: ['https://example.com/mcp']
    },
    data: {}
  }, {
    //a write counterpart on the same route: any non-GET method is a write
    //operation under the method-based classification, so it always needs
    //the full `id:secret` key, never a read-only ID
    method: 'PATCH',
    route: '/api/articles/:id',
    type: 'session',
    event: 'article-update',
    scopes: ['articles.write'],
    oauth: {
      operation: 'articles.update',
      resources: ['https://example.com/mcp']
    },
    data: {}
  }]
}
```

`oauth: true` is rejected outright — membership must be explicit. An
`app`/`public` type route cannot opt in. A GET request may use a read-only
ID; every other method requires the full `id:secret` key. Changing the
route's method, template, event, fixed `data` or `scopes` — or adding a new
opted-in operation — requires fresh approval; it is fingerprinted into the
grant. A grant that only approved the read operation/scope is refused on
the write route; approving both lets the same key read and write.

### MCP

```ts
mcp: {
  route: '/mcp',
  oauth: { resource: 'https://example.com/mcp' },  //enables this listener
  tools: [{
    mode: 'plugin',
    type: 'user',                 //only `user`-type tools accept an OAuth identity
    event: 'comment-create-tool',
    scopes: ['comments.write']    //checked against the OAuth grant's scopes
  }]
}
```

For older SSE at a separate URL, set `mcp.sse.oauth: { resource }`
independently — a `/mcp` and a `/sse` listener are two separate approved
services unless your own tested design states otherwise. An `app`-type tool
(legacy application key) is unaffected either way; `user`-type is the only
tool type an OAuth identity can satisfy.

## 5. Try It

With `templates/blog` running (`yarn generate && yarn migrate && yarn push &&
yarn populate && yarn dev:start`, same as any other setup of that template):

```bash
curl http://127.0.0.1:3000/.well-known/oauth-authorization-server
```

returns the RFC 8414 discovery document (issuer, `/auth/oauth2/authorize`,
`/auth/oauth2/token`, `/auth/oauth2/register`, `/auth/oauth2/revoke`, the
three `articles.read`/`articles.write`/`comments.write` scopes). A native
client (or a manual `/auth/oauth2/register` + browser `/auth/oauth2/authorize`
visit, signed in as the seeded `developer`/`developer` account) walks the
approve screen, lands on `/auth/oauth2/connections` once approved, and from
there can call the OAuth-protected `GET`/`PATCH /api/articles/:id` routes and
the `comment_create` MCP tool with the minted key — `GET` accepts a read-only
ID, `PATCH` always needs the full `id:secret` and only works if the grant
approved `articles.write`/`articles.update`. [00007](../.agents/specs/00004-mcp-native-oauth/tasks/00007-approval-factor-and-connections-pages.md)'s
task notes have 25 screenshots of every page/state in this flow already
reviewed; this page does not repeat them.

## Related

- [Config Reference](./config-reference.md) — the existing `session`, `api` and `mcp` shapes this extends.
- [Session](./session.md) — the `stackpress/session` export surface, including the forwarded OAuth types.
- [Upgrade And Migration](./oauth-upgrade.md) — legacy API-key migration, recovery paths and current release limits.
