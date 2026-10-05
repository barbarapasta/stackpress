//stackpress-ai
import type {
  FileChip,
  Notice,
  PanelActions,
  PanelState,
  Say
} from './types.js';
import { noticeText } from './phrases.js';

export type ComposerProps = {
  state: Pick<
    PanelState,
    'draft' | 'files' | 'models' | 'model' | 'running' | 'uploading' | 'usage'
  > & { notice?: Notice },
  actions: PanelActions,
  canAttach: boolean,
  textarea?: { current: HTMLTextAreaElement | null },
  _: Say
};

function Files(props: {
  files: FileChip[],
  remove: PanelActions['removeFile'],
  _: Say
}) {
  const { files, remove, _ } = props;
  if (!files.length) return null;
  return (
    <ul className="agent-files" aria-label={_('Attached files')}>
      {files.map(file => (
        <li key={file.ref} className="agent-chip">
          <span className="agent-chip-label">{file.name}</span>
          <button
            type="button"
            className="agent-chip-remove"
            aria-label={_('Remove %s', file.name)}
            onClick={() => remove(file.ref)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the person writes. Enter sends, Shift+Enter starts a new line. The
 * attach control exists only when the app supplied a way to turn a file
 * into a reference, and the model picker only when there is a choice.
 */
export default function Composer(props: ComposerProps) {
  const { state, actions, canAttach, _ } = props;
  const { draft, files, models, model, running, uploading, usage } = state;
  const empty = draft.trim().length === 0;
  return (
    <form
      className="agent-composer"
      onSubmit={event => {
        event.preventDefault();
        actions.send();
      }}
    >
      {state.notice && (
        <div className="agent-notice" role="alert">
          <span>{noticeText(state.notice.code, _)}</span>
          <button
            type="button"
            className="agent-chip-remove"
            aria-label={_('Dismiss message')}
            onClick={() => actions.dismiss()}
          >
            ×
          </button>
        </div>
      )}
      <Files files={files} remove={actions.removeFile} _={_} />
      <label htmlFor="agent-message" className="agent-sr">
        {_('Message')}
      </label>
      <textarea
        id="agent-message"
        ref={props.textarea}
        className="agent-input-text"
        rows={2}
        value={draft}
        placeholder={_('Ask the agent…')}
        onChange={event => actions.setDraft(event.target.value)}
        onKeyDown={event => {
          const composing = (event.nativeEvent as KeyboardEvent | undefined)
            ?.isComposing;
          if (event.key === 'Enter' && !event.shiftKey && !composing) {
            event.preventDefault();
            actions.send();
          }
        }}
      />
      <div className="agent-composer-bar">
        {canAttach && (
          <label className="agent-button agent-attach">
            <span>{uploading ? _('Attaching…') : _('Attach')}</span>
            <input
              type="file"
              className="agent-sr"
              disabled={uploading}
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) actions.attach(file);
              }}
            />
          </label>
        )}
        {models.length > 1 && (
          <select
            className="agent-select"
            aria-label={_('Model')}
            value={model}
            disabled={running}
            onChange={event => actions.setModel(event.target.value)}
          >
            {models.map(option => (
              <option key={option.model} value={option.model}>
                {option.title || option.model}
              </option>
            ))}
          </select>
        )}
        <button
          type="submit"
          className="agent-button agent-primary agent-send"
          disabled={running || empty}
        >
          {_('Send')}
        </button>
      </div>
      <p className="agent-note">
        {_('Every action is logged.')}
        {usage?.remaining !== undefined
          ? ` ${_('%s tokens left today.', String(usage.remaining))}`
          : ''}
      </p>
    </form>
  );
};
