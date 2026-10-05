//stackpress-ai
import type { PanelState, Say, ViewProps } from './types.js';
import { chips } from './controller.js';
import { announceText } from './phrases.js';
import ContextBar from './ContextBar.js';
import Composer from './Composer.js';
import Gate from './Gate.js';
import History from './History.js';
import Thread from './Thread.js';

//--------------------------------------------------------------------//
// Helpers

//the line under the title: what the agent is doing, or that it is ready
export function statusLine(state: PanelState, _: Say) {
  if (state.phase === 'loading' || state.phase === 'idle') {
    return _('Connecting…');
  }
  if (state.phase === 'signed-out') return _('Signed out');
  if (state.phase === 'unavailable') return _('Unavailable');
  if (state.phase === 'limit') return _('Daily limit reached');
  if (state.running) return _('Working…');
  const waiting = state.conversation.items.some(
    item => item.kind === 'action' && item.status === 'waiting'
  );
  if (waiting) return _('Waiting for your approval');
  return state.conversation.items.length
    ? _('Ready for a follow-up')
    : _('Ready');
}

//--------------------------------------------------------------------//
// Components

/**
 * The whole panel as a function of its state. It holds no state of its own
 * and calls no hook, so what it draws can be read off the state.
 */
export default function PanelView(props: ViewProps) {
  const { state, actions, _, refs } = props;
  const usable = state.phase === 'ready' || state.phase === 'limit';
  const announced = state.announce
    ? announceText(state.announce.code, state.announce.tool, _)
    : '';
  return (
    <div className="agent-root">
      {!state.open && (
        <button
          type="button"
          ref={refs?.launcher}
          className="agent-launcher"
          aria-expanded="false"
          aria-controls="agent-panel"
          onClick={() => actions.toggle()}
        >
          {_('Agent')}
        </button>
      )}
      {state.open && (
        <aside
          id="agent-panel"
          ref={refs?.panel}
          className="agent-panel"
          aria-label={_('Agent chat')}
          tabIndex={-1}
          onKeyDown={event => {
            const target = event.target as HTMLElement;
            if (event.key === 'Escape' && target.tagName !== 'SELECT') {
              event.stopPropagation();
              actions.close();
            }
          }}
        >
          <header className="agent-head">
            <div className="agent-heading">
              <h2 className="agent-title">{_('Agent')}</h2>
              <p className="agent-status">{statusLine(state, _)}</p>
            </div>
            <div className="agent-tools">
              <button
                type="button"
                className="agent-button"
                disabled={state.phase !== 'ready'}
                onClick={() => actions.newChat()}
              >
                {_('New chat')}
              </button>
              <button
                type="button"
                className="agent-button"
                aria-pressed={state.view === 'history'}
                disabled={!usable}
                onClick={() => (
                  state.view === 'history'
                    ? actions.showChat()
                    : actions.showHistory()
                )}
              >
                {_('History')}
              </button>
              <button
                type="button"
                className="agent-button"
                aria-label={_('Close agent')}
                onClick={() => actions.close()}
              >
                {_('Close')}
              </button>
            </div>
          </header>
          {usable && state.view === 'history' ? (
            <History
              threads={state.threads}
              current={state.conversation.threadId}
              actions={actions}
              _={_}
            />
          ) : usable ? (
            <>
              <ContextBar
                chips={chips(state)}
                remove={actions.removeContext}
                _={_}
              />
              <Thread
                items={state.conversation.items}
                starters={props.starters}
                locked={state.running || state.phase === 'limit'}
                actions={actions}
                scroller={refs?.thread}
                onScroll={props.onScroll}
                behind={props.behind}
                jump={props.jump}
                _={_}
              />
              {state.phase === 'ready' ? (
                <Composer
                  state={state}
                  actions={actions}
                  canAttach={props.canAttach}
                  textarea={refs?.composer}
                  _={_}
                />
              ) : (
                <Gate
                  phase={state.phase}
                  resetsAt={state.resetsAt}
                  signInUrl={props.signInUrl}
                  retry={actions.retry}
                  _={_}
                />
              )}
            </>
          ) : (
            <Gate
              phase={state.phase}
              resetsAt={state.resetsAt}
              signInUrl={props.signInUrl}
              retry={actions.retry}
              _={_}
            />
          )}
        </aside>
      )}
      <div
        className="agent-sr"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announced}
      </div>
    </div>
  );
};
