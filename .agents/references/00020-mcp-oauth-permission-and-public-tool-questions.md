# Permission And Public Tool Questions

Part of the [OAuth question record](../specs/00004-mcp-native-oauth/questions.md).
Read this file when reviewing the exact early questions, answers, and follow-ups.

## Q-004 — Matching A List Of Permissions

- Status: answered-by-user; decision accepted.
- Source: remaining part of G-003; current API/AI checks accept any listed scope.
- Decision update: [G-003](../specs/00004-mcp-native-oauth/decisions.md#g-003--what-happens-to-existing-keys-and-public-tools).

### Exact Question

If a route or tool lists two permissions, should a key need either one, as
Stackpress works today, or both?

### Choices Presented

1. **Either one:** keep the current matching rule.
2. **Both:** require every listed permission, which changes existing behavior.

### Suggested Default, Not Accepted Unless You Choose It

Option 1, to preserve the existing meaning of permission lists. A separate
explicit setting for requiring all permissions could be considered later.

### User Answer

> Suggested default.

Accepted meaning: for a non-empty permission list, any one matching permission
is enough for existing and new keys. Other checks still apply. This does not
add an all-permissions setting or decide what an empty list means.

## Q-005 — Public And Protected Tools At One Address

- Status: answered-by-user; decision accepted.
- Source: remaining part of G-003; AI already filters tools by public/app/user
  type in helpers.ts and serves the configured tool list at its MCP address.
- Decision update: [G-003](../specs/00004-mcp-native-oauth/decisions.md#g-003--what-happens-to-existing-keys-and-public-tools).

### Exact Question

Should public and protected MCP tools share the same server address, or use
separate addresses?

### Choices Presented

1. **Same address:** callers without a key can use public tools; protected tools
   require a valid key and the right permissions.
2. **Separate addresses:** one address for public tools and another for tools
   that require a key.

### Suggested Default, Not Accepted Unless You Choose It

Option 1. It follows Stackpress's existing rule of deciding access per tool.

### User Answer

> Suggested default.

Accepted meaning: public and protected MCP tools share one server address.
Access is decided per tool. Public tools work without a key; protected tools
require the proper key and permissions. This does not make an invalid key valid
or permit protected access through an anonymous connection.

### Evidence And Follow-Up

Current code can filter public/app/user tools from one registry. That does not
prove automatic OAuth works with a mixed list. Shared access is now chosen.
P-002 must test how a client discovers protected tools, starts login when needed,
and refreshes its visible list after approval. No login challenge or tool-list
behavior beyond this question should be treated as accepted yet.

## Q-006 — Empty Permission Lists

- Status: answered-by-user; decision accepted.
- Source: remaining part of G-003; verified difference between API and AI code.
- Decision update: [G-003](../specs/00004-mcp-native-oauth/decisions.md#g-003--what-happens-to-existing-keys-and-public-tools).

### Exact Question

What should happen when a protected route or tool lists no permissions?

### Context Presented

Today, API routes reject the request, while MCP tools accept a valid key of the
right type. Public routes/tools are separate and do not need a key.

### Choices Presented

1. **Keep today's behavior:** API rejects; MCP accepts a valid key.
2. **Allow both:** a valid key is enough when no permissions are listed.
3. **Block both:** protected routes/tools need at least one listed permission.

### Suggested Default, Not Accepted Unless You Choose It

Option 1 for this release, so existing apps keep the behavior they were built for.
The shared key checker can verify the key while each package applies its existing
empty-list rule. Account, method, expiry, and allowed-address checks still apply.

### User Answer

The user asked:

> What do you mean permissions?

The assistant explained:

> By **permissions**, I mean named access labels, called **scopes** in the code. The app developer chooses their names.
>
> For example:
>
> - A tool lists `articles:read`.
> - A person approves a client for `articles:read`.
> - The client's key can use that tool.
> - A key with only `orders:read` cannot.
>
> If a tool lists several permissions, we've agreed that **matching any one is enough**.
>
> My previous question was about a protected route or tool configured with **an empty permission list**: it requires a valid key, but names no particular permission. Should that valid key alone be enough, or should access be refused?

Exact user answer:

> Option 1

Accepted meaning: preserve the current difference. Protected API routes with
empty permission lists refuse access. Protected MCP tools with empty lists
accept a valid key of the correct caller type, subject to all remaining checks.
This does not refer to the permissions saved on the key; it refers to the list
configured on the route/tool. Public routes/tools remain separate.

### Evidence

AI `src/helpers.ts` hasRequiredScopes returns true when required.length is zero;
caller type and method checks still apply. API `src/plugin.ts` session/app handlers
require a scope match through some(), which cannot match an empty list.
This is a product choice about whether to change that difference, not an unknown
about what the current code does.

