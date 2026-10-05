# MCP OAuth Transport Proof

P-002 is **partly proved**. A small replacement transport can use the current
identity on each request with SDK 1.29.0 and Ingest 0.10.8. The existing saved
HTTP and older SSE transports do not do that. Corrected candidates now pass
on both standalone and attached HTTP, including older SSE. The tests also found two limits:
permission upgrades are not always automatic, and a response that has started
streaming cannot change to HTTP 401 or 403.

This folder is a prototype. It changes no package source, exports, dependencies,
or accepted product decisions. Its memory store and small authorization server
are test fixtures, not an OAuth implementation.

## Run It

Run from the repository root after the normal Yarn dependency installation.
Use Node 22; this run used **22.23.2**, SDK **1.29.0**, and Ingest **0.10.8**.

```bash
node --import tsx proofs/mcp-oauth-transport/baseline.mts
node --import tsx proofs/mcp-oauth-transport/candidate-test.mts
node --import tsx proofs/mcp-oauth-transport/sdk-client.mts
node --import tsx proofs/mcp-oauth-transport/legacy-test.mts
node --import tsx proofs/mcp-oauth-transport/sdk-client.mts --legacy
node node_modules/typescript/bin/tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --skipLibCheck --strict proofs/mcp-oauth-transport/*.mts
node --import tsx node_modules/mocha/bin/mocha.js packages/stackpress-ai/tests/stdio.test.ts
```

All commands passed on 2026-09-28. The existing STDIO test has only one case:
an empty registry is rejected. That is a narrow regression check, not complete
STDIO authentication coverage. No production files changed.

The scripts open ephemeral ports on `127.0.0.1` and close them before returning.
Results contain observations, not access keys. The seven baseline observations
passing means the script reproduced the expected current behavior, including
its flaws. It does not mean the current transport is safe for the planned OAuth.

## Existing Behavior We Reproduced

[baseline.mts](baseline.mts) imports the current Stackpress source unchanged.
It uses real TCP requests, the real SDK, the real registry/tool factory, and the
real Ingest Node adapter. Only the backing account lookup rows are fixtures.
See [baseline-results.json](baseline-results.json).

| Current path | Observed result |
| --- | --- |
| Saved HTTP session created by Alice | A later request without a key still runs as Alice |
| Same session with Bob's key | Still runs as Alice |
| Same session after deleting Alice's backing row | Still runs as Alice; auth lookup ran only during initialization |
| New server per request | Missing credentials cannot call a protected tool; Bob's request runs as Bob |
| HTTP inside the real Ingest server | POST body parsing works; the missing-key flaw remains |
| GET/DELETE inside Ingest | Fall through to 404 because the current attach handler selects only POST |
| Browser Origin | Both HTTP modes accept an unapproved Origin |
| Older SSE | POST without a key still uses Alice after her backing row is deleted |
| Older SSE inside real Ingest | Initialization fails with 400: `req.data()` merges query `sessionId` into the strict JSON-RPC message |

The source matches the observations:

- [HTTP transport](../../packages/stackpress-ai/src/scripts/http.ts)
  `_handleStatefulRequest` goes straight to a saved transport. The attached
  handler filters out every method except POST.
- [SSE transport](../../packages/stackpress-ai/src/scripts/sse.ts)
  `_handleMessageRequest` does not run the auth resolver again. Its attached
  handler passes merged `req.data()`; the corrected adapter passes body-only
  `req.post()` so the message keeps its exact JSON-RPC shape.
- [Registry](../../packages/stackpress-ai/src/plugin.ts)
  `createMcpServer` filters once; `registerCallTools` captures that first identity.

## What The Candidate Proves

[candidate.mts](candidate.mts) is a separate prototype using actual SDK server
transports. It places a fresh, frozen identity on the current Node request as
`req.auth`. The SDK passes it to the current tool handler as `extra.authInfo`.
No shared current-user variable is used. The tool checks the backing state again
before recording its example effect.

[candidate-test.mts](candidate-test.mts) repeats the following checks in all
four combinations: standalone HTTP / real Ingest HTTP, each with saved sessions
/ a new server per request. See [candidate-results.json](candidate-results.json).

- Anonymous initialization, public calls, and protected-tool discovery work.
- Missing keys receive 401 with a `resource_metadata` challenge before the SDK
  starts streaming. Missing permission receives 403 with `insufficient_scope`.
- A renewed key for the same approval works; the replaced read ID does not.
- ID alone can call a configured read tool over POST. It cannot call a write
  tool. An explicitly supplied wrong secret also rejects a read.
- A bound saved session refuses another person, another approval, missing keys,
  and a browser cookie without a key.
- Removed permissions, disabled accounts, expiry, and cancellation take effect.
- Two deliberately overlapping requests retain Alice and Bob independently.
  A caller's `person` argument cannot replace the trusted person in the proof
  handler. This is not a test of generated Stackpress event input handling.
- An absent Origin and the configured same Origin work; another Origin fails.
- Saved-session GET and DELETE receive the same identity checks. GET receives
  a real `notifications/tools/list_changed`; DELETE ends the saved session.
- In the per-request mode, GET and DELETE explicitly return 405.
- DELETE requires a full key, even for an anonymous saved session. Other
  operations without a declared safe read classification also need a full key;
  the proof checks `ping` with missing, ID-only, and full credentials.
- Unknown tool names are rejected before read/write classification, with no effect.

These checks do not rely on mocking the SDK transport or the Ingest adapter.
The storage and account state remain in memory, so they do not prove database
isolation or production cancellation propagation across several processes.
The full any-matching-permission and empty-list rules are covered by the
[shared-access proof](../mcp-oauth-shared-access/README.md); these transport
fixtures deliberately use one permission per tool.

## Streaming Changes The Error Contract

The test pauses a tool after the SDK has started its response, cancels access,
and then lets the tool continue. The second check prevents the effect. The
client receives **HTTP 200 with a JSON-RPC error**, because those HTTP headers
are already sent. This happens in all four combinations.

The plan should require 401/403 before SDK dispatch and a safe protocol/tool
error for a refusal discovered after streaming begins. It cannot promise a new
HTTP challenge at that later point. The next protected request must receive the
normal fresh HTTP check. Do not turn a late failure into success or run its effect.

## Actual SDK Client Behavior

[sdk-client.mts](sdk-client.mts) uses the unmodified SDK client, discovery,
PKCE generation, code exchange, refresh, and HTTP retries. Its small local
authorization server returns fixture codes/tokens. It deliberately does not
implement a browser page, real approval, secure code storage, or registration.
See [sdk-client-results.json](sdk-client-results.json).

| Scenario | Observed SDK 1.29.0 behavior |
| --- | --- |
| Anonymous initialization and public call | No login starts |
| First protected call | 401 starts discovery and produces an authorization URL with S256 and the exact MCP resource |
| Approval continuation | Supplying the fixture code through `finishAuth` exchanges it and allows a retry on the same session |
| Expired access key | 401 refreshes automatically and retries successfully |
| Permission removed, valid refresh token remains | 403 refreshes with the old permissions, retries, then fails with `Server returned 403 after trying upscoping`; no approval URL opens |
| Explicit client recovery after that failure | Discarding the refresh credential and retrying starts approval for the requested permission |
| Cancelled approval | Key refused; refresh fails; SDK starts approval again |
| Exchanges and renewals | Every tested token request includes the exact MCP resource |

The permission-upgrade failure follows SDK `client/auth.js`: `authInternal`
tries refresh before starting authorization. `refreshAuthorization` sends no
new scope. `client/streamableHttp.js` stops a repeated 403 challenge to avoid a
loop. A server must not widen refresh permissions to work around this. Client
recovery or a tested SDK/client change is needed before claiming automatic
permission upgrades. These SDK results do not substitute for Claude Code and
Codex application tests.

## Older SSE Candidate

[legacy-candidate.mts](legacy-candidate.mts) uses the same current-request tool
handlers with the SDK's actual older SSE transport. [legacy-test.mts](legacy-test.mts)
uses real SDK clients and repeats the checks through standalone Node and the
real Ingest adapter. [legacy-results.json](legacy-results.json) records both.

Anonymous GET, initialization, listing and public calls work. Every message
POST gets fresh auth before its 202 response. First approval binds the saved
session; another person/approval cannot reuse it. The tests cover rotated keys,
ID-only reads, write denial, a wrong secret, permission removal, expiry,
cancellation, disabled accounts, unknown tools, unclassified controls, overlapping
identities, and Origin checks on both GET and POST. A new GET with a cancelled
key receives 401 before opening its stream.

For a late cancellation, POST has already returned **202**, and the old GET
stream is already **200**. The fresh check stops the effect and sends a JSON-RPC
error on that GET stream. Neither response can change to an HTTP challenge.
The next POST performs the fresh HTTP check again.

The `--legacy` run of [sdk-client.mts](sdk-client.mts) also proves actual SDK
OAuth discovery, first login, same-session approval, automatic renewal,
cancellation and exact resource submission. See
[legacy-sdk-client-results.json](legacy-sdk-client-results.json). The older SSE
client does **not** handle 403 as an OAuth permission-upgrade signal at all.
A separate, explicit client call to the SDK's `auth` helper can start approval
for the new permission after discarding the old refresh credential. That is a
proved recovery option, not an automatic older-SSE behavior.

## Accepted Visibility And Session Mechanics

Q-013 accepted showing protected tool names/descriptions to anonymous clients,
so calling one can trigger login. The candidate does that. Its optional
`stackpress/available` metadata remains a proof-only convention; clients are
not assumed to understand it. Availability changes on the next list request,
and a generic list-change notification works.

To support that accepted public-to-protected flow, a saved anonymous session
binds once to its first verified approval. Every later request must match its
person, client and approval. Both actual SDK transports successfully continue
on that same session after approval. No token is accepted solely because the
caller knows a session ID.

Streamable HTTP closes the old anonymous GET stream at binding. Older SSE keeps
its only GET reply channel open; closing it would discard replies from the
client's existing connection. Protected replies still require a verified POST,
and no unsolicited protected events are emitted by this prototype. Production
features that push protected events will need fresh checks before those events.

Public initialization, its initialized notification, listing, public tool calls,
and an anonymous GET stream are explicitly classified safe operations. They do
not grant write access. DELETE and currently unclassified control operations
require a full key. These rules follow the existing plan's control-operation
restriction; they do not add a new product option.

No automatic approval, expiry, or cancellation scheduler was built. The list
notification was invoked explicitly. The proof shows that the SDK can carry
it, not that production grant changes already notify every running server.
Event replay, cross-origin browser CORS, proxy/Host policy, large bodies, request
limits, process restarts, and network reconnect recovery remain production
checks. This prototype permits same-origin browser use only; it is not a browser
CORS implementation. The native-client proof separately covers real Claude Code
and Codex behavior.

## Ownership And Upstream Inspection

The complete Ingest repository was cloned and its Node adapter and route
lifecycle inspected at commit `477ec47f8b5dafa5713b13f9c964d06c61c22938`
(package version 0.10.8). The inspected files were `ingest/src/http/Adapter.ts`
and `ingest/src/Route.ts`. Installed runtime code was inspected as well and
used directly in the tests.

Ingest loads the body before the request hook and supports stopping its normal
response after the MCP handler sends one. That path works in the real adapter
proof. The stale identity, missing attached methods, and merged JSON-RPC body belong
to Stackpress AI integration.
No Ingest defect or required upstream Ingest release was established. The SDK
already carries current request auth; the separate SDK permission-upgrade
limitation is documented above.
