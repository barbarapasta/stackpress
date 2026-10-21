# How We Will Build It

New session-owned records and ordinary API support are accepted under
G-001/G-002. G-003 keeps IDs for reads, full keys for other operations, and
any matching permission for non-empty route/tool permission lists. Q-005 keeps
public and protected MCP tools at one address.
The user accepted and froze this design on 2026-09-29. The detailed contracts are
in [configuration](configuration.md), [events](events.md), [storage](storage.md),
and [recovery](recovery.md). These define what to build; they do not claim the
implementation has shipped. [Journeys](journeys.md) records the coverage walkthrough.
The [brief](brief.md#a-few-names-used-in-the-code) explains the main terms.

## Keep Each Job In Its Owning Package

Add `packages/stackpress-session/src/oauth/` beside `auth/`, `profile/`, and
`session/`. Give it focused files. Do not add all OAuth work to the browser JWT
`Session` class or one large helper file.

The accepted storage choice uses new session-owned records. Accepted model
names include `OAuthClient`, `OAuthGrant`, `OAuthCode`, and
`OAuthRefreshToken`, declared in `oauth.idea`; the complete [storage contract](storage.md)
adds pending requests, document caching, rate limits, factor replay and legacy bindings. That file may include the existing
session schema to connect approvals to profiles. Test that an app can include
both schemas without creating duplicate models. Leave the API's `Application`
and `Session` models in place. This lets session provide OAuth without needing
API, which already needs session.

Keeping the keys in existing API Session records was considered and not chosen
in Q-001. G-002 now includes ordinary API routes through an explicit connection
to session. This adds work in `stackpress-api` without changing the accepted
storage ownership or the existing API login reply format.
The first release must work through all four existing database adapters:
PGlite, PostgreSQL, MySQL, and SQLite, as accepted in Q-007. Use a common storage
interface with tested adapter behavior; do not ship only a memory-backed stub.
Use Node 22 for the repository checks. Additional databases or server runtimes
are not promised by this decision.

AI and API should ask a named session event to verify an OAuth caller. Session owns the OAuth
types; declare any dependency AI needs. Do not make session import AI or API to
handle MCP connections. AI can keep using API for existing app/session keys.
Give OAuth callers their own type rather than treating an approval as an API row.
API must distinguish new OAuth keys from existing app/session keys without
falling back to weaker checks when an OAuth key fails verification.

## One Approval For MCP And API

A person may approve a client for both MCP tools and ordinary API routes. The
same key works only where that approval permits it. Both packages use session's
checks for the ID, any required secret, account, expiry, and cancellation, then
check the requested
operation's permissions and allowed server address. Disconnect ends both paths;
renewal follows the same approval and cannot add access.

P-004 establishes the candidate representation: one service identifier equal to
the canonical MCP URL, plus saved membership of explicitly approved API operations.
Show that membership during approval; check it independently of permissions and
the route's OAuth setting. New routes require new approval and renewal cannot
expand the list. Production members must reference trusted route definitions,
including methods and generated/parameterized routes. Do not accept an MCP-only
key on arbitrary API routes or replace these checks with hostname/path matching.
API must pass verified user information to events and reject attempts to replace
it through request input. Under Q-012, apps enable new OAuth keys explicitly for
each user route; merely turning OAuth on does not enable existing routes.
A user-approved key must not silently become an application-only identity.

## Where The Files Go

In this table, session means `packages/stackpress-session` and AI means
`packages/stackpress-ai`.

| Location | Job |
| --- | --- |
| session `src/oauth/types.ts` | Types for settings, clients, approvals, key replies, app rules, and storage |
| session `src/oauth/plugin.ts` | Check settings, set up services, register events, and connect pages to views |
| session `src/oauth/scripts/` | Look up clients, check requests, exchange codes, renew/check keys, and cancel access |
| session `src/oauth/events/` | Read Ingest requests, call scripts, and apply app-supplied rules |
| session `src/oauth/pages/` | Serve discovery documents, registration, approval, keys, cancellation, and connected-client pages |
| session `src/oauth/views/` | Show approval and connected-client pages using existing view patterns |
| session focused classes in `src/oauth/` | Save records in the database and fetch/save client documents with limits |
| session `oauth.idea` | Declare optional models; generate code from this file |
| AI `src/scripts/` | Tell clients how to sign in and check access at the connection level |
| AI `src/helpers.ts`, `src/types.ts`, `src/plugin.ts` | Handle verified callers, tool permissions, trusted event input, and fresh checks on calls |
| AI HTTP/SSE scripts | Apply the same checks when MCP runs inside the app server or on its own |
| API `src/plugin.ts`, `src/helpers.ts`, `src/types.ts` and focused scripts/events as needed | Accept new keys on approved API routes, call session checks, enforce route permissions, and keep existing key support |

Names are examples. Name files for their operation and follow nearby package
conventions. Set up services during `config`, register reusable operations during
`listen`, and add pages/views during `route`. MCP running on its own must serve
its own discovery documents because it does not use the app's routes.

Events read request data, find plugins, and set results/errors. Scripts do the
reusable work with dependencies passed in. Pages handle requests and pair with
TSX views. Fixed library events include `oauth-token-verify`, `oauth-code-exchange`,
`oauth-refresh`, `oauth-revoke`, and `oauth-grants-list`. The [event contract](events.md)
defines their inputs/results and the required named app-policy hooks.

## Settings Apps Would Supply

Accepted `session.oauth` settings:

- The trusted login-server address (`issuer`) and endpoint paths. Require HTTPS
  except in a documented local development mode. Do not trust arbitrary Host
  or forwarded headers to choose that address.
- Allowed tool-server addresses (`resources`) and permissions, including the
  labels and descriptions people see on approval pages.
- Under Q-011, any compatible client may request approval by default, with an
  optional allowed-client list applying to both client documents and registration.
  Client checks and user approval remain required; registration grants no access.
- Rules for client registration and for fetching/saving client documents:
  timeouts, size limits, unused-registration expiry, and request limits.
- New OAuth access keys last 15 minutes by default, configurable by the app
  (Q-008). This includes ID-only read access. Renewal is allowed for 7 days from
  original approval by default (Q-009), configurable, with no reset on renewal.
  Access and renewal stop at that deadline. Code expiry is a separate setting.
  Apps can shorten approval or narrow permissions. Q-010 reuses the signed-in
  session by default and lets apps require a fresh factor check for selected
  users/permissions, without changing normal sign-in requirements.
- The existing database plugin and named app-policy events for approval/current
  access, plus browser ownership rules for listing and cancellation.

Accepted `mcp.oauth` settings:

- Whether OAuth is on and the exact tool-server resource. Resolve issuer, scope
  declarations and the fixed verifier from session, avoiding duplicated settings.
- Checks that the MCP route matches that address and that the key-check event
  and discovery services are available.
- Per-tool access at one shared MCP address, as accepted in G-003/Q-005.
  Public tools work without a key; protected tools keep their key/type/permission
  checks. Do not require a key for every call simply because OAuth is enabled.

API settings must identify routes that accept new keys, their required
permissions, and the allowed server address under G-007. Reuse existing route
configuration where it fits; document any new fields and validation. Q-012
requires explicit enablement for each user route. An omitted or disabled setting
refuses new OAuth keys while preserving existing API key support. The exact
field is now defined in [configuration](configuration.md): `oauth.operation`
and explicit `oauth.resources` on existing API `type: session` routes.

Do not advertise Resourcing's three permissions or `offline_access` for every
app. Tell clients renewal is supported through the supported grant types, then
issue renewal tokens according to the app's rules. Do not hardcode ADMIN/USER
roles or the source app's 24-hour approval rule. The 15-minute access-key and
7-day renewal defaults are configurable, as accepted in Q-008/Q-009. Show
role-specific limits as examples.

## Saving And Checking Keys

Use the accepted `id:secret` key format and return the whole value in the
`access_token` field at the top of the JSON reply. The ID alone may authorize
reads under G-003; other operations need the full `id:secret` value.
Generate new OAuth IDs and secrets with secure randomness. A read ID must not
be an exposed database record identifier: treat it as a read-access secret.
The storage contract keeps a separate stable approval reference, stores a
hash for read-ID lookup, and replaces the read ID as well as its secret on access
key renewal. Old read IDs must expire and must not regain access after renewal.
Keep them out of logs, ordinary lists, URLs, and browser props. This does not
require changing the format of existing legacy record IDs.

Generate secrets with secure randomness. Save only hashes of new key secrets,
login codes, and renewal tokens. Keep both hashes and raw secrets out of views,
generated admin screens, ordinary event output, logs, and errors. Return new
secrets only through the intended key-issuing response.

Each approval record needs the person, client, approved permissions, exact server
address, key expiry, final renewal deadline, active/cancelled state, and facts
needed to check the app's rules later. Each code needs its client, exact return
address, S256 challenge, server address, approval record, expiry, and whether it
was used. Save renewal-token history for that approval until its deadline, so
reuse of any older token can be detected, not just reuse of the previous token.

Using a code and creating its keys must succeed together or fail together.
Check the client, approved return address, server address, expiry, and PKCE
secret. Reject badly formed or repeated request fields. Cancel that grant after a real used code is replayed with valid bound client,
redirect, resource and PKCE. Invalid guesses cannot cancel someone else's access;
retain consumed-code evidence until the grant deadline.

Renewal must use up the old renewal token and replace both secrets together.
It must not extend the original final deadline, add permissions, or add server
addresses. New keys normally last 15 minutes (or the configured duration), but
must expire no later than that final deadline. Existing API key lifetimes stay
as configured. Reuse of an old renewal token cancels that approval's whole chain of
renewal tokens. Cancelling access disables both the key and renewal. Check that
the person is still allowed access whenever checking or renewing a key.

Every database change in one transaction must use that transaction's exclusively
reserved connection. P-001 proves current shared Inquire adapters allow overlapping
transactions and ordinary queries to interfere. Add connection ownership and
shared-resource serialization in Inquire before relying on it for OAuth.
The candidate first writes the approval row to lock it, then reads and updates
its mutable state. Replay cancellation must commit before returning an OAuth
error; throwing inside the callback would roll it back. Reading a row and
updating it separately can fail when two requests arrive at once. Prove the operation is safe for each supported database driver. If a
shared database operation is missing, address it in Inquire; do not copy the
app's PostgreSQL-only locking queries into supposedly portable library code.

## Clients And The Approval Page

A client may identify itself with an HTTPS document at a path other than `/`.
Require an exact matching `client_id`, required fields, valid return addresses,
and login method `none` for clients without a password. Never follow a document
redirect. Limit fetch time, decoded size (default 5 KiB), saved document count,
and how long each copy is kept. Follow HTTP cache headers and never save errors.

Do not fetch private, local, or reserved network addresses, including IPv6 and
IPv4 addresses written in IPv6 form. Connect to the address that was actually
checked. Otherwise a host could pass the first check and change its DNS answer
to send the connection into a private network.

For clients that register by sending a description, accept only supported fields
and public-client behavior. Limit request size/rate, return an ID without access
keys, and remove unused registrations after expiry. Registration never means a
person has approved access. Limits across several servers need shared storage;
a counter kept in one running process is insufficient.

Require `response_type=code`, S256, an allowed server address, and approved
permissions. Return addresses must match exactly, except the port for explicitly
allowed HTTP addresses on the client's own machine. Register `localhost`,
`127.0.0.1`, and `::1` separately. Reject username/password parts, fragments
(`#...`), deceptive hostnames, wildcard addresses, and changed paths or queries.
Keep the chosen return address unchanged when exchanging the code.

Use `me` and the existing sign-in return flow. Save the pending approval on the
server so it survives sign-in and two-factor checks. Hidden form fields cannot
be the authority for what gets approved. Protect the browser form against forged
submissions (CSRF); the OAuth `state` field does not replace that check.

Show the declared client name, its document host when available, the return
host, permissions, and a note when the return address leads to a program on
this computer. A client name alone does not prove who published it. Display all
client text safely so it cannot insert HTML or scripts.

Check the client and return address before redirecting anywhere. Unknown clients
or unsafe addresses get a normal local error page. Once an address is safe,
denial and protocol errors go back with the original `state` and `iss` (the
login-server identity). Success returns `code`, `state`, and `iss`. Let app rules
decide when to ask for a fresh identity check, reusing existing verification.
Under Q-010, no extra check is added by default. An app-required check must pass
or use an explicitly configured alternative; never skip it because no factor
is available. Bind any fresh check to the person and pending approval request.

## What Clients See And What MCP Checks

Session's discovery document lists the endpoints that work, `code`, the
`authorization_code` and `refresh_token` grant types, login method `none`, S256,
permissions, client-document support, and support for `iss` on return. List
features only when they are configured and usable.

Key and error replies use the standard fields at the top of the JSON object,
with `Cache-Control: no-store` and correct HTTP status/content type. Do not wrap
them in Stackpress's usual results object. Accept standard form requests for
keys/cancellation and JSON for registration. Browser approval uses a separate
form protected against CSRF.

Public and protected MCP tools share one address. A caller without a key must
be able to initialize a connection and use public tools. Protected operations
still require the current operation's proper credential. An MCP session created
anonymously must not bypass that check. A presented invalid key is rejected;
it does not silently turn into anonymous access.

Under Q-013, anonymous lists may include protected tool names/descriptions.
Execution still requires approval. P-002/P-004 exercise first protected-call
OAuth with the SDK; list changes are carried by real notifications in the
candidate. Actual grant-change scheduling and distribution remain to build.
P-003 proves native CLI fixture login but not every client's automatic UI flow.
The [recovery contract](recovery.md) defines explicit fresh approval after 403;
automatic permission upgrades are not promised. Never widen a refresh grant.
Anonymous protected catalog entries omit private schemas; approved clients relist
for full contracts, including required arguments. Test realistic schemas in production.

AI serves the RFC 9728 discovery document at the tool address's well-known path.
Add a root alias only when it clearly refers to that same server. A protected
request without a key gets HTTP 401 and a Bearer header with `resource_metadata`
pointing to the document. A bad key must not be treated as an anonymous public
caller. Missing permissions get HTTP 403 and `insufficient_scope` naming what is
needed, where HTTP can still send that reply. P-002 proves that a refusal after
streaming starts must be a protocol error inside the existing response, with
no protected effect. The next request gets the normal fresh HTTP check.

On every protected request, check the ID and the secret when required by the
operation, whether the approval and
person still qualify, expiry, cancellation, the issuer where relevant, and the
exact allowed server address. Under Q-004, any one matching permission from a
non-empty route/tool list is enough. Do not silently change this to requiring
every listed permission. Q-006 preserves empty-list behavior: protected API
routes reject the request; protected MCP tools allow a valid key of the right
caller type with the other checks still enforced. A shared verifier must not
flatten these different package rules into one default.
Check again when starting the tool, so an open connection cannot keep expired
access. Set trusted person/client/approval/permissions after caller input and
reject attempts to replace those values.

For API reads (`GET`), accept a valid read ID; other methods require the full
key. For MCP, use the tool's configured method, not its outer HTTP envelope:
read tool calls may arrive over POST. Apply that rule at tool dispatch and tool
visibility as appropriate. A valid ID may initialize/list read tools, but cannot
establish write authority. Renewed or cached MCP sessions never replace the
credential required on the current operation. Keep unknown/control operations
without a safe read classification protected by the full key until specified.
Check a supplied full key rather than ignoring a bad secret; never downgrade a
failed full-key request to an ID-only request. These details need tests.

An MCP session ID remembers a connection; it does not prove access. An initially
anonymous session binds once to its first verified person, client, and approval.
For Streamable HTTP, close the earlier anonymous notification stream at that
transition. Older SSE keeps its existing reply channel so the native client can
continue; every protected reply requires a freshly verified POST. Unsolicited
protected events or replay need their own fresh authorization before delivery.
Thereafter tie requests to the same verified person, client, and approval. Reject reuse by someone else, absent
keys, or a browser cookie presented without an MCP key. Accept a renewed key for
the same approval after fresh permission checks. Do not keep checking against
the old secret or let tool handlers use the old permissions they captured at
setup. Do not share changeable identity data between simultaneous requests.

For attached handlers, pass body-only req.post() into the SDK; req.data() can
merge query parameters into JSON-RPC and fail its strict schema. Reject unknown
tools before deciding whether ID-only read access is sufficient.

Apply these rules to POST and supported GET/DELETE requests, both inside the
app server and on a separate MCP server. Apply them to older SSE connections if
OAuth is supported there. Unsupported combinations must fail clearly at startup,
not open an unchecked path. STDIO keeps using credentials from the environment
or local process. The [recovery contract](recovery.md) defines browser origins, CORS and visible
response headers; [configuration](configuration.md) rejects transport route collisions.

## Imports, Packaging, And Existing Apps

Expose selected types through `types.ts`/`index.ts`. Update package `exports` and
`typesVersions`, include `oauth.idea`, and build CJS, ESM, and type declarations.
Only add imports through the main `stackpress` package deliberately. Its plugin
does not currently register AI; do not change that automatically.

Apps must opt into OAuth. Preserve existing sign-in addresses and browser-cookie
behavior. Prefer new OAuth routes so API `/auth/oauth` keeps its current handler.
Existing API login replies stay unchanged. API also accepts new OAuth keys
under G-002, while keeping existing key support with the security changes
settled in G-003. Document upgrades, defaults, invalid
settings, database changes, when people must approve again, and security changes
that affect existing callers.

The [legacy upgrade contract](storage.md#upgrade-existing-mcp-keys-explicitly)
requires selected old MCP keys to receive explicit service bindings before OAuth
is enabled, with hardened legacy verification. This enabling-time change was
accepted at Freeze; it does not change ordinary legacy API replies.
