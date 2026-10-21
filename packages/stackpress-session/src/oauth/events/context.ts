//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-sql
import type { DatabasePlugin } from 'stackpress-sql/types';
//stackpress-session/oauth
import OAuthStore from '../storage/OAuthStore.js';
import type { NormalizedOAuthSessionConfig, OAuthPlugin } from '../types.js';

export type OAuthEventContext = {
  oauth: OAuthPlugin,
  config: NormalizedOAuthSessionConfig,
  store: OAuthStore
};

/**
 * Shared setup for every fixed OAuth event handler: resolves the typed
 * service and a fresh `OAuthStore` over the configured database engine.
 * `OAuthService.assertFinalized()` enforces configuration.md's "All
 * OAuth handlers refuse requests with 503 until it succeeds" - every
 * handler calls this first, before touching any trusted input.
 */
export function getOAuthContext(ctx: Server): OAuthEventContext {
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  oauth.assertFinalized();
  const engine = ctx.plugin<DatabasePlugin>('database');
  return { oauth, config: oauth.config, store: new OAuthStore(engine) };
}
