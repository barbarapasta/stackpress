# 00009 — Enforce current identity on every MCP request

Status: verified. All seven implementation steps are coded and exercised by
66 new dedicated OAuth transport/identity test cases (plus updates to the
existing oauth.test.ts); the owning package's full suite is 160 passing, 0
failing (up from a 90-passing baseline before this task). The multi-process
list-notification clause (previously left open, PGlite cannot exercise it
at all) is now closed with a dedicated real-PostgreSQL/real-MySQL,
two-OS-process regression suite; every Verification Process bullet passes.
See Implementation Notes and Verification Notes.
Owner: stackpress-ai types, helpers, plugin and attached/standalone HTTP/SSE scripts.
Stage: 4, MCP.
Depends on: [00002](00002-oauth-types-config-and-startup.md), [00005](00005-approval-key-lifecycle-and-policy.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md), [00008](00008-api-shared-access-and-legacy-upgrade.md)
Journeys: J08–J13.
Contracts: [recovery](../recovery.md), [events](../events.md), [configuration](../configuration.md), [storage](../storage.md), [proof-results](../proof-results.md).

## Task Summary

Keep public tools usable while protected calls always use fresh request-specific authority, including saved connections and older SSE.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Implement attached/standalone resource metadata and OAuth checks. Call finalization before standalone listening; reject conflicting HTTP/SSE routes and undeclared resource combinations.
2. Support saved Streamable POST/GET/DELETE, per-request POST with explicit GET/DELETE 405, and older SSE GET/message POST. Pass req.post() body only into the SDK, never merged query data.
3. Carry immutable per-request identity through req.auth to extra.authInfo and recheck before the business event. Classify tools by their trusted method; unknown tools fail before classification, controls/DELETE need full keys.
4. Allow the explicitly safe anonymous operations. Publish only protected names/descriptions and the minimal inputSchema until authorized; suppress private input/output details. Authorized clients relist full contracts, including realistic required inputs.
5. Bind anonymous sessions once to profile/client/grant/resource. Keep same-grant renewal working, reject another identity without destroying its session, close pre-auth Streamable notification streams and keep older SSE only as a fresh-POST reply channel.
6. Apply all 401/403/404/405, Origin and late-error rules. Mark not_started only before event invocation, never automatically repeat ambiguous writes, and keep explicit reapproval/new-session behavior.
7. Send generic list-change notices using grant revisions plus current account/policy/expiry checks, with the specified polling limit. Delayed notices cannot retain authority; add no protected push/replay without separate authorization. Preserve STDIO behavior.

## Verification Process

- Port P-002 defects into actual package regression tests across all six HTTP/SSE combinations, including real SDK and attached Ingest requests.
- Exercise absent/wrong identity, concurrent calls, revoked/expired/rotated keys, any-match/empty scopes, control strength, unknown tools, resource mismatch and no invalid-key-to-public fallback.
- Verify public catalog projection with real required arguments and output schemas; test login, relisting, permission loss and list notifications across processes.
- Check errors before/after headers, legacy SSE 202/GET reply timing, route collisions, CORS and actual STDIO regression. Explicit reapproval remains required where clients cannot escalate automatically.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

Builds on 00002's `registerOAuthResources` scaffolding, 00005's fixed
`oauth-token-verify`/`oauth-refresh`/`oauth-revoke`/`oauth-grants-list` events,
00006's `metadata.ts` builders and `isNativeRoute`, and 00008's
`verifyLegacyMcpKey`/`oauth-legacy-bind`/`oauth-legacy-verify`. No Frozen
contract file was edited.

**New file**: `packages/stackpress-ai/src/oauth.ts` — the shared MCP OAuth
engine both transports use:
- `OAuthMcpRefusal` (status/machine-code/scope) and `isOAuthAccessToken`.
- `resolveMcpAuthContext` — parses the bearer token; `oauth_`-namespaced
  tokens call the real `oauth-token-verify` event; anything else goes through
  `resolveLegacyAuthContext`, which tries `verifyLegacyMcpKey` as `app` then
  `session` (storage.md's legacy upgrade path) and only then builds a full
  `AuthContext` via the existing `resolveApplication`/`resolveSession`
  helpers. Never falls back to public on a bad credential.
- `identityOwnerKey`/`identityIsFullCredential` — the stable per-approval
  binding key and read/full classification, covering `oauth`, `app` and
  `user` kinds.
- `buildAuthInfo`/`extractAuthContext` — wraps/unwraps our richer
  `AuthContext` inside the SDK's `AuthInfo.extra.context`, confirmed against
  the real `StreamableHTTPServerTransport`/`SSEServerTransport` source
  (`req.auth` -> `extra.authInfo`, both read directly from the installed
  SDK 1.29.0).
- `projectToolForListing`/`assertNoReservedOAuthFields` — the Q-013
  anonymous-listing projection and the events.md reserved-field guard.
- `createOAuthMcpServer`/`registerDynamicCallTools` — the OAuth-enabled
  counterpart to `plugin.ts`'s existing `createMcpServer`/`registerCallTools`.
  Unlike the static path (which filters the registry and captures one `auth`
  snapshot at session-creation time — exactly the P-002 stale-identity
  defect), this registers every tool unconditionally (so an unregistered
  name is rejected by the SDK itself, before any classification runs) and
  reads identity fresh from `extra.authInfo` on every call and every
  `tools/list`. A late refusal (after the SDK's JSON-RPC dispatch has begun)
  becomes `McpError(-32001, ...)`; the message is suffixed with
  `(execution: not_started)` only when the refusal happened strictly before
  `ctx.resolve(tool.event, ...)` ran (recovery.md's advisory rule) — found
  that `McpServer`'s own tool-callback wrapper reads only `error.message`,
  never `McpError.data`, so the marker had to go in the text itself to be
  observable at all. Also discovered and handled: the SDK calls a
  zero-input-schema tool's callback with a single `extra` argument, not
  `(input, extra)` — a fixed two-parameter handler would silently receive
  `extra` into `input`.
- `watchGrantForChanges` — storage.md's grant-revision rule, implemented
  against the already-contract-defined `oauth-grants-list` safe summary
  (no dedicated revision column exists on any fixed event this task may
  touch); bounded to <=5s between polls, advisory only — a missed/failed
  poll never grants or retains access, since every real call still runs the
  full verifier.
- `isOriginAllowed`/`writeCorsPreflight`/`writeOAuthRefusal` — shared by both
  transports so the Origin/CORS/error-reply shape is one rule, not two.

**Edited `packages/stackpress-ai/src/helpers.ts`**: `toolAllowed`'s `user`
branch and `withToolData` now also accept an `oauth` identity (events.md:
"Its `user` tools can accept this variant"), using the same scope/credential
rules a legacy user session already enforces; added `oauthCredentialAllowed`.

**Edited `packages/stackpress-ai/src/scripts/http.ts`**: `McpHttpServer`
gained an OAuth-aware dispatch branch (`_dispatchOAuth`), used only when
`mcp.oauth.resource` is configured — every existing non-OAuth code path is
byte-for-byte unchanged. Implements Origin checks, OPTIONS preflight,
stateless-mode GET/DELETE 405, fresh per-request `resolveMcpAuthContext`,
batch-array rejection, unknown-session 404, session-identity-mismatch
403/401, control/DELETE/GET full-key rules, first-identity session binding
(closing the pre-auth standalone SSE stream via
`transport.closeStandaloneSSEStream()`), and the 401/403/404/405/503 reply
table via `writeOAuthRefusal`. `attachHttpToServer` now also routes GET/
DELETE/OPTIONS (not just POST) to the OAuth dispatcher, and both it and the
standalone `http()` entrypoint pass `req.post()` (body-only) instead of
`req.data()` (recovery.md: "merged query data breaks strict JSON-RPC
parsing"). `http()` calls `oauth.finalize()` before `transport.start()` for
a standalone listener (configuration.md: "AI standalone HTTP/SSE entrypoints
call finalize before listening"); `attachHttpToServer` never calls it — that
stays the serving app's bootstrap responsibility. **Bug found and fixed
during verification**: a brand-new Streamable HTTP session's id is not
assigned until `transport.handleRequest()` actually processes the
`initialize` call, not when the transport is constructed — reading
`transport.sessionId` immediately after `_createOAuthSession()` returned
(the original code) always saw `undefined`, so a session created by an
`initialize` call that already carried a real credential never got bound.
Fixed by binding (and starting the watcher) inside
`StreamableHTTPServerTransport`'s own `onsessioninitialized` callback, the
first point the id actually exists.

**Edited `packages/stackpress-ai/src/scripts/sse.ts`**: `McpSseServer`
gained the equivalent `_dispatchOAuth` for the GET handshake and the
`/messages` POST, used only when `mcp.sse.oauth.resource` is configured.
Unlike Streamable HTTP, the GET stream is never closed at binding — older
SSE keeps it as its only reply channel, and a protected result still
requires a freshly verified POST (recovery.md). `SSEServerTransport`
assigns its session id synchronously in its constructor, so no equivalent
of the HTTP bug applies here. Same `req.post()` fix applied to
`attachSseToServer`.

**Edited `packages/stackpress-ai/src/plugin.ts`**: `registerOAuthResources`
now also registers the SSE `/messages` route (a second, separate route for
the same SSE resource) so `OAuthService.registerMcpResource`'s per-route
collision check can catch a clash involving it, not just the handshake
route — configuration.md: "Enabling both transports requires distinct GET
handshake routes and an unambiguous SSE message POST route. Fail startup if
they collide." Also fixed the SSE handshake route's registered default to
match `resolveSseConfig`'s real fallback chain
(`mcp.sse.route` -> `mcp.route` -> `/mcp`) — the original code defaulted to
the literal string `/sse`, which never matched the actual listener default
and would have silently registered the wrong route for a default-configured
SSE listener.

**New public surface**: added `stackpress-session`'s `./oauth/metadata`
export subpath (package.json `exports`/`typesVersions` only — `metadata.ts`
itself was not edited, per the explicit scope boundary). `metadata.ts`'s own
comment already anticipated this: "AI's standalone HTTP/SSE entrypoint (task
00009) imports the same functions so a separately-run MCP server advertises
identical metadata without duplicating this contract." Used for
`resourceMetadataPath`/`issuerMetadataPath` in `writeOAuthRefusal`'s
`WWW-Authenticate` challenge.

**New test infrastructure**, all under `packages/stackpress-ai/tests/`:
- `oauth-fixture.ts` (not matched by the package's `tests/**/*.test.ts`
  glob) — a real PGlite-backed `OAuthStore` plus a `ToolResolverServer`
  double whose `resolve()` dispatches every OAuth event this task's
  production code calls to the *real* session event handlers
  (`codeExchange`/`refresh`/`tokenVerify`/`revoke`/`grantsList`/
  `grantRevoke`/`legacyBind`/`legacyVerify`), via the same plain relative
  `../../stackpress-session/src/oauth/...` import pattern
  `stackpress-api/tests/oauth-legacy-real-store.test.ts` already established
  for test-only cross-package real-store integration (does not touch that
  package's `exports` map). Exposes `issueGrant`/`createApprovedGrant`/
  `revokeToken`/`bindLegacyApp`/`bindLegacySession` helpers.
- `mcp-oauth-http.test.ts` (28 cases) — drives the *real* SDK
  `StreamableHTTPServerTransport` over a **real network socket**: SDK 1.29.0
  bridges Node's `IncomingMessage`/`ServerResponse` through
  `@hono/node-server`, which needs a real socket (confirmed by reading
  `streamableHttp.js`; a hand-rolled response double silently produced a 500
  with an empty body). Covers all three Streamable HTTP combinations
  (stateful POST/GET/DELETE, stateless POST+405, attached-Ingest-shaped
  request hook), anonymous/public/protected catalog projection and calls,
  invalid/unbound/legacy/expired/revoked/rotated keys, session binding and
  rejection without destroying the original session, two genuinely
  overlapping identities on separate sessions, any-match and empty-scope
  rules, Origin/OPTIONS/CORS, batch rejection, 503, and one full real
  end-to-end `notifications/tools/list_changed` delivery on the standalone
  GET stream (short-interval watcher override, used only by this test).
- `mcp-oauth-sse.test.ts` (10 cases) — drives the real
  `SSEServerTransport` (confirmed it writes directly to the real Node
  response methods, so a `MockResponse` double is sufficient here, unlike
  Streamable HTTP). Covers the GET-handshake/POST-message combination,
  the 202-then-late-GET-frame error/success timing, full-key-on-GET-when-
  credentialed, session binding/rejection, unknown session, Origin on both
  verbs, 503, and HTTP/SSE resources binding separately.
- `oauth-helpers.test.ts` (23 cases) — direct unit tests for the pure
  functions in `oauth.ts` (`isOriginAllowed`, `writeCorsPreflight`,
  `writeOAuthRefusal`, `watchGrantForChanges`,
  `assertNoReservedOAuthFields`, `extractAuthContext`,
  `projectToolForListing`, `createOAuthMcpServer`'s empty-registry case).
- `oauth-fixture-smoke.test.ts` (1 case) — a minimal sanity check that the
  fixture itself issues and verifies a real token.
- Updated `tests/oauth.test.ts` (2 assertions changed, 1 case added) for
  the new SSE-messages-route registration and the corrected SSE route
  default.
- Updated `tests/http.test.ts`/`tests/sse.test.ts`: added `.post()` to four
  pre-existing attached-request test doubles that previously only defined
  `.data()`, since the attach hooks now call `req.post()`.
- **New** `tests/fixtures/real-db-ctx.ts` (not matched by the test glob) —
  an engine-agnostic twin of `oauth-fixture.ts` that wires only the three
  events the cross-process scenario below needs
  (`oauth-grants-list`/`oauth-token-verify`/`oauth-revoke`) against
  whatever real `Engine` connection its caller opens; `connectRealDbEngine()`
  opens one fresh PostgreSQL (`pg`/`@stackpress/inquire-pg`) or MySQL
  (`mysql2`/`@stackpress/inquire-mysql2`) connection per call, the same
  adapter packages `store-adapters.test.ts` already uses.
- **New** `tests/fixtures/cross-process-worker.ts` (not matched by the
  test glob) — a standalone script, executed only via `tsx` as a genuine
  separate OS process, never imported in-process. Three modes, each
  opening its own fresh database connection: `watch` (calls the real
  production `watchGrantForChanges()` from `oauth.ts` — the exact
  function `scripts/http.ts`/`scripts/sse.ts` wire to
  `session.server.sendToolListChanged()` — until it observes a change or
  a bounded timeout elapses), `revoke` (calls the real `oauth-revoke`
  event handler), `verify-stale` (calls the real `oauth-token-verify`
  event handler).
- **New** `tests/mcp-oauth-cross-process.test.ts` (4 cases, run against
  both real PostgreSQL and real MySQL) — closes the "list notifications
  across processes" verification clause this file previously left open.
  Starts one disposable tmpfs-backed container per engine
  (`oauth-00009-pg` on 127.0.0.1:55577, `oauth-00009-mysql` on
  127.0.0.1:55578; skips gracefully via `this.skip()` if a container
  isn't reachable, matching `store-adapters.test.ts`'s own convention).
  Each case spawns 2-3 independent `tsx` child processes against that one
  shared real server: a watcher (`watch`) started first so its first poll
  records the "still active" baseline, a writer (`revoke`) that cancels
  the grant through the real event handler, and — in the main scenario —
  a third process (`verify-stale`) that independently confirms the
  now-cancelled key is refused. Case 1 proves the watcher's second poll
  observes the writer's change purely through the real database (no
  shared memory between the two processes) and that a third process sees
  the same refusal; case 2 proves the watcher does not falsely report
  CHANGED when nothing else touches the grant (same bounded-timeout path
  the production code already relies on). Ran the full 4-case suite twice
  in a row against fresh containers to rule out polling-interval
  flakiness; both runs passed cleanly (13s each). Containers removed via
  `docker rm -f` after the run; no state kept.

**Recorded gaps** (none block the steps above; listed so 00010/00011/00012
don't assume they're covered):
1. No trusted-proxy header support exists for Origin/source-address
   decisions here either, matching 00006's own recorded gap for the same
   reason (`NormalizedOAuthSessionConfig` defines no such setting).
2. `Vary: Origin` and `Access-Control-Expose-Headers` are only set on the
   OPTIONS preflight reply, not on every actual GET/POST/DELETE response —
   a real cross-origin browser client reading `Mcp-Session-Id`/
   `WWW-Authenticate` off a non-preflight response would need those
   exposed there too.
3. `resolveLegacyAuthContext`'s race where `verifyLegacyMcpKey` reports a
   bound legacy identity but the application/session record then
   disappears before the follow-up `resolveApplication`/`resolveSession`
   call (lines 193/203 in `oauth.ts`) is not separately tested.
4. STDIO was not touched and its existing one-case regression test still
   passes; that test was already narrow before this task (00002-era proof
   note) and this task did not add to it, since STDIO has no HTTP/SSE
   identity surface to exercise.

## Verification Notes

Environment: Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`), Yarn
1.22.22, this worktree, Inquire d5f5a07 override (unchanged by this task).
Every test except the cross-process suite below uses an in-process PGlite
instance (no docker, no shared container touched). The cross-process suite
added in this follow-up pass starts its own disposable, tmpfs-backed
`oauth-00009-pg`/`oauth-00009-mysql` containers under
`flock /tmp/oauth-db.lock`, on ports 55577/55578 (distinct from
00003/00004/00005/00008's own 55555/55556 ports), and removes them with
`docker rm -f` once the run finishes.

Compile, clean on both module formats:
```
(cd packages/stackpress-ai && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)   # exit 0, exit 0
(cd packages/stackpress-session && npx tsc -p tsconfig.cjs.json --noEmit)                                        # exit 0 (new ./oauth/metadata export only)
(cd packages/stackpress && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)       # exit 0, exit 0
```
`packages/stackpress-ai && yarn build`: clean (tsc cjs+esm, package.json
stamping). `packages/stackpress-session && yarn build`: clean (needed so
the new `./oauth/metadata` subpath's compiled output exists for
`stackpress-ai` to resolve). `packages/stackpress-api && yarn build`: clean
(rebuilt stale `cjs`/`esm` output so `stackpress-ai` could resolve 00008's
already-merged `verifyLegacyMcpKey`/`LegacyMcpIdentity` type exports — no
source change).

**`stackpress-ai` (`yarn test`), full package suite, this worktree:**
**160 passing, 0 failing** (before this task: 90 passing, recorded in
00002/00002A; 156 passing before this cross-process follow-up pass).
Package-wide coverage (`nyc --reporter=text`):
**94.98% statements / 86.91% branch / 93.01% funcs / 96.11% lines** (before:
95.71% statements, measured differently — this run adds this task's entire
`src/oauth.ts` plus the new OAuth-aware branches in `src/scripts/http.ts`/
`sse.ts`, which pulls the package average down slightly while every new
file individually clears the >90% statement bar: `oauth.ts` 95.83%,
`scripts/http.ts` 95.04%, `scripts/sse.ts` 90.57%, `plugin.ts` 98%,
`helpers.ts` 100%). `src/events/*`/`src/transform/*` are untouched by this
task and unchanged from their own baselines; `stdio.ts` (both the script and
its one-case test) is untouched. `tests/fixtures/*` and
`tests/mcp-oauth-cross-process.test.ts` do not themselves count toward
`src/` coverage (they spawn separate `tsx` child processes rather than
calling `src/oauth.ts` in-process), but they do exercise
`watchGrantForChanges()` for real inside each spawned `watch` worker.

Exact command and full result:
```
cd packages/stackpress-ai && yarn test
# 160 passing (≈60s depending on machine load)
```

Ran every new file individually at least once while iterating (not just as
part of the full suite): `npx ts-mocha -r tsx tests/mcp-oauth-http.test.ts`
(28 passing), `tests/mcp-oauth-sse.test.ts` (10 passing),
`tests/oauth-helpers.test.ts` (23 passing),
`tests/oauth-fixture-smoke.test.ts` (1 passing).

**Cross-process follow-up pass** (closes the previously-open "list
notifications across processes" clause): started disposable
`oauth-00009-pg` (`postgres:17-alpine`, 127.0.0.1:55577,
`POSTGRES_HOST_AUTH_METHOD=trust`, `--tmpfs /var/lib/postgresql/data`) and
`oauth-00009-mysql` (`mysql:8.4`, 127.0.0.1:55578,
`MYSQL_ALLOW_EMPTY_PASSWORD=yes`, `--tmpfs /var/lib/mysql`) under
`flock /tmp/oauth-db.lock`, waited for `pg_isready`/`mysqladmin ping`, then
ran:
```
cd packages/stackpress-ai && \
OAUTH_00009_PG_HOST=127.0.0.1 OAUTH_00009_PG_PORT=55577 OAUTH_00009_PG_DATABASE=oauth_proof OAUTH_00009_PG_USER=postgres \
OAUTH_00009_MYSQL_HOST=127.0.0.1 OAUTH_00009_MYSQL_PORT=55578 OAUTH_00009_MYSQL_DATABASE=oauth_proof OAUTH_00009_MYSQL_USER=root \
npx ts-mocha -r tsx tests/mcp-oauth-cross-process.test.ts
# 4 passing (13s) — ran twice in a row against fresh containers; both
# runs passed with no flakiness
```
Then ran the full `yarn test` (160 passing, above) with the same four env
vars set, confirming the new file integrates cleanly with the rest of the
suite. Containers stopped and removed (`docker rm -f oauth-00009-pg
oauth-00009-mysql`) immediately after; `docker ps` confirmed only the
pre-existing protected containers (`ops-cockroach`,
`op-impl-officepress-crdb`, etc.) remained.

**`stackpress-session` (`yarn test`), full package suite, this worktree:**
**485 passing, 48 pending, 0 failing** — unchanged from the existing
baseline (pending rows are the pre-existing PostgreSQL/MySQL adapter skips
without a running container, same convention 00003/00005/00006/00008 use;
no disposable containers were started for this task since no `OAuthStore`
behavior changed, only `package.json`'s `exports` map). Confirms the new
`./oauth/metadata` export did not regress anything.

**`stackpress-api` (`yarn test`), full package suite, this worktree:**
**119 passing, 0 failing** — unchanged from the 00008-verified baseline (no
source in this package was touched by this task; only its stale `cjs`/
`esm` build output was regenerated).

**Verification Process checklist** (task file's own four bullets):
1. "Port P-002 defects into actual package regression tests across all six
   HTTP/SSE combinations, including real SDK and attached Ingest requests."
   — **Done.** Stateful Streamable HTTP POST/GET/DELETE, stateless
   Streamable HTTP POST (+405 on GET/DELETE), and legacy SSE GET+POST are
   each exercised against the real SDK transport classes; the attached
   (`ctx.on('request', ...)`) path is exercised with real
   `IncomingMessage`/`ServerResponse`-prototyped objects, not a hand-rolled
   fake of the whole transport.
2. "Exercise absent/wrong identity, concurrent calls, revoked/expired/
   rotated keys, any-match/empty scopes, control strength, unknown tools,
   resource mismatch and no invalid-key-to-public fallback." — **Done**,
   every clause has at least one dedicated case: absent identity (anonymous
   denial), wrong identity (session-identity-mismatch, unbound legacy key),
   concurrent calls (two genuinely overlapping requests on separate
   sessions via `Promise.all`, effects verified not to cross-contaminate),
   revoked (`revokeToken` then denied), expired (direct `access_expires`
   row mutation via `Update('oauth_grant', ...)` then denied), rotated
   (refresh then the new key still works on the bound session), any-match
   scopes (Q-004: one of two configured scopes is enough), empty scopes
   (Q-006: a valid key of the correct type still passes an empty configured
   list), control strength (DELETE and an already-bound GET both require
   the full key), unknown tools (rejected before classification), resource
   mismatch (a grant approved for the HTTP resource is refused on the SSE
   resource), no invalid-key-to-public fallback (a malformed/unknown
   `oauth_` token gets 401, never the anonymous projection).
3. "Verify public catalog projection with real required arguments and
   output schemas; test login, relisting, permission loss and list
   notifications across processes." — **Done, including "across
   processes."** Catalog projection, login, relisting with real
   `required`/`outputSchema`, and permission loss (revocation) are all
   directly tested. List-change notifications are proven end-to-end in a
   single process (a real `notifications/tools/list_changed` frame
   observed on the standalone GET stream after a background poll detects
   the grant changed), and separately across two real, independent OS
   processes sharing one real PostgreSQL/MySQL server in
   `tests/mcp-oauth-cross-process.test.ts`: a `watch` child process calls
   the real production `watchGrantForChanges()` (the exact function
   `scripts/http.ts`/`scripts/sse.ts` wire to
   `session.server.sendToolListChanged()`) against its own database
   connection, a separate `revoke` child process cancels the grant
   through the real `oauth-revoke` event handler on its own connection,
   and the watcher observes the change with no shared memory between the
   two — only the real server's row data proves the coordination. A third
   process (`verify-stale`) independently confirms the now-cancelled key
   is refused through the real `oauth-token-verify` handler, and a
   second case confirms no false CHANGED fires when nothing else touches
   the grant. Run against both real PostgreSQL and real MySQL (4 cases
   total, run twice in a row with no flakiness).
4. "Check errors before/after headers, legacy SSE 202/GET reply timing,
   route collisions, CORS and actual STDIO regression. Explicit reapproval
   remains required where clients cannot escalate automatically." —
   **Done.** Errors before headers (401/403/404/405/503 with the
   `WWW-Authenticate resource_metadata` challenge) and after headers
   (`writeOAuthRefusal`'s `headersSent` branch, unit-tested directly; a
   late tool-call refusal becomes `McpError(-32001, ...)`, with an
   `(execution: not_started)` text marker only when the business event was
   never invoked) are both covered. Legacy SSE 202-then-GET-reply timing is
   covered for both the denial and success cases. Route collisions reuse
   00002/00006's already-tested `OAuthService.registerMcpResource`
   collision/propagation behavior, now also exercised against the new SSE
   `/messages` registration this task adds. CORS/OPTIONS preflight and
   Origin rejection are covered on both transports. STDIO's existing
   one-case regression test (`tests/stdio.test.ts`) still passes unchanged
   — this task does not touch `scripts/stdio.ts`/`events/stdio.ts` at all.
   No code path in this task ever widens a refusal into an automatic
   escalation; recovery remains explicit reapproval/new-session only.

**Honest gaps recorded** (see Implementation Notes' numbered list for the
full detail, now 3 items — multi-process notification coordination was
closed by the cross-process follow-up pass above): no trusted-proxy header
support (matches 00006's own recorded gap); `Vary`/`Access-Control-Expose-
Headers` only set on OPTIONS preflight, not on every actual response; one
narrow legacy-identity race (`resolveLegacyAuthContext`'s post-verify
lookup failing) not separately tested. None of these three block
verification; none are required test families this task owns per
sprint.md's allocation table.

Cleanup: the original pass started no disposable database containers
(PGlite only, fully in-process). The cross-process follow-up pass started
`oauth-00009-pg`/`oauth-00009-mysql` under `flock /tmp/oauth-db.lock` and
removed both with `docker rm -f` immediately after its test run, confirmed
by `docker ps` showing only the pre-existing protected containers
afterward. No scratch files were left in `/tmp` (confirmed removed:
`/tmp/oauth-00009-debug/`, a stray empty `/tmp/debug-oauth-http.mjs`, and
no leftover files from the cross-process pass). No git worktree was
created by this task. `ps -u $USER` was checked after
every test run; no test runner, watcher or server process from this task
was left running (one background `ts-mocha` invocation that hung during
early SSE-test debugging was terminated by the harness's own timeout before
any fix was applied, not left running).

## Acceptance Notes

No visual acceptance is required. Finish at verified once the checks pass;
do not mark accepted merely because tests pass.
