# Database proof

The candidate passed on all four real databases. The current adapters failed the
shared-connection check on all four. This is evidence for the library plan,
not an OAuth implementation or a production-readiness claim.

Run from the repository root with Node 22, Yarn 1, and Docker:

```bash
bash proofs/mcp-oauth-store/run.sh
```

The script installs pinned proof dependencies in a temporary directory, starts
new databases bound to loopback, runs the checks, and removes its containers and
temporary files. It does not change workspace dependencies or use application
databases. Database credentials are intentionally empty only in these disposable
loopback containers. `results.json` is replaced with the latest run.

[Results](results.json) contain server versions, outcomes, query counts, and the
formatted SQL without bearer values. [Sources](sources.json) records package
versions and hashes of the inspected published implementations. The dependency
manifest and Yarn lock pin all packages; the setup script pins container images.

## What passed

| Check | PGlite | PostgreSQL | MySQL | SQLite |
| --- | --- | --- | --- | --- |
| Two uses of one code, five runs | Pass | Pass | Pass | Pass |
| Two renewals, five runs | Pass | Pass | Pass | Pass |
| Renewal wins the lock before disconnect | Pass | Pass | Pass | Pass |
| Disconnect wins the lock before renewal | Pass | Pass | Pass | Pass |
| SQL failure rolls back code/key changes | Pass | Pass | Pass | Pass |
| SQL failure rolls back renewal/key changes | Pass | Pass | Pass | Pass |
| Reuse of a token four generations old | Pass | Pass | Pass | Pass |
| Final deadline and access expiry cap | Pass | Pass | Pass | Pass |
| Both read ID and secret change together | Pass | Pass | Pass | Pass |
| Unknown token does not cancel access | Pass | Pass | Pass | Pass |
| Transaction keeps its native connection | Pass | Pass | Pass | Pass |

The tested versions are Node 22.23.2, Inquire and its four adapters 0.10.8,
PGlite 0.3.14 (PostgreSQL 17.5), PostgreSQL 17.11, MySQL 8.4.11,
and better-sqlite3 12.4.1 (SQLite 3.50.4). Native network drivers are pg 8.16.3
and mysql2 3.15.3.

## Why the existing connection handling needs work

The complete published `Engine`, adapter `Connection`, helpers, entrypoints and
connection types were inspected. Stackpress's SQL facades re-export these
adapters. The blog's PGlite setup gives its engine one lazily created native
resource. No sibling Inquire source checkout was found in the available home
files; the executed published JavaScript is the source for these findings.

`Engine.transaction()` delegates to the connection. The callback receives that
same `Connection`; it does not receive a new engine, checked-out pool connection,
or isolated transaction resource. Every adapter caches its native resource.
None prevents a second request from starting a transaction on that resource.

The first test deliberately interleaves two callbacks on one adapter:

- PGlite, PostgreSQL and MySQL commit the first request's changes when the
  second request commits. A later rollback of the first request cannot undo
  them. MySQL's second transaction start also ends the earlier transaction.
- SQLite rejects the second `BEGIN`, then its error path rolls back the first
  request's transaction. The first request later gets a rollback error.
- On all four adapters, an ordinary query issued while another request has an
  open transaction joins it. That apparently successful query disappears when
  the other request rolls back.

These are reproduced failures, not guesses based on partial source inspection.
Keeping the same connection is necessary, but exclusive ownership matters too.
Queuing only OAuth transactions while unrelated queries use that same resource
is insufficient.

## The candidate that passed

[Store](store.mjs) uses the same small SQL model on all four adapters. Its first
statement updates the approval's counter to take a write lock. Only then does it
read approval and token state. It checks cancellation and the fixed deadline,
uses up the old credential, saves the replacement, and changes both access-key
hashes inside that transaction. The first statement does not depend on
PostgreSQL-only locking syntax or adapter-specific affected-row results.

PostgreSQL and MySQL races use separate native connections in worker threads.
SQLite races use separate OS processes, a real shared file, and a five-second
busy timeout. A blocked synchronous query cannot prevent the other process from
committing.
Ordered races use messages to hold the first transaction after its write lock,
start the second request, and release the first; they do not rely on sleeps.

PGlite has one native session. The proof queues whole transactions on its one
resource. Setup and inspection queries run only when that queue is idle. This
queue exists only in this process and in the proof; the current adapter does not
supply it. It is not a lock shared by other processes. A PGlite database needs
one owning service/resource; every user of that resource, including ordinary
queries and other plugins, must use the same ownership boundary. Separate
processes opening that same PGlite directory are not a supported proof result.
SQLite's database lock, unlike this queue, is exercised across OS processes.

A losing duplicate renewal records cancellation and commits that result. It
must not throw an error inside the callback: doing so would undo cancellation.
The caller can translate the committed result into an OAuth error afterward.
Token history remains until the original approval deadline, so reuse several
renewals back is still found. A refresh that commits before disconnect can
return a key, but disconnect then cancels its approval; issuance does not imply
continuing validity. Checking a key must consult current approval state.

## Required library work and limits

Inquire needs an explicit ownership boundary: reserve a connection for the whole
transaction and release it afterward; keep other queries from entering it;
and serialize a shared embedded resource. Network pools must supply an acquired
connection per transaction instead of caching a factory's first connection
forever. A startup factory should also resolve once under concurrent use.
Nested transactions and failed `BEGIN` must not roll back another caller's work.
The proof changes no published package and makes no upstream commit.

These runs fit within the databases' lock waits and needed no retries. Production
must bound waiting and retry the whole transaction only for classified transient
failures: PostgreSQL deadlock/serialization failures, MySQL deadlocks and lock
wait timeouts, and SQLite busy/locked errors. Roll back before retrying and use a
bounded retry count with jitter. Never retry a protocol replay, expiry, or denied
approval as a database failure. SQLite's busy timeout alone is not a complete
retry policy. A commit whose outcome is unknown after connection loss needs a
separate recovery rule; blindly issuing another replacement is unsafe and is
not covered here. Preserve the original failure if rollback also fails.

The grant-row write is a portable candidate for session's store. Generated
store calls must use the transaction connection, including cancellation and
app-driven permission changes. Do not keep using a global engine from inside
the callback. The ownership API and regression tests belong in Inquire; OAuth
record and token rules belong in Stackpress session.

This proof uses minimal hand-written tables and deterministic synthetic tokens.
It does not test generated Idea models, account hooks, HTTP, PKCE, client checks,
actual random-key generation, crashes during commit, network loss, large-scale
contention, or performance. It checks that stored old read-ID/secret hashes are
replaced together; it does not implement the HTTP key verifier. MySQL uses the
default transactional InnoDB engine. Other MySQL storage engines are not covered.

All four database engines can support the required operation with the tested
ownership and locking rules. P-001's feasibility work is complete. Release
readiness still requires implementing those rules in the owning libraries and
rerunning these cases through the generated production stores.
