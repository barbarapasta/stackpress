# Upgrading To Native MCP/API OAuth

Companion to [OAuth Setup](./oauth.md). This page covers migrating existing
Application/Session API keys, how an approval can be lost or revoked and what
recovery looks like, and the current release limits for this feature. Spec:
[00004-mcp-native-oauth](../.agents/specs/00004-mcp-native-oauth/).

## Migrating Existing MCP/API Keys

Native OAuth access keys are prefixed `oauth_`. Your existing Application and
Session API keys keep working unchanged and unbound — nothing forces an
upgrade. If you want an existing key to also satisfy an `oauth`-opted-in
route/tool without the person re-approving from scratch, bind it explicitly
with the operator-only `oauth-legacy-migrate` event (not a public route; call
it from your own admin tooling or a one-off script):

```ts
const result = await ctx.resolve<LegacyMigrationResult>('oauth-legacy-migrate', {
  kind: 'app',                 //or 'session'
  resource: 'https://example.com/mcp',
  ids: ['app_123', 'app_456'], //explicit selection only — never "migrate everything"
  dryRun: true                 //report what would happen; writes nothing
});
```

`result.records[]` reports one of `bound`, `would_bind` (dry run), `invalid`
(missing/inactive/expired — no secret ever leaves this function), or the
specific refusal reason `namespace_conflict`/`incarnation_mismatch`. Run with
`dryRun: true` first, review the report, then re-run with `dryRun: false`
(or omitted) to actually bind. The call is repeatable: re-running against
already-bound IDs succeeds again rather than erroring.

### Which keys stop working without a binding

None of them stop working. An unbound legacy key simply continues to use the
legacy application/session check it always used; it is only refused on a
route/tool that is **both** `oauth`-opted-in **and** that the key has no
binding for. A route/tool that was never opted into OAuth is unaffected
either way.

### Removing a binding

There is no separate removal event. Per
[amendment A-001](../.agents/specs/00004-mcp-native-oauth/decisions.md#amendment-a-001--admin-access-to-oauth-records),
`OAuthLegacyBinding` gets the same role-gated, non-menu generated admin page
as the other eight OAuth models; deactivate a binding the same way you would
deactivate any other record there (set it inactive). A deactivated binding is
refused on the next verify, same as any other revoked credential.

## Approval Expiry, Disconnect And Reapproval

- **Renewal**: while the original approval is still within its
  `renewalSeconds` window, a refresh token keeps working and rotates on use.
  Scope can only narrow on refresh, never grow.
- **Disconnect**: the person can revoke their own grant from
  `/auth/oauth2/connections` at any time; `oauth-revoke` and
  `oauth-grant-revoke` both report success for an already-gone/unknown token
  rather than revealing whether it ever existed.
- **Approval ended (deadline passed, or revoked)**: every further call with
  that grant's key is refused `invalid_grant`/`access_denied`. There is no
  automatic re-escalation — [recovery.md](../.agents/specs/00004-mcp-native-oauth/recovery.md)
  is explicit that the tested client SDKs do not reliably retry OAuth
  themselves after a 403. The person must explicitly approve again through
  `/auth/oauth2/authorize`; a new grant always requires a new MCP session,
  even for the same person and client.
- **Lost or uncertain token-response**: if a code/refresh exchange's reply is
  lost after the server already committed it (timeout, dropped connection),
  do not retry the same code/refresh — replay protection treats a second use
  of an already-consumed code/refresh token as reuse and cancels the whole
  grant chain. Start a fresh `/authorize` approval instead. This is a
  deliberate no-secret-grace-window rule, not a bug to work around.
- **A request refused before the business event ran** can be retried safely.
  A request that failed after the event may have partially executed; never
  automatically replay a write. A JSON-RPC ID is not an idempotency key.

### Asking a client to approve again

```bash
# Codex 0.157.0
codex mcp logout <name>
codex mcp login <name> --scopes articles:read,articles:write

# Claude Code 2.1.283
claude mcp logout <name>
claude mcp login <name>
```

These are the client's own commands, checked against their installed
`--help` output at the time this spec was written — not new Stackpress
commands, and not guaranteed stable across client versions. Local `logout`
only clears the client's local credential; use the app's
`/auth/oauth2/connections` page to cancel the old server-side approval when
replacing it with a new one.

## Current Release Limits

This feature is implemented and tested, but the release that includes it is
**blocked** pending one dependency:

### Unpublished Inquire fix (commit `d41472e`)

Root `package.json`'s `resolutions` block pins all five `@stackpress/inquire*`
packages to a local tested build
(`~/projects/inquire/.handoff/*-0.10.8-d41472e.tgz`, commit `d41472e` on
`fix/transaction-ownership`, superseding the earlier `d5f5a07` revision once
task [00001A](../.agents/specs/00004-mcp-native-oauth/tasks/00001A-inquire-nested-transaction-join.md)
let a nested transaction join its outer one) rather than a published npm
version. **Do not change that `resolutions` block or its `yarn.lock`
entries** — every result in this spec, including everything in this
document, was produced against that build. The release stays blocked until
the maintainer publishes the corrected Inquire version and task
[00011](../.agents/specs/00004-mcp-native-oauth/tasks/00011-production-cross-surface-and-database-checks.md)
re-runs the full four-database check against the published version.

### Known upstream findings (not fixed in this repository)

Recorded here so they are not mistaken for defects in the OAuth feature
itself when you hit them:

- **Inquire PostgreSQL dialect drops a falsy `default`.** `field.default`
  is truthy-checked, so a declared default of `0` is silently dropped.
  Worked around in `oauth.idea`'s hand-written tables by declaring the
  affected `INTEGER` counter columns `NOT NULL` with no DB-level default —
  `OAuthStore` always supplies them explicitly on insert. If you declare
  your own schema with a falsy numeric default, verify it survives
  generation against PostgreSQL.
- **Real MySQL rejects a `DEFAULT` on `TEXT`/`BLOB`/`JSON` columns.** Same
  practical effect — avoid declaring a default on those column types for
  MySQL.
- **MySQL/InnoDB's 3072-byte composite index-key limit.** A composite unique
  key across a long `VARCHAR` column can exceed it; keep indexed string
  columns bounded (`oauth.idea` uses `VARCHAR(512)` for its indexed
  `resource` columns).
- **`@stackpress/inquire-mysql2`'s `Connection.format()` stringifies every
  `Date` via `toISOString()`**, which real MySQL's `DATETIME` literal syntax
  rejects. `OAuthStore` works around this transparently with a dialect-aware
  proxy; a production MySQL connection must also be constructed with
  `{ timezone: 'Z' }`.
- **Reactus embeds page props with an unescaped `JSON.stringify`.** Any
  generic `ctx.view`-rendered page whose props include user-controlled text
  containing the literal substring `</script` is script-injectable (a
  self-XSS on the affected person's own next page load at minimum). This
  feature's own OAuth pages do not use `ctx.view` for an unrelated reason
  (session-data leakage) and so happen to avoid it; the existing
  `${auth.base}/account` and `${auth.base}/account/security` pages do use
  `ctx.view` and render a person's own editable `name`, so they are affected.
  Not fixed here — it is a `stackpress-view`/Reactus integration issue, out
  of this feature's package scope. Escape before rendering if you build your
  own `ctx.view` page that renders user-controlled text.
- **Nested transactions now join the outer one** (Inquire commit `d41472e`,
  task 00001A). A `transaction()` call made while the same connection already
  has a transaction open in the same async chain reuses the outer
  transaction's reserved connection and sends no BEGIN/COMMIT/ROLLBACK of its
  own; an error inside it propagates to roll back the whole outer
  transaction. This is what `stackpress-sql`'s `scripts/install.ts` (used by
  the `push` CLI command) needs: it wraps its whole drop+create sequence in
  one outer `database.transaction()`, and each generated model's `.install()`
  independently opens its own transaction via the `Create` builder. `yarn
  push` now succeeds against PGlite and against a pooled PostgreSQL engine,
  creating every table including all nine `oauth_*` tables, with no
  workaround needed.

### Schema corrections found by task 00011's real generated-store checks

Every task through 00010 validated `OAuthStore.ts` only against the
hand-written `storage/tables.ts` builder (used in every test's own setup),
never against a real `yarn generate` + `yarn push`/`migrate` of
`oauth.idea` itself — the schema real consuming apps actually use. Task
00011 found and fixed three places where `oauth.idea` had drifted from
`tables.ts`/`OAuthStore.ts`, confirmed against PGlite, PostgreSQL, MySQL
and SQLite:

- **`OAuthRateBucket.window` renamed to `windowStart`.** `window` is a SQL
  reserved word (MySQL 8.0.2+ and the SQL standard); an unquoted raw WHERE
  clause referencing it fails at the dialect level. The generated column is
  now `window_start`, matching what `storage/tables.ts` and `OAuthStore.ts`
  already expected.
- **Missing `lockToken` column on `OAuthPending`, `OAuthGrant`,
  `OAuthFactorUse` and `OAuthRateBucket`.** `OAuthStore.ts`'s `_claim()`
  CAS primitive (used for every atomic grant/pending/factor/rate-bucket
  mutation) requires a `lock_token` column on each of these tables;
  `oauth.idea` never declared it, so a database generated purely from the
  documented setup steps would fail the very first atomic operation
  (rate-limited registration, authorization-start, approval, and so on)
  with a raw "column does not exist" error.
- **`@default([])`/`@default({})` removed from every JSON/array field**
  (`OAuthPending.scopes/operations/approvedScopes/approvedOperations`,
  `OAuthGrant.scopes/operationFingerprints`, `OAuthClient.metadata`,
  `OAuthClientDocument.metadata`). Real MySQL rejects any `DEFAULT` on a
  `JSON`/`TEXT`/`BLOB` column outright; `OAuthStore.ts` always supplies
  these fields explicitly on insert, so no default was ever needed.

If you generated and pushed/migrated an app's database against an earlier
build of this feature, regenerate `oauth.idea` and run your database's
migration path again before enabling native MCP OAuth; the four affected
tables are missing a required column until you do.

A fourth, blog-template-only defect was also found and fixed: the example's
own `blog:desktop-open-latest-posts` event name (a pre-existing, unrelated
desktop-menu contribution) was silently matching and overwriting the result
of every `blog-oauth-approval`/`blog-oauth-access` policy call, because
Ingest's event matcher treats any `:word` inside a registered event name as
a wildcard variable and both names share the `blog` prefix with no `/`.
Renamed to `blog-desktop-open-latest-posts`. If your own app registers an
event name containing a colon, check whether its prefix collides with any
other event name you rely on.

No version number in this spec or its task files was inferred or bumped, and
nothing here authorizes publishing.

## Related

- [OAuth Setup](./oauth.md)
- [Config Reference](./config-reference.md)
- Spec: [storage.md](../.agents/specs/00004-mcp-native-oauth/storage.md), [recovery.md](../.agents/specs/00004-mcp-native-oauth/recovery.md), [decisions.md](../.agents/specs/00004-mcp-native-oauth/decisions.md)
