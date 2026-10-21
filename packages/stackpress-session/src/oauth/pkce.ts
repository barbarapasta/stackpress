//modules
import { createHash, timingSafeEqual } from 'node:crypto';

//RFC 7636 S256: code_challenge = BASE64URL(SHA256(ASCII(code_verifier))).
//Only S256 is accepted anywhere in this feature (events.md/storage.md
//never mention "plain"); `OAuthCode`/`OAuthPending` only ever persist
//the S256 challenge value itself, never a method flag.
export function computeS256Challenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Constant-time S256 PKCE verification. Returns false (never throws) for
 * a missing/malformed verifier so a caller cannot distinguish a bad
 * verifier from a bad challenge by timing or exception shape.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) {
    return false;
  }
  let computed: string;
  try {
    computed = computeS256Challenge(codeVerifier);
  } catch {
    return false;
  }
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(codeChallenge, 'utf8');
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}
