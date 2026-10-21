# Storage And Key Questions

Part of the [OAuth question record](../specs/00004-mcp-native-oauth/questions.md).
Read this file when reviewing the exact early questions, answers, and follow-ups.

## Q-001 — Where To Save The New Keys

- Status: answered-by-user; decision accepted.
- Source: gap G-001, with the package facts recorded in research R-001.
- Decision update: [G-001](../specs/00004-mcp-native-oauth/decisions.md#g-001--where-should-oauth-keys-be-stored).

### Exact Question

Should the new MCP login keys have their own records in `stackpress-session`,
or use the existing `Session` records in `stackpress-api`?

### Choices Presented

1. **Own records in session:** keeps the new login separate from existing API
   keys. We would add new database tables.
2. **Reuse API Session records:** keeps the keys in the existing storage, but
   requires changes to `stackpress-api` and a plan for updating existing records.

### Suggested Default, Not Accepted Unless You Choose It

Option 1. It lets us add the feature in the two intended packages without
changing how existing API keys are stored. The tradeoff is separate storage
for the two kinds of keys.

### User Answer

> Suggested default.

Accepted meaning: use new OAuth records owned by `stackpress-session`, with new
database tables. Keep existing API Session records in place. This answer does
not decide whether the new keys may also be used on ordinary API routes.

### Evidence And Follow-Up

`packages/stackpress-api/schema.idea` owns current database Session records.
`packages/stackpress-session/src/session/Session.ts` handles browser sign-in
sessions; it is not that database model. The present package structure establishes
these facts, but does not decide where the new feature should save its keys.
Follow-up: [Q-002](#q-002--where-the-new-keys-may-be-used) asks separately where
the keys may be used. Separate storage does not settle that question.

## Q-002 — Where The New Keys May Be Used

- Status: answered-by-user; decision accepted.
- Source: gap G-002, following the accepted storage choice in Q-001.
- Decision update: [G-002](../specs/00004-mcp-native-oauth/decisions.md#g-002--should-the-same-keys-work-on-ordinary-api-routes).

### Exact Question

Should these new keys work only for MCP tools, or also for ordinary API requests?

### Choices Presented

1. **MCP only for the first release:** existing API requests keep using their
   existing keys.
2. **MCP and ordinary API requests:** add support in `stackpress-api` for checking
   the new keys, including which API permissions and server addresses they allow.

### Suggested Default, Not Accepted Unless You Choose It

Option 1. It keeps the first release focused. Support for ordinary API requests
can be added later without moving the new records out of `stackpress-session`.

### User Answer

The user first asked:

> Just a question, why we can't support ordinary API requests?

The assistant explained:

> **We can support ordinary API requests.** My suggestion was about keeping the first release smaller, not a technical limitation.
>
> `stackpress-api` would need to check the new keys through `stackpress-session`. It must verify that the key is still valid, was issued for that API, and includes the permissions the requested route needs. Existing API keys could continue working.
>
> The benefit is useful: a client could get approval once and use both MCP tools and ordinary API routes, within the permissions granted. Disconnecting it would stop both.
>
> If that is the experience you want Stackpress to provide, including API support now is reasonable. It expands the work to three packages, while the new key records still belong to `stackpress-session`.

The user's exact answer:

> Yes please.

Accepted meaning: include ordinary API support in the first release. The same
new key may serve approved MCP tools and API routes. Session owns its records;
AI and API use the shared checks. Disconnect stops both. Existing API keys
remain supported, subject to the separate security-upgrade choices in G-003.

### Evidence And Follow-Up

Q-002 adds API integration to the accepted scope. It does not approve skipping
server-address or permission checks, accepting every key on every route, or
changing existing API login replies. G-007 records the remaining design for which
addresses a shared key covers. Q-003 starts the separate existing-caller review.

## Q-003 — Full Keys For Read Requests

- Status: answered through Q-003a; keep the current read/write rule.
- Source: part of G-003; API helpers/plugin and AI helpers currently exempt GET
  requests from requiring the secret.
- Decision update: [G-003](../specs/00004-mcp-native-oauth/decisions.md#g-003--what-happens-to-existing-keys-and-public-tools).

### Exact Question

Should every protected API and MCP request require the full `id:secret` key,
even when it only reads data?

### Context Presented

Today, some read requests accept the ID without the secret. Requiring the full
key would mean those callers must start sending the secret too. Public routes
and tools would not need a key.

### Suggested Default, Not Accepted Unless You Choose It

Yes. An ID identifies a record; the secret proves the caller may use it.
Apply this to new OAuth keys and existing app/user keys, and explain the change
in the upgrade notes.

### User Answer

> What if we do it the same with the current stackpress pattern?

No decision accepted. The user is asking about keeping current behavior.
Clarify whether that means existing keys only or new OAuth keys too.

### Follow-Up

See [Q-003a](#q-003a--which-keys-keep-the-current-rule).
This settles only whether read requests require the secret. G-003 still needs
separate decisions on permission matching and how public/protected tools coexist.

## Q-003a — Which Keys Keep The Current Rule?

- Status: answered-by-user; requested adaptation recorded.
- Source: user's clarification of Q-003, under G-003.
- Decision update: [G-003](../specs/00004-mcp-native-oauth/decisions.md#g-003--what-happens-to-existing-keys-and-public-tools).

### Exact Question

Do you want to keep the current rule for existing keys only, or for new OAuth
keys too?

### Explanation Presented

The current pattern accepts an ID for reads (GET) and requires `id:secret` for
other methods. This preserves existing callers, but someone who obtains the ID
can make permitted read requests without knowing the secret.

New OAuth clients already send the full `access_token` automatically. Requiring
its full value does not add setup work for the person using the client.

### Suggested Default, Not Accepted Unless You Choose It

Keep existing key behavior for compatibility; require the full key for new OAuth
requests. A failed OAuth key must never fall back to the old ID-only check.
This is a revised suggestion, not acceptance of either choice.

### User Answer

Exact user reply:

> - **Reads (`GET`):** the ID is enough.
> - **Other requests:** require `id:secret`.
>
> Can't we adapt this?

Recorded direction: adapt the current read/write rule for new OAuth keys as
well as existing keys. This follows the user's repeated request to use the
Stackpress pattern instead of either proposed full-secret requirement.
G-003 remains open for permission matching and public/protected tool behavior.

Implementation detail: API uses the actual request method. MCP uses the tool's
configured operation method, not the outer HTTP POST carrying the call. The
server chooses that classification; callers cannot label a write as a read.
OAuth still returns the full key in access_token. Expiry, permissions, allowed
addresses, account checks, and disconnect continue to apply to both read and
write access. New read IDs therefore need protection as access credentials.

