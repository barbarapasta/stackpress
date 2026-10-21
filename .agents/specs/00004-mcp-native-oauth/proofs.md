# Small Tests Needed To Settle The Plan

The user authorized these proofs and parallel prototype work on 2026-09-28.
All four have executed evidence under root proofs/. The result for each is below;
[combined findings](proof-results.md) explain what passed and what remains unproved.
The source application's results cannot replace tests of the library version.

## P-001 — Can Two Requests Use The Same Code Or Renewal Token?

Result: **proved for candidate feasibility** on PGlite/PostgreSQL/MySQL/SQLite.
The existing shared adapters fail isolation; Inquire needs connection ownership
before production OAuth can rely on them. See the [database report](../../../proofs/mcp-oauth-store/README.md)
and results.json beside it. Reproducible command: `bash proofs/mcp-oauth-store/run.sh`.
No fallback drops an accepted database.

Answers G-004. We need to show that the chosen database drivers can use up a
code or renewal token and save its replacement as one operation, on one
transaction connection. Either all changes succeed or none do.

Run the same small example against PGlite, PostgreSQL, MySQL, and SQLite using
the existing Stackpress/Inquire adapters. Q-007 requires all four for release.
Keep the blog/PGlite fixture as the default app example. Try two code exchanges
at once, competing renewals, renewal during
cancellation, a forced database failure, and reuse of an older renewal token.
This test needs neither a UI nor the source app's database models.
Executed prototype: `proofs/mcp-oauth-store/`.

Pass: only one exchange/renewal succeeds; no key is left half-created;
cancellation takes effect in the specified transaction order; and reuse of any
old token is detected until the approval's final deadline. All four adapters
must pass; one passing adapter cannot stand in for another.

Fail: two keys are issued, cancellation is lost, queries leave the transaction
connection, or the driver cannot support the required locking. Record driver
versions, queries and transaction behavior, and anything needed from an underlying
library.

## P-002 — Does Each MCP Call Use The Right Current Identity?

Result: **partly proved**. Current flaws are reproduced; candidate HTTP identity,
control-method, renewal, concurrency, and late-refusal checks pass. SDK automatic
permission escalation fails the tested case. See the [transport report](../../../proofs/mcp-oauth-transport/README.md)
for executable commands, older-SSE coverage, and remaining integration limits.
401/403 applies before headers; late refusal must safely stop the operation
inside the response already underway. The [recovery contract](recovery.md) defines explicit reapproval as the fallback
accepted at Freeze on 2026-09-29. The failed automatic case remains a failure,
not relabelled as passing.

Answers G-005. We need to show that SDK 1.29.0 and Ingest can check every request,
give tool calls a current identity that other requests cannot change, and send
HTTP replies that correctly ask the client to sign in or request permissions.

Test HTTP inside the app and on a separate server, with saved sessions and with
a new session per request. Include supported GET/DELETE methods and older SSE
if we keep it. Test public and protected tools at the same address, anonymous
initialization/public calls, discovering protected tools, automatic login when
needed, and list updates after approval, renewal, expiry, and disconnect.
Use two identities, a renewed key for the same approval, removed
permissions, simultaneous requests, errors after streaming starts, and browser
Origin checks. Proposed location: `proofs/mcp-oauth-transport/`.

Pass: calls do not inherit stale or another request's identity; unsafe session
reuse is refused; renewed keys work; and 401/403 replies reach the client at the
right point in the request.

Fail: the first saved identity keeps controlling later calls, already-sent
headers prevent the promised error, or app request handlers bypass the checks.

## P-003 — Can People Use This With Real Clients?

Result: **inconclusive for the full production journey; native fixture checks pass**.
Codex 0.157.0 and Claude Code 2.1.283 each passed 12 checks with real Chromium,
native OAuth and MCP, a simulated signed-in person, and local model responses.
See the [client report](../../../proofs/mcp-oauth-clients/README.md) for reproduction,
trace requirements, native-issued API-key checks, and exact limits.
Real Stackpress sign-in, CSRF, 2FA, and generated stores await implementation;
this release proof is not waived or silently deferred as complete. The plan
schedules it in Stage 6 after implementation. The user accepted that sequencing
at Freeze on 2026-09-29; it remains a required release gate. Its complete production
execution is deferred until the implementation exists, not declared successful.

Covers G-005/G-006/G-007 and final release checks. Run it once the implementation works
in a complete test app. It must pass before release; the accepted database and
connection contracts still apply and their production checks remain mandatory.

Test Claude Code and Codex: add only the URL, sign in through the normal browser
page, approve, call a tool, renew automatically, disconnect, refuse the next
call, then approve again. Use the same approved key on an allowed ordinary API
route, refuse unapproved routes/addresses, and show that disconnect ends both
kinds of access. Record versions, expiry settings, traces without
secrets, and browser records.

The client's return-address listener must run on the actual client machine:
local-machine addresses return there. Never weaken return-address validation
just to make a test work.

Pass: both clients complete the steps without manually installing an access key.
Fail: a helper, proxy, or copied key is needed; renewal fails; or cancelled access
still works.


## P-004 — Does A Shared Key Keep Its Address Restrictions?

Result: **proved for candidate mechanism**, 35 assertions with SDK 1.29.0.
One exact declared service plus saved API-operation membership passes discovery,
approval, exchange, renewal, access, and refusal checks. P-003 also exercised that
service with both native clients. See the [shared-access report](../../../proofs/mcp-oauth-shared-access/README.md).
Production generated/parameterized routes and actual API handlers remain to test.

New from G-002, answering G-007. First read the resource-indicator rules and check
what the supported clients send. Then test the chosen way to describe allowed
MCP/API addresses in a small app. Do not remove existing address checks to make
the test pass. Proposed location: `proofs/mcp-oauth-shared-access/`.

Pass: the same key works on approved MCP/API operations; API routes require the
explicit per-route enablement accepted in Q-012; omitted/disabled settings refuse
new OAuth keys without changing legacy support; an unapproved address or
permission is refused; discovery, approval, exchange, and renewal agree on
what is allowed; and normal clients still connect and renew. Fail: accepting
any same-host route, ignoring the requested resource, broadening access during
renewal, or requiring manual token replacement. The candidate prototype and
saved run are in the directory above.
