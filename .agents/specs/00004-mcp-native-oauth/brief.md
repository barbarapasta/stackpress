# What We Are Planning

## What The User Asked For

The user wrote:

> This is the stackpress library. We're planning to get the mcp native oauth
> into stackpress-ai and stackpress-session package. I want you to follow the
> coding convention here in our repository strictly. This is an open source
> software. You may follow /chrisai-coding for guidance.

They supplied application spec `00032-mcp-native-oauth` and clarified:

> Prepare the library implementation plan

## What A Person Should Be Able To Do

An app developer turns the feature on through documented Stackpress settings.
A person gives an MCP client the app's address, signs in through the existing
browser page, approves permissions, and uses the allowed tools. The client gets
a usable key in the standard `access_token` field and renews it automatically.
New OAuth keys last 15 minutes by default. Automatic renewal lasts up to 7 days
from original approval, then the person approves again. App developers can
change both settings; renewing a key never extends the approval deadline.
The same key can also call approved ordinary API routes. Apps must explicitly
enable the new keys for each user API route; turning OAuth on does not enable
existing routes automatically. Disconnecting the client, or reaching the renewal
deadline, ends both kinds of access.

## A Few Names Used In The Code

- **Client:** a program such as Claude Code or Codex that calls the app's tools.
- **Key or access token:** the value the client sends to prove it has access.
  OAuth returns `id:secret`. Following the existing Stackpress rule, reads
  (`GET`) may use the ID alone; other operations need the full key.
- **Permission or scope:** an action the person allows the client to perform.
  When a route or tool lists several permissions, any one match is enough.
  An empty list keeps existing behavior: protected API routes refuse access;
  protected MCP tools still accept valid keys of the correct type.
- **Approval or grant:** the saved record of who approved which client,
  permissions, and server address, and for how long.
- **Renewal token or refresh token:** a separate secret used to get a new key.
- **Return address or redirect URI:** where the browser sends the person back
  to the client after approval.
- **Discovery documents or metadata:** small JSON documents that tell the
  client where to sign in and how that server works.
- **PKCE with S256:** the client makes a secret, sends its SHA-256 hash at the
  start, then shows the secret when collecting its key. This proves it is the
  same client that started the request without needing a client password.

Exact field names and file paths stay in the plan so developers can find and
implement them. The surrounding explanations use the plain terms above.

## What We Will Include

- The standard OAuth login: a single-use code and required S256 PKCE for clients
  that have no registered password.
- Documents that tell clients where to sign in and which tool server a key is for.
- Clients that introduce themselves through an HTTPS document, with registration
  by sending a description as the fallback. Any compatible client may request
  approval by default; apps can restrict this to an allowed-client list.
  Client checks and user approval still apply. Registration alone gives no access.
- Existing browser sign-in, approval and denial, and optional rules that ask
  for a fresh identity check before approval. By default the existing sign-in
  is enough; apps choose when to require an extra check.
- Saved single-use codes, hashed secrets, renewal tokens replaced after each
  use, detection of reused tokens, expiry, disconnect, and keys limited to their
  approved server addresses. G-007 uses an exact service URL plus saved API-operation
  membership, defined in [configuration](configuration.md).
- Public and protected MCP tools at one address, with access decided per tool.
  Anonymous clients may see protected names/descriptions under Q-013; their
  execution and data remain protected.
- Fresh key checks on protected MCP tool calls and ordinary API requests,
  with one shared approval and disconnect behavior.
- Pages and events to list and disconnect approved clients.
- Settings, types and imports for app developers, documentation, and a blog
  template example.
- First-release database support for PGlite, PostgreSQL, MySQL, and SQLite,
  each verified through its existing Stackpress adapter.
- Tests for security, requests arriving at the same time, supported clients,
  and all three packages.

## Which Package Does What

`stackpress-session` already handles browser sign-in. Its accepted optional
`oauth/` folder would handle clients, approval, keys, renewal, and disconnect.
`stackpress-ai` would tell MCP clients how to sign in, check their keys and server
address, and pass the verified user and permissions to the requested tool.
`stackpress-api` will accept the new keys on approved ordinary API routes using
the same session checks. It will preserve support for existing API keys.

Today, `stackpress-api` owns the database `Application` and `Session` models,
`/auth/oauth`, and the code that exchanges a code for a key. That database
`Session` is different from the browser JWT `Session` class in
`stackpress-session`. G-001 now keeps those models in place and assigns new
OAuth records to session. [G-002](decisions.md) also includes ordinary API
support. G-007 binds a shared key to one declared service and its explicitly
approved API operations; common hostnames or path prefixes do not grant access.

Follow the repository's [contribution rules](../../context/extension-and-contribution.md)
and [rules for pages, APIs, and MCP](../../context/interfaces-and-experience.md).

## What This Work Does Not Include

- Copying Resourcing's branding, personnel permissions, role names, database
  plugin or table names, deployed addresses, or app-specific tools into Stackpress.
- Rebuilding sign-in or requiring WorkOS, JWT access keys, or an extra proxy server.
- Adding device-code login, WorkOS-style login, or a login command in this phase.
  Leave room for apps that already use those ways to sign in.
- Changing users' databases, deploying, publishing packages, or editing the
  source application.
- Automatically turning OAuth on for existing public MCP servers.
- Counting the source application's tests as proof that this library works.

## People And Systems To Account For

The plan covers app maintainers, people who are signed in or signed out, people
who need stronger approval checks, and existing app users. It also depends on
MCP clients, database drivers, browser pages, and servers hosting client documents.

Tests must cover suspended accounts, expired keys, denied approval, and
cancelled access, including what the person can do next in each case.

The user froze this plan on 2026-09-29. The accepted detailed contracts are: [configuration](configuration.md),
[events](events.md), [storage](storage.md), [recovery](recovery.md), and the full
[journey audit](journeys.md). Explicit reapproval covers clients that cannot
upgrade permissions automatically. Existing MCP keys need service bindings when
OAuth is enabled; ordinary legacy API behavior remains. The [freeze record](freeze.md) records approval of these contracts and the
remaining release checks. Follow the [task plan](tasks/sprint.md) to implement them.
