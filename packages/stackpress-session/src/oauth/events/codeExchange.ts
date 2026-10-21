//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { toFullKey } from '../storage/ids.js';
import { isClientAllowed } from '../clients/policy.js';
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import { resolveResource } from './resource.js';
import { buildAccessDeps } from './accessDeps.js';
import type { OAuthCodeExchangeInput, OAuthTokenResult } from '../types.js';

/**
 * `oauth-code-exchange` (events.md): `{ client_id, code, redirect_uri,
 * code_verifier, resource }` -> standard token JSON. Client admission
 * and resource resolution happen here, before the grant lock; PKCE,
 * current-account and current-access-policy checks happen inside
 * `OAuthStore.exchangeCode`'s transaction via the injected deps, per
 * storage.md's "re-read and validate...inside the transaction" wording.
 */
export default action(async function OAuthCodeExchange({ req, res, ctx }) {
  try {
    const { store, config } = getOAuthContext(ctx);
    const input = req.data() as OAuthCodeExchangeInput;
    const now = new Date();

    if (
      typeof input.client_id !== 'string' || !input.client_id ||
      typeof input.code !== 'string' || !input.code ||
      typeof input.redirect_uri !== 'string' || !input.redirect_uri ||
      typeof input.code_verifier !== 'string' || !input.code_verifier
    ) {
      throw oauthError('invalid_request', 'Missing required token parameters');
    }

    if (!isClientAllowed(input.client_id, config.clients)) {
      throw oauthError('invalid_client', 'Client is not admitted');
    }

    const resource = resolveResource(config, input.resource);
    if (!resource) {
      throw oauthError('invalid_target', 'Missing, unknown or ambiguous resource');
    }

    const issued = await store.exchangeCode(
      {
        code: input.code,
        clientId: input.client_id,
        redirectUri: input.redirect_uri,
        resource,
        codeVerifier: input.code_verifier,
        renewalSeconds: config.renewalSeconds
      },
      now,
      buildAccessDeps(ctx, config, 'exchange')
    );

    const result: OAuthTokenResult = {
      access_token: toFullKey(issued.accessId, issued.accessSecret),
      token_type: 'Bearer',
      expires_in: Math.max(
        0,
        Math.floor((issued.accessExpires.getTime() - now.getTime()) / 1000)
      ),
      scope: issued.scopes.join(' '),
      ...(issued.refreshToken ? { refresh_token: issued.refreshToken } : {})
    };
    res.results(result);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
