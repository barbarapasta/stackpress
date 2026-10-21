# App Settings And Public Imports

Frozen contract for G-006/G-007, accepted 2026-09-29. These settings are the agreed
implementation target, not features already available in a released package.
Product answers remain in [decisions](decisions.md). Operating limits and durations
are accepted library defaults; they are not claimed to be required by standards.

## Small App Example

The example uses the existing nested configuration and named-event pattern.
The app must register the two policy events described in [events](events.md).

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
},
mcp: {
  route: '/mcp',
  oauth: { resource: 'https://example.com/mcp' }
},
api: {
  endpoints: [{
    method: 'GET',
    route: '/api/articles/:id',
    type: 'session',
    event: 'article-detail',
    scopes: ['articles:read'],
    oauth: {
      operation: 'articles.detail',
      resources: ['https://example.com/mcp']
    },
    data: {}
  }]
}
```

API calls its user route type `session`; MCP calls its user tool type `user`.
Do not invent a new API caller type. `oauth` absent or `false` disables the new
feature on that configuration object. API `oauth: true` is invalid: membership
must be explicit. App-only and public API routes cannot enable user OAuth.

## Session Settings

| Field | Contract or default |
| --- | --- |
| `issuer` | Required absolute HTTPS URL, without credentials, query, or fragment; trusted configuration, never inferred from request headers |
| `base` | `/auth/oauth2`; absolute application path, separate from existing API OAuth routes |
| `resources` | Non-empty list of unique canonical service URLs, display names/descriptions, and supported scope names |
| `scopes` | Map of case-sensitive scope names to translated display names/descriptions; use OAuth scope-token grammar |
| `policy.approval`, `policy.access` | Required registered app event names; authorize the person's permissions under [events](events.md); no hardcoded role mapping |
| `policy.timeoutMs` | 5000 per policy invocation; timeout refuses the operation without issuing keys |
| `accessSeconds` | 900; positive integer |
| `renewalSeconds` | 604800 from original approval; positive integer; access is capped at that deadline |
| `codeSeconds` | 60; integer 1–600 |
| `pendingSeconds` | 600; integer 1–1800, including time spent signing in |
| `clients.allowed` | Omitted: any validated compatible client may request approval; otherwise exact client-ID list, including document URLs and registered IDs; empty list denies all |
| `registration.enabled` | `true`; disabling it removes its discovery field and route |
| `registration.bodyBytes` | 16384 decoded bytes; no unlimited setting |
| `registration.redirects` | At most 10 exact approved redirect entries per client |
| `registration.unusedSeconds` | 86400; remove unused registrations after this interval |
| `registration.maxUnused` | 10000 per issuer, enforced across processes; active registrations referenced by unexpired grants are retained |
| `clientMetadata.timeoutMs` | 5000 across DNS, connect, headers and body |
| `clientMetadata.bodyBytes` | 5120 decoded bytes, including compressed response expansion |
| `clientMetadata.maxEntries` | 1000 persisted cached documents per issuer |
| `clientMetadata.maxAgeSeconds` | 3600 maximum freshness; respect shorter HTTP lifetimes, revalidation and no-store; no stale fallback on failure |
| `limits.windowSeconds` | 60, using shared database counters |
| `limits.registration` | 10 requests per window per issuer and source address |
| `limits.authorization` | 30 requests per window per issuer and source address |
| `limits.token` | 60 requests per window per issuer/source first, then issuer/client/source; unknown clients share the source bucket |
| `limits.factor` | 5 attempts per window per pending request and profile, plus 20 per source address |
| `limits.clientMetadata` | 30 outbound cache-miss/revalidation fetches per window per issuer and source address |
| `browserOrigins` | Empty additional-origin list; protocol endpoints permit their configured origin and native requests without Origin |
| `development` | `false`; `true` additionally permits HTTP issuer/resource URLs on literal loopback/localhost only; never weakens remote client-document fetching |

All limits are positive safe integers with bounded allocation and overflow checks;
invalid values stop startup. Only code/pending lifetimes have the hard ceilings
above. Other values can be tuned deliberately. Reject malformed names, duplicate
scopes, unknown scope references and conflicting URLs. Resource identity is an
exact canonical URL with no credentials, query or fragment; do not trim paths or
turn a trailing slash into another service. Missing `resource` may default only
when the issuer has one configured resource; repeated/multiple values are rejected.
Unknown requested scopes return `invalid_scope`; omitted scope proposes that
resource's configured scopes, narrowed by app policy and the person's selection.
An explicitly empty granted scope list stays empty; MCP/API empty-list rules differ.

Limits use the actual peer address unless the application's trusted proxy setup
provides a verified address. Never trust arbitrary forwarded headers. Enforce source limits before allocating attacker-chosen client buckets. Counter
keys contain hashes rather than raw credentials. Rate refusal is 429 with
`Retry-After`; store failure is 503, never permission to skip the limit. Purge
expired buckets in bounded batches. Reserve unused-client and cache capacity atomically, not COUNT then insert.
Unused document-client identities share the unused lifetime/count limits; do not
create unbounded durable identities on failed document fetches. Metadata cache
eviction does not delete identities referenced by active grants. No configured allowlist is a publisher attestation.

## MCP And API Settings

`McpOAuthConfig` contains only `resource`; resolve issuer, scope declarations and
the fixed verification operation from the session service. Do not allow an app
to substitute a weaker verifier through this object. AI supplies its own protected
resource metadata on each standalone listener as well as attached app routes.

For older SSE at another URL, set `mcp.sse.oauth: { resource }` to that declared
resource. Separate `/mcp` and `/sse` services need separate approvals unless a
future separately tested design defines a shared canonical service. Do not infer
that two paths share authority. Enabling both transports requires distinct GET
handshake routes and an unambiguous SSE message POST route. Fail startup if they
collide. Browser origins and supported methods follow [recovery](recovery.md).

An API opt-in names one stable operation ID and one or more declared resources.
At route registration, save the trusted descriptor `{ id, surface: 'api', method,
route, event }`; `route` is the configured template, never caller input. Save its
fingerprint with each approved resource membership. Include fixed `endpoint.data`
and scope requirements in that fingerprint so changing the operation cannot
silently reuse approval. Canonicalize JSON keys and preserve array order; reject non-JSON fixed data on
OAuth-enabled routes rather than fingerprinting functions or unstable objects.
Changes to method, template, event, fixed data or scope requirements require new
approval; so do newly added operations. Reject duplicate IDs and `method: 'ALL'`
for OAuth opt-ins; declare each concrete method instead. GET alone permits read
IDs; HEAD and other methods require a full key. Generated routes follow the same
registration contract. Current opt-in, saved membership and permissions all apply.

## Startup, Routes And Packaging

Session's root plugin invokes its optional `oauth/plugin.ts`. During `config`,
validate configuration and register the typed `OAuthService` as `oauth`, using
the existing `database` plugin. During `listen`, register fixed library events; resolve required policy listeners
only at finalization after every listen/route handler has completed. During `route`, API registers trusted operation
definitions and AI registers resources/tool definitions. Expose idempotent `OAuthService.finalize(): Promise<void>` and the internal
`oauth-finalize` event. After all route listeners complete, serving app bootstraps
explicitly resolve that event and fail on a non-200 result. Update the blog
develop/production bootstraps as examples. AI standalone HTTP/SSE entrypoints call
finalize before listening, after Terminal.bootstrap has run config/listen/route.
No generic server-package dependency on session is needed. Generation/build-only
commands do not finalize a database that has not been generated yet.
Finalization checks policies, duplicate IDs, route collisions, schema availability,
required database capability and transport support. All OAuth handlers refuse
requests with 503 until it succeeds; prohibit registry mutation afterward. Custom
bootstraps must call it explicitly; do not rely on import order or arbitrary priority.

Derive `/authorize` (GET/POST), `/token` (POST), `/register` (POST), `/revoke`
(POST), `/connections` (GET), `/connections/revoke` (POST), and `/factor`
(GET/POST) beneath `base`. Serve issuer metadata at the RFC 8414 well-known path
and resource metadata at each RFC 9728 path. A root resource alias is valid only
for a single unambiguous resource. Metadata advertises code, refresh, S256, public
client authentication `none`, client-document support, and issuer-in-return support.
Do not advertise OpenID Connect, client credentials, implicit/password grants,
confidential-client authentication or offline_access as implemented features.

The global browser `session.access` authorizer must recognize exact registered
protocol/API/MCP route capabilities, allowing those handlers to enforce their own
identity checks. No broad `/auth/*` bypass. Approval/connections pages still load
`me`, verify the current profile and enforce browser ownership and CSRF. Native
protocol routes must not require a cookie or redirect a client to HTML sign-in.
Test this interaction with `session.access` enabled, including route priority.

Export configuration, identity, policy, event DTO and service-interface types from
session `src/oauth/types.ts` through `src/types.ts` and `src/index.ts`; forward
selected types through existing `stackpress/session/types` and `stackpress/session`
barrels. Keep storage classes, scripts, raw models and event implementations
private. Add matching CJS/ESM/declaration OAuth view subpaths. Package `oauth.idea`
and add its exact schema export without making the private runtime public.
AI declares a direct session dependency for these types. API already depends on
session. The aggregate plugin must not automatically load AI.

The consuming app explicitly includes `stackpress-session/oauth.idea`; that schema
includes `schema.idea`. Verify a second direct include of `schema.idea` is deduplicated
by generation, and first/repeated generation, migration and packed imports pass.
OAuth records gain no API or MCP exposure by default. Their generated admin pages are
admin-only and left out of the default menu, like Auth, Application and Session
([amendment A-001](decisions.md#amendment-a-001--admin-access-to-oauth-records)). The shared
[storage contract](storage.md) defines the required models and upstream prerequisite.
