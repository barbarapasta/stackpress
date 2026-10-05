# Stackpress Interfaces And Experience

## Access Surfaces

Stackpress exposes shared server capabilities through multiple adapters:

| Surface | External contract | Access responsibility |
| --- | --- | --- |
| CLI | parsed command and flags | local operator/process policy |
| page/admin | route, request, session, form/CSRF | route and page authorization |
| configured API | HTTP method, path, headers, body | public/app/session identity and scopes |
| OAuth | browser and token flows | application/session records and secrets |
| MCP | tool schemas over stdio, HTTP, or SSE | public/app/user context and scopes |
| desktop | Electron shell, menu, local runtime request | local token and route policy |
| plugin | in-process event call | trusted code or explicit application checks |

Named events are the shared internal invocation protocol. They do not make these
callers equivalent or apply one universal security policy.

## Exposure Models

- Generated model listeners create internal domain capabilities.
- Generated admin routes expose model workflows during `route`.
- Configured API endpoints explicitly map method/path/caller policy to an event.
- MCP can generate model tool definitions, while config selects final visibility,
  overrides, caller type, and transport.
- CLI packages register operational commands as events.
- Desktop packages register optional local commands and contribution events.

Generation supplies candidate integrations; it does not expose every capability
through every surface automatically.

## Surface Adapter Flow

```mermaid
flowchart LR
  CALLER["External caller"] --> PROTOCOL["Surface protocol"]
  PROTOCOL --> POLICY["Identity and access policy"]
  POLICY --> INPUT["Input mapping and validation"]
  INPUT --> EVENT["Named server capability"]
  EVENT --> RESPONSE["Shared response and status"]
  RESPONSE --> OUTPUT["Surface-specific output"]
```

Equivalent operations can legitimately have different identity, validation,
error, and presentation contracts. Direct in-process event resolution has no
automatic caller authorization.

## Host-Routed React

Ingest owns route matching and page action order. A page handler resolves data
and capabilities, selects a React entry, and places response data into the view
pipeline. stackpress-view adapts Reactus as the SSR, asset, build, and hydration
engine.

The view adapter passes a serialized server snapshot containing:

- configured and response data;
- public session details;
- URL fields, headers, request-session data, method, MIME type, and request data;
- normalized response status, errors, results, and totals.

Reactus renders the selected page on the server, embeds the props, and hydrates
the browser with the same snapshot. Client request/response/session wrappers are
readonly helpers over serialized data, not live server objects.

Rendering is skipped for redirects, the configured no-view request flag, or an
existing string body. Development mode can let Reactus/Vite middleware handle
assets and HMR before the response completes.

## Browser Snapshot Boundary

Everything in rendered props is browser-visible and must be intentionally safe
to expose and JSON-serializable. Functions, cyclic structures, native resources,
server secrets, and unnecessary request/session fields do not belong in the
snapshot.

No framework-wide prop allowlist or complete snapshot escaping policy is an
accepted current guarantee. Security-sensitive applications should minimize
forwarded fields and test hostile values, SSR output, and hydration.

## UI And Localization Ownership

- stackpress-view generates role-specific form/filter/list/span/view wrappers;
- stackpress-admin composes generated CRUD pages and routes;
- Frui supplies generic behavior-focused React components, not application
  layout/theme/brand policy;
- r22n translates source phrases and preserves React nodes in interpolation;
- Stackpress config and language/session packages choose locale and caller state;
- Reactus owns rendering/build mechanics, not application routes or domain data.

Generated wording is part of the translation contract. Generated structure does
not replace rendered accessibility and interaction verification.

## Cross-Surface Risks

- access policy can diverge between page, API, and MCP mappings;
- nested event calls can lose caller context unless intentionally propagated;
- validation and errors can map differently by protocol;
- generated definitions and configured exposure can drift;
- audit identity and tracing are not automatically centralized.

## Accepted Native MCP OAuth Direction

Accepted at spec 00004 Freeze on 2026-09-29; implementation is not yet complete.
These are future implementation constraints, not claims about released behavior.
The current API OAuth ownership described above remains unchanged.

- Session will own separate OAuth client/approval/key records and common checks.
  AI will enforce MCP access; API will accept new keys only on explicitly enabled
  user routes. Session must not depend on AI/API. AI remains an explicit plugin.
- One approval may cover the exact declared MCP service and explicitly saved API
  operations. Sharing a hostname or permission name does not add API membership.
  New or changed operations need new approval; renewal cannot expand access.
- Preserve ID-only reads and full id:secret for other operations. For MCP, use
  the configured tool method. Treat new read IDs as secret credentials, store
  hashes, rotate both parts and never downgrade a supplied wrong secret.
- Any one matching configured permission is enough. Empty lists still reject
  protected API requests and allow valid correct-type protected MCP callers.
- Public/protected MCP tools share an address. Anonymous clients may see protected
  names/descriptions, not private schemas or results. Each protected call needs
  fresh checks; a connection ID or browser cookie is not an MCP credential.
- Default new access lifetime is 15 minutes and renewal ends 7 days after original
  approval; both are configurable. Renewal cannot move the final deadline.
  Disconnect, expiry and inactive accounts end access on both surfaces.
- Apps define approval/access rules and when a fresh factor check is needed.
  Compatible clients may request approval unless an explicit allowed-client list
  restricts them. Registration or a declared client name proves no user consent.
- When OAuth is enabled on existing MCP services, selected old keys need explicit
  service bindings and complete current-key checks. Ordinary legacy API behavior
  and reply formats remain unchanged. There is no automatic first-use binding.
- First release requires Node 22 and PGlite/PostgreSQL/MySQL/SQLite. Proofs exposed
  shared Inquire connection-ownership failures; production storage requires their
  correction. Do not claim unmodified adapters pass those concurrency checks.
- Automatic extra-permission approval is not promised. Explicit reapproval and
  reconnection are the accepted recovery path; writes with an unknown outcome
  must not be automatically repeated. Full production/client checks remain due.

Source: user-approved [Freeze record](../specs/00004-mcp-native-oauth/freeze.md).
Load the spec for exact field contracts and evidence, not to infer shipped support.
Future specs should inherit the stable rules here rather than treating prototype
output or a sibling spec as current runtime guarantees.

## Detailed Reference

Load [Runtime API Contracts](../references/00004-runtime-api-contracts.md) when
an interface document needs exact request, response, routing, server, or status
contracts.

Load [Stackpress Configuration Catalog](../references/00008-configuration-catalog.md)
for view, brand, language, session/auth, API, admin, cookie, CSRF, MCP, and
desktop policy that shapes external experiences.

Load [View API Contracts](../references/00012-view-api-contracts.md) for Reactus
SSR/build behavior, view lifecycle, serialized browser props, hooks/providers,
layouts, notifications, aggregate admin helpers, or `setViewProps`.

Load [Session And Language Contracts](../references/00013-session-language-contracts.md)
for JWT/session lifecycle, permission matching, global route authorization,
auth actions, locale selection/persistence, or r22n browser translation.

Load [Interface Exposure Examples](../references/00017-interface-exposure-examples.md)
when adapting one event into a handwritten page, configured API endpoint, MCP
tool, or cross-surface policy comparison.
