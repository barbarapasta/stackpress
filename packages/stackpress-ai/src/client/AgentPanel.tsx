//modules
import { useEffect, useRef } from 'react';
import { useLanguage } from 'r22n';
//stackpress-ai
import type { PanelOptions } from './types.js';
import { useFollow, usePanel } from './hooks.js';
import PanelView from './PanelView.js';

//--------------------------------------------------------------------//
// Types

export type AgentPanelProps = PanelOptions & {
  //where a signed-out person goes to sign in. Defaults to `/auth/signin`
  signInUrl?: string,
  //prompts offered on an empty chat
  starters?: string[]
};

//--------------------------------------------------------------------//
// Components

/**
 * A plain agent chat panel. It talks to the chat routes of `stackpress-ai`
 * and nothing else. Put it anywhere inside the page; it draws a button and,
 * once opened, a panel docked to the right edge, or a full-height sheet on a
 * narrow screen. Its words go through the translate helper of `r22n`.
 */
export default function AgentPanel(props: AgentPanelProps) {
  const { signInUrl = '/auth/signin', starters = [], ...options } = props;
  const { _ } = useLanguage();
  const { state, actions } = usePanel(options);
  const launcher = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const opened = useRef(false);
  const follow = useFollow(
    state.conversation.items,
    `${state.view}:${state.conversation.threadId || ''}`,
    state.open && state.view === 'chat'
  );

  //where focus goes when the panel opens, when it can be used, and when it
  // closes
  useEffect(() => {
    if (state.open) {
      const inside = panel.current?.contains(document.activeElement)
        && document.activeElement !== panel.current;
      if (!inside) (composer.current || panel.current)?.focus();
      opened.current = true;
    } else if (opened.current) {
      opened.current = false;
      launcher.current?.focus();
    }
  }, [ state.open, state.phase ]);

  //a card that needs a decision, or that the person just acted on, takes
  // focus: the card itself, not a button, so a stray key press approves
  // nothing
  useEffect(() => {
    if (!state.focus) return;
    const card = document.getElementById(`agent-card-${state.focus.id}`);
    card?.focus();
  }, [ state.focus?.seq ]);

  return (
    <PanelView
      state={state}
      actions={actions}
      _={_}
      signInUrl={signInUrl}
      starters={starters}
      canAttach={Boolean(options.upload)}
      refs={{ launcher, panel, composer, thread: follow.thread }}
      onScroll={follow.onScroll}
      behind={follow.behind}
      jump={follow.jump}
    />
  );
};
