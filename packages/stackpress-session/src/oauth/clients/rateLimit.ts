//Shared rate-limit enforcement for the client-registration and
//client-document mechanisms (configuration.md `limits.*`). Buckets live
//in `OAuthRateBucket` via `OAuthStore.incrementRateBucket`, which is
//already an atomic shared counter safe across processes; this module
//only decides bucket keys, window boundaries and the 429/503 mapping.

import { hashWithDomain } from '../storage/ids.js';
import { OAuthClientError } from './errors.js';

export type OAuthRateLimitStore = {
  incrementRateBucket(
    keyHash: string,
    windowStart: Date,
    expires: Date
  ): Promise<number>
};

export type OAuthRateLimitStage = {
  //a stable, human-readable key such as "registration:<issuer>:<source>".
  //Hashed before it ever reaches storage (configuration.md: "Counter keys
  //contain hashes rather than raw credentials").
  key: string,
  limit: number
};

function windowBoundary(now: Date, windowSeconds: number): { start: Date, retryAfterSeconds: number } {
  const seconds = Math.floor(now.getTime() / 1000);
  const windowIndex = Math.floor(seconds / windowSeconds);
  const startSeconds = windowIndex * windowSeconds;
  const start = new Date(startSeconds * 1000);
  const retryAfterSeconds = (startSeconds + windowSeconds) - seconds;
  return { start, retryAfterSeconds };
}

/**
 * Checks and increments every stage in order, stopping at the first
 * stage that is already at or over its limit. Checking in order (and
 * never incrementing a later stage once an earlier one has already
 * refused) is what keeps an unlisted/attacker-chosen client ID from
 * ever allocating its own bucket once the source-level stage alone
 * already denies the request (configuration.md: "Enforce source limits
 * before allocating attacker-chosen client buckets"; "unknown client
 * IDs cannot create unlimited buckets").
 *
 * A store failure (connection error, etc.) is never treated as
 * permission to skip the limit: it is reported as `store_unavailable`
 * (503), not silently allowed through.
 */
export async function enforceRateLimit(
  store: OAuthRateLimitStore,
  stages: OAuthRateLimitStage[],
  windowSeconds: number,
  now: Date
): Promise<void> {
  const { start, retryAfterSeconds } = windowBoundary(now, windowSeconds);
  const expires = new Date(start.getTime() + windowSeconds * 1000);
  for (const stage of stages) {
    let count: number;
    try {
      count = await store.incrementRateBucket(
        hashWithDomain('rate-limit', stage.key),
        start,
        expires
      );
    } catch (e) {
      throw new OAuthClientError(
        'store_unavailable',
        'Rate limit store is unavailable'
      );
    }
    if (count > stage.limit) {
      throw new OAuthClientError(
        'rate_limited',
        `Rate limit exceeded for ${stage.key}`,
        Math.max(1, retryAfterSeconds)
      );
    }
  }
}
