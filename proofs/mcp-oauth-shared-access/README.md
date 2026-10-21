# Shared MCP and API access proof

The candidate passed **35 checks** with Node **22.23.2**, Yarn **1.22.22**,
and MCP SDK **1.29.0**. The saved run is [results.json](results.json).
This tests a proposed design in a small local server. It does not implement or
verify the production Stackpress OAuth feature.

Run from the repository root after installing its existing dependencies:

```bash
yarn node proofs/mcp-oauth-shared-access/run.mjs
```

Use Node 22. The command writes a new results file and exits with an error when
any check fails. It starts an available loopback port, uses only invented users
and keys, and closes the server when finished. It needs no external service,
new package dependency, account, or model request.

## The design that passed

Declare one service using the MCP server's exact canonical URL as its resource
identifier. In this fixture that is `http://127.0.0.1:<port>/mcp`. Explicitly list
which API operations belong to that service. The API paths need not begin with
`/mcp`.

Each approval saves the exact resource, permissions, person, client, final
expiry, and allowed operations. The approval page shows its API operations.
Each API operation also needs its own enabled setting. Checking a key requires
both an exact resource match and membership in the saved approval. Matching a
host or path prefix grants nothing. Adding another enabled API route does not
add it to existing approvals. Renewal retains the saved list.

This follows the distinction in RFC 8707 between a resource's identity and its
individual endpoints. A service can include several endpoints, and the
resource value names the intended service. The RFC also permits a token request
to be restricted to what the person originally approved. Here there is one
resource value, with explicit server-owned membership; the server does not
silently accept a second resource. [RFC 8707 sections 2 and 2.2](https://www.rfc-editor.org/rfc/rfc8707.html#section-2)

MCP requires resource indicators in authorization and token requests and checks
that the issued token is intended for the receiving server. The fixture uses
the same exact identifier in discovery, approval, exchange, renewal, and access
checks. This is a candidate interpretation of one shared service, supported by
the protocol experiment; it is not a statement that any ordinary API can accept
an MCP token. [MCP authorization, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

The SDK's own resource selection code was used without an override. Its client
checks permit certain parent resource paths, but that is separate from the
server's access policy. This fixture does **not** use that prefix rule to decide
which API operations a key may call.

## What the tests demonstrate

| Check | Observed result |
| --- | --- |
| Anonymous SDK connection and public tool | Work at the same MCP URL as protected tools |
| Protected call without a key | SDK discovers OAuth, registers, prepares S256 PKCE, and asks for approval |
| Approval | Lists the exact service and API operations; returns the original state and issuer |
| Wrong callback host or path | Refused before any redirect |
| Wrong PKCE verifier or repeated code | Refused |
| SDK code exchange | Receives `id:secret` and a renewal token |
| Same issued key | Works on an approved MCP tool and explicitly enabled API route |
| ID without secret | Permits API GET and a configured MCP GET tool; refuses writes |
| Full key | Permits approved reads and writes |
| Incorrect full secret | Refused; no retry as ID-only, legacy key, or anonymous public caller |
| Nonempty required permissions | One matching permission is sufficient |
| Empty required permissions | Protected API refuses; protected MCP permits a valid user key |
| User key at an app-only operation | Refused, even when membership is present |
| Missing permission or inactive account | Refused on both surfaces |
| Omitted or disabled API OAuth setting | Refused, even when membership is injected independently |
| Same host, matching prefix, different service | Refused |
| API route added after approval | Refused until a new approval includes it |
| Wrong, missing, or repeated resource fields | Refused rather than guessed or silently selected |
| Renewal asks for another resource or more permissions | Refused |
| Expired access key | SDK renews automatically and retries the MCP call; no copied replacement key |
| Renewed key | Works on both surfaces with the same restrictions and final deadline |
| Old full key and old ID | Stay invalid after renewal |
| Permissions removed from the approval | Next API and MCP calls use the changed permissions |
| Approval deadline | Caps access lifetime and ends access and renewal |
| Reused renewal token | Cancels the approval's access on both surfaces |
| Disconnect | Stops both surfaces and renewal |
| Saved credentials | ID lookups, secrets, and renewal lookups are hashed |

The test of the legacy dispatcher is deliberately a **stub**. It shows that
route opt-in can apply to new OAuth credentials while selecting a separate
legacy branch. It does not establish that existing API authentication,
permissions, methods, or response formats remain correct. That requires tests
against Stackpress's actual handlers during implementation.

## Reusing the fixture

[fixture.mjs](fixture.mjs) exports `startFixture(settings)`. It returns:

- `origin`, `mcpUrl`, `resource`, and `metadataUrl`;
- `records`, `routes`, and `tools` for isolated test setup;
- `trace`, containing protocol stages without codes, keys, verifiers, or state;
- `expireAll()`, `revokeAll()`, and asynchronous `close()`.

Settings include `port` (default: an available port), `accessSeconds` (900),
`approvalSeconds` (604800), and `onTrace(entry)`. Setting
`requireAuthOnInitialize: true` creates a different login-only experiment;
the accepted mixed public/protected behavior is the default `false` setting.

The actual HTML approval form is `form[action="/approve"]`, with a hidden
`pending` field and an `Approve fixture access` button. The page clearly labels
the user as simulated. The form generates a code and redirects to the exact
registered callback with `state` and `iss`. The fixture does not run a callback
listener on behalf of a client. Its registration accepts explicit HTTPS and
loopback HTTP return addresses; it never substitutes one loopback host for
another.

Safe trace entries `mcp-accepted`, `mcp-tool-completed`, and `mcp-refused` include method, tool name,
resolved invented user, and status where relevant. They contain no approval ID
or access key. Token trace entries record grant type, resource, and whether a
verifier was present, never its contents.

[access.mjs](access.mjs) holds the candidate shared checker and in-memory
records. [run.mjs](run.mjs) drives the SDK and adversarial HTTP checks. No
production package source, package manifest, or lockfile is changed.

## Limits and implementation follow-up

This is evidence for P-004's service-membership design and SDK flow. The
production release proof still needs the actual session-owned records,
Stackpress route/tool integration, and real client results from P-003.

The fixture uses memory and deliberately simulated sign-in. It does not prove
database atomicity, user-session handling, browser CSRF protection, two-factor
checks, account policy, distributed limits, safe client-document fetching,
HTTPS deployment, or registration policy. P-001 and the implementation tests
own those checks. Dynamic registration is used here; client metadata documents
are not implemented in this fixture.

The fixture's static operations are method plus absolute URL. Production must
bind membership to the selected server-owned route definition, including method
and service, so generated and parameterized routes work without treating a
caller-supplied path prefix as permission. The final public configuration and
model field names remain design work.

The fixture keeps no MCP session between requests. Saved-session identity,
GET/DELETE, SSE, Ingest routing, concurrent calls, and stream timing belong to
P-002. Showing every tool in this fixture's list is not evidence for the final
protected-tool listing or list-change behavior.

The stored JSON contains loopback addresses and invented identifiers only.
It is a reproducible run record, not evidence of deployed software or a
completed OAuth security audit.
