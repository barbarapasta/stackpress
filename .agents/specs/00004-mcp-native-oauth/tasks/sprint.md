# Implementation Plan

Spec 00004: Frozen 2026-09-29. Implementation plan: **accepted**.
The user instructed “Freeze then create task files” after reviewing the six-stage
plan and final choices. This authorizes the final task files now; it supersedes
the workflow's usual extra proposal/confirmation step. No implementation or task
acceptance has started. [Status](status.md) tracks the twelve open tasks.

## Work Order

| Task | Output | Depends on |
| --- | --- | --- |
| [00001](00001-inquire-transaction-ownership.md) | Fix Inquire transaction ownership | None |
| [00002](00002-oauth-types-config-and-startup.md) | Add shared OAuth types, settings and startup checks | None |
| [00003](00003-oauth-schema-and-private-storage.md) | Add the optional schema and private database operations | 00001, 00002 |
| [00004](00004-client-registration-and-safe-metadata.md) | Validate client registration and safely read client documents | 00002, 00003 |
| [00005](00005-approval-key-lifecycle-and-policy.md) | Implement approval, key renewal, verification and cancellation | 00003, 00004 |
| [00006](00006-oauth-protocol-routes-and-browser-guard.md) | Add discovery and OAuth protocol routes | 00002, 00004, 00005 |
| [00007](00007-approval-factor-and-connections-pages.md) | Build approval, extra-check and connected-program pages | 00005, 00006 |
| [00008](00008-api-shared-access-and-legacy-upgrade.md) | Connect ordinary API requests and migrate selected old MCP keys | 00002, 00003, 00005 |
| [00009](00009-mcp-http-sse-and-current-identity.md) | Enforce current identity on every MCP request | 00002, 00005, 00006, 00008 |
| [00010](00010-package-exports-blog-and-upgrade-docs.md) | Package the feature and document a complete blog example | 00007, 00008, 00009 |
| [00011](00011-production-cross-surface-and-database-checks.md) | Verify the real packages together on all four databases | 00010 |
| [00012](00012-real-client-journeys-and-release-evidence.md) | Run the complete real-client journeys before release | 00011 |

Task 00001 is the critical first dependency: fix the owning Inquire library.
Task 00002 can be prepared alongside it because types/settings do not need live
OAuth storage. Task 00003 cannot start production store work without both and a
consumable corrected dependency. Tasks 00007 and 00008 can proceed separately
after their listed prerequisites; coordinate shared session interfaces. No task
may pretend a dependency is complete because its prototype worked.

The six accepted stages map as follows: stage 1 → 00002; stage 2a → 00001;
stage 2b → 00003–00005; stage 3 → 00006–00007; stage 4 → 00008–00009;
stage 5 → 00010; final production integration → 00011; stage 6/P-003 → 00012.
This splits the accepted work into reviewable pieces without changing scope.

## Maintainable Implementation

| Layer | Tasks and expected result | How to check it | Visual acceptance |
| --- | --- | --- | --- |
| Shared foundation | 00001–00003: connection ownership, types, settings and private schema/store methods | Owning tests, real database checks, generation and public import/build checks | None |
| Test substitutes | 00004–00007: controllable clocks, DNS/network failures and test accounts | Failure and contract tests; never runtime fallbacks | Included only in browser development checks, never substitutes for final review |
| Reusable logic | 00004–00006 and 00008: clients, keys, policies, events, shared access and protocol replies | Security/contract tests and real handler checks | None |
| Page structure and interaction | 00007: existing session/view patterns, approval, factor and connected-client screens | Browser, server-rendered data, keyboard and form checks | Rendered screens and interaction states |
| Main integrations | 00008–00010: API/MCP behavior, packaged exports and consuming blog app | Actual event dispatch, transport modes, package/import and app tests | Setup/upgrade documentation and working example in 00010 |
| Replace substitutes with real behavior | 00011–00012: actual stores/accounts and both native clients | Four real databases and complete P-003 journeys | Real browser/client recordings and readable release-check report in 00012 |
| Maintainability review | Each task; final cross-package review in 00011 | Ownership, focused files, no duplicated security logic, affected checks after refactoring | Recheck affected screens if refactoring changes them |

A separate placeholder product/UI sprint is unnecessary: this extends existing
session pages and package behavior. Keep test substitutes near the tests. Build
real persistence before final page/client acceptance. Merge layout and interaction
work into the page task so neither is accepted as a disconnected mockup.

## Shared Working Rules

- Use Node 22 and Yarn, repository source conventions and owning-package tests.
  Read AGENTS.md and the relevant accepted context at execution time. Edit source,
  not compiled output; keep scripts separate from event/request adapters.
- Keep session independent of AI/API, types explicit, config serializable and
  responsibilities in their owning libraries. Use the package public-surface
  workflow when adding exports. Do not automatically load AI in the aggregate.
- Record before/after tests and coverage. Every changed package must meet the
  above-90% requirement, including meaningful branch/security cases. A missing
  suite is work to resolve, not a pass. Do not add tests that only mirror code.
- Run focused checks as each behavior changes, then real integration in 00011 and
  native journeys in 00012. Do not repeat broad suites without a new reason.
- Use isolated databases and explicit test accounts/resources. Preserve existing
  work and user configuration. Never commit secrets, raw credentials, private
  browser state or generated output that repository rules treat as disposable.
- No task publishes, deploys, changes outside application databases or invents a
  corrected dependency version. Inquire belongs in its own checkout; record any
  checkout/version handoff blocker instead of copying a local workaround.
- Do not silently edit Frozen behavior when implementation uncovers a conflict.
  Record the affected contract, evidence and requested reopening. Routine internal
  choices consistent with the contract need no new approval loop.

## Verification And Acceptance

Task state flows open → started → verified. Tasks 00001–00006, 00008–00009 and
00011 have `Acceptance criteria: none` and finish at verified. Tests, source review,
logs and JSON output are verification, not user acceptance.

Tasks 00007, 00010 and 00012 have existing human-reviewable outputs: browser pages,
rendered setup/upgrade docs and real-client recordings/report. They remain verified
until the user explicitly accepts the specified output, then become accepted.
Acceptance is not delegated. The instruction to freeze does not accept future code.
Do not create artificial screenshots/reports just to manufacture an approval gate.

Each task records changed files/revisions, exact commands, environment and results,
coverage, redacted evidence, blockers and review outcomes. Use actual available
package commands; the root verification document lists the intended commands.
After every task and any later required side work finishes, mark implementation
completed only when all tasks are verified with no visual criteria or accepted.

## Every Required Test Has An Owner

These are all 22 rows from [required tests](../verification.md#required-tests).
A task must preserve the full row's cases; this table allocates them rather than
replacing the detailed requirements. Task 00011 checks the integrated cases, and
00012 adds real native-client evidence where applicable.

| Required test family | Owning tasks |
| --- | --- |
| Login instructions | [00002](00002-oauth-types-config-and-startup.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md), [00009](00009-mcp-http-sse-and-current-identity.md) |
| Client documents | [00004](00004-client-registration-and-safe-metadata.md) |
| Client registration | [00004](00004-client-registration-and-safe-metadata.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md) |
| Return addresses | [00004](00004-client-registration-and-safe-metadata.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md), [00007](00007-approval-factor-and-connections-pages.md) |
| Approval | [00005](00005-approval-key-lifecycle-and-policy.md), [00007](00007-approval-factor-and-connections-pages.md) |
| Extra approval check | [00003](00003-oauth-schema-and-private-storage.md), [00007](00007-approval-factor-and-connections-pages.md) |
| Single-use code | [00005](00005-approval-key-lifecycle-and-policy.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md) |
| Key reply | [00005](00005-approval-key-lifecycle-and-policy.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md) |
| Client admission policy | [00004](00004-client-registration-and-safe-metadata.md), [00005](00005-approval-key-lifecycle-and-policy.md) |
| Access-key lifetime | [00005](00005-approval-key-lifecycle-and-policy.md), [00011](00011-production-cross-surface-and-database-checks.md) |
| Renewal | [00005](00005-approval-key-lifecycle-and-policy.md), [00009](00009-mcp-http-sse-and-current-identity.md), [00012](00012-real-client-journeys-and-release-evidence.md) |
| API/MCP key checks | [00005](00005-approval-key-lifecycle-and-policy.md), [00008](00008-api-shared-access-and-legacy-upgrade.md), [00009](00009-mcp-http-sse-and-current-identity.md) |
| Permission lists | [00008](00008-api-shared-access-and-legacy-upgrade.md), [00009](00009-mcp-http-sse-and-current-identity.md) |
| Mixed public/protected MCP tools | [00009](00009-mcp-http-sse-and-current-identity.md), [00012](00012-real-client-journeys-and-release-evidence.md) |
| API route enablement | [00002](00002-oauth-types-config-and-startup.md), [00008](00008-api-shared-access-and-legacy-upgrade.md) |
| Shared MCP/API key | [00008](00008-api-shared-access-and-legacy-upgrade.md), [00011](00011-production-cross-surface-and-database-checks.md), [00012](00012-real-client-journeys-and-release-evidence.md) |
| Read-ID protection | [00003](00003-oauth-schema-and-private-storage.md), [00005](00005-approval-key-lifecycle-and-policy.md), [00008](00008-api-shared-access-and-legacy-upgrade.md), [00009](00009-mcp-http-sse-and-current-identity.md) |
| Saved connections | [00009](00009-mcp-http-sse-and-current-identity.md), [00012](00012-real-client-journeys-and-release-evidence.md) |
| Connection methods | [00006](00006-oauth-protocol-routes-and-browser-guard.md), [00009](00009-mcp-http-sse-and-current-identity.md) |
| Existing apps | [00007](00007-approval-factor-and-connections-pages.md), [00008](00008-api-shared-access-and-legacy-upgrade.md), [00009](00009-mcp-http-sse-and-current-identity.md), [00010](00010-package-exports-blog-and-upgrade-docs.md), [00011](00011-production-cross-surface-and-database-checks.md) |
| Detailed contract additions | [00002](00002-oauth-types-config-and-startup.md), [00003](00003-oauth-schema-and-private-storage.md), [00004](00004-client-registration-and-safe-metadata.md), [00005](00005-approval-key-lifecycle-and-policy.md), [00006](00006-oauth-protocol-routes-and-browser-guard.md), [00007](00007-approval-factor-and-connections-pages.md), [00008](00008-api-shared-access-and-legacy-upgrade.md) |
| Database/package | [00001](00001-inquire-transaction-ownership.md), [00003](00003-oauth-schema-and-private-storage.md), [00010](00010-package-exports-blog-and-upgrade-docs.md), [00011](00011-production-cross-surface-and-database-checks.md) |

## Every Journey Has An Owner

| Journey | Main tasks | Final check |
| --- | --- | --- |
| J01 setup | 00001–00006, 00010 | 00011/00012 |
| J02 existing keys | 00003, 00008, 00010 | 00011/00012 |
| J03 signed-out approval | 00004, 00006, 00007 | 00012 |
| J04 approve/deny | 00004–00007 | 00012 |
| J05 fresh factor | 00003, 00007 | 00012 |
| J06 unavailable factor | 00005, 00007 | 00012 |
| J07 inactive account | 00005, 00007–00009 | 00011/00012 |
| J08 public discovery | 00006, 00009 | 00012 |
| J09 approved use | 00005, 00008, 00009 | 00011/00012 |
| J10 more permission | 00007–00010 | 00012 |
| J11 renewal | 00001, 00003, 00005, 00009 | 00011/00012 |
| J12 approval ended | 00005, 00007–00009 | 00012 |
| J13 list/disconnect | 00003, 00005, 00007–00009 | 00011/00012 |
| J14 sign-in to list | 00006, 00007 | 00012 |

The full [journey document](../journeys.md) controls all success/failure branches.
External client/account-support handoffs remain explicit; tests cannot claim to
implement third-party UI. No supported database, connection mode or accepted
person state is removed by this task split.

## Release Requirements Still Outstanding

P-001/P-004 prove candidate mechanisms, not production stores/handlers. P-002's
automatic escalation failure keeps the accepted explicit reapproval fallback.
P-003 complete production execution is deferred to 00012 and remains mandatory.
A local fixture pass cannot close that task. The Inquire correction and all four
database results are required; loss of a dependency never authorizes weaker checks.

Next: start 00001 in the owning repository, while preparing 00002 if appropriate.
All tasks are currently open. No production task ran during task-file creation.
