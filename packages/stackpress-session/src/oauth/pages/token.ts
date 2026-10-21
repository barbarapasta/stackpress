//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-sql
import type { DatabasePlugin } from 'stackpress-sql/types';
//stackpress-session/oauth
import OAuthStore from '../storage/OAuthStore.js';
import { enforceRateLimit } from '../clients/rateLimit.js';
import { toEventErrorResponse, oauthError } from '../events/errors.js';
import type { OAuthPlugin } from '../types.js';
import {
  applyOAuthCors,
  applyOAuthPreflight,
  setNoStore,
  singleFormField,
  sourceAddress,
  writeEventResult
} from './helpers.js';

/**
 * Native `${base}/token` (configuration.md). Form-encoded body
 * (events.md: "Token/revoke requests use form encoding"); dispatches to
 * the fixed `oauth-code-exchange`/`oauth-refresh` events by `grant_type`
 * and translates their result into a top-level token/error JSON reply
 * with `Cache-Control: no-store`, never the Ingest results envelope.
 * Enforces `limits.token` here (source stage always, a client-keyed
 * stage only once the client is on the admitted list) since only this
 * HTTP layer has the trusted source address - task 00005's events
 * deliberately do not duplicate this check.
 */
export default action(async function OAuthToken({ req, res, ctx }) {
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (req.method.toUpperCase() === 'OPTIONS') {
    if (oauth.finalized) {
      applyOAuthPreflight(req, res, oauth.config, [ 'POST', 'OPTIONS' ]);
    }
    return;
  }
  if (!oauth.finalized) {
    setNoStore(res);
    res.json({ error: 'server_error' }, 503);
    return;
  }
  const config = oauth.config;
  if (!applyOAuthCors(req, res, config)) {
    res.statusCode(403);
    return;
  }
  try {
    const now = new Date();
    const engine = ctx.plugin<DatabasePlugin>('database');
    const store = new OAuthStore(engine);
    const source = sourceAddress(req);

    const grantType = singleFormField(req, 'grant_type');
    if (grantType === null) {
      throw oauthError('invalid_request', 'Duplicate grant_type parameter');
    }
    const clientId = singleFormField(req, 'client_id');
    if (clientId === null) {
      throw oauthError('invalid_request', 'Duplicate client_id parameter');
    }

    const stages = [
      { key: `token:${config.issuer}:${source}`, limit: config.limits.token }
    ];
    if (typeof clientId === 'string' && clientId) {
      stages.push({
        key: `token:${config.issuer}:${clientId}:${source}`,
        limit: config.limits.token
      });
    }
    await enforceRateLimit(store, stages, config.limits.windowSeconds, now);

    if (grantType === 'authorization_code') {
      const code = singleFormField(req, 'code');
      const redirectUri = singleFormField(req, 'redirect_uri');
      const codeVerifier = singleFormField(req, 'code_verifier');
      const resource = singleFormField(req, 'resource');
      if (code === null || redirectUri === null || codeVerifier === null || resource === null) {
        throw oauthError('invalid_request', 'Duplicate token parameter');
      }
      const resolved = await ctx.resolve('oauth-code-exchange', {
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
        resource
      });
      writeEventResult(res, resolved);
      return;
    }

    if (grantType === 'refresh_token') {
      const refreshToken = singleFormField(req, 'refresh_token');
      const resource = singleFormField(req, 'resource');
      const scope = singleFormField(req, 'scope');
      if (refreshToken === null || resource === null || scope === null) {
        throw oauthError('invalid_request', 'Duplicate token parameter');
      }
      const resolved = await ctx.resolve('oauth-refresh', {
        client_id: clientId,
        refresh_token: refreshToken,
        resource,
        scope
      });
      writeEventResult(res, resolved);
      return;
    }

    throw oauthError('invalid_request', 'Unsupported grant_type');
  } catch (e) {
    writeEventResult(res, toEventErrorResponse(e));
  }
});
