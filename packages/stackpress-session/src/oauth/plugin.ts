//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-session
import normalizeOAuthConfig from './config.js';
import OAuthService from './OAuthService.js';
import type { OAuthSessionConfig } from './types.js';
import finalize from './events/finalize.js';

/**
 * This interface is intended for the Stackpress library. It never
 * exposes a runtime OAuth surface: no protocol/approval routes and no
 * fixed protocol event handlers are registered here. Those arrive
 * once session's storage/policy work (tasks 00003+) supplies real
 * implementations; until then finalize() intentionally fails closed.
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
  //on listen, register the fixed internal finalize event; runtime
  //protocol event handlers are registered by later tasks
  ctx.on('listen', ({ ctx }) => {
    ctx.on('oauth-finalize', finalize);
  });
};
