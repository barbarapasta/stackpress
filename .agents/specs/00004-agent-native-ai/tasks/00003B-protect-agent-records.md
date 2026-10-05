# Task 00003B: Protect Agent Records From Generated Edits

## Task Summary

Side quest of [Task 00003](00003-records-and-turn-store.md). The store never
edits or deletes a turn, but the generated admin routes and model events for
the agent records still allow it. An admin, or any plugin that emits those
events, can change a stored turn or rewrite the action log.

Approved by the user on 2026-10-05 with the recommended choice: the package rejects generated edits of agent records.

## Implementation Steps

1. `src/plugin.ts`: during `listen`, register guards ahead of the generated
   listeners for the write events of `AgentTurn`, `AgentAction`, and
   `AgentUsage` that the store does not use. A guarded event answers 403.
2. Keep the generated read and create events working, since the store and the
   admin lists use them.
3. Tests: each guarded event is refused, and every store method still works.

## Verification Process

- `yarn test` in `packages/stackpress-ai` passes with all four coverage numbers
  above 90%.
- `yarn build` in the package.

## Acceptance Criteria

A short transcript showing an admin edit of a stored turn refused, and the
admin list still loading.

## Implementation Notes

All three steps are done, in `packages/stackpress-ai`.

What the store uses (read from `src/scripts/store.ts`): `agent-thread-create`,
`-detail`, `-search`, `-update`; `agent-turn-create`, `-search`;
`agent-action-create`, `-detail`, `-search`; `agent-usage-create`, `-detail`. All
its other changes to actions and usage are its own guarded SQL statements through
the `database` plugin, which are not events. The store never calls any other
generated event.

- `src/scripts/records.ts` (new): the lists, and a shared marker. Refused for
  `agent-turn|action|usage`: `update`, `remove`, `restore`, `purge`, `upsert`,
  `batch`. Create is allowed only from the store. `detail`, `search`, `get` stay
  open. For `agent-thread`: only `purge`.
- `src/events/guard.ts` (new): `guard(event, creation)` builds an Ingest action
  that answers 403 "Agent records can only be changed through the agent store."
  and returns `false` to stop later listeners. `guardRecords(ctx)` registers
  them at priority 1000. Not exported from `events/index` (the surface test pins
  that list) and not public.
- `src/plugin.ts`: `listen` calls `guardRecords` first, whenever the plugin is
  active (`mcp` or `agent` config), before the client is loaded.
- `src/scripts/store.ts`: its `resolve` helper runs the three create events
  inside `asStore(event, ...)`.

**Creation is closed to everything but the store.** The mark is an
`AsyncLocalStorage` value holding the event name, set only for the duration of the
store's own `ctx.resolve` of one create event. A request, its data, its headers
or its session cannot carry it, and it ends when the call ends. A create guard
lets through only when the scope names its own event. The `AsyncLocalStorage`
instance lives on `globalThis` under `Symbol.for('stackpress-ai.records')`, shared
the way `src/scripts/tools.ts` shares its state, so a CJS store and an ESM guard
agree. I first considered marking the request object in a `WeakSet`, as `tools.ts`
does. It would have meant the store sends a request instead of a plain payload,
which changes what every existing store test sees. The async scope needs no
payload change. Tests: a forged create with fields that claim to be the store is
403; an outside create made while a store call is running is 403; a listener
hooked on a turn create cannot use that scope to create an action; a mark made by
a second loaded copy of the module is honoured, and only for its own event.

**Threads.** The store updates the thread (to touch `updated`), and a person's
title and active flag belong to the person, not to the audit log, so create,
update, remove (a soft delete, since the model has `@active`), restore, upsert and
batch stay open. `purge` is refused: the generated purge truncates the whole table,
which would leave every turn and action without an owner, and the store reads
turns and actions through the thread, so the log would be hidden.

**Listener order.** Ingest's `ActionRouter` queue sorts by priority, highest
first (`@stackpress/lib` `ItemQueue.add`, `EventEmitter.on(event, action,
priority = 0)`), and a listener that returns `false` stops the rest. The generated
listeners register at the default 0 in `stackpress-sql`'s `listen`; the guards use
1000, so they run first whichever plugin registers first. Tests build a real Ingest
server and register the guards both before and after the generated listeners, and
assert the generated listener is never reached. A listener at a higher priority
than 1000 would run before the guards.

`tests/helpers.ts`: the context stub's `on` now keeps a listener that has a
priority in a separate `ranked` list, so existing assertions on `ctx.events` did
not change. README: Stored records, What changed.

## Verification Notes

Node 22.23.2, Yarn 1.22.22.

- `yarn test` in `packages/stackpress-ai`: 725 passing, 0 failing; 96.5 / 91.83 /
  96.55 / 97.2 (before: 700 tests; 96.5 / 91.78 / 96.66 / 97.17). `src/scripts/records.ts` and
  `src/events/guard.ts` are at 100 percent.
- The existing store and workflow suites pass with no assertion changed. Their
  harness answers model events without the listener queue, so they do not
  exercise the guards. `tests/records.test.ts` (15 tests, real Ingest server over
  PGlite) does: every guarded event is refused for each table, the turn and the
  action log are unchanged afterwards, every store method runs with the guards
  registered, threads stay editable, and the order tests above.
- `yarn build` in the package and at the repository root: passed.
- Live: `evidence/00003B-guarded-records.md`, real requests to `templates/blog`
  as the seeded admin. An admin edit of a stored turn is 403 and the turn is
  unchanged; an admin delete of a logged action is 403 and the action remains; an
  admin rewrite of an action and an admin create of a made-up action are 403; the
  admin list of agent actions loads (HTTP 200, "Showing 1 - 8 of 8").
- Not run live: the store's own writes through the running blog (the seed script
  used the store before the server started, and I did not check whether that
  bootstrap registered the guards); the unit tests cover this.

## Acceptance Notes

Accepted by the user on 2026-10-05 ("I think we're good now").
