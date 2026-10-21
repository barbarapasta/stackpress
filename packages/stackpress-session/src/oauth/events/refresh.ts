//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { toFullKey } from '../storage/ids.js';
import { isClientAllowed } from '../clients/policy.js';
import { getOAuthContext } from './context.js';
import { toEventErrorResponse, oauthError } from './errors.js';
import { resolveResource } from './resource.js';
import { buildAccessDeps } from './accessDeps.js';
import type { OAuthRefreshInput, OAuthTokenResult } from '../types.js';

/**
 * `oauth-refresh` (events.md): `{ client_id, refresh_token, resource,
 * scope? }` -> standard token JSON; requested scope may only narrow.
 */
export default action(async function OAuthRefresh({ req, res, ctx }) {
  try {
    const { store, config } = getOAuthContext(ctx);
    const input = req.data() as OAuthRefreshInput;
    const now = new Date();

    if (
      typeof input.client_id !== 'string' || !input.client_id ||
      typeof input.refresh_token !== 'string' || !input.refresh_token
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

    let narrowedScopes: string[] | undefined;
    if (typeof input.scope === 'string') {
      narrowedScopes = input.scope.length > 0 ? input.scope.split(' ').filter(Boolean) : [];
    }

    const issued = await store.refreshGrant(
      {
        refreshToken: input.refresh_token,
        clientId: input.client_id,
        resource,
        narrowedScopes
      },
      now,
      buildAccessDeps(ctx, config, 'refresh')
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
