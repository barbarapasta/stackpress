//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-session/oauth
import { registerClient } from '../clients/register.js';
import { getOAuthContext } from './context.js';
import { toEventErrorResponse } from './errors.js';
import type { OAuthClientRegisterResult } from '../types.js';

//Trusted internal input this fixed event actually reads: the raw,
//not-yet-parsed request body bytes (so `registerClient` can enforce
//`registration.bodyBytes` before ever calling `JSON.parse`, per
//task 00004's `register.ts`) plus the trusted rate-limit source
//address. The HTTP page (this task) is the only caller; it is the one
//place with access to the raw body and a real peer address.
export type OAuthClientRegisterEventInput = {
  body: Buffer,
  source: string
};

/**
 * `oauth-client-register` (events.md): validated public-client metadata
 * and trusted rate-limit context -> registration JSON (client_id,
 * client_id_issued_at, redirect_uris, grant_types, response_types,
 * token_endpoint_auth_method). Never issues an approval or user key
 * (events.md: "Client registration creates no grant"). Calls task
 * 00004's `registerClient` rather than reimplementing its validation,
 * SSRF-safety or rate-limiting, per that task's documented handoff.
 */
export default action(async function OAuthClientRegister({ req, res, ctx }) {
  try {
    const { store, config } = getOAuthContext(ctx);
    const input = req.data() as OAuthClientRegisterEventInput;
    const result: OAuthClientRegisterResult = await registerClient(
      input.body,
      input.source,
      config,
      { store }
    );
    res.results(result as unknown as Record<string, unknown>);
  } catch (e) {
    res.setError(toEventErrorResponse(e));
  }
});
