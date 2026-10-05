//stackpress-ai
import type { PanelActions, Threads, Say } from './types.js';
import { when } from './phrases.js';

export type HistoryProps = {
  threads: Threads,
  current?: string,
  actions: Pick<PanelActions, 'openThread' | 'showChat' | 'showHistory'>,
  _: Say
};

/**
 * The person's earlier chats, newest first as the server lists them.
 */
export default function History(props: HistoryProps) {
  const { threads, current, actions, _ } = props;
  return (
    <section className="agent-history" aria-label={_('Earlier chats')}>
      {threads.status === 'loading' && threads.rows.length === 0 && (
        <p role="status">{_('Loading earlier chats…')}</p>
      )}
      {threads.status === 'error' && (
        <div role="alert">
          <p>{_('Earlier chats could not be loaded.')}</p>
          <button
            type="button"
            className="agent-button"
            onClick={() => actions.showHistory()}
          >
            {_('Try again')}
          </button>
        </div>
      )}
      {threads.status === 'ready' && threads.rows.length === 0 && (
        <p>{_('No earlier chats yet.')}</p>
      )}
      {threads.rows.length > 0 && (
        <ul className="agent-threads">
          {threads.rows.map(row => (
            <li key={row.id}>
              <button
                type="button"
                className="agent-thread-row"
                aria-current={row.id === current ? 'true' : undefined}
                onClick={() => actions.openThread(row.id)}
              >
                <span className="agent-thread-title">
                  {row.title || _('Untitled chat')}
                </span>
                <time dateTime={String(row.updated)}>
                  {when(String(row.updated))}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="agent-button"
        onClick={() => actions.showChat()}
      >
        {_('Back to chat')}
      </button>
    </section>
  );
};
