# Decisions And Detailed Plan Review

Status: **Frozen, 2026-09-29.** The user instructed: “Freeze then create task files.”
This accepts G-001–G-007, their detailed technical contracts and the final choices
presented in the freeze-readiness reply. Earlier question answers retain their
original wording; this later acceptance does not rewrite their history.
The user asked us to prepare the plan and follow the repository's conventions.
The grill session is complete; [exact questions and answers](questions.md) are saved
there. Q-006 preserves empty-list behavior and completes the G-003 product
choices. Q-007 selects all four existing databases. Q-008 sets new keys to 15 minutes
by default. Q-009 sets a 7-day renewal window. Q-010 lets apps choose extra
two-factor checks. Q-011 permits compatible clients to request approval by default.
Q-012 requires apps to enable new keys explicitly for each user API route.
Q-013 permits anonymous discovery of protected names/descriptions. Authorized
[proof work](proof-results.md) now supplies evidence for G-004/G-005/G-007.

## G-001 — Where Should OAuth Keys Be Stored?

Accepted by the user in [Q-001](../../references/00022-mcp-oauth-storage-and-key-questions.md#q-001--where-to-save-the-new-keys):
add new OAuth records and database tables owned by `stackpress-session`, under
its `src/oauth/` code. Leave existing API Session records in place. The exact models/fields are now specified in the [storage contract](storage.md).

This keeps new OAuth records separate from existing API key storage. G-002
also permits the new keys on approved ordinary API routes.

## G-002 — Should The Same Keys Work On Ordinary API Routes?

Accepted by the user in [Q-002](../../references/00022-mcp-oauth-storage-and-key-questions.md#q-002--where-the-new-keys-may-be-used):
include ordinary API requests in the first release. A person can approve a client
once and use the same new key for allowed MCP tools and API routes. Disconnecting
that approval stops both kinds of access.

`stackpress-session` owns the new records and shared key checks. `stackpress-ai`
and `stackpress-api` use those checks and enforce the permissions and server
addresses allowed by the approval. This expands planned implementation to all
three packages. Existing API keys remain supported; their security-upgrade rules
are still under G-003. Existing API login replies are not changed by this answer.

The earlier MCP-only recommendation was not chosen. G-007 records the remaining
technical design for a key that covers both MCP and ordinary API routes.

## G-003 — What Happens To Existing Keys And Public Tools?

Read/write direction recorded from [Q-003a](../../references/00022-mcp-oauth-storage-and-key-questions.md#q-003a--which-keys-keep-the-current-rule):
adapt the existing Stackpress rule for new OAuth keys as well as existing keys.
Reads (`GET`) may use the ID alone; other operations require `id:secret`.
The earlier full-secret-for-all and new-keys-only suggestions were not chosen.

For ordinary API routes use the request method. For MCP use the configured tool
method: an HTTP POST carrying a read tool call is still a read operation. The
caller cannot choose or override this classification. Initialization/listing may
use a valid read ID, but it must not permit later write calls without the secret.
OAuth continues to return the full key in `access_token`; normal clients can
send it for either kind of operation. All requests still undergo expiry,
account, permission, address, and disconnect checks.

An ID that grants reads must be treated as a read-access credential. Protect new
OAuth IDs accordingly. This is an intentional difference from the source app's
full-secret requirement, not a claim that its original security rule is preserved.
Do not fall back from a failed OAuth check to another credential store.

Accepted in [Q-004](../../references/00023-mcp-oauth-permission-and-public-tool-questions.md#q-004--matching-a-list-of-permissions): for a
non-empty route/tool permission list, any one matching permission is enough.
Keep this rule for existing and new keys. Identity, method, expiry, allowed
addresses, and account checks still apply. The earlier all-permissions proposal
was not chosen; a new all-permissions setting is not part of this decision.

Accepted in [Q-005](../../references/00023-mcp-oauth-permission-and-public-tool-questions.md#q-005--public-and-protected-tools-at-one-address):
public and protected MCP tools share one address. Access is decided per tool.
Public tools work without a key; protected tools require the appropriate key
and permissions. The earlier separate-address proposal was not chosen.
P-002/P-004 demonstrate mixed-tool SDK discovery and first-call login. Native
client fixture checks also pass; automatic permission escalation remains a
separate failing case under G-005. An invalid presented key does
not become a valid anonymous identity by selecting a public tool.

Accepted in [Q-006](../../references/00023-mcp-oauth-permission-and-public-tool-questions.md#q-006--empty-permission-lists): preserve empty
permission-list behavior. Protected API routes refuse access; protected MCP
tools accept a valid key of the correct caller type. The list in question is
the route/tool's configured list, not the list stored on the key. Method,
account, expiry, allowed-address, and disconnect checks still apply. Neither
an empty list nor any-match makes a protected operation public.

G-003's product choices are answered. The [legacy upgrade contract](storage.md#upgrade-existing-mcp-keys-explicitly)
now spells out source G-013's service binding: existing ordinary API keys continue
as before; selected old MCP keys require explicit binding and hardened checks
when OAuth is enabled. This enabling-time change is accepted by the later Freeze instruction; it is
not retroactively attributed to an earlier question answer. Tests and migration notes remain required.

## G-004 — Which Databases And Server Environments Will We Support?

Accepted in [Q-007](questions.md#q-007--databases-for-the-first-release): the first
release targets PGlite, PostgreSQL, MySQL, and SQLite through the existing
Stackpress/Inquire adapters. The earlier two-database option was not chosen.
The blog's PGlite setup remains the default end-to-end example, not the only
required database test. Do not silently defer an accepted adapter after a failure.

Use the repository's Node 22 baseline for verification. This does not add a
promise about Bun, Deno, edge runtimes, or unspecified Node versions. All current
in-scope HTTP connection modes still need their own tests.

P-001 inspected the complete published transaction/connection implementations
and proved the candidate on all four real engines. G-004's feasibility question
is answered, with a required Inquire prerequisite: exclusive transaction
connection ownership and serialization of every query on a shared embedded
resource. Current shared adapters fail overlapping-transaction and unrelated-query
isolation checks. Session's store can use the tested approval-row write lock.
See [proof results](proof-results.md) and the database report for boundaries.
This does not claim the unmodified adapters or generated production stores pass.

## G-005 — Will Every Supported MCP Connection Enforce The Same Rules?

P-002 reproduces stale identity in existing saved HTTP/SSE sessions and missing
attached HTTP methods. Candidate standalone/attached and saved/per-request HTTP
checks use the actual SDK and Ingest; current identity, renewal, expiry,
disconnect, concurrency, GET/DELETE, and list notifications are exercised.
Corrected older SSE also passes standalone/attached checks. Its current attached
path incorrectly merges query fields into JSON-RPC; pass body-only req.post().
Unknown tools must be rejected before method classification; DELETE and
unclassified controls require a full key. No Ingest upstream defect was
established. See the [transport findings](proof-results.md#transport-findings)
for error timing, older-SSE coverage, and remaining integration limits.

Evidence settles the error boundary: 401/403 before SDK headers; after streaming
starts, return a protocol error and perform no effect. It cannot become a new
HTTP challenge. SDK 1.29.0 can refresh unchanged permissions after 403 and then
stop without opening approval; older SSE does not start OAuth for 403 at all
in the tested path. Do not broaden grants to work around this;
automatic permission escalation cannot be promised. The detailed
[recovery contract](recovery.md) uses explicit native logout/login, fresh approval
and a new MCP session. It specifies 401/403, late protocol errors and safe retry
boundaries. The user accepted this fallback at Freeze.

Accepted in [Q-013](questions.md#q-013--protected-tool-names-before-sign-in):
anonymous clients may discover protected tool names/descriptions. Protected
execution/data still require approval and the agreed checks. An initially
anonymous saved session may bind once to the first verified person/client/approval,
then reject other identities. The [recovery](recovery.md) and [storage](storage.md)
contracts define public metadata projection and distributed generic notifications.
Names/descriptions are public; full protected input/output contracts appear only
after permission checks. The proof used simple schemas; realistic relisting and
production distribution remain release checks.

## G-006 — Which Defaults And App-Supplied Rules Will We Offer?

Require keys and approvals to expire. Let apps choose permissions, account
checks, and when to ask for fresh identity verification. Do not hardcode roles.
Access and renewal durations and extra approval checks are now chosen below.
Client policy is chosen below. The accepted technical contract is in
[configuration](configuration.md), [events](events.md) and [storage](storage.md):
exact fields/defaults, named policy contracts, protocol routes, startup finalization,
public exports, pending approval and factor replay, safe metadata and shared limits.
The required app policy listeners explicitly authorize scopes and current access;
the library does not guess role mappings. Numeric operating limits other than the
accepted lifetimes are accepted engineering defaults, not requirements imposed by standards.

Accepted in [Q-008](questions.md#q-008--how-long-an-access-key-lasts): new OAuth
access keys last 15 minutes by default, configurable by the app. Clients renew
automatically while approval is still valid. Existing API key lifetimes are not
changed. Apply expiry to both ID-only read access and full-key access.

Accepted in [Q-009](questions.md#q-009--when-browser-approval-is-needed-again):
renewal lasts 7 days from the original browser approval by default, configurable
by the app. Renewing a key does not restart the clock. Disconnect can end access
earlier. At the deadline, renewal and remaining access stop; a new browser
approval is required. An access key may never outlive that deadline, so its
remaining lifetime near the deadline is shorter than the usual 15 minutes.

Accepted in [Q-010](questions.md#q-010--an-extra-two-factor-check-at-approval):
use the existing signed-in session by default and retain normal sign-in checks.
Apps can require a fresh factor check for selected people or permissions.
Stackpress supplies the check without hardcoding an ADMIN role. If an app
requires a check that cannot be completed, do not silently skip it; any different
approval path must follow an explicit app rule.

Accepted in [Q-011](questions.md#q-011--which-clients-may-ask-for-approval): when
an app enables OAuth, any compatible client may request approval by default.
Apps can restrict clients with an allowed-client list. Client checks, safe
metadata fetching, request limits, and user approval still apply. Registration
alone grants no access. Apply the policy to both supported ways clients identify
themselves; fetching a client document cannot bypass an app's allowed-client list.

G-001 settles key storage. G-002 includes API support. G-003 preserves the
selected existing access rules.
G-004 has passing feasibility evidence and a required upstream fix. G-005 now has
a concrete recovery proposal and remaining production tests. G-006 public contracts
are complete and accepted at Freeze.
These choices do not require changing the source application's Frozen spec.

## G-007 — Which Server Addresses Does A Shared Key Cover?

New from the accepted API support in Q-002. The earlier design bound every key
to one MCP address. A key used for both MCP and API needs an explicit definition
of the addresses it may access, consistent with client discovery and approval.

P-004 and the native-client fixture runs establish a workable mechanism: one
declared service named by the MCP server's exact canonical URL, with an explicit
saved list of approved API operations. Both surfaces validate that service and
membership independently of permissions. Discovery, approval, exchange, and
renewal use the same resource. Neither common hostname nor path prefix grants
access. New route membership needs new approval; renewal preserves the saved list.
G-007's mechanism is evidence-resolved for the plan. Production must bind members
to trusted route definitions, including generated/parameterized routes, and
rerun the tests through actual API/session handlers. The [configuration contract](configuration.md)
now defines stable operation IDs, exact resources and trusted descriptor fingerprints
covering method/template/event/fixed data/scopes. Changes require new approval. See [combined proof findings](proof-results.md).

Accepted in [Q-012](questions.md#q-012--which-existing-api-routes-accept-new-keys):
apps explicitly enable new OAuth keys for each user API route using route
configuration. Turning OAuth on does not add support to existing user routes
automatically. Keep approved-address, permission, and other key checks, plus the
user-versus-app distinction. Existing API keys remain supported. The exact new
field is `oauth: { operation, resources }`, as detailed in the accepted configuration contract.
The shared-service representation above is supported by proof evidence.

## Planning Closeout And Freeze

The user authorized remaining planning on 2026-09-28 and Freeze/task creation on
2026-09-29. This later instruction accepts the reviewed contracts, including
explicit legacy-key service bindings, required named app policies, protected-name
visibility with private schemas, and explicit reapproval when more access is needed.
All seven library topics are answered; there are no unresolved Freeze blockers.
Earlier “draft/review/proposed” descriptions below record their planning origin;
the [freeze record](freeze.md) records acceptance without inventing earlier answers.

The [journey audit](journeys.md) covers five features, eleven actor states, all
55 combinations and fourteen goals/journeys. Research R-001–R-007 is complete.
P-001/P-004 establish candidate feasibility. P-002's automatic escalation failure
has the accepted explicit-reapproval fallback. Complete P-003 production execution
is deferred to the required post-implementation release task. No release check
is waived or falsely marked passed. Inquire remains the first database prerequisite.

Stable accepted ownership/access rules are promoted to
[shared interface guidance](../../context/interfaces-and-experience.md).
Detailed field contracts, task order and prototype evidence remain spec-local.
The task plan is accepted for creation from the reviewed six-stage sequence;
implementation has not begun and no task acceptance is delegated.

## How The Source Application's Decisions Apply Here

The IDs below belong to application spec 00032, not the seven library questions
above. Its exact wording is preserved in the [saved decisions](../../resources/00005-mcp-native-oauth/resourcing-spec-00032/decisions.md).

### Source G-001 — How Clients Introduce Themselves

Keep both methods: prefer an HTTPS client document and fall back to registration.
Neither needs a client password. Keep the required URL path, exact client ID,
no redirects or private network targets, proposed 5 KiB response limit, HTTP
cache rules, no saved errors, request limits, and unused-registration expiry.
Make operating limits configurable and shared across servers where needed.
Introducing a client never gives it access to a person's data.

### Source G-002 — Proof That This Client Started The Login

Require S256 PKCE, save the challenge, and tell clients it is supported. Test
both the secret's format and whether it matches the original request.

### Source G-003 — The Approval Page

The source reuses its page and accepts response type, state, challenge, and
resource; it allows a separate page if needed. Reuse Stackpress sign-in and page
patterns, but propose a separate session OAuth address so it does not take over
the existing API page.

### Source G-004 — Allowed Return Addresses

Keep exact address matching except for the port on the client's own machine.
Support explicitly registered `localhost`, `127.0.0.1`, and `::1` addresses.
They are separate hosts, not interchangeable names. Paths and queries stay exact.

### Source G-005 — Where The Reply Puts The Key

New client login and renewal put the full `id:secret` in `access_token`. The
source keeps `access_key` for its helper and postpones changing old website
replies until a coordinated library fix. Here, that extra field is optional for
compatibility. Existing API login replies stay as they are; library G-002
adds acceptance of new keys, not a change to old login reply fields.

### Source G-006 — Which Server The Key Is For

The source uses `<origin>/api/mcp`, publishes both address-specific and root
documents, defaults a missing resource to that address, and still accepts the
key on ordinary API routes. Make the library's address configurable. Publish
its specific document; offer a root alias only when its meaning is clear.
A missing resource may default to the only configured address, never a guessed
one. Library G-002 accepts ordinary API support; G-007 must settle which
addresses the shared key covers without weakening these checks.

### Source G-007 — Administrator Time Limits

The source gives ADMIN keys 15 minutes and renewal up to 24 hours. Those remain
app-specific role rules. Separately, the user chose a configurable 15-minute
library access-key default in Q-008; this does not hardcode ADMIN behavior.
Q-009 separately selects a configurable 7-day library renewal window, without
a special ADMIN default. Renewal must never extend the original final deadline.

### Source G-008 — Connected Clients

The source puts each client under the person's existing Agent access entry and
uses the same disconnect list. Provide a general list-and-disconnect feature
without requiring that grouping or name. Library G-001 assigns new storage
to session.

### Source G-009 — Error Pages And Replies

Unknown clients and unsafe return addresses get a normal page on our server.
After validating the return address, send errors back with the original state
and server identity. Include that identity on successful returns too.

### Source G-010 — Existing Access Rules And Other Ways To Sign In

Keep key format, permission limits, expiry, renewal, reused-token detection,
disconnect, connected-client listing, checks on every call, and hashed secrets.
Library G-003 intentionally differs by allowing the ID alone for reads, as the
user requested. It must protect that ID as a read-access credential.
The source also keeps device login, WorkOS login, and its helper. Those app
features do not already exist in this library and are not automatically included
in this work. Keep ways to add them, and test the old behavior if porting them later.

### Source G-011 — Name The Server On Return

Include `iss` on every validated success/error return and advertise that support.
This also preserves the exact return paths clients expect. Set the trusted server
address in configuration rather than taking it from request headers.

### Source G-012 — What The Approval Page Shows

Show the declared client name, its document's host, the return-address host, and
a note when access goes to a program on this computer. Use translated text and
safely display client-supplied text. A declared name does not verify its publisher.

### Source G-013 — Keys From Other Login Methods

The source adds a server address to device/WorkOS keys, rejects website keys at
MCP, and temporarily accepts old agent keys during the update. If the library
must consume existing keys, plan that conversion and the connecting code
explicitly. New approvals always name a server. Do not permanently accept keys
with no server address.

### Source G-014 — Which Permissions Clients See

The source names three read permissions, omits `offline_access`, narrows approval
by role, and returns 403 with the missing permission. Use app-configured
permissions and approval limits, not those three fixed names. Keep accurate
error replies and report the permissions actually granted. Test when the SDK
can send the required HTTP response.

### Source G-015 — Fresh Two-Factor Check

The source asks administrators for a fresh 2FA code and permits a user-key
fallback only when no verified factor exists. Provide an app rule that can reuse
the existing verification feature. Apps can reproduce that behavior without
the library assigning it automatically to a role name.

### Amendment A-001 — Admin Access To OAuth Records

Approved by the user on 2026-10-15, after Freeze, during task 00003. Task 00003's
generation check found that Stackpress builds admin pages for every model in the
app's schema. The admin menu config only controls which links appear; the pages
stay reachable by address. No per-model opt-out exists, and the user chose not to
change the maintainer packages (admin, schema, SQL, view, AI). The AI package
only exposes tools listed in `mcp.tools`, and API routes are opt-in by config, so
those stay closed by default.

The user noted that admins can already open and edit the Auth, Application and
Session records, which hold the existing API keys and sessions. OAuth records add
no new power. The original "no generated admin exposure" rule is therefore relaxed:
OAuth admin pages are treated like those existing records. They are reachable only
by roles the app's access rules allow, not added to the default admin menu, and
must not display hash columns. Apps that want them fully hidden can filter the
models out with an app-level transformer later. Raw secrets and hashes remain
excluded from views, event output, logs and errors (design.md). Changed files:
storage.md and configuration.md.

## Fit With Existing Repository Rules

Choose files by which package owns the job. Keep events separate from reusable
scripts, use the existing startup phases, build both module formats, and require
above-90% test coverage for changed packages.

OAuth currently uses the API's application/session records. Moving that code
would require a separate upgrade plan and updates to accepted project guidance.
The accepted optional session feature leaves that existing ownership in place.
At Freeze, shared interface guidance gained the stable approved direction, clearly
labelled unimplemented. Current runtime claims and unrelated Frozen specs remain
unchanged; exact implementation facts require verification before promotion.
