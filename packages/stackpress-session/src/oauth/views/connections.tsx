//stackpress-view
import { LayoutBlank, useLanguage } from 'stackpress-view/client';
//stackpress-session/oauth
import type {
  OAuthConnectionView,
  OAuthConnectionsSnapshot
} from './types.js';
import type { OAuthPageProps } from './components.js';
import { decodeSnapshot } from './snapshot.js';
import {
  OAuthAlert,
  OAuthCsrf,
  OAuthHead,
  OAuthLinks,
  OAuthShell,
  formatDate
} from './components.js';

export type OAuthConnectionsPageProps = OAuthPageProps<OAuthConnectionsSnapshot>;

function Result(props: { data: OAuthConnectionsSnapshot }) {
  const { data } = props;
  const { _ } = useLanguage();
  switch (data.result) {
    case 'disconnected':
      return (
        <OAuthAlert tone="success">
          {data.resultName
            ? _('%s was disconnected. It can no longer use your account through this approval.', data.resultName)
            : _('The program was disconnected. It can no longer use your account through this approval.')}
        </OAuthAlert>
      );
    case 'not_found':
      return (
        <OAuthAlert tone="error">
          {_('That connection is unavailable. It may already have been removed.')}
        </OAuthAlert>
      );
    case 'failed':
      return (
        <OAuthAlert tone="error">
          {_('We could not disconnect that program, so its access was not changed. Please try again.')}
        </OAuthAlert>
      );
    case 'form_expired':
      return (
        <OAuthAlert tone="error">
          {_('This form expired or did not come from this page. Nothing was changed. Please try again.')}
        </OAuthAlert>
      );
    default:
      return null;
  }
}

function Connection(props: {
  connection: OAuthConnectionView,
  data: OAuthConnectionsSnapshot,
  index: number
}) {
  const { connection, data, index } = props;
  const { _ } = useLanguage();
  const name = connection.client.name || connection.client.host || _('Unnamed program');
  const headingId = `oauth-connection-${index}`;
  return (
    <li className="oauth-connection" aria-labelledby={headingId}>
      <h2 id={headingId} className="oauth-connection-name">{name}</h2>
      <dl className="oauth-facts">
        <dt>{_('Program')}</dt>
        <dd>
          {connection.client.host ? <code className="oauth-code">{connection.client.host}</code> : null}
          <code className="oauth-code">{connection.client.id}</code>
        </dd>
        <dt>{_('Service')}</dt>
        <dd>
          <span>{connection.resource.name}</span>
          <code className="oauth-code">{connection.resource.id}</code>
        </dd>
        <dt>{_('Permissions')}</dt>
        <dd>
          {connection.scopes.length
            ? connection.scopes.map((scope) => scope.name).join(', ')
            : _('No permissions')}
        </dd>
        <dt>{_('API operations')}</dt>
        <dd>
          {connection.operations.length
            ? connection.operations.join(', ')
            : _('No API operations')}
        </dd>
        <dt>{_('Approved')}</dt>
        <dd>{formatDate(connection.issued)}</dd>
        <dt>{_('Access ends by')}</dt>
        <dd>{formatDate(connection.deadline)}</dd>
      </dl>
      <form method="post" action={`${data.links.connections}/revoke`} className="oauth-inline-form">
        <OAuthCsrf csrf={data.csrf} />
        <input type="hidden" name="grant" value={connection.grantId} />
        <button
          type="submit"
          className="oauth-button oauth-button-danger"
          aria-label={_('Disconnect %s', name)}
        >
          {_('Disconnect')}
        </button>
      </form>
    </li>
  );
}

export function OAuthConnectionsBody(props: { data: OAuthConnectionsSnapshot }) {
  const { data } = props;
  const { _ } = useLanguage();
  const footer = (
    <OAuthLinks links={[ { href: data.links.account, label: _('Back to account settings') } ]} />
  );
  if (data.state === 'inactive') {
    return (
      <OAuthShell icon="user-slash" title={_('Connected programs')} footer={footer} wide>
        <OAuthAlert tone="error">
          {_('Your account is inactive or suspended, so connected programs cannot be shown. Contact the app owner for help.')}
        </OAuthAlert>
      </OAuthShell>
    );
  }
  if (data.state !== 'list') {
    return (
      <OAuthShell icon="exclamation-circle" title={_('Connected programs')} footer={footer} wide>
        <Result data={data} />
        <OAuthAlert tone="error">
          {_('Connected programs could not be loaded right now. Please try again in a moment.')}
        </OAuthAlert>
        <OAuthLinks links={[ { href: data.links.connections, label: _('Try again') } ]} />
      </OAuthShell>
    );
  }
  return (
    <OAuthShell icon="plug" title={_('Connected programs')} footer={footer} wide>
      <Result data={data} />
      <p className="oauth-lead">
        {_('Programs you approved to use your account. Disconnecting stops both their tool and API access.')}
      </p>
      {data.connections.length ? (
        <ul className="oauth-connections">
          {data.connections.map((connection, index) => (
            <Connection
              key={connection.grantId}
              connection={connection}
              data={data}
              index={index}
            />
          ))}
        </ul>
      ) : (
        <div className="oauth-empty">
          <i className="fas fa-fw fa-plug" aria-hidden="true" />
          <p>{_('No programs are connected to your account.')}</p>
        </div>
      )}
      <p className="oauth-muted">
        {_('Older API keys are not listed here; they are managed separately.')}
      </p>
    </OAuthShell>
  );
}

export function OAuthConnectionsHead(props: OAuthConnectionsPageProps) {
  const { _ } = useLanguage();
  return <OAuthHead {...props} title={_('Connected programs')} />;
}

export function OAuthConnectionsPage(props: OAuthConnectionsPageProps) {
  return (
    <LayoutBlank {...props}>
      <OAuthConnectionsBody data={decodeSnapshot<OAuthConnectionsSnapshot>(props.data.oauth)} />
    </LayoutBlank>
  );
}

export const Head = OAuthConnectionsHead;
export default OAuthConnectionsPage;
