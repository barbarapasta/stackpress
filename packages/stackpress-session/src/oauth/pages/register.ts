//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { toEventErrorResponse, oauthError } from '../events/errors.js';
import type { OAuthPlugin } from '../types.js';
import {
  applyOAuthCors,
  applyOAuthPreflight,
  setNoStore,
  sourceAddress,
  writeEventResult
} from './helpers.js';

/**
 * Native `${base}/register` (configuration.md). JSON body (events.md:
 * "registration uses JSON"); dispatches to the fixed
 * `oauth-client-register` event and translates its result into a
 * top-level JSON reply. `registration.enabled: false` removes both this
 * route's discovery advertisement (metadata.ts) and its behavior here.
 */
export default action(async function OAuthRegister({ req, res, ctx }) {
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
    if (!config.registration.enabled) {
      throw oauthError('registration_disabled', 'Client registration is disabled');
    }
    const raw = req.body;
    const body = Buffer.isBuffer(raw) ?
      raw : Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}), 'utf8');
    const resolved = await ctx.resolve('oauth-client-register', {
      body,
      source: sourceAddress(req)
    });
    //events.md: "Success sets code 200 (registration HTTP page maps
    //creation to 201)."
    writeEventResult(res, resolved.error ? resolved : { ...resolved, code: 201 });
  } catch (e) {
    writeEventResult(res, toEventErrorResponse(e));
  }
});
