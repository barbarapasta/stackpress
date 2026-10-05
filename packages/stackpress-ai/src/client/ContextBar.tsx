//stackpress-ai
import type { Chip, PanelActions, Say } from './types.js';

export type ContextBarProps = {
  chips: Chip[],
  remove: PanelActions['removeContext'],
  _: Say
};

/**
 * What the agent is told the page is about: the page address and what the
 * page declared. Each chip can be removed, and a removed one is not sent.
 */
export default function ContextBar(props: ContextBarProps) {
  const { chips, remove, _ } = props;
  if (!chips.length) return null;
  return (
    <ul className="agent-context" aria-label={_('Page context')}>
      {chips.map(chip => (
        <li key={chip.key} className="agent-chip">
          <span className="agent-chip-label">{chip.label}</span>
          <button
            type="button"
            className="agent-chip-remove"
            aria-label={_('Remove %s', chip.label)}
            onClick={() => remove(chip.key)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
};
