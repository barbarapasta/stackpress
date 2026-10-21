//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { toEventErrorResponse, oauthError } from '../events/errors.js';
import type { OAuthPlugin } from '../types.js';
import {
  applyOAuthCors,
  applyOAuthPreflight,
  setNoStore,
  singleFormField,
  writeEventResult
} from './helpers.js';

/**
 * Native `${base}/revoke` (configuration.md). Form-encoded body
 * (events.md: "Token/revoke requests use form encoding"); dispatches to
 * the fixed `oauth-revoke` event. events.md: "unknown token is also
 * successful" - the event itself never distinguishes that case from a
 * real revocation, so this page cannot either.
 */
export default action(async function OAuthRevoke({ req, res, ctx }) {
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
    const clientId = singleFormField(req, 'client_id');
    const token = singleFormField(req, 'token');
    const tokenTypeHint = singleFormField(req, 'token_type_hint');
    if (clientId === null || token === null || tokenTypeHint === null) {
      throw oauthError('invalid_request', 'Duplicate revoke parameter');
    }
    if (typeof clientId !== 'string' || !clientId || typeof token !== 'string' || !token) {
      throw oauthError('invalid_request', 'Missing required revoke parameters');
    }
    const resolved = await ctx.resolve('oauth-revoke', {
      client_id: clientId,
      token,
      ...(tokenTypeHint ? { token_type_hint: tokenTypeHint } : {})
    });
    writeEventResult(res, resolved);
  } catch (e) {
    writeEventResult(res, toEventErrorResponse(e));
  }
});
