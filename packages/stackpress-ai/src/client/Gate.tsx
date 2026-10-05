//stackpress-ai
import type { PanelActions, Phase, Say } from './types.js';
import { when } from './phrases.js';

export type GateProps = {
  phase: Phase,
  resetsAt?: string,
  signInUrl: string,
  retry: PanelActions['retry'],
  _: Say
};

/**
 * What takes the place of the composer when the agent cannot be used: it
 * is still connecting, nobody is signed in, it is not reachable, or the
 * person's daily allowance is used up.
 */
export default function Gate(props: GateProps) {
  const { phase, resetsAt, signInUrl, retry, _ } = props;
  if (phase === 'loading' || phase === 'idle') {
    return (
      <div className="agent-gate" role="status">
        <p>{_('Connecting to the agent…')}</p>
      </div>
    );
  }
  if (phase === 'signed-out') {
    return (
      <div className="agent-gate agent-gate-signed-out">
        <h3>{_('Sign in to use the agent')}</h3>
        <p>{_('The agent acts as you, so it needs you to be signed in.')}</p>
        <a className="agent-button agent-primary" href={signInUrl}>
          {_('Sign in')}
        </a>
      </div>
    );
  }
  if (phase === 'unavailable') {
    return (
      <div className="agent-gate agent-gate-unavailable" role="alert">
        <h3>{_('The agent is unavailable')}</h3>
        <p>
          {_('It is not set up here, or it cannot be reached right now.')}
        </p>
        <button
          type="button"
          className="agent-button agent-primary"
          onClick={() => retry()}
        >
          {_('Try again')}
        </button>
      </div>
    );
  }
  if (phase === 'limit') {
    return (
      <div className="agent-gate agent-gate-limit" role="status">
        <h3>{_('Daily limit reached')}</h3>
        <p>
          {resetsAt && when(resetsAt)
            ? _('You can use the agent again after %s.', when(resetsAt))
            : _('You can use the agent again tomorrow.')}
        </p>
      </div>
    );
  }
  return null;
};
