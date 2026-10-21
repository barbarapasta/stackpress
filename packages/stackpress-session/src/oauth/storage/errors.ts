//Machine-readable error codes used by OAuthStore. These map directly to
//the OAuth error vocabulary used by the protocol HTTP pages (events.md:
//"Failure sets the standard error field to the machine code"); OAuthStore
//itself never touches HTTP, it only throws this one typed exception so
//callers in later tasks (00005/00006) can translate it.

export type OAuthStoreErrorCode =
  | 'invalid_grant'
  | 'invalid_request'
  | 'invalid_client'
  | 'conflict';

export class OAuthStoreError extends Error {
  public readonly code: OAuthStoreErrorCode;

  public constructor(code: OAuthStoreErrorCode, message?: string) {
    super(message || code);
    this.code = code;
    this.name = 'OAuthStoreError';
  }
}

/**
 * Internal-only signal thrown to force a transaction rollback and retry
 * when the portable first-row lock detects it raced another writer. Never
 * escapes a public OAuthStore method.
 */
export class OAuthLockConflict extends Error {
  public constructor() {
    super('lock conflict');
    this.name = 'OAuthLockConflict';
  }
}
