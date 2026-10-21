//stackpress-session
import StackpressSessionException from '../../Exception.js';
//stackpress-session/oauth
import { OAuthStoreError } from '../storage/errors.js';
import { OAuthClientError } from '../clients/errors.js';

//events.md: "Failure sets the standard error field to the machine code
//and errors to safe description/scope information." `error` is always
//the exception message (StackpressSessionException.toResponse() copies
//`this.message`), so every machine code below is passed as the message,
//never embedded only in `errors`.
export type OAuthEventErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_token'
  | 'invalid_scope'
  | 'invalid_target'
  | 'access_denied'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'store_unavailable'
  | 'registration_disabled'
  | 'conflict'
  | 'server_error';

const STATUS: Record<OAuthEventErrorCode, number> = {
  invalid_request: 400,
  invalid_client: 400,
  invalid_grant: 400,
  invalid_token: 401,
  invalid_scope: 400,
  invalid_target: 400,
  access_denied: 403,
  insufficient_scope: 403,
  rate_limited: 429,
  store_unavailable: 503,
  registration_disabled: 403,
  conflict: 409,
  server_error: 500
};

export function oauthError(
  code: OAuthEventErrorCode,
  description?: string,
  extra?: Record<string, string>
): StackpressSessionException {
  const exception = StackpressSessionException
    .for(code)
    .withCode(STATUS[code]);
  if (description || extra) {
    exception.withErrors({
      ...(description ? { error_description: description } : {}),
      ...(extra || {})
    });
  }
  return exception;
}

/**
 * Translates the two typed internal exceptions `OAuthStore`/the client
 * mechanisms throw into the shared OAuth machine-code vocabulary. Any
 * other thrown value becomes an opaque `server_error` - events.md:
 * "Unexpected exceptions become a generic server error and redacted
 * server log" - never a leaked internal message.
 */
/**
 * One shared catch-site helper: an exception already raised by
 * `oauthError()` (an explicit machine-coded refusal this event decided
 * itself) is used as-is; anything else goes through `mapKnownError()`.
 * Using `instanceof StackpressSessionException` instead of re-deriving
 * the code keeps a deliberate `oauthError('access_denied', ...)` from
 * being flattened into a generic `server_error` by this function's own
 * fallback.
 */
export function toEventErrorResponse(e: unknown) {
  const exception = e instanceof StackpressSessionException ? e : mapKnownError(e);
  return exception.toResponse();
}

export function mapKnownError(e: unknown): StackpressSessionException {
  if (e instanceof OAuthStoreError) {
    return oauthError(e.code, e.message);
  }
  if (e instanceof OAuthClientError) {
    const code: OAuthEventErrorCode =
      e.code === 'invalid_client_metadata' ? 'invalid_client'
      : e.code === 'unsafe_target' || e.code === 'fetch_failed' ? 'invalid_client'
      : e.code;
    const extra = e.retryAfterSeconds ?
      { retryAfterSeconds: String(e.retryAfterSeconds) } : undefined;
    return oauthError(code, e.message, extra);
  }
  return oauthError('server_error', 'An unexpected error occurred');
}
