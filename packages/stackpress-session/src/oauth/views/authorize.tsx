//stackpress-view
import { LayoutBlank, useLanguage } from 'stackpress-view/client';
//stackpress-session/oauth
import type {
  OAuthAuthorizeNotice,
  OAuthAuthorizeSnapshot,
  OAuthAuthorizeState
} from './types.js';
import type { OAuthPageProps } from './components.js';
import { decodeSnapshot } from './snapshot.js';
import {
  OAuthAlert,
  OAuthClientFacts,
  OAuthCsrf,
  OAuthHead,
  OAuthLinks,
  OAuthLocalNotice,
  OAuthShell
} from './components.js';

export type OAuthAuthorizePageProps = OAuthPageProps<OAuthAuthorizeSnapshot>;

function useTitle(state: OAuthAuthorizeState): string {
  const { _ } = useLanguage();
  switch (state) {
    case 'approve': return _('Approve program access');
    case 'factor_unavailable': return _('Extra identity check needed');
    case 'policy_denied': return _('This access is not available');
    case 'completed': return _('This request is already finished');
    case 'denied': return _('You denied this request');
    case 'lost': return _('Sign-in request not found');
    case 'expired': return _('This sign-in request expired');
    case 'wrong_account': return _('This request belongs to another account');
    case 'inactive': return _('Your account cannot approve programs');
    case 'invalid_request': return _('This sign-in request cannot be used');
    case 'unavailable': return _('Service temporarily unavailable');
    case 'rate_limited': return _('Too many requests');
    default: return _('Something went wrong');
  }
}

function Notice(props: { notice?: OAuthAuthorizeNotice }) {
  const { _ } = useLanguage();
  switch (props.notice) {
    case 'selection_changed':
      return (
        <OAuthAlert tone="warning">
          {_('The access available for this request changed, or the form was altered. Nothing was approved. Review the current choices and try again.')}
        </OAuthAlert>
      );
    case 'selection_denied':
      return (
        <OAuthAlert tone="error">
          {_('Your account is not allowed to approve that selection. Nothing was approved. Choose less access or deny the request.')}
        </OAuthAlert>
      );
    case 'form_expired':
      return (
        <OAuthAlert tone="error">
          {_('This form expired or did not come from this page. Nothing was changed. Review the request and submit again.')}
        </OAuthAlert>
      );
    case 'retry':
      return (
        <OAuthAlert tone="error">
          {_('We could not complete the approval. Nothing was approved. Please try again.')}
        </OAuthAlert>
      );
    default:
      return null;
  }
}

/**
 * Deny-only form: returns the person to the program with a refusal.
 */
function DenyForm(props: { data: OAuthAuthorizeSnapshot, label: string }) {
  const { data, label } = props;
  return (
    <form method="post" action={data.links.authorize} className="oauth-inline-form">
      <OAuthCsrf csrf={data.csrf} />
      <button type="submit" name="action" value="deny" className="oauth-button oauth-button-secondary">
        {label}
      </button>
    </form>
  );
}

function ApproveForm(props: { data: OAuthAuthorizeSnapshot }) {
  const { data } = props;
  const { _ } = useLanguage();
  const needsCheck = data.factor.required && !data.factor.verified;
  return (
    <form method="post" action={data.links.authorize} className="oauth-form">
      <OAuthCsrf csrf={data.csrf} />
      <fieldset className="oauth-fieldset">
        <legend className="oauth-subtitle">{_('Permissions')}</legend>
        {data.scopes.length ? data.scopes.map((scope, index) => (
          <div className="oauth-choice" key={scope.id}>
            <input
              type="checkbox"
              id={`oauth-scope-${index}`}
              name="scope[]"
              value={scope.id}
              defaultChecked={scope.checked}
              aria-describedby={`oauth-scope-${index}-desc`}
            />
            <label htmlFor={`oauth-scope-${index}`}>
              <span className="oauth-choice-name">{scope.name}</span>
              <span id={`oauth-scope-${index}-desc`} className="oauth-muted">
                {scope.description} <code className="oauth-code">{scope.id}</code>
              </span>
            </label>
          </div>
        )) : <p className="oauth-muted">{_('This program did not request any permissions.')}</p>}
      </fieldset>
      <fieldset className="oauth-fieldset">
        <legend className="oauth-subtitle">{_('API operations')}</legend>
        {data.operations.length ? data.operations.map((operation, index) => (
          <div className="oauth-choice" key={operation.id}>
            <input
              type="checkbox"
              id={`oauth-operation-${index}`}
              name="operation[]"
              value={operation.id}
              defaultChecked={operation.checked}
            />
            <label htmlFor={`oauth-operation-${index}`}>
              <code className="oauth-code">{operation.method} {operation.route}</code>
              <span className="oauth-muted">{operation.id}</span>
            </label>
          </div>
        )) : <p className="oauth-muted">{_('No ordinary API operations are included.')}</p>}
      </fieldset>
      <p className="oauth-muted" id="oauth-narrow-help">
        {_('You can untick anything you do not want to allow. The program cannot receive more than it asked for.')}
      </p>
      {data.factor.required ? (
        data.factor.verified ? (
          <OAuthAlert tone="success">
            {_('Identity check complete for the selection shown. Changing the selection needs a new check.')}
          </OAuthAlert>
        ) : (
          <OAuthAlert tone="info">
            {_('This app requires an extra identity check with your authenticator before you approve.')}
          </OAuthAlert>
        )
      ) : null}
      <div className="oauth-actions">
        <button
          type="submit"
          name="action"
          value="approve"
          className="oauth-button oauth-button-primary"
          aria-describedby="oauth-narrow-help"
        >
          {needsCheck ? _('Continue to identity check') : _('Approve')}
        </button>
        <button type="submit" name="action" value="deny" className="oauth-button oauth-button-secondary">
          {_('Deny')}
        </button>
      </div>
    </form>
  );
}

export function OAuthAuthorizeBody(props: { data: OAuthAuthorizeSnapshot }) {
  const { data } = props;
  const { _ } = useLanguage();
  const title = useTitle(data.state);
  const name = data.client?.name || _('This program');
  const restart = _('Return to your program and start signing in again.');
  const links = [
    { href: data.links.connections, label: _('Manage connected programs') },
    { href: data.links.account, label: _('Account settings') }
  ];
  switch (data.state) {
    case 'approve':
      return (
        <OAuthShell icon="plug" title={title} footer={<OAuthLinks links={links} />}>
          <Notice notice={data.notice} />
          <p className="oauth-lead">
            {_('%s wants to use your account.', name)}
          </p>
          <OAuthClientFacts client={data.client} resource={data.resource} account={data.account} />
          <OAuthLocalNotice client={data.client} />
          <ApproveForm data={data} />
        </OAuthShell>
      );
    case 'factor_unavailable':
      return (
        <OAuthShell icon="key" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="warning">
            {_('This app requires an authenticator check before you approve this program, but your account has no authenticator set up. Access has not been approved.')}
          </OAuthAlert>
          <OAuthClientFacts client={data.client} resource={data.resource} account={data.account} />
          <p>{_('Set up two-factor authentication, then come back to this request while it is still open. If you cannot set it up, contact the app owner for help.')}</p>
          <div className="oauth-actions">
            <a className="oauth-button oauth-button-primary" href={data.links.factorSetup}>
              {_('Set up two-factor authentication')}
            </a>
            <DenyForm data={data} label={_('Cancel and return to the program')} />
          </div>
        </OAuthShell>
      );
    case 'policy_denied':
      return (
        <OAuthShell icon="ban" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="error">
            {_('Your account is not allowed to give this program the access it requested. Nothing was approved.')}
          </OAuthAlert>
          <OAuthClientFacts client={data.client} resource={data.resource} account={data.account} />
          <p>{_('Deny the request to tell the program, or contact the app owner if you think you should have this access.')}</p>
          <div className="oauth-actions">
            <DenyForm data={data} label={_('Deny and return to the program')} />
          </div>
        </OAuthShell>
      );
    case 'completed':
      return (
        <OAuthShell icon="check-circle" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="info">
            {_('Your answer to this request was already saved, so nothing new was issued.')}
          </OAuthAlert>
          <p>{_('If your program did not finish connecting, return to it and start signing in again.')}</p>
        </OAuthShell>
      );
    case 'denied':
      return (
        <OAuthShell icon="times-circle" title={title} footer={<OAuthLinks links={links} />}>
          <p>{_('No access was given. If you change your mind, start signing in again from your program.')}</p>
        </OAuthShell>
      );
    case 'lost':
    case 'expired':
      return (
        <OAuthShell icon="hourglass-end" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="warning">
            {data.state === 'expired'
              ? _('This request was open too long. No access was given.')
              : _('This browser has no open sign-in request. No access was given.')}
          </OAuthAlert>
          <p>{restart}</p>
        </OAuthShell>
      );
    case 'wrong_account':
      return (
        <OAuthShell icon="user-lock" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="error">
            {_('This request was opened by a different account. No access was given.')}
          </OAuthAlert>
          <p>{_('Sign in with the account that started it, or start signing in again from your program.')}</p>
        </OAuthShell>
      );
    case 'inactive':
      return (
        <OAuthShell icon="user-slash" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="error">
            {_('Your account is inactive or suspended, so it cannot approve programs. No access was given.')}
          </OAuthAlert>
          <p>{_('Contact the app owner for help with your account.')}</p>
        </OAuthShell>
      );
    case 'invalid_request':
      return (
        <OAuthShell icon="exclamation-triangle" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="error">
            {_('The program, its return address or its request could not be verified. You were not sent back to the program.')}
          </OAuthAlert>
          <p>{restart}</p>
        </OAuthShell>
      );
    case 'rate_limited':
      return (
        <OAuthShell icon="stopwatch" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="error">
            {_('Too many sign-in attempts. Wait %s seconds, then try again.', String(data.retryAfter || 60))}
          </OAuthAlert>
        </OAuthShell>
      );
    default:
      return (
        <OAuthShell icon="exclamation-circle" title={title} footer={<OAuthLinks links={links} />}>
          <OAuthAlert tone="error">
            {_('Nothing was approved. Please try again in a moment.')}
          </OAuthAlert>
          <OAuthLinks links={[ { href: data.links.authorize, label: _('Try again') } ]} />
        </OAuthShell>
      );
  }
}

export function OAuthAuthorizeHead(props: OAuthAuthorizePageProps) {
  const title = useTitle(decodeSnapshot<OAuthAuthorizeSnapshot>(props.data.oauth).state);
  return <OAuthHead {...props} title={title} />;
}

export function OAuthAuthorizePage(props: OAuthAuthorizePageProps) {
  return (
    <LayoutBlank {...props}>
      <OAuthAuthorizeBody data={decodeSnapshot<OAuthAuthorizeSnapshot>(props.data.oauth)} />
    </LayoutBlank>
  );
}

export const Head = OAuthAuthorizeHead;
export default OAuthAuthorizePage;
