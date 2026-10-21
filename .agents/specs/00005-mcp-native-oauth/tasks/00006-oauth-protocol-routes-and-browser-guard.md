# 00006 — Add discovery and OAuth protocol routes

Status: verified.
Owner: stackpress-session OAuth plugin/pages and exact browser-guard integration.
Stage: 3, protocol handling.
Depends on: [00002](00002-oauth-types-config-and-startup.md), [00004](00004-client-registration-and-safe-metadata.md), [00005](00005-approval-key-lifecycle-and-policy.md)
Journeys: J01, J03, J04, J08, J10–J12, J14.
Contracts: [configuration](../configuration.md), [events](../events.md), [recovery](../recovery.md), [design](../design.md).

## Task Summary

Give native clients the correct discovery, token, registration and cancellation replies without forcing them through browser-cookie authorization.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Register issuer metadata and accepted /token, /register and /revoke handlers beneath the separate OAuth base; provide reusable protected-resource metadata for AI. Advertise only configured supported capabilities.
2. Implement exact issuer/resource documents and root-alias rules, sole-resource defaulting, invalid_target and unsupported request errors. Keep public-client code/refresh/S256 behavior and validated iss/state return helpers.
3. Read standard form or JSON input as appropriate and reject repeated, malformed or oversized parameters. Translate fixed event results into top-level OAuth JSON/status/headers, never a Stackpress results wrapper.
4. Add exact registered route capabilities to browser authorization so native protocol/API/MCP handlers enforce their own checks. Do not add a broad /auth/* exception; browser approval and connections still require current browser identity and CSRF.
5. Implement the configured Origin/CORS/OPTIONS/header rules and trusted-proxy address handling. Native calls without Origin work; bearer protocol requests do not gain cookie-based authority.
6. Connect serving finalization guards and standard errors, no-store handling and redacted diagnostics. Browser page actions/views are completed in task 00007; do not expose an unguarded placeholder.

## Verification Process

- Test exact custom/well-known routes, ambiguous aliases, disabled registration, capability declarations, invalid target/scope, duplicate fields and standard top-level token/error replies.
- With session.access enabled, prove native routes never require cookies or return sign-in HTML, while browser/account routes and unrelated /auth paths keep their checks.
- Test real request bodies, status/content types, cache headers, allowed/refused Origins, preflight methods/headers, exposed challenges and forwarded-header spoofing.
- Regression-test existing API OAuth addresses/replies and OAuth-off behavior. Final attached/standalone resource metadata is checked in tasks 00009/00011.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

Scope decision (recorded so 00007 does not re-litigate it): this task registers
the discovery/token/register/revoke **native** protocol routes and the two
remaining fixed events (`oauth-authorization-start`, `oauth-client-register`)
00005 left unregistered. It deliberately does **not** register HTTP routes for
`/authorize`, `/connections`, `/connections/revoke` or `/factor` — those are
ordinary signed-in browser pages with views, which is 00007's task title and
scope ("Browser page actions/views are completed in task 00007; do not expose
an unguarded placeholder"). `OAuthService.finalize()` now succeeds once an app
registers its two policy listeners and the `database` plugin, since all nine
required fixed events are registered by 00005 + this task combined.

New files, all under `packages/stackpress-session/src/oauth/`:
- `metadata.ts` — `issuerMetadataPath`/`resourceMetadataPath` (RFC 8414/9728
  well-known path derivation from the issuer/resource URL's own path
  component) and `buildIssuerMetadata`/`buildProtectedResourceMetadata` (pure,
  reusable builders — task 00009's standalone AI HTTP/SSE entrypoint should
  import these directly rather than re-deriving the same documents).
- `events/authorizationStart.ts` (`oauth-authorization-start`) — validates
  client admission (`isClientAllowed`) and lookup (registered client via
  `store.getClientByClientId`, or a client-document URL via task 00004's
  `fetchClientDocument`) before ever touching the return address; validates
  the exact return address (`validateReturnAddress`); only once client+
  redirect are safe does a later problem (`unsupported_response_type`,
  `invalid_request` code_challenge_method, `invalid_target`, `invalid_scope`)
  come back as a validated redirect carrying the original `state`/`iss`,
  matching design.md's "Check the client and return address before
  redirecting anywhere" ordering. Enforces `limits.authorization` via task
  00004's `clients/rateLimit.ts` (the event handlers 00005 built deliberately
  do not, per that task's own recorded boundary decision — this is the HTTP-
  adjacent layer with the trusted source address). Creates the
  `OAuthPending` row via `store.createPending` with a caller-supplied
  `bindingHash` (the continuation-cookie value itself is page/00007 concern;
  this event only ever sees its hash, never the raw token). `types.ts` gained
  `bindingHash`/`source` on `OAuthAuthorizationStartInput` (additive).
- `events/clientRegister.ts` (`oauth-client-register`) — thin wrapper calling
  task 00004's `registerClient(body, source, config, { store })`; the only
  new behavior is the event boundary itself (routing trusted `{body, source}`
  through `getOAuthContext`/`toEventErrorResponse` like every other fixed
  event).
- `pages/helpers.ts` — shared HTTP-layer translation every native route uses:
  `writeEventResult` (writes a resolved fixed-event `StatusResponse` as a
  **pre-serialized JSON string** via `res.json(...)`, not a plain object via
  `res.results(...)`/`res.body = obj` — the Node HTTP adapter
  (`@stackpress/ingest/http/Adapter.js`) wraps any object/array response body
  in the `{code,status,results,...}` envelope regardless of which Response
  method set it; only a string body bypasses that, which is what
  `Response.json()` actually produces internally. This was the one non-
  obvious finding this task required discovering by reading the adapter
  source, since nothing in this package already needed an unenveloped JSON
  reply), `applyOAuthCors`/`applyOAuthPreflight` (exact-origin allowlist of
  the issuer's own origin plus `browserOrigins`; rejects `null`/malformed/
  disallowed; a missing Origin is always a native call and is permitted),
  `sourceAddress` (the real peer address only — this task does not implement
  trusted-proxy header parsing since `configuration.md`/`NormalizedOAuthSessionConfig`
  define no such setting; flagged below as a recorded gap, not silently
  invented), `singleFormField` (rejects a repeated form parameter outright).
- `pages/discovery.ts` — `issuerMetadata` and `resourceMetadata(resourceUrl?)`
  actions serving the RFC 8414/9728 documents; the no-argument form serves the
  single configured resource at the root alias and 404s `invalid_target` when
  more than one resource is configured (configuration.md: "A root resource
  alias is valid only for a single unambiguous resource").
- `pages/token.ts`, `pages/register.ts`, `pages/revoke.ts` — translate form
  (token/revoke) or JSON (register) input into the matching fixed event,
  handle OPTIONS preflight, reject duplicate form fields, and write the
  result through `writeEventResult` with `Cache-Control: no-store`.
  `register.ts` maps a successful `200` event result to HTTP `201`
  (events.md: "registration HTTP page maps creation to 201"). `token.ts`
  enforces `limits.token` (source stage always; a client-keyed stage added
  only once `isClientAllowed` admits the client — "unknown clients share the
  source bucket", reusing 00004's exact admission check rather than
  reimplementing the distinction).

**Edited `OAuthService.ts`**: added `isNativeRoute(method, pathname)` — an
exact-match allowlist of the discovery/token/register/revoke protocol routes
(derived from `metadata.ts`'s well-known path helpers) plus every registered
API operation (`_apiOperations`) and MCP resource (`_mcpResources`) route.
Added to the public `OAuthService`/`OAuthPlugin` interface in `types.ts`.

**Edited `packages/stackpress-session/src/session/events/authorize.ts`** (the
global per-request browser authorizer `session/plugin.ts` wires to the
`request` hook): when `ctx.plugin('oauth')` exists, is finalized, and
`isNativeRoute(method, pathname)` matches the current request exactly, the
cookie-based `session.authorize()` check is skipped entirely so a bearer-token
protocol/API/MCP request is never redirected to HTML sign-in — matching
configuration.md's "exact registered protocol/API/MCP route capabilities...no
broad /auth/* bypass" precisely: `/authorize`, `/connections` and `/factor`
are **not** in `isNativeRoute`'s allowlist, so they keep requiring the
ordinary signed-in session this task does not touch.

**Edited `packages/stackpress-session/src/oauth/plugin.ts`**: registers the
two new fixed events in `listen`, and adds a `route` handler that mounts the
discovery/token/register/revoke routes (and their `OPTIONS` preflights) under
`${config.base}`, reading the already-validated config from the registered
`OAuthService` rather than re-normalizing the raw setting a second time.

**Orchestrator review (2026-10-15)** confirmed gap #1 below as accepted design
(no trusted-proxy setting exists in the frozen configuration contract, so
real-peer-only is correct) but required forwarded-header-spoofing tests
specifically because nothing is trusted, plus `Access-Control-Expose-Headers`
coverage and a real client-document-path integration test. All three were
added in a follow-up pass (see Verification Notes); gap #3 below is resolved,
gap #2 is unchanged (still 00009's scope), and gap #1 stays recorded as an
accepted, tested design choice rather than an open item.

Follow-up changes made for this review:
- `pages/helpers.ts`: `writeEventResult` now promotes a rate-limit error's
  `retryAfterSeconds` onto a real `Retry-After` response header (previously it
  only ever reached the JSON error body's `errors`, never an actual header,
  which did not match configuration.md's "Rate refusal is 429 with
  Retry-After"). `applyOAuthCors`/`applyOAuthPreflight` now set
  `Access-Control-Expose-Headers: WWW-Authenticate, Retry-After,
  Mcp-Session-Id, MCP-Protocol-Version` whenever an Origin is present and
  allowed (recovery.md: "Expose WWW-Authenticate, Mcp-Session-Id,
  MCP-Protocol-Version and Retry-After...Apply equivalent explicit rules to
  token/registration clients"); WWW-Authenticate/Mcp-Session-Id/
  MCP-Protocol-Version are never actually *set* by this task's routes (that is
  task 00009's job on protected MCP/API requests), only declared readable
  cross-origin here so a browser client never needs an extra round trip.
- `events/authorizationStart.ts`: extracted the previously inline logic into
  an exported `runAuthorizationStart(input, context, deps)`, with `deps`
  (`resolveHost`/`transport`/`now`) defaulting to production values
  (`resolveHostname`, `fetchClientDocument`'s own default transport) but
  overridable — the same injection point `fetchClientDocument` itself already
  exposed, now threaded one layer up so a test can exercise the full
  admission→fetch→return-address→pending-creation path for a client-document
  identity without opening a real socket. The default-exported `action()`
  handler is now a thin wrapper calling this function with production
  defaults; behavior is unchanged.

**Recorded gaps, so 00007/00009/00011 do not assume these are covered**:
1. **Accepted by orchestrator 2026-10-15.** No trusted-proxy address support
   exists anywhere in this task's rate-limit or CORS code —
   `sourceAddress()` always uses the real peer address and never reads a
   forwarded header, since `NormalizedOAuthSessionConfig` defines no such
   setting. This is correct under the frozen contract, not a shortcut; tests
   now prove it holds under an actively spoofed `X-Forwarded-For`/`Forwarded`
   header (see Verification Notes) rather than merely asserting the code
   never references those headers.
2. `defaultTransport`'s documented WWW-Authenticate/`resource_metadata`
   challenge headers on a protected *MCP/API* 401 are task 00009's scope, not
   this task's — this task only serves the discovery documents those
   challenges point to, and now exposes the `WWW-Authenticate` header name
   via CORS so 00009's eventual challenge is readable cross-origin without
   needing its own separate CORS wiring on these same routes.
3. No PostgreSQL/MySQL/SQLite adapter run was performed for this pass: this
   task adds no new `OAuthStore` methods or schema and only calls existing,
   already cross-adapter-tested methods (`createPending`, `getClientByClientId`,
   `incrementRateBucket` via `enforceRateLimit`); task 00011 re-verifies all
   four databases together.
4. `limits.token`'s "unsupported grant_type" case is mapped to the existing
   `invalid_request` machine code rather than a new `unsupported_grant_type`
   code, since `events/errors.ts`'s `OAuthEventErrorCode` union is 00005's
   file and this task avoids editing it for one cosmetic code.

## Verification Notes

Environment: Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`), Yarn
1.22.22, this worktree, Inquire d5f5a07 override (unchanged by this task).

Compile, clean on both module formats:
```
(cd packages/stackpress-session && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
(cd packages/stackpress && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
(cd packages/stackpress-api && npx tsc -p tsconfig.cjs.json --noEmit)
(cd packages/stackpress-ai && npx tsc -p tsconfig.cjs.json --noEmit)
```
`packages/stackpress-session && yarn build`: clean (tsc cjs+esm, package.json
stamping).

Tests (`yarn test` = `nyc ts-mocha -r tsx tests/**/*.test.ts`), run from
`packages/stackpress-session`, confirmed with `echo tests/**/*.test.ts` first
that all test files stay flat under `tests/oauth/` (no nested subfolder), so
none drop from the package's unquoted glob. **430 passing, 0 failing, 46
pending** — the pending rows are exclusively this worktree's pre-existing
PostgreSQL/MySQL adapter skips (no disposable containers were started for
this pass; see Implementation Notes gap #3) plus the same skips in test files
other in-progress tasks (00005/00008) added, none of which this task's own
new code touches.

Package-wide coverage (`nyc --reporter=text`): **94.07%** statements / 88.43%
branch / 96.12% funcs / 94.20% lines — above the sprint's >90% statement bar.
Per new/changed file: `metadata.ts` 100%, `OAuthService.ts` 95.57%, `plugin.ts`
100% statements, `events/authorizationStart.ts` 100% statements/86.79% branch,
`events/clientRegister.ts` 100%, `pages/discovery.ts` 100%, `pages/helpers.ts`
100% statements/94.73% branch, `pages/register.ts` 100% statements,
`pages/revoke.ts` 91.66%, `pages/token.ts` 93.87%, `session/events/authorize.ts`
100%.

New test files (all flat under `tests/oauth/`): `metadata.test.ts`,
`events-authorization-start.test.ts` (16 cases: success, scope narrowing,
operations listing, unadmitted registered/document client, unknown client,
mismatched redirect, validated-redirect `unsupported_response_type`/
`invalid_request`/`invalid_target`/`invalid_scope`, the `limits.authorization`
rate limit, missing parameters, plus a nested "client-document path" group of
3 cases exercising `runAuthorizationStart` directly with 00004-style
injectable `resolveHost`/`transport` fakes: a full admission→fetch→
return-address-match→pending-creation success, a non-200 document fetch
rejected as `invalid_client` rather than falling back to any stale value, and
a fetched document whose `redirect_uris` does not include the requested
return address still rejected after a successful fetch), `events-client-register.test.ts`
(4 cases), `pages-test-helpers.ts` (shared HTTP-layer test doubles, not a
`*.test.ts` file), `pages-helpers.test.ts` (now also covering
`Access-Control-Expose-Headers` on an allowed origin/preflight and its
absence on a disallowed origin; `Retry-After` promoted from a rate-limited
event result's `errors.retryAfterSeconds` onto a real header, and absent for
a non-rate-limited failure; `sourceAddress` proven to ignore a spoofed
`X-Forwarded-For`/`Forwarded` header and to resolve two requests from the
same real peer with different spoofed values to the same identity),
`pages-discovery.test.ts` (plus a case proving spoofed `Host`/
`X-Forwarded-Host`/`X-Forwarded-Proto` headers never change the served
issuer/token-endpoint URLs), `pages-token.test.ts` (the real `limits.token`
rate-limit regression against a real PGlite-backed `OAuthStore`; plus a case
proving two requests from the same real peer with *different* spoofed
`X-Forwarded-For` values still share one rate-limit bucket and the second is
refused, and a case proving a spoofed `Host`/forwarded triad never changes
the token reply), `pages-register.test.ts`, `pages-revoke.test.ts`,
`session-authorize-guard.test.ts` (7 cases proving the exact
`isNativeRoute`-based bypass). Extended `OAuthService.test.ts` (9
`isNativeRoute` cases) and `plugin.test.ts` (fixed-event registration and
exact route mounting, including that disabling `registration.enabled` removes
the `/register` route).

Cleanup: no disposable database containers were started. A scratch debug
script used once to isolate a test-only binding-hash collision bug was
removed immediately after (`/tmp/debug-auth-start.mjs`, confirmed gone). No
test runner, watcher or server process was left running.

Every Verification Process line item for this task is now covered: exact
custom/well-known routes and ambiguous root-alias rules
(`metadata.test.ts`/`pages-discovery.test.ts`); disabled registration
(`plugin.test.ts`, `pages-register.test.ts`); capability declarations
(`OAuthService.test.ts`); invalid target/scope
(`events-authorization-start.test.ts`); duplicate fields
(`pages-helpers.test.ts`'s `singleFormField`, `pages-token.test.ts`,
`pages-revoke.test.ts`); standard top-level token/error replies
(`pages-helpers.test.ts`'s `writeEventResult`); the `session.access` native
bypass with `/authorize`/`/connections`/unrelated routes still gated
(`session-authorize-guard.test.ts`); real request bodies/status/content
types/cache headers/allowed-refused Origins/preflight methods and headers
(`pages-token.test.ts`, `pages-register.test.ts`, `pages-revoke.test.ts`,
`pages-helpers.test.ts`); exposed `Access-Control-Expose-Headers` headers
(`pages-helpers.test.ts`); forwarded-header spoofing, both at the
`sourceAddress` unit level and as a real rate-limit-bucket-sharing/
issuer-stability integration proof (`pages-helpers.test.ts`,
`pages-token.test.ts`, `pages-discovery.test.ts`). Existing API OAuth
addresses/replies and OAuth-off behavior are unchanged by this task (no edits
to `stackpress-api`'s own `/auth/oauth` routes); regression coverage for that
remains owned by `stackpress-api`'s own suite, which this task did not touch
or need to re-run.

## Acceptance Notes

No visual acceptance is required. Finish at verified once the checks pass;
do not mark accepted merely because tests pass.
