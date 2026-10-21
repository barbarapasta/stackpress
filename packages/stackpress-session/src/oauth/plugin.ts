//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-session
import normalizeOAuthConfig from './config.js';
import OAuthService from './OAuthService.js';
import type { OAuthSessionConfig } from './types.js';
import finalize from './events/finalize.js';
import authorize from './events/authorize.js';
import authorizationStart from './events/authorizationStart.js';
import clientRegister from './events/clientRegister.js';
import codeExchange from './events/codeExchange.js';
import refresh from './events/refresh.js';
import tokenVerify from './events/tokenVerify.js';
import revoke from './events/revoke.js';
import grantsList from './events/grantsList.js';
import grantRevoke from './events/grantRevoke.js';
import cleanup from './events/cleanup.js';
import legacyBind from './events/legacyBind.js';
import legacyVerify from './events/legacyVerify.js';
import tokenPage from './pages/token.js';
import registerPage from './pages/register.js';
import revokePage from './pages/revoke.js';
//task 00007: ordinary signed-in browser pages (not native routes)
import authorizePage from './pages/authorize.js';
import factorPage from './pages/factor.js';
import connectionsPage, { connectionsRevokePage } from './pages/connections.js';
import { issuerMetadata, resourceMetadata } from './pages/discovery.js';
import { issuerMetadataPath, resourceMetadataPath, ROOT_RESOURCE_METADATA_PATH } from './metadata.js';
import type { OAuthPlugin } from './types.js';

/**
 * This interface is intended for the Stackpress library.
 */
export default function plugin(ctx: Server) {
  //if no session.oauth config, disable the optional feature entirely
  const session = ctx.config.get<{ oauth?: OAuthSessionConfig }>('session');
  if (!session || !session.oauth) return;
  //on config, validate settings and register the typed service
  ctx.on('config', ({ ctx }) => {
    const session = ctx.config
      .get<{ oauth?: OAuthSessionConfig }>('session');
    const config = normalizeOAuthConfig(session?.oauth);
    ctx.register('oauth', new OAuthService(ctx, config));
  });
  //on listen, register every fixed internal event handler
  ctx.on('listen', ({ ctx }) => {
    ctx.on('oauth-finalize', finalize);
    ctx.on('oauth-authorization-start', authorizationStart);
    ctx.on('oauth-authorize', authorize);
    ctx.on('oauth-client-register', clientRegister);
    ctx.on('oauth-code-exchange', codeExchange);
    ctx.on('oauth-refresh', refresh);
    ctx.on('oauth-token-verify', tokenVerify);
    ctx.on('oauth-revoke', revoke);
    ctx.on('oauth-grants-list', grantsList);
    ctx.on('oauth-grant-revoke', grantRevoke);
    ctx.on('oauth-cleanup', cleanup);
    //task 00008: operator-only legacy-key upgrade; not one of
    //OAuthService's required nine finalize() listeners (same treatment
    //as oauth-cleanup above), since these back API's migration adapter
    //and hardened legacy validator, not the client-facing protocol.
    ctx.on('oauth-legacy-bind', legacyBind);
    ctx.on('oauth-legacy-verify', legacyVerify);
  });
  //on route, add the native discovery/token/register/revoke protocol
  //routes beneath the configured base, then (task 00007) the guarded
  //GET/POST /authorize, /factor, GET /connections and POST
  ///connections/revoke browser pages.
  ctx.on('route', ({ ctx }) => {
    //the already-validated config from the service registered during
    //`config`, not a re-normalized copy of the raw setting.
    const config = ctx.plugin<OAuthPlugin>('oauth').config;

    ctx.route('GET', issuerMetadataPath(config.issuer), issuerMetadata);
    for (const resource of config.resources) {
      ctx.route(
        'GET',
        resourceMetadataPath(resource.resource),
        resourceMetadata(resource.resource)
      );
    }
    if (config.resources.length === 1) {
      ctx.route(
        'GET',
        ROOT_RESOURCE_METADATA_PATH,
        resourceMetadata(config.resources[0].resource)
      );
    }

    ctx.route('POST', `${config.base}/token`, tokenPage);
    ctx.route('OPTIONS', `${config.base}/token`, tokenPage);
    ctx.route('POST', `${config.base}/revoke`, revokePage);
    ctx.route('OPTIONS', `${config.base}/revoke`, revokePage);
    if (config.registration.enabled) {
      ctx.route('POST', `${config.base}/register`, registerPage);
      ctx.route('OPTIONS', `${config.base}/register`, registerPage);
    }

    //task 00007: approval, extra-check and connected-program pages.
    //These are ordinary signed-in browser pages - deliberately absent
    //from `OAuthService.isNativeRoute()` - so `session.access` still
    //applies and each page loads the browser profile and checks CSRF.
    //They render their own explicit safe snapshot instead of using
    //`ctx.view` routes (see pages/browser.ts `renderBrowserPage`).
    ctx.route('GET', `${config.base}/authorize`, authorizePage);
    ctx.route('POST', `${config.base}/authorize`, authorizePage);
    ctx.route('GET', `${config.base}/factor`, factorPage);
    ctx.route('POST', `${config.base}/factor`, factorPage);
    ctx.route('GET', `${config.base}/connections`, connectionsPage);
    ctx.route('POST', `${config.base}/connections/revoke`, connectionsRevokePage);
  });
};
