# What The Proofs Established

Run on 2026-09-28 after the user authorized parallel proof work. Three agents
owned database, transport, and shared-access experiments. The coordinating agent
ran real-client checks and reviewed the combined evidence. Agents also reviewed
each other's work; assertions were strengthened where observations alone could
have counted an error as success.

No production package, workspace dependency, or application database was changed.
The prototypes live under root `proofs/`. They are experiments to settle the plan,
not the session OAuth implementation or a release approval.

## Results And Reproduction

| Proof | Result | Evidence and command |
| --- | --- | --- |
| P-001 database safety | Proved feasible on all four databases; current shared adapters fail isolation | [Database report](../../../proofs/mcp-oauth-store/README.md); `bash proofs/mcp-oauth-store/run.sh` |
| P-002 MCP connections | Partly proved; current defects reproduced, HTTP and older-SSE candidates pass, SDK permission escalation fails | [Transport report](../../../proofs/mcp-oauth-transport/README.md); its five runs and strict TypeScript command |
| P-003 real clients | Each native client passes 12 fixture checks; complete production application journey remains unproved | [Client report](../../../proofs/mcp-oauth-clients/README.md); its browser paths plus `yarn node proofs/mcp-oauth-clients/run.mjs` |
| P-004 shared MCP/API access | Candidate proved in 35 checks; production route integration remains to build | [Shared-access report](../../../proofs/mcp-oauth-shared-access/README.md); `yarn node proofs/mcp-oauth-shared-access/run.mjs` |

All runs use Node 22.23.2. HTTP experiments use MCP SDK 1.29.0; attached
transport experiments use real Ingest 0.10.8. Reports and JSON records retain
versions, commands, scenarios, outcomes, and limits. A baseline test passing
means it reproduced the expected defect, not that the existing code is safe.

## Database Findings

PGlite, PostgreSQL, MySQL, and SQLite all passed concurrent code/renewal use,
both disconnect ordering cases, real SQL rollback, old-token replay, expiry
limits, key-hash replacement, and native connection ownership checks.

Current Inquire 0.10.8 adapters share their native resource without reserving it
for an entire transaction. On PostgreSQL, PGlite, and MySQL, another transaction
can commit the first caller's changes. SQLite's overlapping BEGIN error can
roll back the other caller. On all four, ordinary queries can enter another
caller's transaction. This is reproduced behavior and requires an Inquire fix.

The passing candidate reserves independent connections for network databases,
uses SQLite locks across separate processes, and queues whole PGlite operations
on its single resource. It writes the approval row before reading mutable key
state. Reuse detection commits cancellation before the caller returns its OAuth
error; throwing inside the transaction would undo that cancellation.

The PGlite queue is only within one process. Production must route every query
on that resource through the same owner. Network pools need acquired connections;
all adapters need bounded waits and a defined transient-error retry policy.
Unknown commit outcomes, crash recovery, generated stores, and performance were
not tested. See the database report for the full boundary and pinned setup.

## Transport Findings

Unmodified saved HTTP and older SSE connections can keep the initial person's
identity after credentials disappear or change. The attached HTTP handler skips
GET and DELETE. Origin checks are missing in the exercised current paths.
The candidate passes fresh identity checks in all four standalone/attached and
saved/per-request HTTP combinations using the real SDK and Ingest Node adapter.

The SDK carries request-local `req.auth` into each handler's `extra.authInfo`.
Use that current identity and recheck the backing approval before the effect.
A session identifier never replaces the key. Bind an anonymous saved session
once to its first verified person/client/approval, then reject any change except
a renewed key for that same approval. Keep concurrent requests separate.

Before streaming begins, send the required HTTP 401/403 challenge. If access is
cancelled after headers have gone out, refuse the effect with a protocol error
inside the existing response. The tested reply is HTTP 200 with an error body;
promising a fresh HTTP challenge at that point is impossible.

SDK 1.29.0 handles first protected-call login and 401 renewal in the tested flow.
When a permission is missing but a refresh credential exists, it refreshes the
old permissions and can stop after a repeated 403 without opening approval.
Explicit client recovery works in the experiment. Automatic permission upgrades
remain an open compatibility issue; do not widen refresh grants to hide it.

The user accepted Q-013: anonymous clients may see protected names/descriptions,
while protected execution stays checked. The proof's optional availability
metadata is only an experiment, not a new public API contract. List-change
notifications were explicitly triggered; distributed notification scheduling
still needs production work. Corrected older SSE now passes with real SDK clients
on both standalone and attached Ingest servers. The existing attached SSE path
merges query sessionId into JSON-RPC input and gets a strict-schema 400; body-only
req.post() fixes the candidate. After an older-SSE POST has returned 202, late
refusal is an error on its existing HTTP 200 GET stream. That reply channel
stays open through approval; unsolicited protected events/replay require separate
fresh checks and are not covered by the fixture. Older-SSE 403 does not initiate OAuth in the
tested SDK path; explicit client recovery works. Unknown tools are refused before
classification, and DELETE/unclassified controls require a full key.

## Shared Service And Native Clients

The passing design names one service with the MCP server's exact canonical URL.
It separately records the API operations that belong to that service and were
shown during approval. API routes also require their own enabled setting.
Matching a host or path prefix grants nothing. A new route does not silently
expand earlier approvals, and renewal preserves their membership.

The SDK selected the resource from discovery without a custom override. Both
native clients sent that resource during approval/exchange and renewal.
Codex 0.157.0 and Claude Code 2.1.283 each passed browser approval, protected tool
execution, automatic renewal, API use with the same key, read-ID rules, route
and service refusal, disconnect, and reapproval. Chromium 153.0.8010.12 submitted
the real HTML form; the person on that form was explicitly simulated.

Model responses came from a local deterministic stub that requested only the
proof read tool. Native clients performed the MCP and OAuth work. Each positive
check requires actual tool completion, a matching successful returned result,
and a successful client exit. All proof credentials and temporary listeners were
cleaned up. Native-client disconnect was tested on the next connection, not an
already-running tool. P-002 covers the in-flight case separately.

P-003 is still incomplete as a release proof. It cannot verify Stackpress's
real sign-in/CSRF/two-factor pages or generated OAuth stores before they exist.
The fixture also does not establish HTTPS deployment, safe client-document
fetching, distributed rate limits, or every client UI's automatic login behavior.
These limits are explicit, not silently counted as passes.

## Effect On The Plan

G-004's database feasibility and G-007's shared-service mechanism are answered
with implementation prerequisites. G-005 has useful passing evidence but remains
open for automatic permission escalation and remaining transport/integration
contracts. G-006 still needs detailed public settings and event contracts.
The plan remains Draft and is not approved for production implementation.

Keep reusable prototype details and findings here until the owning-library fixes
and final public contracts are settled. Context-promotion review was performed;
no prototype behavior was promoted as shipped Stackpress behavior.
