//Machine-readable error codes for the client-registration/client-document
//mechanisms in this task. Kept separate from storage/OAuthStoreError:
//these represent request-shape, network-safety and rate-limit outcomes
//that exist before any database transaction is reached.

export type OAuthClientErrorCode =
  | 'invalid_request'
  | 'invalid_client_metadata'
  | 'unsafe_target'
  | 'fetch_failed'
  | 'rate_limited'
  | 'store_unavailable'
  | 'registration_disabled';

export class OAuthClientError extends Error {
  public readonly code: OAuthClientErrorCode;
  public readonly retryAfterSeconds?: number;

  public constructor(
    code: OAuthClientErrorCode,
    message?: string,
    retryAfterSeconds?: number
  ) {
    super(message || code);
    this.code = code;
    this.name = 'OAuthClientError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
