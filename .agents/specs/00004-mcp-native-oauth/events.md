# Events, Identity And Approval Rules

Frozen contract for G-006/G-007, accepted 2026-09-29. Use the existing Ingest event/script/page pattern:
events read trusted inputs and set standard response fields; focused scripts do
the work; HTTP pages translate results into OAuth replies. Accepted public types
live in session `src/oauth/types.ts`. All dates in HTTP JSON are represented by
standard protocol fields; internal identity dates remain `Date` values.

## What A Verified Caller Contains

```ts
type OAuthIdentity = {
  profileId: string;
  clientId: string;
  grantId: string;
  resource: string;
  scopes: string[];
  expires: Date;
  deadline: Date;
  credential: 'read' | 'full';
};
```

AI extends `AuthContext` with `{ kind: 'oauth', identity: OAuthIdentity }`.
Its `user` tools can accept this variant. It does not create a fake API Session
or Application. Treat the result as an immutable snapshot for one request, not
as lasting authority. API/AI still apply caller type, scope and method rules.

For calls to business events, reject reserved caller fields `profileId`,
`applicationId`, `sessionId` and `oauth`, including values in configured fixed
data. Then inject trusted `profileId` and `oauth: { clientId, grantId, resource,
scopes }` after normal input mapping. Do not inject credentials or their hashes.
Existing legacy handlers keep their own identity shape. OAuth `grantId` is safe
as a connection-management reference, but never authorizes access by itself.

## Fixed Library Events

These are internal operations, not automatically exposed routes. In-process
callers are trusted library/app code, as with other Stackpress events. HTTP pages
must not accept a submitted `profileId`, grant owner or successful factor flag
as proof. Only token-issuing events return secrets, directly to their protocol page.

| Event | Input | Successful `results` |
| --- | --- | --- |
| `oauth-client-register` | Validated public-client metadata and trusted rate-limit context | Registration JSON: client_id, client_id_issued_at, redirect_uris, grant_types, response_types, token_endpoint_auth_method |
| `oauth-authorization-start` | Validated authorization query and trusted browser continuation context | Safe approval summary and opaque pending reference, or validated redirect/error result |
| `oauth-authorize` | Pending reference, trusted browser profile, selected scope/operation subsets, verified server-side factor receipt, approve/deny | `{ redirect }`, built only from the saved checked request |
| `oauth-code-exchange` | `{ client_id, code, redirect_uri, code_verifier, resource }` | Standard token JSON |
| `oauth-refresh` | `{ client_id, refresh_token, resource, scope? }` | Standard token JSON; requested scope may only narrow |
| `oauth-token-verify` | `{ token, resource, surface, method, requiredCredential, operation? }` from the adapter | `OAuthIdentity` |
| `oauth-revoke` | `{ client_id, token, token_type_hint? }` | Empty success; unknown token is also successful |
| `oauth-grants-list` | Trusted `{ profileId }` from the browser edge | Safe list of owned approvals |
| `oauth-grant-revoke` | Trusted `{ profileId, grantId }` | `{ revoked: true }` for owned active or already cancelled approval |
| `oauth-finalize` | No external input; called after listen/route complete | Empty success or startup error |
| `oauth-cleanup` | Trusted bounded batch size and clock | Counts of removed expired records, never raw keys |

`surface` is `mcp` or `api`. MCP method comes from the normalized tool definition;
API method comes from the matched route/request. `operation` is the registered
API descriptor for membership checking, not a client-supplied URL. `requiredCredential` is `read` or `full`, derived from the trusted
operation/control classification, never a submitted value. Preserve the actual
method; do not pretend a GET control request was POST. The verifier
checks credential syntax/strength, current active profile, client admission,
expiry, grant cancellation, exact resource, current app access policy, and API
membership. Empty-scope and any-match behavior stays with AI/API.

Registration accepts public clients using `authorization_code` and optional
`refresh_token`, response type `code`, and auth method `none`. Reject incompatible
requested methods/grants; apply standard defaults when optional metadata is
absent. Issuance includes renewal only when the client's allowed grant types
include it. Client registration creates no grant. The configured allowlist checks
client IDs at use; an unlisted dynamically registered ID receives no user access.

A token result is `{ access_token, token_type: 'Bearer', expires_in, scope,
refresh_token? }`, at the HTTP JSON top level. Do not introduce `access_key` in
new replies; existing API reply formats stay unchanged. Reject duplicate form
parameters and malformed/oversized input before resolving events. Token/revoke
requests use form encoding, registration uses JSON, approval uses CSRF forms.
Set no-store on token, authorization and connection-management responses.

Use `ctx.resolve<T>()` and the existing status shape. Success sets code 200
(registration HTTP page maps creation to 201). Failure sets the standard `error`
field to the machine code and `errors` to safe description/scope information.
The HTTP adapter emits `{ error, error_description? }`, never an Ingest results
envelope. Unexpected exceptions become a generic server error and redacted server
log. Do not serialize whole request/session objects into errors or browser props.

Stackpress's revocation endpoint requires a full access key or refresh token plus its bound public
client ID, not a read ID or grant ID. A wrong secret must not revoke a grant.
Known valid tokens cancel the whole approval; unknown tokens do not reveal whether
an account/client exists. The owned-grant browser operation uses session + CSRF
instead. Listing returns grantId, safe client display, resource, scope labels,
API membership, issued/expiry/deadline dates and active/cancelled status. It never
returns access IDs, secrets, renewal tokens, code values, hashes or session JWTs.

## App Policy Events

The app supplies named approval and access events in configuration. They cannot
replace library verification or expand configured authority. Missing listeners,
invalid results, errors or timeouts deny the operation. This explicit contract
keeps the library from guessing the app's roles or treating an active account as
permission for every configured scope. The app may use the same listener for both.

Approval input: `{ phase: 'approval', profile, client, resource, scopes,
operations, factor }`. `profile` is a freshly loaded safe `{ id, roles }` summary,
not the browser JWT or full `me` result. `scopes` is the requested configured set;
`operations` is the current explicitly opted-in API set for that resource.
`factor` reports availability of a verified factor, never its secret.

Approval result: `{ allowed: boolean, scopes?: string[], operations?: string[],
accessSeconds?: number, renewalSeconds?: number, requireFactor?: boolean }`.
An allowed result must explicitly supply `scopes` and `operations`, including
empty arrays where intended. Values must be subsets of the inputs; durations
may only shorten app defaults. Excess values are errors, not silent expansion.
No supplied `requireFactor` means no extra check, preserving Q-010. Ordinary
sign-in requirements still apply. The person may further narrow the returned
sets on the approval form; membership and scopes remain independent checks.

Access input: `{ phase: 'exchange' | 'verify' | 'refresh', profile, client, grant }`, using a
fresh profile and a secret-free current grant summary. Result:
`{ allowed: boolean, scopes?: string[] }`. Omitted scopes preserve the stored
set; supplied scopes must be a subset. Verification uses the intersection now;
exchange/refresh persist the narrowed set. A policy cannot change the person, client,
resource, API membership, original deadline or lifetime ceiling. Business events
remain responsible for object ownership and domain-specific access checks.

`requireFactor: true` uses the existing verified TOTP mechanism in a new approval
page; the sign-in 2FA page redirects signed-in people and cannot be reused as-is.
A receipt is server-bound to profile, pending request and final approval content,
valid at most 5 minutes and never past pending expiry. Retrying the same TOTP
must not mint multiple approval receipts; store the accepted counter in a separate
OAuthFactorUse row for that exact verified factor with an atomic check. Do not
repurpose Auth.consumed, which belongs to existing sign-in semantics. Scope/membership changes invalidate
the receipt. Missing factor means no code is issued and the page explains how to
set up a factor or contact the app owner. An app may explicitly allow its ordinary
session as an alternative by returning `requireFactor: false` based on its own
verified policy. The library never chooses this fallback on failure.

## Browser Continuation And Disconnect

Save a pending request server-side before redirecting to sign-in. Bind it to an
unguessable HttpOnly, Secure, SameSite=Lax browser continuation cookie; store only
its hash. It holds the checked client, exact redirect, state, S256 challenge,
resource, requested scopes and expiry. The pending reference alone grants nothing.
After sign-in, bind the current profile and re-evaluate policy and client metadata.
Changes require redisplaying the approval; never enlarge a submitted approval.

Browser POST reads body-only fields, checks CSRF and continuation ownership, then
reloads account, pending state and policy before the atomic approval transaction.
Hidden inputs can select subsets, never redefine authority. A completed duplicate
submission shows a local completion page; do not issue or replay another code.
Expired/lost pending state shows a local restart instruction. Invalid client or
redirect stays on a local error page. Denial after redirect validation returns
`access_denied`, original `state` if supplied, and configured `iss`; success returns
code, state and iss. Never attach tokens to browser redirects.

Views receive an explicit safe snapshot, including only CSRF/form continuation
fields needed by the browser. Do not serialize `me.token`, incoming authorization
headers, factor values, pending PKCE/state internals or full request wrappers.
Use translated text, accessible form errors, escaped client names, no remote logo
fetches, and a clear approve/deny choice. Show scopes, exact service and API
operations plus the client/redirect hosts and a local-program notice. No selection
is a publisher endorsement. The connections page has an empty state and a link
back to account settings. Disconnect shows confirmation on that page; another
person's grant is reported as unavailable without revealing its owner.
