//modules
import type { ReactNode } from 'react';
//stackpress-view
import type { ServerPageProps } from 'stackpress-view/client';
import { useLanguage } from 'stackpress-view/client';
//stackpress-session/oauth
import type {
  OAuthBrowserCsrf,
  OAuthBrowserPageData,
  OAuthClientView,
  OAuthOperationView,
  OAuthResourceView,
  OAuthScopeView
} from './types.js';

//Every value rendered below is React text (escaped by React), never
//`dangerouslySetInnerHTML`, and client-supplied values are never used
//as a link target, image source or style. No remote logo is fetched.

export type OAuthPageProps<S> = ServerPageProps<OAuthBrowserPageData<S>>;

export function OAuthCsrf(props: { csrf?: OAuthBrowserCsrf }) {
  const { csrf } = props;
  if (!csrf) return null;
  return <input type="hidden" name={csrf.name} value={csrf.token} />;
}

export function OAuthShell(props: {
  icon: string,
  title: string,
  children: ReactNode,
  footer?: ReactNode,
  wide?: boolean
}) {
  const { icon, title, children, footer, wide } = props;
  return (
    <main className={`oauth-page${wide ? ' oauth-page-wide' : ''}`}>
      <section className="oauth-card" aria-labelledby="oauth-title">
        <header className="oauth-card-header">
          <i className={`fas fa-fw fa-${icon}`} aria-hidden="true" />
          <h1 id="oauth-title" className="oauth-title">{title}</h1>
        </header>
        <div className="oauth-card-body">{children}</div>
        {footer ? <footer className="oauth-card-footer">{footer}</footer> : null}
      </section>
    </main>
  );
}

export function OAuthAlert(props: {
  tone: 'error' | 'success' | 'warning' | 'info',
  children: ReactNode,
  id?: string
}) {
  const { tone, children, id } = props;
  //errors interrupt (alert); confirmations and hints are polite (status)
  const role = tone === 'error' ? 'alert' : 'status';
  const icon = tone === 'error' ? 'exclamation-circle'
    : tone === 'success' ? 'check-circle'
    : tone === 'warning' ? 'exclamation-triangle'
    : 'info-circle';
  return (
    <div id={id} className={`oauth-alert oauth-alert-${tone}`} role={role}>
      <i className={`fas fa-fw fa-${icon}`} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/**
 * Program, its checked addresses, the exact service and the account.
 */
export function OAuthClientFacts(props: {
  client?: OAuthClientView,
  resource?: OAuthResourceView,
  account?: { name: string }
}) {
  const { client, resource, account } = props;
  const { _ } = useLanguage();
  return (
    <dl className="oauth-facts">
      {client ? (
        <>
          <dt>{_('Program')}</dt>
          <dd>
            <span className="oauth-client-name">{client.name || _('Unnamed program')}</span>
            <code className="oauth-code">{client.id}</code>
          </dd>
          <dt>{_('Program address')}</dt>
          <dd>
            {client.host ? <code className="oauth-code">{client.host}</code> : (
              <span>{_('Registered directly with this app; no website was checked')}</span>
            )}
          </dd>
          <dt>{_('Returns to')}</dt>
          <dd>
            <code className="oauth-code">{client.redirectHost}</code>
            <span className="oauth-muted oauth-break">{client.redirect}</span>
          </dd>
        </>
      ) : null}
      {resource ? (
        <>
          <dt>{_('Service')}</dt>
          <dd>
            <span>{resource.name}</span>
            <code className="oauth-code">{resource.id}</code>
            {resource.description ? (
              <span className="oauth-muted">{resource.description}</span>
            ) : null}
          </dd>
        </>
      ) : null}
      {account ? (
        <>
          <dt>{_('Signed in as')}</dt>
          <dd>{account.name || _('Your account')}</dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * The local-program notice (events.md): no selection or allowlist is a
 * publisher endorsement.
 */
export function OAuthLocalNotice(props: { client?: OAuthClientView }) {
  const { client } = props;
  const { _ } = useLanguage();
  if (!client) return null;
  return (
    <div className="oauth-notice" role="note">
      <i className="fas fa-fw fa-shield-alt" aria-hidden="true" />
      <div>
        <p>
          {_('This app has not verified who published this program. Only approve a program you started yourself and trust.')}
        </p>
        {client.local ? (
          <p>
            {_('After you answer, your browser returns to %s, an address on this computer.', client.redirectHost)}
          </p>
        ) : (
          <p>
            {_('After you answer, your browser returns to %s.', client.redirectHost)}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Read-only list of the access being verified or already approved.
 */
export function OAuthAccessList(props: {
  scopes: OAuthScopeView[],
  operations: OAuthOperationView[]
}) {
  const { scopes, operations } = props;
  const { _ } = useLanguage();
  return (
    <div className="oauth-access">
      <h2 className="oauth-subtitle">{_('Permissions')}</h2>
      {scopes.length ? (
        <ul className="oauth-list">
          {scopes.map((scope) => (
            <li key={scope.id}>
              <span className="oauth-choice-name">{scope.name}</span>
              {scope.description ? (
                <span className="oauth-muted"> — {scope.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="oauth-muted">{_('No permissions')}</p>}
      <h2 className="oauth-subtitle">{_('API operations')}</h2>
      {operations.length ? (
        <ul className="oauth-list">
          {operations.map((operation) => (
            <li key={operation.id}>
              <code className="oauth-code">{operation.method} {operation.route}</code>
              <span className="oauth-muted"> {operation.id}</span>
            </li>
          ))}
        </ul>
      ) : <p className="oauth-muted">{_('No API operations')}</p>}
    </div>
  );
}

export function OAuthLinks(props: { links: Array<{ href: string, label: string }> }) {
  return (
    <nav className="oauth-links">
      {props.links.map((link) => (
        <a key={link.href} href={link.href}>{link.label}</a>
      ))}
    </nav>
  );
}

export function OAuthHead<S>(props: OAuthPageProps<S> & { title: string }) {
  const { data, styles = [], title } = props;
  const { favicon = '/favicon.ico' } = data?.brand || {};
  const mimetype = favicon.endsWith('.png')
    ? 'image/png'
    : favicon.endsWith('.svg')
      ? 'image/svg+xml'
      : 'image/x-icon';
  return (
    <>
      <title>{title}</title>
      <meta name="robots" content="noindex" />
      <meta name="referrer" content="no-referrer" />
      {favicon && <link rel="icon" type={mimetype} href={favicon} />}
      <link rel="stylesheet" type="text/css" href="/styles/global.css" />
      {styles.map((href, index) => (
        <link key={index} rel="stylesheet" type="text/css" href={href} />
      ))}
    </>
  );
}

export function formatDate(iso: string): string {
  //deterministic (server and browser render the same text)
  return iso ? `${iso.substring(0, 10)} ${iso.substring(11, 16)} UTC` : '';
}
