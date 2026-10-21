# Questions And Exact Answers

Spec: `00005-mcp-native-oauth`. Grill session in progress.
The user asked to discuss decisions here, using `/bro` for plain language.
Ask one question at a time and save each answer exactly before updating decisions.

## Earlier Questions And Answers

- [Storage and key questions](../../references/00022-mcp-oauth-storage-and-key-questions.md):
  read for Q-001 through Q-003a, including exact answers about storage, ordinary
  API support, and the read/write key rule.
- [Permission and public tool questions](../../references/00023-mcp-oauth-permission-and-public-tool-questions.md):
  read for Q-004 through Q-006, including exact answers about matching permissions,
  public tools, and empty permission lists.

## Q-007 — Databases For The First Release

- Status: answered-by-user; release target accepted.
- Source: G-004 and source inspection under R-003.
- Decision update: [G-004](decisions.md#g-004--which-databases-and-server-environments-will-we-support).

### Exact Question

Should the first OAuth release support all four databases Stackpress already
has adapters for, or start with PGlite and PostgreSQL?

### Choices Presented

1. **All four:** PGlite, PostgreSQL, MySQL, and SQLite. More implementation and
   testing work, but apps can keep their chosen database.
2. **PGlite and PostgreSQL first:** a smaller first release; MySQL and SQLite
   support would come later.

### Suggested Default, Not Accepted Unless You Choose It

Option 1, because this is a reusable library. Each adapter must pass the code
exchange, renewal, cancellation, and simultaneous-request tests before support
is claimed. This chooses a release target; it does not claim those tests passed.

### User Answer

> Suggested default.

Accepted meaning: the first release must support PGlite, PostgreSQL, MySQL,
and SQLite through Stackpress's existing adapters. Each must pass the required
OAuth/database tests. This does not assert the tests have passed or permit an
adapter to be dropped silently if implementation problems appear.

### Evidence

The blog's plugins/store/connect.ts uses PGlite. stackpress-sql's mysql.ts,
pgsql.ts, pglite.ts, and sqlite.ts re-export the corresponding Inquire adapters.
Inquire owns transactions; native database behavior still needs P-001 testing.
This question does not choose non-Node runtimes or waive storage proofs.

## Q-008 — How Long An Access Key Lasts

- Status: answered-by-user; decision accepted.
- Source: G-006; new OAuth key lifetime is not decided by existing API settings.
- Decision update: [G-006](decisions.md#g-006--which-defaults-and-app-supplied-rules-will-we-offer).

### Exact Question

How long should a new OAuth key last before the client renews it automatically?

### Choices Presented

1. **15 minutes.**
2. **1 hour.**

Either would be a default that app developers can change in configuration.
This is the key's lifetime, not how often the person must approve the client
again in the browser. The final renewal deadline is a separate decision.

### Suggested Default, Not Accepted Unless You Choose It

15 minutes. It keeps each key short-lived while the client handles renewal.
This applies to new OAuth keys; existing API key lifetimes stay as configured.

### User Answer

> Suggested default.

Accepted meaning: new OAuth access keys expire after 15 minutes by default.
Apps can change that setting. Clients renew automatically within the approval
window. Existing API key lifetimes remain unchanged. The final deadline for
renewal has not been selected yet.

## Q-009 — When Browser Approval Is Needed Again

- Status: answered-by-user; decision accepted.
- Source: remaining lifetime choice in G-006, following Q-008.
- Decision update: [G-006](decisions.md#g-006--which-defaults-and-app-supplied-rules-will-we-offer).

### Exact Question

How long should a client be allowed to renew its keys before the person must
approve access again in the browser?

### Choices Presented

1. **7 days.**
2. **24 hours.**
3. **30 days.**

This would be configurable by the app and counted from the original approval.
Renewing a key would not restart the clock. Disconnect can end access earlier.

### Suggested Default, Not Accepted Unless You Choose It

7 days, giving a default weekly approval cycle while keys renew automatically
every 15 minutes. Apps can set a shorter window for more sensitive access.
This is a proposed product default, not a lifetime required by OAuth.

### User Answer

> Suggested default.

Accepted meaning: renewal is allowed for 7 days from original browser approval
by default, configurable by the app. Renewal never restarts that clock.
Disconnect ends access earlier. At the deadline, both renewal and remaining
access stop; the person must approve again to restore access.

## Q-010 — An Extra Two-Factor Check At Approval

- Status: answered-by-user; decision accepted.
- Source: remaining app-policy choice under G-006 and source decision G-015.
- Decision update: [G-006](decisions.md#g-006--which-defaults-and-app-supplied-rules-will-we-offer).

### Exact Question

Should approving a client ask for a fresh two-factor code by default, or only
when the app requires it?

### Choices Presented

1. **Let the app decide:** use the existing signed-in session by default; an
   app can require a fresh code for selected users or permissions.
2. **Ask by default:** request a fresh code at each approval when the account
   has two-factor authentication enabled.

Existing sign-in checks still apply in both cases. This question is about an
extra check when approving the client after the person has already signed in.

### Suggested Default, Not Accepted Unless You Choose It

Option 1. Stackpress supplies the check, while the app chooses when it is needed.
Do not hardcode an ADMIN role or silently bypass an app-required check when no
factor is available; any fallback needs an explicit app rule.

### User Answer

> Suggested default.

Accepted meaning: use the existing signed-in session by default, retaining
ordinary sign-in checks. Apps may require a fresh factor check for selected
users or permissions. Stackpress provides the capability without a hardcoded
ADMIN rule. An app-required check cannot silently be bypassed when no factor
is available; a different approval path requires an explicit app rule.

### Evidence

The current auth/pages/signin/2fa.ts completes sign-in and redirects already
signed-in users. It is not, by itself, a fresh approval check for a signed-in
person. Reuse the underlying verification ability with a separate approval
request binding, rather than assuming a redirect to that page proves freshness.

## Q-011 — Which Clients May Ask For Approval

- Status: answered-by-user; decision accepted.
- Source: remaining app-policy choice in G-006 and source G-001.
- Decision update: [G-006](decisions.md#g-006--which-defaults-and-app-supplied-rules-will-we-offer).

### Exact Question

When an app enables OAuth, should any compatible client be able to ask the
person for approval, or only clients the app has approved in advance?

### Choices Presented

1. **Any compatible client:** it must pass the client checks, and the person
   must still approve its requested access.
2. **Approved clients only:** the app maintains a list of allowed clients.

### Suggested Default, Not Accepted Unless You Choose It

Option 1, with a setting for apps that want an allowed-client list. This lets
people connect a compatible client without asking an administrator to add it
first. Client registration alone gives no access. Metadata-fetch safeguards,
request limits, and user approval still apply.

### User Answer

> Suggested dfeault.

Accepted meaning: any compatible client may request approval by default, with
an optional app-maintained allowed-client list. Client checks, safe document
fetching, request limits, and the person's approval still apply. Registration
alone grants no access. This applies when the app enables OAuth.

## Q-012 — Which Existing API Routes Accept New Keys

- Status: answered-by-user; decision accepted.
- Source: G-007 route configuration, following accepted ordinary API support.
- Decision update: [G-007](decisions.md#g-007--which-server-addresses-does-a-shared-key-cover).

### Exact Question

When OAuth is enabled, should existing user API routes accept the new keys
automatically, or only when the app enables them for each route?

### Choices Presented

1. **Enable each route:** the app marks which user API routes accept OAuth keys.
2. **Accept automatically:** existing user API routes also accept OAuth keys.

Both choices still require the approved server address, route permissions, and
all other key checks. Application-only routes do not become user routes.

### Suggested Default, Not Accepted Unless You Choose It

Option 1. It lets app maintainers choose where the new sign-in method is accepted
without changing every existing user route when they turn OAuth on.
Use the existing route configuration pattern; the exact field is still a proposal.

### User Answer

> Suggested default.

Accepted meaning: apps explicitly enable new OAuth keys for each user API route
through route configuration. Enabling OAuth does not automatically enable them
on existing user routes. Approved-address, permission, and other key checks
still apply. Application-only routes do not become user routes. Existing API
keys remain supported; the exact new configuration field is still a proposal.

### Evidence

packages/stackpress-api/src/types.ts defines public, app, and session route types.
The session handler in src/plugin.ts resolves an existing API Session and supplies
its profileId to the event. It does not yet accept the new OAuth records.
Before Q-012, the plan required approved API routes without settling whether
existing session routes were included automatically. Q-012 now settles that
default, not the protocol representation of the shared server address.

## Q-013 — Protected Tool Names Before Sign-In

- Status: answered-by-user; decision accepted.
- Source: P-002 transport proof, G-005; current anonymous registries hide protected tools.
- Decision update: [G-005](decisions.md#g-005--will-every-supported-mcp-connection-enforce-the-same-rules).

### Exact Question

The transport proof found that anonymous clients need to discover protected tools before a call can trigger login. Should they be allowed to see protected tool names and descriptions, while execution still requires approval?

### Choices Presented

1. Show names and descriptions (recommended for automatic login)
2. Hide protected tools until the client signs in explicitly

### Suggested Default, Not Accepted Unless You Choose It

Option 1. The client can discover a protected operation and receive a login
challenge when it tries to call it. Names and descriptions become visible before
sign-in, but protected execution and data still need the agreed checks.
This visibility change is not implied by keeping public and protected tools at
one address; it needs its own answer.

### User Answer

> Show names and descriptions (recommended for automatic login)

Accepted meaning: anonymous clients may see protected tool names and descriptions
so they can discover an operation and trigger login by calling it. Execution
still requires approval and the agreed key, permission, account, and address
checks. Tool results and protected data are not made public by this choice.

### Evidence

P-002's candidate exposes protected descriptions to exercise automatic first
login. Current Stackpress hides those tools from anonymous lists. The proof
establishes candidate mechanics, not permission to change the public catalog.
Explicit client login remains possible without exposing protected names.

## Planning Follow-Up

All 14 question records remain answered, including Q-003's follow-up. No user
question is currently pending. Exact questions, suggested defaults and answers
above and in the linked history have not been rewritten.

The user subsequently requested completion of remaining planning. G-004's Inquire
prerequisite is in [storage](storage.md); G-005's explicit recovery proposal is in
[recovery](recovery.md); G-006 settings/events/limits and G-007 route fingerprints
are in [configuration](configuration.md) and [events](events.md). These are detailed
technical recommendations, not additional questions falsely marked accepted.
G-003's enabling-time legacy binding and G-005's recovery fallback need review
with the completed draft. [Journeys](journeys.md) covers all identified scenarios.

[Proof results](proof-results.md) retain all executed outcomes and limits. The
complete Stackpress account/client journey is still a release gate. Final review
and Freeze precede implementation tasks; completing the plan does not authorize
production implementation or waive failed/unrun tests.


## Freeze Instruction — 2026-09-29

User instruction: “Freeze then create task files.” This accepts the final detailed
contracts and proof sequencing described in [freeze record](freeze.md). All earlier
questions and answers are historical records, preserved exactly. Their then-pending
review statements are superseded by this later instruction, not rewritten as if
those choices were part of an earlier answer.
