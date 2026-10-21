//stackpress-session/oauth
import type { NormalizedOAuthSessionConfig } from '../types.js';

/**
 * configuration.md: "Missing resource may default only when the issuer
 * has one configured resource; repeated/multiple values are rejected."
 * Returns `null` for a missing resource when more than one is
 * configured, or for any value that is not one of the configured exact
 * canonical resource URLs - both map to the token/authorization
 * `invalid_target` error at the caller.
 */
export function resolveResource(
  config: NormalizedOAuthSessionConfig,
  requested?: string
): string | null {
  if (typeof requested === 'string' && requested.length > 0) {
    const known = config.resources.some((entry) => entry.resource === requested);
    return known ? requested : null;
  }
  if (config.resources.length === 1) {
    return config.resources[0].resource;
  }
  return null;
}
