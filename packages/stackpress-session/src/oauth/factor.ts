//modules
import { createHmac, timingSafeEqual } from 'node:crypto';
//stackpress-session/oauth
import { canonicalize } from './OAuthService.js';

//events.md: "A receipt is server-bound to profile, pending request and
//final approval content, valid at most 5 minutes and never past pending
//expiry." The receipt is minted by the app-facing 2FA page (task 00007)
//after it has itself verified a real TOTP code and advanced the replay
//guard through `OAuthStore.checkAndAdvanceFactor`; this module only
//proves later, inside `oauth-authorize`, that the exact approval content
//being committed is the content the factor check was shown for - it
//carries no TOTP secret and advances no counter itself.
export type OAuthFactorReceiptContent = {
  profileId: string,
  pendingId: string,
  scopes: string[],
  operations: string[]
};

const RECEIPT_MAX_AGE_MS = 5 * 60 * 1000;

function sign(seed: string, payload: string): string {
  return createHmac('sha256', seed).update(payload).digest('base64url');
}

/**
 * Mints an opaque, HMAC-signed receipt binding `content` to an
 * expiry capped at both five minutes and the owning pending request's
 * own expiry, whichever is sooner. Never repurposes `Auth.consumed`
 * (events.md): this is a wholly separate signed value, not a database
 * row, so retrying the same verified TOTP and minting a new receipt
 * with it is guarded by `OAuthFactorUse`'s atomic counter instead, not
 * by this function.
 */
export function createFactorReceipt(
  seed: string,
  content: OAuthFactorReceiptContent,
  pendingExpires: Date,
  now = new Date()
): string {
  const exp = Math.min(
    now.getTime() + RECEIPT_MAX_AGE_MS,
    pendingExpires.getTime()
  );
  const body = canonicalize({ ...content, exp });
  const payload = Buffer.from(body, 'utf8').toString('base64url');
  const signature = sign(seed, payload);
  return `${payload}.${signature}`;
}

/**
 * Verifies a receipt's signature, expiry (including the pending
 * request's own expiry, re-checked at verification time, not only at
 * mint time) and exact content match against `expected`. Any scope or
 * API-membership narrowing between the factor check and the final
 * approval content changes `expected` and therefore invalidates the
 * receipt (events.md: "Scope/membership changes invalidate the
 * receipt").
 */
export function verifyFactorReceipt(
  seed: string,
  receipt: string,
  expected: OAuthFactorReceiptContent,
  pendingExpires: Date,
  now = new Date()
): boolean {
  if (typeof receipt !== 'string') {
    return false;
  }
  const dot = receipt.indexOf('.');
  if (dot <= 0 || dot !== receipt.lastIndexOf('.')) {
    return false;
  }
  const payload = receipt.substring(0, dot);
  const signature = receipt.substring(dot + 1);
  const expectedSignature = sign(seed, payload);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  if (a.length !== b.length || a.length === 0 || !timingSafeEqual(a, b)) {
    return false;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (
    typeof decoded !== 'object' || decoded === null ||
    typeof (decoded as { exp?: unknown }).exp !== 'number'
  ) {
    return false;
  }
  const exp = (decoded as { exp: number }).exp;
  if (exp <= now.getTime() || exp > pendingExpires.getTime()) {
    return false;
  }
  const expectedBody = canonicalize({ ...expected, exp });
  const actualBody = canonicalize(decoded);
  return expectedBody === actualBody;
}
