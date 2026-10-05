//modules
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
//stackpress-ai
import type { PanelActions, PanelOptions } from './types.js';
import { createPanel } from './controller.js';
import type { PanelController } from './controller.js';

//--------------------------------------------------------------------//
// Constants

//how close to the end the person must be for new text to keep them there
const NEAR = 48;

//a layout effect does not run on the server, and warns older React there
const useLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

//--------------------------------------------------------------------//
// Functions

/**
 * Whether a scrolling element is at, or close to, its end.
 */
export function nearBottom(
  box: { scrollHeight: number, scrollTop: number, clientHeight: number }
) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR;
}

/**
 * The actions the components call, bound to a panel.
 */
export function bind(panel: PanelController): PanelActions {
  return {
    toggle: () => void panel.toggle(),
    close: () => panel.close(),
    retry: () => void panel.retry(),
    newChat: () => void panel.newChat(),
    showHistory: () => void panel.showHistory(),
    showChat: () => panel.showChat(),
    openThread: id => void panel.openThread(id),
    send: text => void panel.send(text),
    approve: id => void panel.approve(id),
    decline: id => void panel.decline(id),
    undo: id => void panel.undo(id),
    removeContext: key => panel.removeContext(key),
    setDraft: text => panel.setDraft(text),
    setModel: model => panel.setModel(model),
    dismiss: () => panel.dismiss(),
    attach: file => void panel.attach(file),
    removeFile: ref => panel.removeFile(ref)
  };
}

/**
 * A panel for a component: its state, its actions, and the work of picking
 * up where a reload left off once the page is in the browser. The server
 * and the first render in the browser agree: a closed panel.
 */
export function usePanel(options: PanelOptions) {
  const held = useRef<PanelController | null>(null);
  if (!held.current) held.current = createPanel(options);
  const panel = held.current;
  const state = useSyncExternalStore(
    panel.subscribe,
    panel.getState,
    panel.getServerState
  );
  const actions = useMemo(() => bind(panel), [ panel ]);

  useEffect(() => {
    void panel.mount();
    return () => panel.destroy();
  }, [ panel ]);

  const key = JSON.stringify(options.context || []);
  useEffect(() => {
    panel.setContext(options.url, options.context || []);
  }, [ panel, options.url, key ]);

  return { panel, state, actions };
}

/**
 * Keep the conversation where the person is reading. New text follows the
 * end only while they are at the end; once they scroll up it stays put,
 * and a button offers the way back. Sending a message, or opening a
 * thread, goes to the end.
 */
export function useFollow(
  items: unknown[],
  key: string,
  active: boolean
) {
  const thread = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);
  const last = useRef<unknown>(undefined);
  const where = useRef('');
  const [ behind, setBehind ] = useState(false);

  useLayout(() => {
    const box = thread.current;
    if (!active || !box) return;
    const newest = items[items.length - 1] as { kind?: string } | undefined;
    if (where.current !== key
      || (newest?.kind === 'user' && newest !== last.current)
    ) {
      stuck.current = true;
    }
    where.current = key;
    last.current = newest;
    if (stuck.current) {
      box.scrollTop = box.scrollHeight;
      setBehind(false);
    } else {
      setBehind(true);
    }
  }, [ items, key, active ]);

  return {
    thread,
    behind,
    onScroll() {
      const box = thread.current;
      if (!box) return;
      stuck.current = nearBottom(box);
      if (stuck.current) setBehind(false);
    },
    jump() {
      const box = thread.current;
      if (!box) return;
      stuck.current = true;
      box.scrollTop = box.scrollHeight;
      setBehind(false);
    }
  };
}
