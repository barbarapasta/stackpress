# 00001 — Fix Inquire transaction ownership

Status: verified.
Owner: Inquire and its four database adapters in the owning sibling repository.
Stage: 2a; required before production storage.
Depends on: None. This task can be prepared independently.
Journeys: J01, J02, J09, J11, J13.
Contracts: [storage](../storage.md), [proof-results](../proof-results.md), [verification](../verification.md).

## Task Summary

Give each transaction exclusive use of its real database connection so concurrent requests cannot commit or undo each other’s work.

Follow the shared working and evidence rules in [sprint](sprint.md). The Frozen
contracts control behavior; these steps do not authorize changing them.

## Implementation Steps

1. Locate the complete Inquire checkout and its contributor rules. Record its commit, adapter versions, Node 22/Yarn commands and existing test results; do not edit compiled node_modules files as the fix.
2. Reserve/release a real connection for pooled databases. On a shared embedded database, serialize every native query and transaction, including ordinary queries made outside transaction callbacks.
3. Keep all callback statements on the reserved connection until commit/rollback finishes. Release ownership after errors and cancellation; reject unsupported nesting before BEGIN, without rolling back another transaction.
4. Preserve the supported transaction entry point where possible. Keep PGlite locking scoped to its native resource; use SQLite native locking across independent processes.
5. Turn the P-001 failures into regressions in the owning repository. Prepare the corrected dependency handoff with an exact tested revision/build and eventual coordinated version; do not invent a released version or publish packages.

## Verification Process

- Run real PGlite, PostgreSQL, MySQL and SQLite checks separately under Node 22: overlapping transactions, outside queries, native connection identity, nested calls and actual SQL rollback failures.
- Prove ownership is released after success, error and failed commit. Repeat the original failing baseline cases against the correction and record before/after outcomes.
- Run the owning library suites/builds and required coverage. Document unsupported multi-process PGlite access explicitly; never drop an accepted adapter.
- Provide the exact dependency and reproducible commands needed by task 00003. If an owning checkout/build is unavailable, record the blocker instead of substituting a Stackpress-only queue.

## Acceptance Criteria

Acceptance criteria: none. This task changes internal behavior; source review,
tests, builds and machine-readable results are verification, not visual acceptance.

## Implementation Notes

**Owning checkout**: `/home/solution-team/projects/inquire`, cloned from
`https://github.com/stackpress/inquire` (read-only, no push). Base commit
`039a1b5` (main). Fix committed locally (not pushed) on branch
`fix/transaction-ownership` at commit `d5f5a07`. Node 22.23.2, Yarn 1.22.22.
AGENTS.md commands used: `yarn install`, `yarn build`, `yarn test`
(root scripts fan out to all five packages: `inquire`, `inquire-pg`,
`inquire-mysql2`, `inquire-pglite`, `inquire-sqlite3`).

**Root cause**: every adapter's `Connection.transaction()` ran
`BEGIN`/`COMMIT`/`ROLLBACK` directly on the one native resource cached in
`_resource`, with no ownership boundary. Two overlapping
`engine.transaction()` calls (or an ordinary `engine.query()` call issued
while a transaction was open) shared that same resource and could
commit/rollback/join each other's work. Confirmed by reading the published
`Engine`/`Connection`/adapter source (no prior fix existed) and reproducing
each proof-results.md failure against it before making any change.

**Fix** (all four adapter packages, `packages/inquire-pg`,
`packages/inquire-mysql2`, `packages/inquire-pglite`,
`packages/inquire-sqlite3`, plus a new shared primitive in
`packages/inquire`):
- Added `packages/inquire/src/Lock.ts` (exported as
  `@stackpress/inquire/Lock`): an `AsyncLocalStorage`-backed FIFO queue.
  `queue()` serializes ordinary queries behind any open transaction;
  `transact()`/`reserve()` reserve a native resource for an owner for the
  duration of an async chain; `active()` lets a connection tell a truly
  nested transaction call (same async chain — would deadlock if queued)
  apart from a separate concurrent caller (different chain — safe to
  queue behind).
- **Single shared resource** (a `pg.Client`/`PoolClient`, a plain mysql2
  `Connection`, the one PGlite session, or the one better-sqlite3
  `Database`): every transaction and every ordinary query now goes
  through one `Lock` per `Connection` instance, so nothing can interleave
  with an open transaction's statements. Queries issued from inside the
  transaction's own callback bypass the queue (they already hold
  ownership) instead of deadlocking behind themselves.
- **Real pools** (`pg.Pool` detected via `.totalCount`/`.connect`;
  `mysql2/promise` `Pool` detected via `.getConnection`): `transaction()`
  now acquires ("reserves") a dedicated connection via
  `pool.connect()`/`pool.getConnection()`, runs BEGIN/callback/
  COMMIT-ROLLBACK on it, and always releases it in a `finally` block.
  Concurrent pooled transactions run on independent native connections
  (verified via `pg_backend_pid()` / `CONNECTION_ID()` and by timing two
  concurrent `pg_sleep(0.3)`/`SLEEP(0.3)` transactions completing in
  ~300ms, not ~600ms). Ordinary queries against a pool go straight to the
  pool's own `.query()`/`.execute()`, which already acquires/releases a
  connection per call.
- **Nested transactions**: `transaction()` checks `Lock.active(this)`
  synchronously before BEGIN and throws
  `Exception.for('Nested transactions are not supported.')` immediately,
  without touching the outer transaction's rollback — matches storage.md
  "reject unsupported nesting before BEGIN, without rolling back another
  transaction."
- **Rollback-after-error**: rollback is now wrapped in its own try/catch
  in every adapter so a failing rollback never masks the original error
  that triggered it.
- **SQLite**: `transaction()` now issues `BEGIN IMMEDIATE` (was
  `BEGIN TRANSACTION`) so the write lock is acquired up front, and
  `resource()` applies a default `busy_timeout = 5000` once per resolved
  database handle if the caller has not already set one. This makes
  cross-process serialization rely on SQLite's own file lock (verified by
  forking a separate OS process — `packages/inquire-sqlite3/tests/worker.mjs`
  — that opens the same file and writes while the parent holds an open
  transaction), not merely the in-process `Lock`, per storage.md "use
  SQLite native locking across independent processes."
- **PGlite**: no pool concept exists; kept on the single-shared-resource
  path above so its one native session is queued for every transaction
  and every query outside a transaction, per storage.md "queue is scoped
  to its native resource."
- The public transaction entry point (`engine.transaction(callback)` /
  `connection.transaction(callback)`, callback receives the same
  `Connection` instance) is unchanged.
- `packages/inquire-pg/src/types.ts` and
  `packages/inquire-mysql2/src/types.ts`: widened `Resource` to also
  accept `Pool` (`pg`) / `Pool` (`mysql2/promise`).

**Regressions added** (all real, no mocks; turn P-001 into failing-then-passing
tests in the owning repository):
- `packages/inquire/tests/Lock.test.ts` — unit tests for the new
  primitive (queueing order, error recovery, reservation isolation,
  nested-transaction rejection semantics).
- `packages/inquire-pg/tests/TransactionOwnership.test.ts` — real
  PostgreSQL: single-Client mode (nested rejection, concurrent-transaction
  serialization/no-lost-update, ordinary query cannot join an open
  transaction, real SQL failure rolls back, ownership released after
  success/error, all statements stay on the same native connection) and
  Pool mode (distinct native connection per transaction via
  `pg_backend_pid()`, true concurrency via timing, connection released
  back to the pool after commit/error, nested pooled transaction
  rejected).
- `packages/inquire-mysql2/tests/TransactionOwnership.test.ts` — same
  matrix against real MySQL (`CONNECTION_ID()` for connection identity).
- `packages/inquire-pglite/tests/TransactionOwnership.test.ts` — same
  matrix (minus pool mode, which does not apply) against a real embedded
  PGlite instance.
- `packages/inquire-sqlite3/tests/TransactionOwnership.test.ts` plus
  `tests/worker.mjs` — same matrix against real better-sqlite3, plus the
  cross-process native-locking case.
- Confirmed these are genuine regressions, not tautologies: stashed only
  the `src/` fix (keeping the new tests and Lock.ts removed from the
  import graph) and reran — all of the above failed with the exact
  proof-results.md symptoms (lost updates `[1,2,3,4,5]` instead of
  `[1,3,6,10,15]`, ordinary query observed mid-transaction, nested call
  silently accepted or crashing the adapter, `resource.rollback is not a
  function` for pool mode). Restored the fix and reran clean before
  committing.

**Dependency handoff for task 00003** (do not invent a release version;
this is the exact tested revision, not a publish):
- Exact tested revision: `fix/transaction-ownership` branch,
  commit `d5f5a07` in `/home/solution-team/projects/inquire`
  (based on main `039a1b5`; not pushed — read-only GitHub access).
- Locally consumable build: `.handoff/stackpress-inquire-0.10.8-d5f5a07.tgz`,
  `.handoff/stackpress-inquire-pg-0.10.8-d5f5a07.tgz`,
  `.handoff/stackpress-inquire-mysql2-0.10.8-d5f5a07.tgz`,
  `.handoff/stackpress-inquire-pglite-0.10.8-d5f5a07.tgz`,
  `.handoff/stackpress-inquire-sqlite3-0.10.8-d5f5a07.tgz`, all under
  `/home/solution-team/projects/inquire/.handoff/`, produced with
  `yarn pack --filename <path>` run from each package directory after
  `yarn build` at the repository root. Version strings inside the
  tarballs remain `0.10.8` (unchanged) — the filename, not the semver, is
  what identifies this as the corrected build; task 00003 (or a later
  coordinated release) picks the eventual real version bump.
- Consume locally (example, from a Stackpress package or a scratch
  project) by pointing at the tarball with a `file:` dependency, e.g. in
  `package.json`:
  `"@stackpress/inquire-sqlite3": "file:/home/solution-team/projects/inquire/.handoff/stackpress-inquire-sqlite3-0.10.8-d5f5a07.tgz"`
  (and the matching `@stackpress/inquire` tarball, since the adapters
  depend on it), then `yarn install`. Verified end-to-end with a scratch
  project (`yarn install` + a real `better-sqlite3` transaction exercising
  the new nested-rejection behavior) before recording this handoff.
- To reproduce the fix/tests from scratch: `cd
  /home/solution-team/projects/inquire && git checkout
  fix/transaction-ownership && source ~/.nvm/nvm.sh && nvm use 22 && yarn
  install && yarn build && yarn test`. PostgreSQL/MySQL regression tests
  additionally need a disposable server reachable at the host/port in
  `packages/inquire-pg/tests/TransactionOwnership.test.ts` /
  `packages/inquire-mysql2/tests/TransactionOwnership.test.ts`
  (`OAUTH_PROOF_PG_*` / `OAUTH_PROOF_MYSQL_*` env vars override the
  127.0.0.1:55555 / 127.0.0.1:55556 defaults used here); this task used
  disposable Docker containers (`postgres:17-alpine`,
  `mysql:8.4`, `POSTGRES_HOST_AUTH_METHOD=trust` /
  `MYSQL_ALLOW_EMPTY_PASSWORD=yes`, database `inquire_proof`) started and
  removed for this run only, not any existing project container.

**No Frozen-contract conflicts found.** The design matches storage.md's
"For pools, reserve/release a real connection; for a shared embedded
resource, serialize every native query and transaction" and "Keep PGlite
locking scoped to its native resource; use SQLite native locking across
independent processes" without needing any contract change.

**2026-10-15 update**: the nested-transaction rejection this task shipped
broke `yarn push` (Inquire's own `Create`/`Alter` builders and
`stackpress-sql`'s outer transaction wrap both call `transaction()` from
inside an already-open transaction). See
[00001A](00001A-inquire-nested-transaction-join.md), commit `d41472e`
(supersedes `d5f5a07` in the dependency handoff above) — a nested call now
joins the outer transaction instead of being rejected.

## Verification Notes

Environment: Node 22.23.2 (via `source ~/.nvm/nvm.sh && nvm use 22`),
Yarn 1.22.22, macOS-free Linux container with Docker 29.8.1. Disposable
`postgres:17-alpine` on 127.0.0.1:55555 and `mysql:8.4` on
127.0.0.1:55556, both removed after this run.

- `yarn build` (repository root, all 5 packages): pass, no TypeScript
  errors, before and after the fix.
- `yarn test` (repository root, all 5 packages) after the fix: **233
  passing, 0 failing** —
  `inquire` 168 passing (160 pre-existing + 8 new `Lock.test.ts`),
  `inquire-mysql2` 20 passing (10 pre-existing + 10 new),
  `inquire-pg` 19 passing (9 pre-existing + 10 new),
  `inquire-pglite` 18 passing (12 pre-existing + 6 new),
  `inquire-sqlite3` 18 passing (12 pre-existing + 6 new).
  No pre-existing test was modified or deleted.
- Before/after baseline: with only the four `src/Connection.ts` fixes and
  `Lock.ts` temporarily removed (`git stash` of just those files, new
  test files and `Lock.test.ts` left in place), reran the new
  `TransactionOwnership.test.ts` suites: **16 of 26 new tests failed**
  against the original code (3 sqlite3, 3 pglite, 4 pg-single-client,
  1 pg-pool-nested, 3 mysql2-single-connection, 4 mysql2-pool — mysql2
  pool mode additionally crashed with `resource.rollback is not a
  function` since a mysql2 `Pool` has no `beginTransaction`/`commit`/
  `rollback`), with failure symptoms matching proof-results.md exactly
  (lost updates, ordinary query observed mid-transaction, nested call
  silently accepted). Restored the fix; all 26 passed again. Stash
  applied/dropped, not left dangling.
- Coverage (`nyc --reporter=text`, `NODE_OPTIONS` ESM loader hook per
  root `report:env` script), changed packages only:
  - `packages/inquire` (`yarn report`): 95.54% stmts / 79.04% branch /
    96.52% funcs overall; `Lock.ts` itself 100/100/100. (Not all files in
    this package changed — `Exception.ts` at 0% is pre-existing and
    untouched by this task.)
  - `packages/inquire-pg`: `Connection.ts` 95.23% stmts / 96.42% branch /
    85.71% funcs.
  - `packages/inquire-mysql2`: `Connection.ts` 96.82% stmts / 93.33%
    branch / 93.33% funcs.
  - `packages/inquire-pglite`: `Connection.ts` 90.74% stmts / 83.33%
    branch / 84.61% funcs (uncovered lines are pre-existing
    `before`/`lastId` getters and `format()` exception branches, not
    introduced by this fix).
  - `packages/inquire-sqlite3`: `Connection.ts` 92.85% stmts / 93.54%
    branch / 76.92% funcs.
  - All five changed packages meet the sprint's above-90% statement-
    coverage bar; no package was skipped.
- Required-check coverage against verification.md's list for this task:
  overlapping transactions ✅ (all 4 DBs, lost-update assertion), outside
  queries ✅ (ordinary query cannot join an open transaction, all 4 DBs),
  native connection identity ✅ (`connection.before` hook asserts every
  statement in a transaction sees the same native resource, pg/mysql2/
  pglite/sqlite3; pg/mysql2 pool mode additionally asserts *different*
  connections across concurrent transactions), nested calls ✅ (rejected
  before BEGIN, outer transaction unaffected, all 4 DBs and pg/mysql2
  pool mode), actual SQL rollback failures ✅ (insert into a nonexistent
  table forces a real driver error and full rollback, all 4 DBs),
  ownership released after success/error/cancellation ✅ (a later
  transaction always succeeds after a prior success or a prior forced
  failure, all 4 DBs and pools).
- Multi-process PGlite access: not supported, as documented in
  storage.md and the proof; this task did not attempt it and the
  PGlite adapter's lock remains explicitly scoped to one process (see
  code comment in `packages/inquire-pglite/src/Connection.ts`). SQLite's
  cross-process case (the one PGlite cannot support) is exercised
  directly with a forked OS process.
- No accepted adapter was dropped; `Resource`/`Connector` types for
  pg and mysql2 were widened (`Pool` added), not narrowed.
- Dependency handoff for task 00003 verified end-to-end (see
  Implementation Notes): tarballs built after a clean `yarn build`,
  installed into a scratch project via `file:` dependency, and exercised
  with a real `better-sqlite3` transaction.

## Acceptance Notes

No visual acceptance is required (`Acceptance criteria: none`). All
verification items above passed; nothing here is marked accepted, per the
sprint's task-state rule that this task finishes at verified.
