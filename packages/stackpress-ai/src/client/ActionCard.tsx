//stackpress-ai
import type { ActionItem, PanelActions, Say } from './types.js';
import { statusText, when } from './phrases.js';
import { resultLine, toolLabel } from './state.js';

//--------------------------------------------------------------------//
// Helpers

//one input value as a person reads it
function show(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? '').length > 200 ? `${text.slice(0, 200)}…` : text ?? '';
}

//--------------------------------------------------------------------//
// Components

export type ActionCardProps = {
  card: ActionItem,
  //another request is in flight, so no button on this card may fire
  locked: boolean,
  actions: Pick<PanelActions, 'approve' | 'decline' | 'undo'>,
  _: Say
};

/**
 * One action the agent took or wants to take: what it is, what goes into
 * it, where it stands, and the buttons that apply. A waiting card says
 * nothing runs until the person approves. Undo shows only when the server
 * said the action can be undone.
 */
export default function ActionCard(props: ActionCardProps) {
  const { card, locked, actions, _ } = props;
  const name = _(toolLabel(card.tool));
  const inputs = Object.entries(card.input || {});
  const line = card.status === 'done' ? resultLine(card.result) : undefined;
  const disabled = locked || Boolean(card.busy);
  const detail = card.status === 'done'
    && card.result !== null
    && typeof card.result === 'object'
    ? JSON.stringify(card.result, null, 2).slice(0, 2000)
    : undefined;
  return (
    <article
      id={`agent-card-${card.id}`}
      className={`agent-card agent-card-${card.status}`}
      role="group"
      tabIndex={-1}
      aria-labelledby={`agent-card-${card.id}-name`}
    >
      <header className="agent-card-head">
        <strong id={`agent-card-${card.id}-name`} className="agent-card-name">
          {name}
        </strong>
        <span className={`agent-badge agent-badge-${card.status}`}>
          {statusText(card.status, card.busy, _)}
        </span>
      </header>
      {inputs.length > 0 && (
        <dl className="agent-inputs">
          {inputs.map(([ key, value ]) => (
            <div key={key} className="agent-input">
              <dt>{key}</dt>
              <dd>{show(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {card.status === 'waiting' && (
        <p className="agent-card-hint">
          {_('Nothing runs until you approve.')}
          {card.expires ? ` ${_('Expires %s.', when(card.expires))}` : ''}
        </p>
      )}
      {line && <p className="agent-card-result">{line}</p>}
      {card.status === 'failed' && (
        <p className="agent-card-result agent-card-error">
          {card.error || _('The action did not finish.')}
        </p>
      )}
      {card.undoError && (
        <p className="agent-card-error" role="alert">
          {_('Could not undo this.')}
          {card.undoError === 'refused' ? '' : ` ${card.undoError}`}
        </p>
      )}
      {detail && (
        <details className="agent-card-details">
          <summary>{_('Details')}</summary>
          <pre>{detail}</pre>
        </details>
      )}
      {card.status === 'waiting' && (
        <div className="agent-card-buttons">
          <button
            type="button"
            className="agent-button agent-primary"
            disabled={disabled}
            aria-label={_('Approve %s', name)}
            onClick={() => actions.approve(card.id)}
          >
            {_('Approve')}
          </button>
          <button
            type="button"
            className="agent-button"
            disabled={disabled}
            aria-label={_('Decline %s', name)}
            onClick={() => actions.decline(card.id)}
          >
            {_('Decline')}
          </button>
        </div>
      )}
      {card.status === 'done' && card.undoable && (
        <div className="agent-card-buttons">
          <button
            type="button"
            className="agent-button"
            disabled={disabled}
            aria-label={_('Undo %s', name)}
            onClick={() => actions.undo(card.id)}
          >
            {_('Undo')}
          </button>
        </div>
      )}
    </article>
  );
};
