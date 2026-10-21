# 00007A — Bring stackpress-session package coverage back above 90%

Status: verified (2026-10-15).
Parent: [00007](00007-approval-factor-and-connections-pages.md).
Owner: `packages/stackpress-session` test suite.
Depends on: 00007 source changes (already in the worktree).

## Why This Side Task Exists

Task 00007's browser-page tests load the existing sign-in, session and profile
code, so the coverage tool now counts those files. The package-wide figure
dropped to 78.91%, even though the new 00007 code is well covered. The
[sprint](sprint.md) rule says every changed package must stay above 90%, and a
gap is work to resolve, not a pass. This is the same situation as
[00002A](00002A-ai-api-package-coverage.md) for stackpress-ai and stackpress-api,
so this side task is plainly required and proceeds without a separate proposal.

## Task Summary

Add meaningful tests for the existing, previously untested stackpress-session
code so the whole package exceeds 90% coverage, including branch and
security-relevant cases.

## Implementation Steps

1. Record current per-file coverage for the package using `yarn test`.
2. Add tests for untested existing behavior, most security-relevant first:
   sign-in, sign-up and sign-out flows, session and cookie handling,
   authorization/access checks, password and token handling, error branches.
   Follow the existing test style and helpers.
3. Test the behavior described by the source and documentation, not
   line-by-line mirrors of the implementation. Make no production source
   changes unless a test exposes a real defect. If one does, record the
   defect, make the smallest fix and note it.
4. If some code cannot be reached without infrastructure owned by a later task,
   record it explicitly instead of faking coverage.

## Verification Process

- Run `yarn test` with coverage for the package under Node 22. Statements and
  lines must exceed 90%, with branches reported.
- Run type checks and the build. Confirm every 00003–00007 test still passes.

## Acceptance Criteria

Acceptance criteria: none. Tests and coverage reports are verification, not
visual acceptance.

## Implementation Notes

Added direct, real-stack tests (real PGlite engine, no mocks) for the
previously-untested `src/auth`, `src/profile` and `src/session` code, all
under `packages/stackpress-session/tests/`, flat one level deep so the
package's unquoted `tests/**/*.test.ts` glob still picks them up (confirmed
with `echo tests/**/*.test.ts`, 51 files, none dropped):

- `auth/AuthActions.test.ts` (28 cases) — `assert()` password-policy
  branches (min/max/upper/lower/number/special), `signup` (username/email/
  phone, duplicate-token error shape), `signin` (success + consumed-advance,
  unknown identity, wrong password, passwordless `password=false`), and
  `create`/`update`/`upsert`/`remove`/`restore`/`delete`/`batch`/`count`
  including the duplicate-token and rollback-on-error paths.
- `auth/AuthStore.filters.test.ts` (7 cases) — the `q`/`like`/`ne`/`ge`/`le`
  query-builder filter branches, `scalarize`/`unscalarize` round-tripping
  (token/secret encrypt-at-rest), and relation-prefixed `selectors()`.
- `auth/columns.test.ts` (53 cases) — every auth column's required-field
  `assert()` branch and the Date/object/number serialize-unserialize
  branches, parameterized once per column group (string, boolean, date).
- `auth/lifecycle.test.ts` (3 cases) — `install`/`upgrade`/`uninstall` for
  both `AuthActions` and `ProfileActions`, including `alter()`'s field-diff
  loop (a same-shape "upgrade" still runs the comparison before Inquire's
  dialect rejects the resulting empty ALTER, so the test asserts that
  specific rejection rather than faking a schema difference to force a
  write).
- `profile/ProfileActions.test.ts` (18 cases), `profile/ProfileStore.filters.test.ts`
  (9 cases) and `profile/columns.test.ts` (50 cases) — the same shape of
  coverage as the two `auth/` files above, plus `has`/`hasnt` array-contains
  filters against the `roles`/`tags` array columns (Auth has no array
  column, so the equivalent branches there are an honest, recorded gap —
  see below).
- `session/helpers.test.ts` (21 cases) — `matchEvent`/`matchAnyEvent`/
  `matchRoute`/`matchAnyRoute` (exact, wildcard, double-star, regexp-string,
  method `ALL`), `base32Decode` (including the invalid-character throw),
  and `generateTOTP`/`verifyTOTP`/`generateSecret`.
- `session/Session.test.ts` (13 cases) — `SessionServer.create`/`load`/
  `data`/`guest`/`can`/`permits`/`authorization`/`save`, and the static
  `authorize()` guard (open-access passthrough, 401 denial, route-permitted
  signed-in pass), using small request/response doubles (no HTTP server
  needed for this unit-level class).

**One real defect found and fixed** (smallest-possible fix, per this task's
own step 3): `AuthActions.create()`'s PGlite/PostgreSQL return branch
(`packages/stackpress-session/src/auth/AuthActions.ts`, the `rows.length > 0`
path) called `this.store.unserialize(rows[0])`, which is `AuthSchema`'s
plain unserialize — it does **not** decrypt `token` (that schema method is
shared with input-sanitization round-tripping, where decrypting a
not-yet-encrypted caller-supplied token would be wrong). But `rows[0]` here
is a raw DB row, already encrypted at rest by `scalarize()`'s
`column.serialize(value, true)`. So every `create()`/`signup()`/`upsert()`-
via-create() caller on PostgreSQL/PGlite got back an **encrypted-looking
token** in the returned record, while `find()`/`findAll()` (which decrypt
correctly via their own per-column `unserialize(value, true)` pass) and the
MySQL/SQLite fallback branch (`find()` after insert) both returned the
correct plaintext token. Fixed by decrypting `token` explicitly in that one
branch, matching what every other read path already does; see the comment
left in `AuthActions.ts`. Three of this task's own tests
(`signup: creates a profile plus a username credential`, `...email and phone
credentials together`, `upsert: creates when no id...`) failed before this
fix and pass after it — confirmed by reverting the fix locally and re-running
just those three, then reapplying it.

**Honest, recorded gaps** (not blocking `verified`; none regress existing
behavior):
1. `AuthStore.whereArrayContains`/`whereArrayNotContains` and the `where()`
   `has`/`hasnt` branches (AuthStore.ts) stay uncovered: the `Auth` table has
   no array/JSON column (`roles`/`tags` are Profile-only), so a real
   `has`/`hasnt` filter against any Auth column is not a valid query — tried
   it directly (`auths.findAll({ has: { type: 'username' } })`) and Postgres
   correctly rejects it (`operator does not exist: character varying ? unknown`).
   Forcing a call that always throws would not be real coverage; left as a
   gap, matching this task's own step 4 ("record it explicitly instead of
   faking coverage"). The equivalent code is already covered on the Profile
   side (`has`/`hasnt` against `tags`).
2. `src/auth/plugin.ts`/`src/session/plugin.ts` (route-registration-only
   files, 72–75%), `src/auth/events/signin.ts` (77%), `src/auth/pages/signin/
   2fa.ts` (58%) and `src/session/pages/authorize.ts` (83%) remain below
   their individual 90% line, even though the package total clears the bar.
   These all require a real HTTP request/response round trip (not just a
   direct function call) to exercise meaningfully, which 00007's own
   `tests/oauth/browser-app.ts` harness already partially does incidentally
   (sign-in, 2FA sign-in) for the paths OAuth's browser pages touch. A
   dedicated auth/session-only HTTP harness for the remaining branches
   (2FA setup/removal, signin's own missing-account-data and `auth-search`
   failure branches, the global `request`-hook authorize guard with no
   access list vs. with one) is additional scope beyond "bring the package
   back above 90%" and is not required to clear the stated bar — flagging
   for a future task if deeper coverage of those specific files is wanted.

## Verification Notes

Environment: Node v22.23.2 (`source ~/.nvm/nvm.sh && nvm use 22`), Yarn
1.22.22, this worktree, Inquire d5f5a07 override (unchanged).

Compile, clean on both module formats:
```
(cd packages/stackpress-session && npx tsc -p tsconfig.cjs.json --noEmit && npx tsc -p tsconfig.esm.json --noEmit)
```
`packages/stackpress-session && yarn build`: clean (tsc cjs+esm, package.json
stamping).

**Before** (`yarn test`, PGlite only, no containers): 461 passing, 72
pending, 0 failing; **78.91%** statements / 71.07% branch / 84.31% funcs /
79.57% lines (the drop 00007 found and this task exists to fix).

**After** (`yarn test`, PGlite only, no containers, 51 test files confirmed
by `echo tests/**/*.test.ts`): **687 passing, 48 pending, 0 failing**;
**91.03%** statements / 83.79% branch / 92.89% funcs / 91.94% lines — both
statements and lines above the 90% bar this task's Verification Process
requires.

**All four databases**, disposable tmpfs containers under
`flock /tmp/oauth-db.lock` (`oauth-00007a-pg` on 55581, `oauth-00007a-mysql`
on 55582, same shape as prior tasks' runs), with the `OAUTH_00003_*`/
`OAUTH_00008_*` env vars both `store-adapters`/`client-store-adapters`/
`legacy-store-adapters` suites read:
```
docker run -d --rm -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=oauth_proof -p 127.0.0.1:55581:5432 --tmpfs /var/lib/postgresql/data --name oauth-00007a-pg postgres:17-alpine
docker run -d --rm -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=oauth_proof -p 127.0.0.1:55582:3306 --tmpfs /var/lib/mysql --name oauth-00007a-mysql mysql:8.4
```
First combined run (same containers reused for a second consecutive
`yarn test` invocation without recreating them) showed 2 failures in
`tests/oauth/legacy-store-adapters.test.ts` ("dry-run does no write, then the
real bind is repeatable") on PostgreSQL and MySQL only — diagnosed as
**test-isolation leftover state from running `yarn test` twice against the
same persistent containers**, not a regression: that file's deterministic
`legacy-session-${name}` ID carries real rows across separate `yarn test`
invocations against the same container, so the second run's "before any
bind" assertion saw the first run's leftover binding. Confirmed by stopping
the containers, starting fresh ones, and running `yarn test` exactly once:
**735 passing, 0 failing**; 91.23% statements / 92.15% lines. SQLite
re-confirmed directly: `npx ts-mocha -r tsx tests/oauth/legacy-store-adapters.test.ts -g SQLite`
→ 6 passing, 0 failing. Containers stopped and confirmed removed
(`docker ps -a`) immediately after each run; no pre-existing container
touched.

`python3 .agents/scripts/validate-agent-workspace.py`: warnings only
(pre-existing, unrelated to this task), no ERROR.

Per-file coverage after (changed/added-to files only; package total above):
`AuthActions.ts` 88.83%, `AuthStore.ts` 84.29% (package-measured; both rise
further under the real-database run above), `AuthSchema.ts` 100%, auth
columns 95.35% as a group, `ProfileActions.ts` 88.03%, `ProfileStore.ts`
81.63%, `ProfileSchema.ts` 100%, profile columns 89.3% as a group,
`Session.ts` 100%, `session/helpers.ts` 98%. See Implementation Notes for
the specific files still below 90% individually and why.

Cleanup: both disposable containers stopped and confirmed removed; no
scratch left in `/tmp` beyond this session's debug scripts, all deleted
after use; no test runner, watcher or server process left running.

## Acceptance Notes

No visual acceptance is required. Finished at verified: `yarn test` passes
with statements and lines both above 90% (91.03%/91.94% on PGlite alone,
91.23%/92.15% with all four databases), type checks and build are clean, and
00003–00007's own existing tests all still pass (735 passing with all four
databases up, 0 failing).
