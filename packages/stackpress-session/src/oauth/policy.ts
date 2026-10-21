//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-session/profile
import type { ProfileExtended } from '../profile/types.js';
//stackpress-session/oauth
import type {
  NormalizedOAuthSessionConfig,
  OAuthSafeProfile,
  OAuthApprovalPolicyInput,
  OAuthApprovalPolicyResult,
  OAuthAccessPolicyInput,
  OAuthAccessPolicyResult
} from './types.js';

//events.md: "Missing listeners, invalid results, errors or timeouts deny
//the operation." None of these ever throws; every failure path returns
//`null`, which every caller below treats identically to an explicit
//`allowed: false`.

function isSubset(subset: string[], superset: string[]): boolean {
  const allowed = new Set(superset);
  return subset.every((value) => allowed.has(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Races a policy listener invocation against `policy.timeoutMs`
 * (configuration.md: "timeout refuses the operation without issuing
 * keys"). A listener that later resolves after the timeout is ignored;
 * its result is simply discarded, never applied retroactively.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    );
  });
}

/**
 * Loads a fresh, safe `{ id, roles }` profile summary for policy input -
 * never the browser JWT or a cached copy - and treats a missing or
 * explicitly inactive (`active: false`) profile as "no usable profile"
 * so every caller denies rather than guessing eligibility for a
 * suspended account.
 */
export async function loadSafeProfile(
  ctx: Server,
  profileId: string
): Promise<OAuthSafeProfile | null> {
  const resolved = await ctx.resolve<ProfileExtended>(
    'profile-detail',
    { id: profileId }
  );
  if (resolved.code !== 200 || !resolved.results) {
    return null;
  }
  if (resolved.results.active === false) {
    return null;
  }
  return {
    id: resolved.results.id,
    roles: Array.isArray(resolved.results.roles) ? resolved.results.roles : []
  };
}

export type OAuthApprovalDecision = {
  scopes: string[],
  operations: string[],
  accessSeconds: number,
  renewalSeconds: number,
  requireFactor: boolean
};

/**
 * Invokes the app's configured `policy.approval` listener and validates
 * its result against events.md's narrowing rules before trusting any of
 * it: `scopes`/`operations` must be explicitly present (including an
 * intentionally empty array) and a subset of what was requested;
 * `accessSeconds`/`renewalSeconds` may only shorten the library default,
 * never lengthen it. Any violation - missing listener, non-200/empty
 * result, `allowed !== true`, a missing or non-subset list, an expanding
 * duration, or a timeout - denies by returning `null`.
 */
export async function invokeApprovalPolicy(
  ctx: Server,
  config: NormalizedOAuthSessionConfig,
  input: OAuthApprovalPolicyInput
): Promise<OAuthApprovalDecision | null> {
  const resolved = await withTimeout(
    ctx.resolve<OAuthApprovalPolicyResult>(config.policy.approval, input),
    config.policy.timeoutMs
  );
  if (!resolved || resolved.code !== 200 || !resolved.results) {
    return null;
  }
  const result = resolved.results;
  if (result.allowed !== true) {
    return null;
  }
  if (!isStringArray(result.scopes) || !isSubset(result.scopes, input.scopes)) {
    return null;
  }
  if (!isStringArray(result.operations) || !isSubset(result.operations, input.operations)) {
    return null;
  }
  let accessSeconds = config.accessSeconds;
  if (typeof result.accessSeconds !== 'undefined') {
    if (
      typeof result.accessSeconds !== 'number' ||
      !Number.isFinite(result.accessSeconds) ||
      result.accessSeconds <= 0 ||
      result.accessSeconds > config.accessSeconds
    ) {
      return null;
    }
    accessSeconds = result.accessSeconds;
  }
  let renewalSeconds = config.renewalSeconds;
  if (typeof result.renewalSeconds !== 'undefined') {
    if (
      typeof result.renewalSeconds !== 'number' ||
      !Number.isFinite(result.renewalSeconds) ||
      result.renewalSeconds <= 0 ||
      result.renewalSeconds > config.renewalSeconds
    ) {
      return null;
    }
    renewalSeconds = result.renewalSeconds;
  }
  return {
    scopes: result.scopes,
    operations: result.operations,
    accessSeconds,
    renewalSeconds,
    //Q-010: no supplied requireFactor means no extra check; the library
    //never substitutes this fallback on its own.
    requireFactor: result.requireFactor === true
  };
}

export type OAuthAccessDecision = {
  scopes: string[]
};

/**
 * Invokes the app's configured `policy.access` listener for the
 * `exchange`/`verify`/`refresh` phase. Omitted `scopes` preserves the
 * grant's current stored set; supplied `scopes` must be a subset of it.
 * Denies (`null`) on a missing listener, non-200/empty result,
 * `allowed !== true`, a non-subset scope list, or a timeout.
 */
export async function invokeAccessPolicy(
  ctx: Server,
  config: NormalizedOAuthSessionConfig,
  input: OAuthAccessPolicyInput
): Promise<OAuthAccessDecision | null> {
  const resolved = await withTimeout(
    ctx.resolve<OAuthAccessPolicyResult>(config.policy.access, input),
    config.policy.timeoutMs
  );
  if (!resolved || resolved.code !== 200 || !resolved.results) {
    return null;
  }
  const result = resolved.results;
  if (result.allowed !== true) {
    return null;
  }
  let scopes = input.grant.scopes;
  if (typeof result.scopes !== 'undefined') {
    if (!isStringArray(result.scopes) || !isSubset(result.scopes, input.grant.scopes)) {
      return null;
    }
    scopes = result.scopes;
  }
  return { scopes };
}
