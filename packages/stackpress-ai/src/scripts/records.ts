//node
import { AsyncLocalStorage } from 'node:async_hooks';

//the generated model events of the records that only the store may change.
// Reading them stays open, since the admin lists and the store both read.
export const RECORD_MODELS = [
  'agent-turn',
  'agent-action',
  'agent-usage',
  'agent-lock'
] as const;

//the generated write events nobody may call on those records. The store never
// uses them: it changes actions and usage with its own guarded statements.
export const RECORD_REFUSED = [
  'update',
  'remove',
  'restore',
  'purge',
  'upsert',
  'batch'
] as const;

//the generated create event of those records. Only the store may call it
export const RECORD_CREATE = 'create';

//a thread belongs to the person and its title is not part of the audit log,
// and the store updates it, so only the event that empties the whole table
// is refused.
export const THREAD_REFUSED = [ 'agent-thread-purge' ] as const;

//the CJS and ESM builds of this package can both be loaded into one process,
// as when a plugin imports it as ESM while the server loads it as CJS. The
// marker therefore lives in one scope shared through the global symbol
// registry, so a store from one copy is recognised by a guard from the other.
const SCOPE = Symbol.for('stackpress-ai.records');
const scope: AsyncLocalStorage<string> = (
  (globalThis as Record<symbol, unknown>)[SCOPE] ??= new AsyncLocalStorage()
) as never;

/**
 * Every generated event that is refused outright.
 */
export function refusedEvents() {
  return [
    ...RECORD_MODELS.flatMap(
      model => RECORD_REFUSED.map(verb => `${model}-${verb}`)
    ),
    ...THREAD_REFUSED
  ];
}

/**
 * Every generated create event that only the store may call.
 */
export function createEvents() {
  return RECORD_MODELS.map(model => `${model}-${RECORD_CREATE}`);
}

/**
 * Run one create event as the store. The mark lives in the async context of
 * this call alone, not in the request or its data, so a request from outside
 * cannot carry it and it ends when the call does.
 */
export function asStore<T>(event: string, run: () => Promise<T>) {
  return scope.run(event, run);
}

/**
 * Whether the event that is running was started by the store.
 */
export function fromStore(event: string) {
  return scope.getStore() === event;
}
