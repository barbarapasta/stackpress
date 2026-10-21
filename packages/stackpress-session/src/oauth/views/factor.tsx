//stackpress-view
import { LayoutBlank, useLanguage } from 'stackpress-view/client';
//stackpress-session/oauth
import type {
  OAuthFactorError,
  OAuthFactorSnapshot,
  OAuthFactorState
} from './types.js';
import type { OAuthPageProps } from './components.js';
import { decodeSnapshot } from './snapshot.js';
import {
  OAuthAccessList,
  OAuthAlert,
  OAuthClientFacts,
  OAuthCsrf,
  OAuthHead,
  OAuthLinks,
  OAuthShell
} from './components.js';

export type OAuthFactorPageProps = OAuthPageProps<OAuthFactorSnapshot>;

function useTitle(state: OAuthFactorState): string {
  const { _ } = useLanguage();
  switch (state) {
    case 'verify': return _('Confirm it is you');
    case 'unavailable': return _('Extra identity check needed');
    case 'lost': return _('Sign-in request not found');
    case 'expired': return _('This sign-in request expired');
    case 'completed': return _('This request is already finished');
    case 'wrong_account': return _('This request belongs to another account');
    case 'inactive': return _('Your account cannot approve programs');
    case 'unavailable_service': return _('Service temporarily unavailable');
    default: return _('Something went wrong');
  }
}

function useErrorText(error: OAuthFactorError | undefined, retryAfter?: number): string {
  const { _ } = useLanguage();
  switch (error) {
    case 'invalid_code':
      return _('That code is not valid. Check your authenticator app and enter the current 6-digit code.');
    case 'code_reused':
      return _('That code was already used. Wait for your authenticator to show a new code, then try again.');
    case 'rate_limited':
      return _('Too many attempts. Wait %s seconds, then try again.', String(retryAfter || 60));
    case 'form_expired':
      return _('This form expired or did not come from this page. Enter a new code and try again.');
    default:
      return '';
  }
}

export function OAuthFactorBody(props: { data: OAuthFactorSnapshot }) {
  const { data } = props;
  const { _ } = useLanguage();
  const title = useTitle(data.state);
  const errorText = useErrorText(data.error, data.retryAfter);
  const back = { href: data.links.authorize, label: _('Back to the approval request') };
  const links = [
    { href: data.links.connections, label: _('Manage connected programs') },
    { href: data.links.account, label: _('Account settings') }
  ];
  if (data.state === 'verify') {
    const name = data.client?.name || _('this program');
    return (
      <OAuthShell icon="key" title={title} footer={<OAuthLinks links={[ back ]} />}>
        <p className="oauth-lead">
          {_('Enter a code from your authenticator app to approve %s with the access below.', name)}
        </p>
        <OAuthClientFacts client={data.client} resource={data.resource} account={data.account} />
        <OAuthAccessList scopes={data.scopes} operations={data.operations} />
        <form method="post" action={data.links.factor} className="oauth-form" noValidate>
          <OAuthCsrf csrf={data.csrf} />
          {data.scopes.map((scope) => (
            <input key={`s-${scope.id}`} type="hidden" name="scope[]" value={scope.id} />
          ))}
          {data.operations.map((operation) => (
            <input key={`o-${operation.id}`} type="hidden" name="operation[]" value={operation.id} />
          ))}
          <div className="oauth-field">
            <label htmlFor="oauth-factor-code" className="oauth-label">
              {_('Authenticator code')}
            </label>
            <input
              id="oauth-factor-code"
              className="oauth-input"
              type="text"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoFocus
              aria-invalid={errorText ? true : undefined}
              aria-describedby={errorText ? 'oauth-factor-help oauth-factor-error' : 'oauth-factor-help'}
            />
            <p id="oauth-factor-help" className="oauth-muted">
              {_('6 digits. Each code can be used once.')}
            </p>
            {errorText ? (
              <OAuthAlert tone="error" id="oauth-factor-error">{errorText}</OAuthAlert>
            ) : null}
          </div>
          <div className="oauth-actions">
            <button type="submit" className="oauth-button oauth-button-primary">
              {_('Verify')}
            </button>
          </div>
        </form>
      </OAuthShell>
    );
  }
  if (data.state === 'unavailable') {
    return (
      <OAuthShell icon="key" title={title} footer={<OAuthLinks links={[ back, ...links ]} />}>
        <OAuthAlert tone="warning">
          {_('This app requires an authenticator check before you approve this program, but your account has no authenticator set up. Access has not been approved.')}
        </OAuthAlert>
        <OAuthClientFacts client={data.client} resource={data.resource} account={data.account} />
        <p>{_('Set up two-factor authentication, then come back to this request while it is still open. If you cannot set it up, contact the app owner for help, or go back and deny the request.')}</p>
        <div className="oauth-actions">
          <a className="oauth-button oauth-button-primary" href={data.links.factorSetup}>
            {_('Set up two-factor authentication')}
          </a>
        </div>
      </OAuthShell>
    );
  }
  const message = data.state === 'lost' || data.state === 'expired'
    ? _('No access was given. Return to your program and start signing in again.')
    : data.state === 'completed'
      ? _('Your answer to this request was already saved, so nothing new was issued.')
      : data.state === 'wrong_account'
        ? _('This request was opened by a different account. No access was given.')
        : data.state === 'inactive'
          ? _('Your account is inactive or suspended, so it cannot approve programs. Contact the app owner for help.')
          : _('Nothing was approved. Please try again in a moment.');
  return (
    <OAuthShell icon="exclamation-triangle" title={title} footer={<OAuthLinks links={links} />}>
      <OAuthAlert tone={data.state === 'completed' ? 'info' : 'error'}>{message}</OAuthAlert>
    </OAuthShell>
  );
}

export function OAuthFactorHead(props: OAuthFactorPageProps) {
  const title = useTitle(decodeSnapshot<OAuthFactorSnapshot>(props.data.oauth).state);
  return <OAuthHead {...props} title={title} />;
}

export function OAuthFactorPage(props: OAuthFactorPageProps) {
  return (
    <LayoutBlank {...props}>
      <OAuthFactorBody data={decodeSnapshot<OAuthFactorSnapshot>(props.data.oauth)} />
    </LayoutBlank>
  );
}

export const Head = OAuthFactorHead;
export default OAuthFactorPage;
