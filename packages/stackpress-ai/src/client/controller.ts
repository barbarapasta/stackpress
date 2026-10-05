//NOTE: Browser safe. Everything the panel does that is not markup: the
// state, the requests, and what each answer changes. The components only
// draw this state and call these methods. The panel decides nothing about
// permission: approve, decline and undo are requests, and what the server
// answers is what the page shows.
import { createClient } from './api.js';
import {
  addUser,
  applyEvent,
  dropLast,
  emptyConversation,
  fromThread,
  patchAction,
  settle,
  syncActions
} from './state.js';
import type {
  ActionItem,
  Chip,
  ContextItem,
  Failure,
  Memory,
  PanelOptions,
  PanelState,
  SendBody,
  Sent,
  StartInfo,
  Uploaded
} from './types.js';

//--------------------------------------------------------------------//
// Constants

export const STORAGE_KEY = 'stackpress-ai-panel';

//what the server accepts: up to 20 references of up to 500 characters
const MAX_FILES = 20;
const MAX_REF = 500;
const MAX_UNDO_ERROR = 300;

//--------------------------------------------------------------------//
// Functions

/**
 * A key for a context item, so a chip can be removed by it.
 */
export function contextKey(item: ContextItem) {
  return `item:${labelOf(item)}`;
}

/**
 * What a context item is called on its chip.
 */
export function labelOf(item: ContextItem) {
  if (typeof item === 'string') return item;
  if (typeof item.label === 'string' && item.label) return item.label;
  const named = [ item.type, item.id ]
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .join(' ');
  if (named) return named;
  try {
    return JSON.stringify(item).slice(0, 80);
  } catch {
    return 'item';
  }
}

/**
 * The chips the context bar shows: the page address and the items the page
 * declared, less the ones the person removed.
 */
export function chips(state: Pick<PanelState, 'url' | 'context' | 'removed'>) {
  const list: Chip[] = [];
  if (state.url && !state.removed.includes('url')) {
    list.push({ key: 'url', label: state.url });
  }
  for (const item of state.context) {
    const key = contextKey(item);
    if (!state.removed.includes(key)
      && !list.some(chip => chip.key === key)
    ) {
      list.push({ key, label: labelOf(item) });
    }
  }
  return list;
}

/**
 * The page context a message carries: what is still on the bar.
 */
export function wire(state: Pick<PanelState, 'url' | 'context' | 'removed'>) {
  const items = state.context.filter(
    item => !state.removed.includes(contextKey(item))
  );
  const result: NonNullable<SendBody['context']> = {};
  if (state.url && !state.removed.includes('url')) result.url = state.url;
  if (items.length) result.items = items;
  return result.url || result.items ? result : undefined;
}

/**
 * The panel's state, and what it does. Subscribe for changes; call the
 * methods for what the person does.
 */
export function createPanel(options: PanelOptions = {}) {
  const client = createClient({
    base: options.base,
    fetch: options.fetch,
    stream: options.stream
  });
  const storage = memory(options.storage);

  const initial: PanelState = {
    open: false,
    phase: 'idle',
    view: 'chat',
    models: [],
    model: '',
    conversation: emptyConversation(),
    running: false,
    threads: { status: 'idle', rows: [] },
    url: options.url,
    context: options.context || [],
    removed: [],
    files: [],
    uploading: false,
    draft: ''
  };
  let state = initial;
  const listeners = new Set<() => void>();
  //the thread to come back to after a reload
  let saved: string | undefined;
  let saving = '';
  //a new chat or another thread ends what was running for the old one
  let epoch = 0;
  let abort: AbortController | undefined;
  let creating = false;

  const set = (patch: Partial<PanelState>) => {
    state = { ...state, ...patch };
    keep();
    for (const listener of Array.from(listeners)) listener();
  };

  const keep = () => {
    //what was taken off the bar belongs to the page it was taken off
    const text = JSON.stringify({
      open: state.open,
      threadId: state.conversation.threadId ?? saved,
      draft: state.draft,
      ...(state.removed.length
        ? { removed: state.removed, page: state.url }
        : {})
    });
    if (text === saving) return;
    saving = text;
    try {
      storage?.setItem(STORAGE_KEY, text);
    } catch {
      //storage is full or off; the panel works without it
    }
  };

  const say = (code: string, tool?: string) => set({
    announce: { code, tool, seq: (state.announce?.seq || 0) + 1 }
  });

  const focus = (id: string) => set({
    focus: { id, seq: (state.focus?.seq || 0) + 1 }
  });

  const card = (id: string) => state.conversation.items.find(
    (item): item is ActionItem => item.kind === 'action' && item.id === id
  );

  //--------------------------------------------------------------------//
  // Failures and endings

  /**
   * Show a failed request the way a person can act on: a state of the
   * panel when it blocks everything, else a short message. The server's
   * own words are never shown.
   */
  const refused = (failure: Failure) => {
    switch (failure.reason) {
      case 'aborted':
        return;
      case 'unauthorized':
        set({ phase: 'signed-out', running: false });
        return;
      case 'limit':
        set({ phase: 'limit', resetsAt: failure.resetsAt, running: false });
        return;
      case 'unavailable':
        if (failure.status === 500) {
          set({ notice: { code: 'failed' } });
        } else {
          set({ phase: 'unavailable', running: false });
        }
        return;
      case 'network':
        set({ notice: { code: 'network' } });
        return;
      case 'csrf':
        set({ notice: { code: 'csrf' } });
        return;
      case 'invalid':
        set({ notice: { code: 'invalid' } });
        return;
      case 'not_found':
        set({ notice: { code: 'not-found' } });
        return;
      case 'conflict':
        set({ notice: { code: 'conflict' } });
        return;
      case 'forbidden':
        set({ notice: { code: 'forbidden' } });
        return;
      default:
        set({ notice: { code: 'failed' } });
    }
  };

  const refresh = async () => {
    try {
      if (options.onRefresh) {
        await options.onRefresh();
      } else if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch {
      //the page could not refresh itself; what the person did still stands
    }
  };

  //the cards on the page, as the server has them now
  const sync = async () => {
    const id = state.conversation.threadId;
    if (!id) return;
    const mine = epoch;
    const found = await client.thread(id);
    if (found.ok && mine === epoch) {
      set({
        conversation: syncActions(state.conversation, found.actions)
      });
    }
  };

  const onEvent = (mine: number, mode: 'turn' | 'undo') => (
    event: Parameters<typeof applyEvent>[1]
  ) => {
    if (mine !== epoch) return;
    set({ conversation: applyEvent(state.conversation, event, mode) });
    if (event.type === 'action-waiting') {
      focus(event.actionId);
      say('waiting', event.tool);
    } else if (event.type === 'action-done') {
      say('done', event.tool);
    } else if (event.type === 'action-failed') {
      say('failed', event.tool);
    } else if (event.type === 'action-declined') {
      say('declined', event.tool);
    }
  };

  /**
   * What a run that was answered leaves behind: how it ended, a refresh
   * of the page when an action finished, and cards brought up to date when
   * the run may have changed them without saying so.
   */
  const conclude = async (
    outcome: Sent | Failure,
    before: { finished: number, used: number, said?: number },
    mine: number,
    resync = false
  ) => {
    abort = undefined;
    if (mine !== epoch) return;
    if (!outcome.ok) {
      set({ running: false });
      refused(outcome);
      return;
    }
    const conversation = settle(state.conversation);
    const ended = conversation.ended;
    const used = conversation.used - before.used;
    //an action finished, so the page behind the panel is out of date
    const acted = conversation.finished > before.finished;
    set({
      conversation,
      running: false,
      usage: state.usage && used > 0
        ? {
          ...state.usage,
          used: state.usage.used + used,
          ...(state.usage.remaining !== undefined
            ? { remaining: Math.max(0, state.usage.remaining - used) }
            : {})
        }
        : state.usage
    });

    if (!outcome.finished) {
      //the connection dropped before the end: what the server stored is
      // the truth, so load that
      const id = conversation.threadId;
      if (id) await openThread(id, true);
      set({ notice: { code: 'interrupted' } });
    } else if (ended === 'limit') {
      set({
        phase: 'limit',
        resetsAt: conversation.failure?.resetsAt || state.resetsAt
      });
    } else if (ended === 'unavailable') {
      set({ phase: 'unavailable' });
    } else if (ended === 'steps' || ended === 'length'
      || ended === 'refusal' || ended === 'busy' || ended === 'failed'
    ) {
      set({ notice: { code: ended } });
    } else if (ended === 'settled') {
      set({ notice: { code: 'settled' } });
    }

    if (resync || ended === 'settled') await sync();
    //a card or a failure has already said what happened; a plain reply
    // says that it arrived
    if (ended === 'done' && state.announce?.seq === before.said) {
      say('replied');
    }
    if (acted) await refresh();
  };

  //--------------------------------------------------------------------//
  // Loading

  const load = async () => {
    if (options.signedIn === false) {
      set({ phase: 'signed-out' });
      return;
    }
    set({ phase: 'loading' });
    const started = await client.start();
    if (!started.ok) {
      set({ phase: started.reason === 'unauthorized' ? 'signed-out' : 'unavailable' });
      return;
    }
    const info: StartInfo = started;
    const limited = info.usage.limit !== undefined
      && (info.usage.remaining ?? 1) <= 0;
    set({
      models: info.models,
      model: info.model,
      usage: info.usage,
      resetsAt: info.usage.resetsAt,
      phase: limited ? 'limit' : 'ready'
    });
    if (saved) {
      const id = saved;
      saved = undefined;
      await openThread(id, true);
    }
  };

  const openThread = async (id: string, quiet = false) => {
    epoch++;
    abort?.abort();
    const mine = epoch;
    const found = await client.thread(id);
    if (mine !== epoch) return;
    if (!found.ok) {
      if (quiet) {
        set({ running: false, conversation: emptyConversation() });
      } else {
        set({ running: false });
        refused(found);
      }
      return;
    }
    const conversation = fromThread(found.thread, found.turns, found.actions);
    const offered = state.models.some(model => model.model === found.thread.model);
    const waiting = conversation.items.find(
      item => item.kind === 'action' && item.status === 'waiting'
    );
    set({
      view: 'chat',
      conversation,
      running: false,
      model: offered ? String(found.thread.model) : state.model,
      notice: undefined,
      removed: quiet ? state.removed : []
    });
    if (waiting) {
      focus(waiting.id);
      say('waiting', (waiting as ActionItem).tool);
    }
  };

  //--------------------------------------------------------------------//
  // What the person does

  const open = () => {
    if (state.open) return Promise.resolve();
    set({ open: true });
    return state.phase === 'idle' ? load() : Promise.resolve();
  };

  const close = () => {
    set({ open: false });
  };

  const act = async (kind: 'approve' | 'decline', id: string) => {
    const target = card(id);
    if (!target || target.status !== 'waiting' || target.busy || state.running) {
      return;
    }
    //busy is set before the request, so a second click finds it set
    abort = new AbortController();
    const mine = epoch;
    const before = {
      finished: state.conversation.finished,
      used: state.conversation.used,
      said: 0
    };
    set({
      running: true,
      notice: undefined,
      conversation: patchAction(state.conversation, id, { busy: kind })
    });
    say(kind === 'approve' ? 'approving' : 'declining', target.tool);
    before.said = state.announce?.seq ?? 0;
    const outcome = await client[kind](id, onEvent(mine, 'turn'), abort.signal);
    if (mine !== epoch) return;
    set({
      conversation: patchAction(state.conversation, id, { busy: undefined })
    });
    await conclude(outcome, before, mine);
    if (mine === epoch) focus(id);
  };

  return {
    client,

    getState: () => state,
    //what the server draws: the panel closed, nothing loaded
    getServerState: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Start in the browser: pick up where a reload left off.
     */
    mount() {
      //read what was kept before anything is written over it
      let found: Record<string, unknown> | null = null;
      try {
        const value = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
        found = value && typeof value === 'object' ? value : null;
      } catch {
        //nothing kept, or not readable
      }
      if (typeof found?.threadId === 'string' && found.threadId) {
        saved = found.threadId;
      }
      if (state.url === undefined && typeof window !== 'undefined') {
        set({ url: window.location.pathname + window.location.search });
      }
      if (typeof found?.draft === 'string' && found.draft) {
        set({ draft: found.draft });
      }
      if (Array.isArray(found?.removed) && found?.page === state.url) {
        set({
          removed: found.removed.filter(
            (key: unknown): key is string => typeof key === 'string'
          )
        });
      }
      return found?.open === true || options.defaultOpen
        ? open()
        : Promise.resolve();
    },

    destroy() {
      epoch++;
      abort?.abort();
    },

    open,

    close,

    toggle() {
      return state.open ? close() : open();
    },

    //try again after the agent could not be reached
    retry() {
      set({ phase: 'idle', notice: undefined });
      return load();
    },

    setContext(url: string | undefined, context: ContextItem[]) {
      const next = url ?? state.url;
      if (next === state.url
        && JSON.stringify(context) === JSON.stringify(state.context)
      ) {
        return;
      }
      set({ url: next, context });
    },

    removeContext(key: string) {
      if (!state.removed.includes(key)) {
        set({ removed: [ ...state.removed, key ] });
      }
    },

    setDraft(draft: string) {
      set({ draft });
    },

    setModel(model: string) {
      if (state.models.some(offered => offered.model === model)) {
        set({ model });
      }
    },

    dismiss() {
      set({ notice: undefined });
    },

    /**
     * Send what is in the composer, or the text given.
     */
    async send(text?: string) {
      const message = (text ?? state.draft).trim();
      if (!message || state.running || state.phase !== 'ready') return;
      const files = state.files;
      const had = state.conversation.items.some(
        item => item.kind === 'action' && item.status === 'waiting'
      );
      const before = {
        finished: state.conversation.finished,
        used: state.conversation.used,
        said: 0
      };
      const body: SendBody = {
        message,
        model: state.model || undefined,
        threadId: state.conversation.threadId
      };
      if (files.length) body.files = files.map(file => file.ref);
      const context = wire(state);
      if (context) body.context = context;

      abort = new AbortController();
      const mine = epoch;
      set({
        draft: '',
        files: [],
        notice: undefined,
        running: true,
        conversation: addUser(
          state.conversation,
          message,
          files.map(file => file.name)
        )
      });
      say('sending');
      before.said = state.announce?.seq ?? 0;
      const outcome = await client.send(body, onEvent(mine, 'turn'), abort.signal);
      if (mine === epoch && !outcome.ok && outcome.reason !== 'aborted') {
        //it was refused, so nothing was stored: give the person their
        // words back
        set({
          conversation: dropLast(state.conversation),
          draft: state.draft || message,
          files: state.files.length ? state.files : files
        });
      }
      await conclude(outcome, before, mine, had);
    },

    approve(id: string) {
      return act('approve', id);
    },

    decline(id: string) {
      return act('decline', id);
    },

    /**
     * Ask for the undo of a finished action. Whether it can be done is the
     * app's to say, and the answer is shown as it comes.
     */
    async undo(id: string) {
      const target = card(id);
      if (!target || target.status !== 'done' || !target.undoable
        || target.busy || state.running
      ) {
        return;
      }
      const mine = epoch;
      set({
        running: true,
        notice: undefined,
        conversation: patchAction(state.conversation, id, {
          busy: 'undo',
          undoError: undefined
        })
      });
      say('undoing', target.tool);
      const outcome = await client.undo(id);
      if (mine !== epoch) return;
      set({
        running: false,
        conversation: patchAction(state.conversation, id, { busy: undefined })
      });
      if (!outcome.ok) {
        refused(outcome);
      } else {
        const results = outcome.results || {};
        if (results.status === 'undone') {
          set({
            conversation: {
              ...patchAction(state.conversation, id, {
                status: 'undone',
                undoable: false
              }),
              finished: state.conversation.finished + 1
            }
          });
          say('undone', target.tool);
          await refresh();
        } else if (results.status === 'refused') {
          set({
            conversation: patchAction(state.conversation, id, {
              undoError: typeof results.error === 'string' && results.error
                ? results.error.slice(0, MAX_UNDO_ERROR)
                : 'refused'
            })
          });
          say('undo-refused', target.tool);
        } else {
          set({ notice: { code: 'settled' } });
          await sync();
        }
      }
      if (mine === epoch) focus(id);
    },

    /**
     * Start an empty chat with the page's context.
     */
    async newChat() {
      if (state.phase !== 'ready' || creating) return;
      creating = true;
      epoch++;
      abort?.abort();
      const mine = epoch;
      set({
        running: false,
        view: 'chat',
        notice: undefined,
        draft: '',
        files: [],
        removed: [],
        conversation: emptyConversation()
      });
      try {
        const created = await client.create(wire({ ...state, removed: [] }));
        if (mine !== epoch) return;
        if (!created.ok) {
          refused(created);
          return;
        }
        const thread = (created.results?.thread || {}) as { id?: unknown };
        if (typeof thread.id === 'string') {
          set({ conversation: emptyConversation(thread.id) });
        }
      } finally {
        creating = false;
      }
    },

    async showHistory() {
      if (state.phase !== 'ready' && state.phase !== 'limit') return;
      set({
        view: 'history',
        threads: { status: 'loading', rows: state.threads.rows }
      });
      const found = await client.threads();
      if (!found.ok) {
        set({ threads: { status: 'error', rows: [] } });
        if (found.reason === 'unauthorized') refused(found);
        return;
      }
      set({ threads: { status: 'ready', rows: found.threads } });
    },

    showChat() {
      set({ view: 'chat' });
    },

    openThread(id: string) {
      return openThread(id);
    },

    /**
     * Hand a file the person picked to the app's upload handler, and keep
     * the reference it answers with. The panel itself sends the file nowhere.
     */
    async attach(file: File) {
      const upload = options.upload;
      if (!upload || state.uploading) return;
      if (state.files.length >= MAX_FILES) {
        set({ notice: { code: 'attach-limit' } });
        return;
      }
      set({ uploading: true, notice: undefined });
      try {
        const done: Uploaded = await upload(file);
        const ref = typeof done === 'string' ? done : done?.ref;
        const name = typeof done === 'object' && done?.name
          ? done.name
          : file.name || String(ref);
        if (typeof ref !== 'string' || !ref || ref.length > MAX_REF) {
          set({ notice: { code: 'attach-failed' } });
        } else if (!state.files.some(kept => kept.ref === ref)) {
          set({ files: [ ...state.files, { ref, name } ] });
          say('attached');
        }
      } catch {
        set({ notice: { code: 'attach-failed' } });
      } finally {
        set({ uploading: false });
      }
    },

    removeFile(ref: string) {
      set({ files: state.files.filter(file => file.ref !== ref) });
    }
  };
}

export type PanelController = ReturnType<typeof createPanel>;

//--------------------------------------------------------------------//
// Helpers

function memory(given: Memory | null | undefined): Memory | null {
  if (given !== undefined) return given;
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    //storage is blocked
    return null;
  }
}
