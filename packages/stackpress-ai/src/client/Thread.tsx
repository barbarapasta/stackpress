//stackpress-ai
import type { Item, PanelActions, Say } from './types.js';
import ActionCard from './ActionCard.js';

//--------------------------------------------------------------------//
// Components

export type MessageProps = {
  item: Extract<Item, { kind: 'user' | 'agent' }>,
  _: Say
};

/**
 * One message. It is plain text, never markup, kept as the author broke
 * the lines.
 */
export function Message(props: MessageProps) {
  const { item, _ } = props;
  return (
    <article
      className={`agent-message agent-${item.kind}`}
      aria-busy={item.streaming ? 'true' : undefined}
    >
      <span className="agent-sr">
        {item.kind === 'user' ? _('You') : _('Agent')}
      </span>
      <p className="agent-text">{item.text}</p>
      {item.files && item.files.length > 0 && (
        <ul className="agent-files" aria-label={_('Attached files')}>
          {item.files.map((name, index) => (
            <li key={index} className="agent-chip">{name}</li>
          ))}
        </ul>
      )}
    </article>
  );
};

export type EmptyProps = {
  starters: string[],
  disabled: boolean,
  send: PanelActions['send'],
  _: Say
};

/**
 * What an empty chat says, with the prompts the app offered.
 */
export function Empty(props: EmptyProps) {
  const { starters, disabled, send, _ } = props;
  return (
    <div className="agent-empty">
      <p>{_('Ask the agent to do something on this page.')}</p>
      {starters.length > 0 && (
        <ul className="agent-starters" aria-label={_('Suggestions')}>
          {starters.map(text => (
            <li key={text}>
              <button
                type="button"
                className="agent-button"
                disabled={disabled}
                onClick={() => send(text)}
              >
                {text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export type ThreadProps = {
  items: Item[],
  starters: string[],
  //a request is running, so cards and prompts are locked
  locked: boolean,
  actions: PanelActions,
  _: Say,
  scroller?: { current: HTMLDivElement | null },
  onScroll?: () => void,
  behind?: boolean,
  jump?: () => void
};

/**
 * The conversation. Messages and cards come in the order they happened. It
 * is a scrolling region a keyboard can reach, and it does not read itself
 * aloud as text arrives: a separate status line says what changed.
 */
export default function Thread(props: ThreadProps) {
  const { items, starters, locked, actions, _ } = props;
  return (
    <div className="agent-thread-wrap">
      <div
        ref={props.scroller}
        className="agent-thread"
        role="log"
        aria-live="off"
        aria-label={_('Conversation')}
        tabIndex={0}
        onScroll={props.onScroll}
      >
        {items.length === 0 ? (
          <Empty
            starters={starters}
            disabled={locked}
            send={actions.send}
            _={_}
          />
        ) : items.map(item => item.kind === 'action' ? (
          <ActionCard
            key={item.id}
            card={item}
            locked={locked}
            actions={actions}
            _={_}
          />
        ) : (
          <Message key={item.id} item={item} _={_} />
        ))}
      </div>
      {props.behind && (
        <button
          type="button"
          className="agent-button agent-jump"
          onClick={props.jump}
        >
          {_('Jump to latest')}
        </button>
      )}
    </div>
  );
};
