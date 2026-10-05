# Task 00010B: Correct Review Findings And Source Standards

## Task Summary

The user approved the fixes in [the feature review](../../../../docs/agent-native-ai-review.md)
on 2026-10-05 and requested strict adherence to the CTO's repository standards.
This task corrects the accepted implementation without rewriting the Frozen
product decisions. It does not edit the pilot application or publish a release.

## Implementation Steps

1. Guard the blog's app-owned write operations with the user's normal access.
2. Coordinate thread execution and provider admission durably across runtimes.
3. Bind approvals to the proposed execution contract and refuse changed tools.
4. Include undo outcomes in subsequent provider requests and paginate history.
5. Normalize unanswered tool events as failures for MCP and the built-in agent.
6. Align public type exports, remove unused unreleased store methods, and fix
   import grouping and whitespace using current repository conventions.
7. Update affected documentation and source-backed knowledge after verification.

## Verification Process

- Node 22 and Yarn; package tests above 90% in all four coverage totals.
- Isolated database regressions across separate runtime instances for concurrent
  thread work, admission limits, approval races, and contract changes.
- Real application operations for USER/MANAGER refusal and ADMIN success,
  including undo; the blog application suite must discover and run tests.
- Full histories beyond 1,000 records and model-visible undo results.
- Real MCP failure mapping and successful null result preservation.
- Built consumer type checks for both root and types imports, root build,
  schema generation/import, workspace validator, and whitespace checks.

## Acceptance Criteria

The readable review document records each resolved finding, the final behavior,
and fresh verification with any evidence limits. Internal state transitions
have no separate visual output; their acceptance relies on that explanation.

## Implementation Notes

Started on 2026-10-05. Sonnet 5.5 agents use medium reasoning and auto mode;
the primary agent coordinates and independently verifies the combined changes.
No broad formatting migration or invented lint policy is included.

## Verification Notes

Verified by the primary agent on 2026-10-05 with Node 22 and Yarn:

- Clean root build and optional desktop build pass.
- AI suite: 777 passing; statements 96.09%, branches 91.23%, functions 96.59%,
  lines 96.85%. All four package totals exceed 90%.
- Clean/repeat blog generation and generated-handler tests: 28 passing.
  Tests use isolated databases and offline adapters, never the app database.
- Public source and built declarations pass for root and types imports. A
  packed external consumer also compiles both and loads all 17 ESM entries.
  It reuses installed dependency links; no fresh registry install was claimed.
- Real MCP tests preserve null success and refuse missing handlers. Route and
  panel tests preserve busy reasons, input and approval cards across retry.
- Feature-range whitespace and workspace validator pass; the latter retains
  its existing preferred-length warning for reference 00010.

The review document records the inherited native CommonJS import defect and
pre-feature blog desktop-menu type mismatch. No live provider, hosting-platform
or new browser test was run. Durable coordination tests use PGlite only.
Manual lock recovery and regeneration/migration of the revised schema are
explicitly documented. The user authorized committing the corrections on 2026-10-05; no push was
requested.

## Acceptance Notes

The user authorized implementation. The repaired result has not yet been
accepted separately.
