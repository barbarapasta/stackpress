# 00001A — Let a nested Inquire transaction join the outer one

Status: verified.
Parent: [00001](00001-inquire-transaction-ownership.md).
Owner: the local Inquire fix branch at `~/projects/inquire` (`fix/transaction-ownership`).
Found by: [00010](00010-package-exports-blog-and-upgrade-docs.md).

## Why This Side Task Exists

Task 00001's fix rejects any `transaction()` call made while the same
connection already has a transaction open in the same async chain. Inquire's
own `Create` and `Alter` builders call `engine.transaction()` internally, and
`stackpress-sql`'s `scripts/install.ts` (used by `yarn push`) wraps the whole
drop-and-create sequence in an outer `database.transaction()`. So `yarn push`
fails with "Nested transactions are not supported." on every app, schema and
database adapter. The old Inquire allowed this nesting but sent a second BEGIN
and an early COMMIT. The user approved on 2026-10-15 changing the local fix so
an inner call joins the outer transaction. Savepoints were rejected because
MySQL table creation implicitly commits, which destroys savepoints.

## Task Summary

A `transaction()` call made inside an already-open transaction on the same
connection and async chain runs its callback on the outer transaction's
reserved connection. It sends no BEGIN, COMMIT or ROLLBACK of its own. Errors
propagate to the outer transaction, which rolls everything back. Unrelated
concurrent callers keep exclusive ownership exactly as before.

## Implementation Steps

1. In `~/projects/inquire` on `fix/transaction-ownership`, replace the
   nested-call rejection in all four adapters with join behavior that reuses
   the reserved connection. Keep the shared `Lock` primitive's ownership,
   queuing and pool reservation unchanged for unrelated callers.
2. Update the regression tests. Nested calls now join, and an inner error
   rolls back the whole outer transaction, including work done before the
   inner call. Concurrent callers still never share or interleave. Ownership
   is released after success, error and failed commit. A `Create` or `Alter`
   builder inside an outer transaction works.
3. Commit locally (no push), rebuild, and `yarn pack` new tarballs named with
   the new short commit SHA into `~/projects/inquire/.handoff/`. Delete the old
   `d5f5a07` tarballs only after the Stackpress worktree no longer references
   them.
4. In the Stackpress worktree, point the root `package.json` `resolutions`
   block at the new tarballs and run `yarn install`. This side task is
   authorized to change that block. Confirm `node_modules/@stackpress/inquire`
   holds the new build.

## Verification Process

- Inquire repo: `yarn build` and `yarn test` on all four databases, under
  Node 22, with each changed package above 90% coverage.
- Stackpress: run the stackpress-sql suite and all stackpress-session adapter
  suites on all four databases, confirming each shows passing, not pending.
- Run `yarn push` for `templates/blog` on PGlite from a clean `.build`, and on
  at least one pooled engine (PostgreSQL). It must succeed and create every
  table, including the nine OAuth tables. Clean up generated state afterwards.
- Correct `docs/oauth-upgrade.md`: remove the nested-transaction release limit
  and the wrong "use a different database" workaround, and record the new
  Inquire commit.

## Acceptance Criteria

Acceptance criteria: none. Tests and command results are verification, not
visual acceptance.

## Implementation Notes

Done 2026-10-15 in `/home/solution-team/projects/inquire`, branch
`fix/transaction-ownership`, commit `d41472e` (based on `d5f5a07`; not
pushed). Node 22.23.2, Yarn 1.22.22.

**Fix (all four adapters, `packages/inquire-pg`, `packages/inquire-mysql2`,
`packages/inquire-pglite`, `packages/inquire-sqlite3`).** Each adapter's
`Connection.transaction()` nested-call guard changed from throwing
`Exception.for('Nested transactions are not supported.')` to:
```ts
if (this._lock.active(this)) {
  return await callback(this);
}
```
A nested call now runs its callback directly on `this` (the same
`Connection` instance), with no BEGIN/COMMIT/ROLLBACK of its own. Because
`resource()` already resolves to the outer transaction's reserved native
resource when `Lock.active(this)` is true (the `reserved()` lookup added by
00001), every statement — outer and inner — lands on the exact same
native connection/session/pool-checkout. An error thrown inside the nested
call is not caught locally; it propagates up through the nested
`transaction()` call and into the *outer* transaction's own try/catch,
which issues the real ROLLBACK and rolls back everything, including work
the outer transaction did before the nested call. Unrelated concurrent
callers are unaffected: `Lock`'s queuing/reservation (`active()`,
`reserved()`, `transact()`, `reserve()`, `queue()`) is untouched by this
task — the join behavior lives entirely in each adapter's `transaction()`,
not in the shared primitive. Savepoints were rejected per the user's
2026-10-15 decision (MySQL's implicit DDL commit on `CREATE`/`ALTER TABLE`
destroys savepoints).

`Exception` import removed from `inquire-mysql2`/`inquire-sqlite3`'s
`Connection.ts` (no longer referenced there; `inquire-pg`/`inquire-pglite`
still use it in `format()`). Added an explicit `Promise<R>` return-type
annotation to all four `transaction()` methods — needed once the method
could return `callback(this)` directly, otherwise `tsc` reports TS7023
(implicit `any` return from self-referential inference) in
`inquire-mysql2`.

**Regressions updated** (all four `TransactionOwnership.test.ts` suites):
replaced each "reject a nested transaction" test with: (1) a join test
asserting the result returns normally, no second BEGIN/COMMIT fires
(tracked via the `before` hook counting distinct native resources seen,
stays at 1), and the outer write plus the nested write both land; (2) a
rollback test asserting a nested-call error rolls back the whole outer
transaction including the outer's own prior write; (3) a new test using
Inquire's own `Create` builder (`@stackpress/inquire/Create`) inside an
outer `engine.transaction()` to prove the real caller shape from
`stackpress-sql`'s `install.ts` works, not just a synthetic nested call.
PG and MySQL pool-mode suites similarly replaced their nested-pooled-reject
test with one proving the nested call reuses the outer's already-reserved
pool connection (same `pg_backend_pid()`/`CONNECTION_ID()`) instead of
checking out a second one. `Lock.test.ts` unchanged — the primitive itself
has no nested-rejection logic to update.

**Handoff tarballs**: rebuilt (`yarn build`, all 5 packages, clean) and
`yarn pack`'d into `~/projects/inquire/.handoff/*-0.10.8-d41472e.tgz`
(version strings still `0.10.8`, filename carries the commit as before).
The prior `d5f5a07` tarballs were deleted after the Stackpress worktree's
`resolutions` block was repointed and `node_modules/@stackpress/inquire*`
confirmed to hold the new build (verified by `grep`-ing the installed
`cjs/Connection.js` for the join code, not the throw).

**Stackpress worktree**: root `package.json` `resolutions` block
repointed at the five `d41472e` tarballs (uncommitted, per this task's
authorization); `yarn install` run; confirmed via `grep` that
`node_modules/@stackpress/inquire-pglite/cjs/Connection.js` and
`inquire-sqlite3`'s equivalent contain `return yield callback(this);`
under the `active(this)` branch, not the old throw.

**docs/oauth-upgrade.md**: removed the "PGlite/Inquire reject a nested
transaction" release-limit entry and its "call `scripts.install(engine)`
directly / use a different database engine" workaround; replaced with a
short note that nested transactions now join and `yarn push` succeeds on
PGlite and on a pooled PostgreSQL engine. Also updated the "Unpublished
Inquire fix" section's commit reference from `d5f5a07` to `d41472e` so the
documented resolutions-block path matches what's actually pinned.

No Frozen-contract conflict: this only changes Inquire's own (non-Frozen)
behavior to match the user-approved 2026-10-15 decision recorded in this
task file's "Why This Side Task Exists" section.

## Verification Notes

Node 22.23.2 (`nvm use 22`), Yarn 1.22.22, 2026-10-15. Disposable
`postgres:17-alpine` on 127.0.0.1:55555 and `mysql:8.4` on 127.0.0.1:55556
(databases `inquire_proof` and `oauth_proof` both created in the same two
containers), removed after this run; no existing project container used
or touched.

- **Inquire `yarn build`** (all 5 packages): pass, no TypeScript errors.
- **Inquire `yarn test`** (all 5 packages, under the disposable containers):
  **251 passing, 0 failing** — `inquire` 168, `inquire-mysql2` 22,
  `inquire-pg` 21, `inquire-pglite` 20, `inquire-sqlite3` 20. No
  pre-existing test outside the nested-transaction cases was changed.
- **Inquire coverage** (`nyc --reporter=text`, same env hook as 00001),
  changed packages only — all above the 90% statement bar, matching/
  exceeding 00001's baseline:
  - `inquire` (`Lock.ts` untouched this task): 95.54% stmt / 79.04% branch
    / 96.52% func overall; `Lock.ts` itself 100/100/100.
  - `inquire-pg` `Connection.ts`: 95.23% stmt / 96.42% branch / 85.71% func.
  - `inquire-mysql2` `Connection.ts`: 96.82% stmt / 93.33% branch / 93.33%
    func.
  - `inquire-pglite` `Connection.ts`: 90.74% stmt / 83.33% branch / 84.61%
    func.
  - `inquire-sqlite3` `Connection.ts`: 94.64% stmt / 93.54% branch / 84.61%
    func.
- **Stackpress `stackpress-sql` suite**: `yarn sql test` — 23 passing, 0
  failing (unchanged from pre-task behavior; this task did not modify
  `stackpress-sql` source).
- **Stackpress `stackpress-session` suite, all four databases**: `yarn
  session test` with `OAUTH_00003_PG_*`/`OAUTH_00003_MYSQL_*` and
  `OAUTH_00008_PG_*`/`OAUTH_00008_MYSQL_*` pointed at the two disposable
  containers — **735 passing, 0 failing, 0 pending**. Confirmed every
  PostgreSQL/MySQL/PGlite/SQLite adapter describe block shows `✔`, not `-`
  (pending); with no env vars pointed at a container, 48 of these would
  `this.skip()` as PG/MySQL-only — not the case here. Coverage 91.26%/
  84.02%/93.43%/92.18% (stmt/branch/func/line), above the 90% bar.
- **`yarn push` against PGlite**, `templates/blog`, clean `.build`
  (`rm -rf .build node_modules/blog-client` before `yarn generate` then
  `yarn push`): succeeds, creates all 18 tables including the nine
  `oauth_*` tables (confirmed via a direct PGlite query against
  `information_schema.tables`). No more "Nested transactions are not
  supported." error.
- **`yarn push` against pooled PostgreSQL**: `templates/blog/plugins/
  store/connect.ts` temporarily swapped (backed up first to
  `/tmp/oauth-00001a-connect.ts.bak`) to `stackpress/pgsql`'s `connect()`
  over a real `pg.Pool` pointed at the disposable container instead of
  PGlite, same generated client; `yarn push` succeeds, all nine `oauth_*`
  tables plus the other eight confirmed present via `psql`. `connect.ts`
  restored from the backup immediately after (`diff` confirmed byte-
  identical to the pre-change version; `git status` shows no diff for
  that file).
- **Cleanup**: `templates/blog/.build`, regenerated
  `node_modules/blog-client`, and `node_modules/.vite` removed after both
  `push` runs. Both disposable Docker containers (`inquire-proof-pg`,
  `inquire-proof-mysql`) removed. `/tmp/oauth-00001a-connect.ts.bak` and
  `/tmp/session-test-output*.log` removed. No process left running
  (`ps -u $USER` checked clean of anything this task started).

## Acceptance Notes

No visual acceptance is required (`Acceptance criteria: none`). All
verification items above passed.
