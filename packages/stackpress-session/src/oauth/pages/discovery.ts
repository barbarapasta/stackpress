//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { buildIssuerMetadata, buildProtectedResourceMetadata } from '../metadata.js';
import type { OAuthPlugin } from '../types.js';
import { setNoStore } from './helpers.js';

/**
 * RFC 8414 authorization server metadata at the configured issuer's
 * well-known path. Advertises only configured/supported capabilities
 * (configuration.md); discovery documents are explicitly excluded from
 * `no-store` (unlike token/authorization/connection-management replies)
 * since they are ordinary, cacheable public metadata.
 */
export const issuerMetadata = action(async function OAuthIssuerMetadata({ res, ctx }) {
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (!oauth.finalized) {
    setNoStore(res);
    res.json({ error: 'server_error' }, 503);
    return;
  }
  res.json(
    buildIssuerMetadata(oauth.config) as unknown as Record<string, unknown>,
    200
  );
});

/**
 * RFC 9728 protected-resource metadata, one route per configured
 * resource plus an unambiguous root alias (configuration.md: "A root
 * resource alias is valid only for a single unambiguous resource").
 * `resourceUrl` is omitted only for the root-alias route, which this
 * task's route wiring registers only when exactly one resource exists.
 */
export function resourceMetadata(resourceUrl?: string) {
  return action(async function OAuthResourceMetadata({ res, ctx }) {
    const oauth = ctx.plugin<OAuthPlugin>('oauth');
    if (!oauth.finalized) {
      setNoStore(res);
      res.json({ error: 'server_error' }, 503);
      return;
    }
    const config = oauth.config;
    const resource = resourceUrl ?
      config.resources.find((entry) => entry.resource === resourceUrl) :
      (config.resources.length === 1 ? config.resources[0] : undefined);
    if (!resource) {
      res.json({ error: 'invalid_target' }, 404);
      return;
    }
    res.json(
      buildProtectedResourceMetadata(resource, config) as unknown as Record<string, unknown>,
      200
    );
  });
}
