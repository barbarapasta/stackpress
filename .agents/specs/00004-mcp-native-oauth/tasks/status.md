# Task Status

Spec 00004: Frozen 2026-09-29. Implementation plan: accepted.
Authorized by “Freeze then create task files.” Implementation started 2026-09-29.
See [sprint](sprint.md) for dependencies, working rules and complete coverage.

| Task | Status | Depends on | Visual acceptance | Current note |
| --- | --- | --- | --- | --- |
| [00001](00001-inquire-transaction-ownership.md) — Fix Inquire transaction ownership | verified | None | None | Verified 2026-09-29: ~/projects/inquire branch fix/transaction-ownership, commit d5f5a07; 233 tests pass on all four databases; waiting for upstream push and publish |
| [00001A](00001A-inquire-nested-transaction-join.md) — Let a nested Inquire transaction join the outer one (side task of 00001) | verified | 00001 | None | Verified 2026-10-15: Inquire commit d41472e; 251 Inquire tests and 735 session tests pass on all four databases; `yarn push` works on PGlite and PostgreSQL |
| [00002](00002-oauth-types-config-and-startup.md) — Add shared OAuth types, settings and startup checks | verified | None | None | Verified 2026-09-29: session 97.5%, ai 95.7%, api 99.0% (after 00002A) |
| [00002A](00002A-ai-api-package-coverage.md) — Bring stackpress-ai and stackpress-api coverage above 90% (side task of 00002) | verified | 00002 | None | Verified 2026-09-29: ai 90 tests / 95.7%, api 78 tests / 99.0%; no source changes |
| [00003](00003-oauth-schema-and-private-storage.md) — Add the optional schema and private database operations | verified | 00001, 00002 | None | Verified 2026-10-15 on all four databases (Inquire d5f5a07 override); 150 tests; admin pages hide hash columns per A-001 |
| [00004](00004-client-registration-and-safe-metadata.md) — Validate client registration and safely read client documents | verified | 00002, 00003 | None | Verified 2026-10-15: 246 tests, 94.9%; atomic capacity reservation; all four databases (SQLite re-run by orchestrator under Node 22) |
| [00005](00005-approval-key-lifecycle-and-policy.md) — Implement approval, key renewal, verification and cancellation | verified | 00003, 00004 | None | Verified 2026-10-15: 341 tests, 93.7%; 12 race/replay cases pass on all four databases |
| [00006](00006-oauth-protocol-routes-and-browser-guard.md) — Add discovery and OAuth protocol routes | verified | 00002, 00004, 00005 | None | Verified 2026-10-15: 430 session tests, 94.1%; faked forwarded headers ignored; Retry-After now sent as a real header |
| [00007](00007-approval-factor-and-connections-pages.md) — Build approval, extra-check and connected-program pages | verified | 00005, 00006 | Browser pages and interactions | Verified 2026-10-15; 25 screenshots in /tmp/oauth-00007-shots/ waiting for user review |
| [00007A](00007A-session-package-coverage.md) — Bring stackpress-session package coverage back above 90% (side task of 00007) | verified | 00007 | None | Verified 2026-10-15: session 91.0% (735 tests with all four databases); fixed a token bug in AuthActions.create on PostgreSQL/PGlite |
| [00008](00008-api-shared-access-and-legacy-upgrade.md) — Connect ordinary API requests and migrate selected old MCP keys | verified | 00002, 00003, 00005 | None | Verified 2026-10-15: api 119 tests / 99.0%; legacy-key linking passes on all four databases; revocation, link removal and recreated-record cases refused |
| [00009](00009-mcp-http-sse-and-current-identity.md) — Enforce current identity on every MCP request | verified | 00002, 00005, 00006, 00008 | None | Verified 2026-10-15: ai 160 tests / 95.0%; cross-process notifications pass on PostgreSQL and MySQL |
| [00010](00010-package-exports-blog-and-upgrade-docs.md) — Package the feature and document a complete blog example | verified | 00007, 00008, 00009 | Setup/upgrade docs and example | Verified 2026-10-15: docs/oauth.md, docs/oauth-upgrade.md and the blog example; fixed an oauth-finalize reply bug. Its nested-transaction release note is being corrected by 00001A. Waiting for user review |
| [00011](00011-production-cross-surface-and-database-checks.md) — Verify the real packages together on all four databases | verified | 00010 | None | Verified 2026-10-15: full MCP+API journey on the real generated schema; 7 defects fixed; schema drift guard added (proven to catch a renamed column); session 91.1%, ai 95.0%, api 99.0% on all four databases |
| [00012](00012-real-client-journeys-and-release-evidence.md) — Run the complete real-client journeys before release | verified | 00011 | Real-client recordings and report | Verified 2026-10-15: all 12 P-003 checks pass with real Claude Code 2.1.296 and Codex CLI 0.161.0, including approved API writes; report in references/00025; evidence in /tmp/oauth-00012-evidence/ waiting for user review |

## Progress And Blockers

Counts: 0 open, 0 started, 15 verified, 0 accepted (includes side tasks 00001A, 00002A and 00007A).
Inquire checkout: ~/projects/inquire (clone of stackpress/inquire main 039a1b5).

First dependency: the corrected Inquire code and a consumable tested build.
Locate its owning checkout when starting 00001. If access or dependency delivery
is unavailable, keep the current task state and record the specific blocker and
next action; do not bypass it with a production-only workaround.

User decision 2026-09-29: wait for a published Inquire release before 00003.
User decision 2026-10-15 (replaces the above): continue 00003–00012 against the
tested local Inquire build. The CTO will publish the upstream fix. The root
`package.json` `resolutions` block points all five `@stackpress/inquire*`
packages at `~/projects/inquire/.handoff/*-0.10.8-d41472e.tgz` (commit d41472e, which replaced d5f5a07 via 00001A).
Do not commit that block or its `yarn.lock` entries. Release stays blocked until
the published version replaces it and 00011 is re-run against that version.
No deadlines, estimates or resource assignments have been invented.

## Updating This Tracker

Use only proposed, open, started, verified and accepted. Record blockers separately.
A nonvisual task finishes at verified. Tasks 00007/00010/00012 need explicit user
review after verification before accepted; no delegated acceptance exists.
Keep task numbers stable, implementation/verification notes in their owning files,
and the spec's implementation tracker aligned. A new required side task follows
the repository workflow and must not silently change a Frozen requirement.
