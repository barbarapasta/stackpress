# What We Checked And Where It Came From

Checked 2026-09-28. Initial findings came from source and document reading.
Authorized prototypes have now run; [proof results](proof-results.md) distinguish
executed findings from remaining implementation and browser-integration work.

## Source Records

- Stackpress commit: `a71d683051ba8350fdd12d6b5a33f268fdcc285f`.
  Unrelated edits already existed in `package.json` and agent guidance,
  workflows, and scripts. We left them as they were.
- Source app: `/home/solution-team/.paseo/worktrees/25y5f1ot/cruel-blobfish`,
  at commit `58c9a9459899dee21ae43946e00d80e2123a84f7` when inspected.
- Source spec: `.agents/specs/00032-mcp-native-oauth/`. We saved exact copies of
  its [index](../../resources/00005-mcp-native-oauth/resourcing-spec-00032/index.md),
  [brief](../../resources/00005-mcp-native-oauth/resourcing-spec-00032/brief.md),
  [decisions](../../resources/00005-mcp-native-oauth/resourcing-spec-00032/decisions.md),
  and [status](../../resources/00005-mcp-native-oauth/resourcing-spec-00032/status.md).
  Links inside those copies still refer to the source app. Read any other linked
  files there. We did not copy the whole spec folder or application code.
- Relevant app code remains at `plugins/agent-auth/domain/authorization-code.ts`,
  `renewal.ts`, `key-store.ts`, and
  `plugins/agent-auth/overrides/upstream/stackpress-ai-key-verification.patch`.
  That patch targets compiled code and says it has not been tested on a live
  server. Apply its intended fixes to source and test them; do not apply the
  patch blindly. This planning pass did not audit the whole application.

The source says its deployed feature and clients worked. That is useful evidence
about that app. Its prototype shortcuts and database assumptions do not prove
that the reusable Stackpress version will work.

## R-001 — What The Packages Do Today

Reading complete. Relevant to G-001, G-002, and G-003.

- `packages/stackpress-api/schema.idea` owns Application and database Session.
  Session lacks the fields needed for PKCE, used-code tracking, renewal-token
  history, server-address restrictions, and the app's renewal/cancellation rules.
- `packages/stackpress-api/src/pages/oauth.ts` creates a Session and returns its
  ID as the code. `pages/token.ts` returns the ID and secret separately through
  Stackpress's usual results response. New public clients need a single-use code
  and the standard key reply instead.
- `packages/stackpress-session/src/session/Session.ts` manages browser JWTs.
  `session/plugin.ts` registers `me`, permission checks, and account/security
  pages. Reuse the signed-in person's identity; a browser cookie is not an MCP key.
- `packages/stackpress-ai/src/helpers.ts` looks up app/session rows by ID.
  `requiresSecret()` skips the secret check for GET. `hasRequiredScopes()` accepts
  any listed permission. `resolveListAuth()` treats unresolved keys as public.
- `packages/stackpress-ai/src/scripts/http.ts` checks identity when creating a
  saved MCP session, then sends later requests straight to that session.
  When attached to the app server, its request handler currently selects POST.
  `src/plugin.ts` keeps the initial identity in tool handlers. Fix these together
  so a later request cannot keep using old access.
- AI needs `stackpress-api`, and API uses session. Making session also need API
  would make the packages depend on each other.
- `packages/stackpress/src/plugin.ts` loads session and API, but not AI.
  Do not silently change that list while adding OAuth.

## R-002 — The Standard Client Login Rules

Official sources checked. Testing the implementation remains to be done.

The [MCP 2025-11-25 authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
separates the server hosting tools from the server issuing keys. It explains
how clients discover login instructions, how servers ask for a key, and how
clients introduce themselves. It covers HTTP; STDIO gets credentials from the
environment. This supports the session/AI split but does not choose database models.

[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) describes security rules
for return addresses, proof that a client started login, permission limits, and
renewal tokens. [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) explains
how the login server names itself on the return to the client.
[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html) explains how a client names
the server it wants a key for. The detailed defaults are now in
[configuration](configuration.md); they are engineering choices accepted at Freeze on 2026-09-29.

Plan against MCP 2025-11-25, OAuth 2.1 draft-13 and the client-document draft-00
referenced by that MCP version; recheck the pinned compatibility baseline when building. These sources do not prove support for all future standards or
client versions. The package currently pins MCP SDK `1.29.0`.

## R-003 — Safe Database Updates

P-001 is executed. The complete published Inquire Engine, all four adapter
Connection implementations, helpers, entrypoints, and types were inspected;
versions and source hashes are saved in the [database proof](../../../proofs/mcp-oauth-store/README.md).
No full sibling checkout was available; claims are grounded in the executed
published implementations, not an assumed source revision.

All four current adapters fail exclusive transaction ownership. The candidate
passes on real PGlite/PostgreSQL/MySQL/SQLite using reserved connections or a
shared embedded-resource queue, then a write lock on the approval row. SQLite
contention ran across separate OS processes. Inquire owns the connection fix;
session owns the OAuth record rules. Full generated-store SQL integration,
crash recovery, and classified bounded retries remain implementation checks.
The blog/PGlite fixture stays the default example without narrowing support.

## R-004 — MCP And Browser Support We Can Reuse

P-002 now uses actual SDK 1.29.0 and Ingest 0.10.8. The complete Ingest checkout
was inspected at 477ec47f8b5dafa5713b13f9c964d06c61c22938, especially
http/Adapter.ts and Route.ts. No upstream Ingest fix was required for the tested
body-before-hook and response-handling path. Stackpress AI owns stale saved
auth, missing attached HTTP methods, and the attached SSE query/body merge.

The HTTP candidate matrix and corrected standalone/attached SSE prove current
request auth, renewal, refusal, and identity isolation using SDK transports.
Use req.auth/extra.authInfo and body-only req.post() for attached JSON-RPC input.
An unknown tool cannot inherit a read classification. Unclassified controls
need a full key. The [transport report](../../../proofs/mcp-oauth-transport/README.md)
records exact tested scenarios, including control checks.

Late refusal stops effects but cannot change sent HTTP headers. SDK HTTP scope
escalation can refresh unchanged permissions then fail; older SSE does not
start OAuth for 403 in the tested SDK path. Explicit client recovery works.
Browser CSRF/fresh-factor integration and distributed notifications remain
production work. Q-013 accepts anonymous visibility of protected descriptions.

## R-005 — Existing Build And Test Support

Reading complete; builds/tests will run during implementation.
Both packages have CJS/ESM build scripts and Mocha/Chai/NYC test commands. AI has
tests for connections, its tool list, plugin registration, and code generation.
No session test files appeared in the package listing.

Measure current coverage before estimating what it takes to reach the repository's
above-90% requirement. Root `yarn test` covers only server, schema, and SQL.
It does not test this feature.


## R-006 — Ordinary API Support And Shared Keys

Added after the user accepted G-002. API source inspection found that
`packages/stackpress-api/src/helpers.ts` permits an ID without a secret on GET.
The session/app handlers in `src/plugin.ts` also skip secret comparison on GET
and accept any matching listed permission. The session handler sets `profileId`
before calling the configured event. These are existing behaviors to account
for when adding the shared verifier and asking the G-003 upgrade questions.

P-004 now passes 35 candidate checks: one canonical service resource plus
explicit saved API-operation membership, with per-route enablement and independent
permission checks. Hostname/path similarity grants no access. The SDK's default
resource discovery works without a custom override. P-003 also passes 12 fixture
checks per native client, including API use of each client's newly issued key.
See [combined findings](proof-results.md) for commands and limits.

This resolves the shared-service mechanism, not production API integration.
Generated/parameterized routes must use trusted server-owned definitions for
membership. Existing API replies and key ownership stay unchanged. The legacy
branch in the shared fixture is explicitly a dispatcher stub; it is not proof
that all existing API handlers have been regression-tested.


### R-006 Follow-Up — Resource Identifiers And Route Adoption

Rechecked [RFC 8707 section 2](https://www.rfc-editor.org/rfc/rfc8707.html#section-2):
a resource identifier can represent a complete API with several endpoints, and
an authorization server may map the requested identifier to its intended audience.
This supports investigating an explicitly configured shared service. It does
not establish that arbitrary routes on the same host are covered. MCP/client
compatibility and P-004 were still pending at this reading. The executed
proofs above now supply that candidate evidence; the RFC alone did not.

The existing API configuration separates public, app, and session routes in
packages/stackpress-api/src/types.ts. The session handler in src/plugin.ts
resolves existing API Session records and sets profileId before calling the event.
There is no existing new-OAuth route default to preserve. Q-012 accepts explicit
opt-in for each user API route, without changing existing API key support.

The [MCP 2025-11-25 resource rules](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#resource-parameter-implementation)
require clients to name the MCP resource during authorization and key exchange.
Servers must verify that the key was issued for them. Together with RFC 8707,
this makes an explicitly declared service covering both interfaces a candidate
to test, not permission to accept any same-host key.

Read installed SDK 1.29.0's dist/esm/client/auth.js selectResourceURL and
shared/auth-utils.js checkResourceAllowed. The default client accepts metadata
whose resource URL has the same origin and a containing path, then selects that
metadata resource. Without metadata it returns no resource unless a provider
supplies custom validation. This is client discovery behavior; do not copy its
path-prefix matching into server authorization. Publish resource metadata and
check exact configured service membership on the server. This limited source
reading alone does not establish behavior in Claude Code or Codex or replace
P-004. The later executed proofs above provide those separate observations.

### R-003 Follow-Up — Available Database Choices

Source inspection confirms templates/blog/plugins/store/connect.ts uses PGlite.
packages/stackpress-sql/src/mysql.ts, pgsql.ts, pglite.ts, and sqlite.ts forward
the corresponding Inquire adapters. The accepted ecosystem context lists mysql2,
pg, PGlite, and sqlite3 connectors. The local node_modules directory includes
Inquire and the PGlite adapter; this is not the complete sibling repository.
Engine.transaction delegates to the connection implementation, as recorded in
the SQL reference and visible installed Engine code. This initial inspection
did not claim a missing primitive. The later P-001 source tracing and real
concurrency/rollback tests establish the connection ownership defect described
above. Q-007 selected release coverage; those later tests establish feasibility.


### R-004 Follow-Up — Fresh Approval Checks

Read packages/stackpress-session/src/auth/pages/signin/2fa.ts for Q-010.
It redirects already signed-in users and verifies the sign-in challenge for
others. Reusing that page unchanged would not establish a fresh factor check
for an already signed-in approval. The underlying verification helper may be
reused, but the approval check needs its own server-bound request. Q-010 chooses
the default policy; the implementation and browser proof remain pending.


## R-007 — Final Public Contracts And Recovery

Completed source/proof review on 2026-09-28 for G-003/G-005/G-006/G-007.
Read session Session.ts/plugin.ts/pages/authorize.ts and schema.idea; API types,
helpers and plugin; AI tool/transport types and helpers; session package exports;
Terminal.bootstrap and blog develop/production bootstraps. Events use Ingest
status fields. API user routes are type session, MCP user tools type user. OAuth
needs its own identity, safe view props, and exact browser-guard integration.
Existing Auth.consumed is not a TOTP replay counter; add separate factor-use state.
Existing legacy handlers do not already enforce the complete planned validation.

Three proof agents independently reviewed the draft contracts. Corrections cover
first-statement grant locking after an outside lookup, explicit lock/revision fields,
nullable unissued access values, legacy incarnation, no-store metadata separation,
atomic caps and source limits, current exchange policy, startup finalization,
trusted credential-strength input, and minimal anonymous protected-tool schemas.
These are source-backed design corrections, not executed production proof results.

The installed Codex/Claude help confirms the login/logout examples in
[recovery](recovery.md); only Codex's checked version exposes a scopes flag.
The transport proof shows explicit approval recovery works while automatic 403
escalation fails. A new grant needs a new session; same-grant renewal can continue.

Rechecked the pinned [MCP authorization standard](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization),
[RFC 6749 code rules](https://www.rfc-editor.org/rfc/rfc6749.html#section-4.1.2),
and [RFC 7009 revocation](https://www.rfc-editor.org/rfc/rfc7009.html#section-2.1).
Resource-request errors use invalid_target under the previously checked RFC 8707.
The 60-second code default, operating limits, required named policy listeners,
record layout and full-key revocation rule are accepted Stackpress choices; those
standards do not prescribe them. No unversioned future compatibility claim is made.

Research needed to write this plan is complete. Remaining work is implementation
verification and the release gates in [verification](verification.md), including
full accounts/browser flow, generated stores, realistic tool schemas and long-lived
native-client recovery. No production check is waived by this research closeout.

Freeze 2026-09-29: research is complete for the accepted build plan. Historical
source-reading/proof statements retain their original limits. Production checks
are owned by the [implementation tasks](tasks/sprint.md).
