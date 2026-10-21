//modules
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

//storage.md: "New access IDs use oauth_ followed by 32 random bytes
//encoded as unpadded base64url; secrets also contain 32 random bytes.
//Full keys are id:secret. Refresh tokens use oauthr_ plus 32 random
//bytes; codes use 32 random bytes. Use CSPRNG only."
export const OAUTH_ACCESS_PREFIX = 'oauth_';
export const OAUTH_REFRESH_PREFIX = 'oauthr_';

//domain separation so the same raw bytes never collide across credential
//kinds (storage.md: "Store SHA-256 hashes of high-entropy credentials,
//domain-separated by credential kind").
export type OAuthHashDomain =
  | 'access-read'
  | 'access-full'
  | 'code'
  | 'refresh'
  | 'legacy-id'
  | 'client-document-url'
  | 'pending-binding'
  | 'rate-limit';

function base64url(bytes: Buffer) {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 32 CSPRNG bytes, unpadded base64url encoded, with an optional fixed
 * prefix. Used for access IDs/secrets, refresh tokens and authorization
 * codes.
 */
export function randomToken(prefix = '') {
  return `${prefix}${base64url(randomBytes(32))}`;
}

/**
 * A new oauth_ access read-ID.
 */
export function newAccessId() {
  return randomToken(OAUTH_ACCESS_PREFIX);
}

/**
 * A new access secret (paired with an access ID as `id:secret`).
 */
export function newAccessSecret() {
  return base64url(randomBytes(32));
}

/**
 * Builds the full `id:secret` access key from its two parts.
 */
export function toFullKey(id: string, secret: string) {
  return `${id}:${secret}`;
}

/**
 * Splits a caller-supplied full key into its id/secret parts. Returns
 * null for anything that is not exactly one `:` separating two
 * non-empty parts, so a malformed key never falls through to an
 * ID-only read (storage.md: "a supplied bad secret never becomes an
 * ID-only read").
 */
export function splitFullKey(key: string): { id: string, secret: string } | null {
  const index = key.indexOf(':');
  if (index <= 0 || index !== key.lastIndexOf(':')) {
    return null;
  }
  const id = key.substring(0, index);
  const secret = key.substring(index + 1);
  if (!id || !secret) {
    return null;
  }
  return { id, secret };
}

/**
 * A new oauthr_ refresh token.
 */
export function newRefreshToken() {
  return randomToken(OAUTH_REFRESH_PREFIX);
}

/**
 * A new single-use authorization code (32 raw CSPRNG bytes, no prefix;
 * only ever transported and hashed, never parsed for a namespace).
 */
export function newCode() {
  return base64url(randomBytes(32));
}

/**
 * A new unguessable browser continuation cookie value for an
 * OAuthPending row.
 */
export function newPendingBinding() {
  return base64url(randomBytes(32));
}

/**
 * Domain-separated SHA-256 hash of a high-entropy credential or lookup
 * key. Domain separation means the same raw value hashes differently
 * per credential kind, so a hash leaked/reused across one kind cannot
 * be replayed as another.
 */
export function hashWithDomain(domain: OAuthHashDomain, value: string) {
  return createHash('sha256').update(domain).update(':').update(value).digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded hashes. Returns false
 * (never throws) for mismatched lengths so a caller cannot use timing
 * or exceptions to distinguish "wrong length" from "wrong value".
 */
export function hashesEqual(a: string, b: string) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * True when the supplied read ID or full key uses the `oauth_`
 * namespace. Used to route lookups to the OAuth verifier before any
 * legacy key check, per storage.md: "The oauth_ namespace selects the
 * OAuth verifier. Malformed/unknown/expired/new keys never fall
 * through to legacy lookup."
 */
export function isOAuthNamespace(value: string) {
  return value.startsWith(OAUTH_ACCESS_PREFIX);
}
