# Build Order And How We Will Check The Result

Frozen build sequence and checks, accepted 2026-09-29. The [task plan](tasks/sprint.md)
breaks these six stages into twelve tasks without dropping any required checks.
Stage 1 establishes the accepted contracts in code; Stage 2a blocks Stage 2b.
A stage is done only when its checks pass, not when its files have been written.

## Stage 1 — Agree On Settings, Inputs, And Supported Systems

Owners: session, AI, and API, as accepted in G-001/G-002.

Use the accepted [settings](configuration.md), [event contracts](events.md),
[storage and upgrade rules](storage.md), and [connection recovery](recovery.md).
Q-007 requires all four databases under Node 22. Implement the accepted policy listeners,
finalization, legacy bindings and explicit reapproval. A requirement change needs
explicit permission to reopen the affected Frozen files.
Target MCP 2025-11-25 and tested SDK 1.29.0; recheck pinned dependencies at build time.
Measure existing tests/coverage and check public imports before editing.
Use the executed P-001/P-002 findings and remaining limits before promising
that their database and connection behavior is supported.

Done when: the choices are settled, runnable examples show old and new behavior,
and app developers can review imports/settings without Resourcing-specific names.

## Stage 2 — Fix Inquire, Then Save And Manage Keys Safely

**Stage 2a, release prerequisite:** Inquire for exclusive connection ownership and shared-resource query
serialization; session for `oauth.idea`, types, storage, scripts, and events.
P-001 reproduced failures in current Inquire adapters. Complete that prerequisite
and its regression tests before treating the generated OAuth stores as safe.

**Stage 2b, session:** after the corrected dependency is pinned, build the optional
schema and its generated code, secure random secrets and
hashing, client registration, single-use codes, approval checks, renewal-token
history, cancellation, cleanup, and account rules. Keep database operations in
scripts separate from events that read requests and set responses.

Build client-document fetching and storage with the required limits. Let tests
replace the network connection and clock so they can repeat failures reliably.

Done when: corrected production adapters pass outside-query exclusion, nested/error
ownership and four-engine races; first-time and repeated code generation both compile; database work
on one connection handles competing requests and undoes failed changes; two
requests cannot both issue the next valid key; reused tokens cancel the right
approval; secrets stay out of ordinary output. Run the same code-exchange,
renewal, cancellation, rollback, and simultaneous-request tests on all four
accepted database adapters. Record each result separately. Save records in a database, not
only in the running server's memory.

## Stage 3 — Add Login, Approval, And Connected-Client Pages

Owner: session `src/oauth/plugin.ts`, pages, views, events, settings, types/imports.

Connect the optional discovery, registration, approval, key, renewal, cancellation,
and connected-client features. Reuse sign-in, browser sessions, CSRF protection,
translation, and view patterns. Keep the pending request on the server while
the person signs in or completes a fresh identity check.

Done when: replies use standard JSON fields/status/headers; validated returns
include state and server identity; bad clients get normal local error pages;
approval stays within the person's permissions; and people can list/cancel only
their own approvals. Check server-rendered pages, browser startup, interactions,
and accessibility. Include pending expiry/duplicates, safe prop snapshots, factor
counter replay and client metadata changes between display and approval.

## Stage 4 — Check Access On MCP And API Requests

Owners: AI types, helpers, plugin, HTTP/SSE handling, and API route integration.

Add discovery documents, replies asking clients to sign in, the key-check event,
any-listed-permission matching accepted in Q-004, and trusted user data
passed to events. Check keys on every protected request and tool call. Tie saved
connections to an approval without keeping the original identity forever or
letting another caller take over. Cover MCP inside the app and on its own, and
every supported HTTP method. An MCP session ID must never act as an access key.
Public and protected tools share one address: anonymous users can initialize
and call public tools, while protected calls trigger the tested login/error
path. Verify the list updates after approval and access changes.

Connect API routes to the same session key-check event. Enforce approved addresses
and route permissions before invoking events. Preserve existing app/session key
support, but never let a failed new-key check fall back to weaker old-key rules.
Test both interfaces with the same approved key and a single disconnect. Test
changed route fingerprints, immutable per-request identities, anonymous catalog
projection and relisting with realistic required arguments; SDK default schemas
must not leak. Attached adapters use req.post(); transport route collisions fail
finalization. Explicit legacy bindings require the new hardened legacy checks.

Done when: bad access gets the right client error instead of an empty-tool-list
500; expiry/cancellation works on the next call; saved sessions cannot use absent
or another person's keys; renewal works for the same approval; removed permissions
cannot survive through old saved identity or requests running at the same time.
The approved key works on permitted MCP and API operations, fails on unapproved
ones, and stops working on both after cancellation, expiry, or account suspension.

## Stage 5 — Make It Usable From An App

Owners: session/AI/API README files, package declarations and type exports, plus the
blog example. Change the main Stackpress exports only when deliberately adding
public names there.

Document minimum settings, model generation/database upgrades, permission and
app-rule events, running inside the app or separately, proxy/login-server
settings, limits, renewal, cancellation, custom routes, and effects on existing
apps. Example permissions and roles must remain examples. Include app-policy listeners,
serving bootstrap oauth-finalize, ordinary API opt-ins, legacy migration dry-run
and native permission-recovery commands. Show setup without
importing the source app's plugin or generated models.

Done when: Node 22 and Yarn build CJS, ESM, and type declarations; a clean example
can import the packaged files/schema; and the blog's full test passes. Do not
publish packages or update outside databases as part of these tests.

## Stage 6 — Try Real Clients Before Release

Use supported Claude Code and Codex versions against an app running the library
implementation. Record exact versions, MCP version, settings, and test records.
Use an ordinary account and an account with stronger approval rules. Shorten
expiry only in test settings so automatic renewal can be checked promptly.

Done when: both clients connect using only a URL and their native login path, complete browser
approval, call an
allowed tool, renew automatically, and fail on the next call after disconnect.
Also use the approved key on an allowed ordinary API route and show that the
same disconnect ends API access. Record any remaining limits. Automated requests alone do not prove these real
client journeys. Also test explicit permission/membership reapproval, relisting
after login, long-lived sessions, real callback delivery, configured proxy/CORS,
and multi-process cancellation. Do not promise automatic 403 escalation. Write
database-upgrade and release notes for changed old behavior.

## Required Tests

Keep every case below when creating implementation tasks.

| Area | What to test |
| --- | --- |
| Login instructions | Correct login/tool addresses and paths, custom routes, ambiguous root document, disabled or invalid settings, only working features advertised |
| Client documents | Exact client ID; bad JSON, fields, or login method; HTTPS/path rules; host changing its DNS answer; private IPv4/IPv6 and IPv4 written as IPv6; no redirects; timeout; oversized decoded response; HTTP cache rules; no saved errors; limits on saved copies |
| Client registration | Body/field limits, only supported public-client grant types, no client secret required, request limits across servers, expiry/cleanup, registration alone gives no access |
| Return addresses | Each local-machine host spelling, changed port, exact path/query, unrelated host, username/password parts, fragment, deceptive localhost name, never using an unchecked address |
| Approval | Return after sign-in, approve/deny when signed in, CSRF, safe display of client text, changed hidden/pending request data, role/account changes before submit, configured fresh check, local-program notice |
| Extra approval check | Existing signed-in session sufficient by default; normal sign-in 2FA still enforced; app-selected users/permissions require fresh verification tied to the pending approval; missing/invalid factor cannot silently bypass the rule; only explicit app alternatives allowed |
| Single-use code | Required S256, secret format, wrong challenge/client/return/server address, expired/missing/repeated fields, code reuse, simultaneous exchange, undoing failed database work, reply failure after changes were saved |
| Key reply | Full key in top-level access_token, permissions/expiry/type/renewal token, form input, standard errors, no-store, no secrets in logs/errors/browser props |
| Client admission policy | Compatible clients may request approval by default; optional allowed-client list permits listed clients and rejects others for both client-document and registration paths; neither path bypasses client checks, limits, or user approval; registration alone issues no user key |
| Access-key lifetime | Default 15 minutes; configured duration respected; expiry enforced on ID-only reads and full-key calls; automatic renewal before the approval deadline; issued keys never outlive that deadline; existing API key lifetimes unchanged |
| Renewal | Replace secrets, preserve client/approval/server binding, only reduce permissions, default 7-day deadline from original approval and configured alternatives, no clock reset on renewal, both key and renewal refused at/after the deadline, repeat browser approval, reuse of previous or older tokens, simultaneous use, cancelling the whole renewal chain, inactive account, renewal and cancellation arriving together |
| API/MCP key checks | Valid ID on reads; full key on writes; missing secret refused for writes; malformed, unknown, wrong-secret, expired, inactive, cancelled, wrong-address keys refused; MCP POST envelope does not turn a configured read into a write; caller cannot change method classification; one matching permission is enough for a non-empty list; no match is refused; bad keys never become public callers |
| Permission lists | Existing/new keys both accept either listed permission, accept multiple matches, reject no matches, and still require correct identity/method/address/expiry; empty configured lists reject protected API requests but allow valid correct-type MCP callers; key scopes and route/tool scopes are tested separately; remaining checks still apply |
| Mixed public/protected MCP tools | Same address; protected names/descriptions visible anonymously under Q-013 while data/execution remain checked; anonymous initialization and public calls work; protected calls require proper credentials; public sessions cannot bypass checks; bad presented keys are rejected; test discovery/login and list updates after approval/renewal/expiry/disconnect |
| API route enablement | New OAuth keys refused when the route setting is absent or disabled; explicitly enabled user routes accept valid approved keys subject to all existing checks; global OAuth enablement does not enable routes automatically; application-only routes do not accept user approvals; existing API keys remain supported |
| Shared MCP/API key | Same key on approved tools/routes; wrong address or missing permissions refused; shared renewal/expiry/disconnect; suspended accounts; no invalid-key fallback or user-to-app identity conversion; trusted user data cannot be overwritten |
| Read-ID protection | Unpredictable new IDs; no exposure as public record references, logs, URLs, or browser props; hashed lookup; old read IDs fail after expiry/renewal; ID-only initialization/listing never permits writes; a failed full key cannot downgrade to ID-only |
| Saved connections | Session ID without key, different person/client/approval, renewed key for same approval, removed permissions, simultaneous calls keeping separate identities, handlers retaining old identity |
| Connection methods | Inside app or standalone HTTP, saved or per-request sessions, supported POST/GET/DELETE, older SSE if enabled, browser Origin/CORS/header rules, STDIO still working |
| Existing apps | OAuth off, public tools, old app/user keys under the chosen upgrade rules, browser sign-in/2FA/account pages, existing API key replies |
| Detailed contract additions | Required app policy listeners and narrowing validation; exchange rechecks current policy; oauth-finalize call/503 guard; exact route capabilities with global browser authorization; malformed/repeated resource invalid_target; no-store client bodies never persisted through another model; atomic client/cache capacity and source-level unknown-client rate limits; factor counter replay; code replay after short expiry; legacy record incarnation; no unknown-commit issuance retry |
| Database/package | Including both schemas, first/repeated generation, transactions on PGlite/PostgreSQL/MySQL/SQLite, CJS/ESM/types, packaged schema/view imports, imports from a consuming app |

## What People Should Experience

| Person or situation | Expected result |
| --- | --- |
| App maintainer | Turns on documented settings/schema and gets a discoverable protected server without app-specific source code |
| Signed-out person | Adds URL, signs in, keeps pending request, approves, returns to working client |
| Signed-in person | Sees declared client, permissions, and return address; approves only selected allowed permissions |
| Person needing stronger checks | Completes the configured fresh check or allowed alternative; no silent approval of stronger access |
| Person saying no | Safe return gets access_denied, state, and server identity; no usable approval is issued |
| Person using an open client | Keys renew automatically within 7 days of original approval by default; at the final deadline access stops until browser approval is repeated; app overrides work; no copied key or deadline extension |
| Person disconnecting a client | Own approval is cancelled; next MCP call, API request, and renewal fail; other approvals still work |
| Suspended person | Existing key and renewal are refused under the configured account rules |
| Person facing an unsafe client | Sees a normal local error and a way to retry; browser is not sent to an unchecked address |
| Person using both MCP and API | Approves once, uses the same key for permitted tools and API routes, and gets refused elsewhere |
| Existing app user | Browser and old API use still follow the agreed upgrade behavior |

The complete actor/state matrix and scenario walkthrough is in [journeys](journeys.md).
These remain production implementation requirements. Proofs exercise several
mechanisms and native clients against explicit fixtures; they do not verify
these complete journeys against a production library implementation.

## Commands And Records To Keep

Use Node 22 and Yarn from the repository root:

```bash
yarn install
yarn session test
yarn ai test
yarn api test
yarn session build
yarn ai build
yarn api build
yarn build
```

Also test affected packages that use the changed code, and run the chosen blog
example's actual full-test command. API is now part of the required package
checks. Check that the suites exist and fill missing coverage; do not call a
missing suite a pass.

Every changed package must pass above 90% coverage, including evidence for branch
and security cases. Low existing coverage does not remove that requirement.
Keep before/after coverage, test results, import checks, simultaneous-request
results, browser records, and real-client traces with the build task records.
