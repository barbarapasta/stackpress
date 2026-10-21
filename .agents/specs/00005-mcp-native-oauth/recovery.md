# Connection Errors And Getting Back In

Frozen contract for G-005, accepted 2026-09-29. Based on the executed [transport and client results](proof-results.md).
The first release supports discovery, browser approval, automatic renewal while
approval is valid, and explicit reapproval. Do not promise that every client opens
its browser automatically or that a 403 automatically asks for more permission.

## Replies And Next Steps

| Situation before dispatch | Reply | Recovery |
| --- | --- | --- |
| Protected operation without a key | 401 with Bearer `resource_metadata` | Client starts native login |
| Malformed, expired, cancelled, wrong-resource or replaced key | 401, `invalid_token`, discovery challenge | Renew if possible; otherwise approve again for the correct service |
| ID only on a write/control operation | 401, `invalid_token`, safe explanation that the full key is required | Send id:secret; extra scopes do not fix this |
| Valid key lacks any acceptable configured scope | 403, `insufficient_scope` | Explicitly request an allowed scope and approve again |
| Scope exists but approved API membership is absent/changed | 403, `access_denied`, safe reapproval instruction | New approval must include the current operation; renewal cannot add it |
| Valid key is for a different bound person/client/grant | 403, `session_identity_mismatch`, no scope challenge | Initialize a new MCP session; do not destroy the other session |
| Unknown MCP session | 404 | Initialize again |
| Unknown tool | Reject before read/write classification; no event | Correct the tool name; candidate uses HTTP 400 before dispatch |
| Unsupported method | 405 with Allow | Use a supported method |
| Disallowed Origin | 403 without login challenge | Correct the origin configuration |
| Database, policy service or required dependency unavailable | 503, no login challenge | Retry later; do not discard credentials as if they were invalid |
| Missing, malformed, unknown or unacceptable requested resource | Authorization/token error `invalid_target` (sole configured default remains allowed) | Correct the resource request |
| Code/refresh expired, reused, cancelled or mismatched | Token endpoint 400, `invalid_grant` | Start new approval; never widen or revive the grant |

Permission challenges choose the first configured supported alternative in scope
order. Approval policy then decides whether the person may receive it; the access
policy cannot infer eligibility for scopes outside the current grant. Put just that minimal alternative in Bearer `scope`, not
all alternatives as if all were required. The safe error body may also include
`acceptable_scopes` as an advisory list; clients need not understand it. If approval policy denies every alternative, the approval page explains denial;
do not repeat an automatic upgrade loop. Do not include confidential operation data in errors.
Protected API empty scope lists deny; protected MCP empty lists still require a
valid correct-type identity. Neither uses an insufficient_scope fiction to turn
an empty list into a configurable permission.

If headers have already been sent, return an MCP protocol error with code -32001,
`reason` and `execution: 'not_started'` only when the final check prevented the
business event from being invoked. HTTP may already be 200; older SSE POST may
already be 202 with its error delivered on the GET reply stream. Never claim a
new HTTP 401/403 was sent then. This extension is advisory, not a promise clients
will understand it. Unknown execution outcome does not carry not_started.

## Asking For More Permission

The tested SDK 1.29.0 HTTP client may refresh unchanged scopes after a 403 and
then fail again; the older SSE path does not start OAuth for that 403. Correct
server errors therefore cannot guarantee automatic escalation. The fixture proves
explicit fresh approval works; final production/client journeys remain required.

Codex 0.157.0 exposes these commands, checked against installed help:

```bash
codex mcp logout <name>
codex mcp login <name> --scopes articles:read,articles:write
```

Claude Code 2.1.283 exposes:

```bash
claude mcp logout <name>
claude mcp login <name>
```

Both offer `--no-browser`. Claude's checked login command has no `--scopes` option;
it uses the configured metadata/approval flow. If scope is omitted, the server
proposes the resource's configured scopes and the app/person can narrow them.
Do not document an invented flag. Client commands are versioned examples, not
new Stackpress commands. Local logout clears local credentials; use the app's
connections page to cancel the old server approval when replacing it.

After new approval, reconnect/restart the MCP connection before repeating the
operation. A new grant requires a new MCP session, even for the same person and
client. A refreshed key for the same grant keeps its session after fresh checks.
If a client cannot complete login, show the validated authorization link through
its normal manual-login path; never ask the person to paste an access key into a
browser URL. The library does not implement third-party client UI.

A request refused before event invocation can be retried after recovery. Never
automatically repeat writes after timeout, connection loss, partial response or
an error after execution starts. A JSON-RPC ID is not an idempotency key. If the
code/refresh reply was lost after commit, replay protection may require reapproval.
That deliberate rule must be explained in docs and tested; no secret grace window.

## Request Classification And Connection Binding

Streamable saved HTTP supports POST/GET/DELETE; per-request HTTP supports POST
and returns explicit 405 for GET/DELETE. Older SSE supports its GET connection
and a separate authenticated message POST. All attached handlers pass body-only
`req.post()` into the SDK; merged query data breaks strict JSON-RPC parsing.

Anonymous initialization, initialized notification, tool listing, public tools
and the initial GET connection are explicitly safe. For protected tools, anonymous listings project only accepted names/descriptions
and a minimal protocol-required `inputSchema: { type: 'object' }`; suppress full
input/output schemas, examples, enums, defaults and other private metadata. Public
tools keep their callable schemas. Once authorized, expose the permitted protected
contracts and send list_changed so clients can relist before constructing a valid
call. The SDK publishes configured schemas by default, so implement this projection
explicitly. Test realistic required arguments: an initial protected call triggers
login before argument validation; afterward a client may need to relist/rebuild it. Later public
requests on a bound connection still require its matching credential. Presented
invalid credentials never become anonymous. Unclassified controls and DELETE
require a full key; reject unknown tools before choosing a method rule.

Carry immutable request identity through `req.auth` to SDK `extra.authInfo`, then
recheck the authoritative grant/account immediately before invoking a protected
event. Do not capture the first identity in a saved server closure or share a
mutable identity between concurrent requests. Bind anonymous sessions once to
the first verified profile/client/grant/resource. Close pre-auth Streamable GET
notification streams at binding. Older SSE retains its existing reply channel;
protected results require a fresh verified POST. Generic list-change notifications
may be coalesced; protected unsolicited events or stored replay are not enabled
without separate per-delivery authorization. No session ID grants access.

## Browser, Proxy And Local Connections

Accept native requests with no Origin. For browser requests, compare exact parsed
origins against the configured service origin plus explicit additional origins;
reject `null`, wildcard and malformed origins. Validate before SDK dispatch.
Handle OPTIONS without a bearer key but with origin/method/header validation.
Allow Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id
and Last-Event-ID only where used. Expose WWW-Authenticate, Mcp-Session-Id,
MCP-Protocol-Version and Retry-After; send Vary: Origin. Protocol bearer requests
do not enable credentialed-cookie CORS. Browser approval remains a same-origin
session/CSRF flow. Apply equivalent explicit rules to token/registration clients.

Issuer/resource URLs come from config. Reverse-proxy headers may supply network
context only under trusted application proxy rules, never rewrite issuer or
resource authority. Require HTTPS except explicit loopback development mode;
loopback client redirect exceptions are separate from service transport settings.
STDIO retains local/environment credentials; do not start browser OAuth from STDIO.

Release checks must cover configured proxies, browser CORS, production event
wiring, long-lived native clients, distribution of cancellation/list notifications,
actual account sign-in/CSRF/factor checks and real generated stores. Passing the
fixture checks does not waive any of those requirements.
