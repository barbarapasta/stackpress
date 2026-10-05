//modules
import type Server from '@stackpress/ingest/Server';
//stackpress-session
import StackpressSessionException from '../Exception.js';
import type {
  NormalizedOAuthSessionConfig,
  OAuthApiOperationDescriptor,
  OAuthMcpResourceDescriptor,
  OAuthService as IOAuthService
} from './types.js';

/**
 * Deterministically stringifies a value with sorted object keys while
 * preserving array order, so an operation fingerprint changes only
 * when its actual shape changes.
 */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') {
      return input;
    }
    if (seen.has(input as object)) {
      throw StackpressSessionException.for(
        'Cannot canonicalize a circular value'
      ).withCode(500);
    }
    seen.add(input as object);
    if (Array.isArray(input)) {
      return input.map(walk);
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input as object).sort()) {
      sorted[key] = walk((input as Record<string, unknown>)[key]);
    }
    return sorted;
  };
  return JSON.stringify(walk(value));
}

/**
 * Rejects a fixed-data value that is not plain JSON (functions,
 * symbols, undefined, non-finite numbers) so the registry fingerprints
 * stable data instead of silently dropping unstable members.
 */
function assertJsonSafe(value: unknown, path: string): void {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw StackpressSessionException.for(
        `${path} must be finite JSON data, not ${value}`
      ).withCode(500);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${path}[${index}]`));
    return;
  }
  if (type === 'object') {
    for (const key of Object.keys(value as object)) {
      assertJsonSafe((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  throw StackpressSessionException.for(
    `${path} must be plain JSON data, not ${type}`
  ).withCode(500);
}

/**
 * Holds the validated session.oauth configuration, the registry of
 * trusted API/MCP operation descriptors collected during route setup,
 * and the idempotent finalize() gate. No handler may serve OAuth
 * requests until finalize() has succeeded; the registry is frozen
 * immediately afterward.
 */
export default class OAuthService implements IOAuthService {
  protected _ctx: Server;
  protected _config: NormalizedOAuthSessionConfig;
  protected _finalized = false;
  protected _finalizing: Promise<void> | null = null;
  protected _apiOperations = new Map<string, {
    descriptor: OAuthApiOperationDescriptor,
    fingerprint: string
  }>();
  protected _mcpResources = new Map<string, OAuthMcpResourceDescriptor>();

  constructor(ctx: Server, config: NormalizedOAuthSessionConfig) {
    this._ctx = ctx;
    this._config = config;
  }

  get config() {
    return this._config;
  }

  get finalized() {
    return this._finalized;
  }

  get apiOperations() {
    return this._apiOperations;
  }

  get mcpResources() {
    return this._mcpResources;
  }

  /**
   * Refuses registry mutation once finalization has run; every caller
   * that would otherwise register a route or resource after startup
   * has completed must fail loudly instead of silently no-op-ing.
   */
  protected assertMutable() {
    if (this._finalized) {
      throw StackpressSessionException.for(
        'Cannot register an OAuth operation after finalize() has run'
      ).withCode(500);
    }
  }

  registerApiOperation(descriptor: OAuthApiOperationDescriptor) {
    this.assertMutable();
    if (descriptor.method === 'ALL') {
      throw StackpressSessionException.for(
        'OAuth-enabled API routes must declare a concrete method, not ALL'
      ).withCode(500);
    }
    if (this._apiOperations.has(descriptor.id)) {
      throw StackpressSessionException.for(
        `Duplicate OAuth API operation ID: ${descriptor.id}`
      ).withCode(500);
    }
    for (const resource of descriptor.resources) {
      const known = this._config.resources.some(r => r.resource === resource);
      if (!known) {
        throw StackpressSessionException.for(
          `OAuth API operation "${descriptor.id}" references unknown ` +
          `resource: ${resource}`
        ).withCode(500);
      }
    }
    assertJsonSafe(descriptor.data, `${descriptor.id}.data`);
    const fingerprint = canonicalize({
      id: descriptor.id,
      method: descriptor.method,
      route: descriptor.route,
      event: descriptor.event,
      resources: descriptor.resources,
      scopes: descriptor.scopes,
      data: descriptor.data
    });
    this._apiOperations.set(descriptor.id, { descriptor, fingerprint });
  }

  registerMcpResource(descriptor: OAuthMcpResourceDescriptor) {
    this.assertMutable();
    const known = this._config.resources.some(
      r => r.resource === descriptor.resource
    );
    if (!known) {
      throw StackpressSessionException.for(
        `OAuth MCP resource is not declared in session.oauth.resources: ` +
        descriptor.resource
      ).withCode(500);
    }
    //separate /mcp and /sse services need separate approvals; a shared
    //route can never be inferred to carry shared authority, so reject
    //any reuse of a route regardless of which surface claims it first
    const existing = this._mcpResources.get(descriptor.route);
    if (existing) {
      throw StackpressSessionException.for(
        `OAuth MCP route collision on ${descriptor.route}: already bound ` +
        `to the ${existing.surface} transport`
      ).withCode(500);
    }
    this._mcpResources.set(descriptor.route, descriptor);
  }

  assertFinalized() {
    if (!this._finalized) {
      throw StackpressSessionException.for(
        'OAuth is not finalized; requests are refused until startup ' +
        'finalization succeeds'
      ).withCode(503);
    }
  }

  /**
   * Idempotent finalization. Resolves the app-supplied policy
   * listeners only now, after every listen/route handler has had a
   * chance to register, rather than depending on plugin import order.
   * Any capability that later tasks still owe (real storage, the
   * fixed protocol events) is treated as "not yet built" and fails
   * closed rather than silently permitting requests.
   */
  async finalize(): Promise<void> {
    if (this._finalized) return;
    if (this._finalizing) return this._finalizing;
    this._finalizing = (async () => {
      const errors: string[] = [];
      const hasListener = (event: string) => {
        const listeners = this._ctx.listeners as
          Record<string, Set<unknown> | undefined>;
        const set = listeners[event];
        return !!set && set.size > 0;
      };

      if (!hasListener(this._config.policy.approval)) {
        errors.push(
          `Missing required app policy listener: ${this._config.policy.approval}`
        );
      }
      if (!hasListener(this._config.policy.access)) {
        errors.push(
          `Missing required app policy listener: ${this._config.policy.access}`
        );
      }

      if (!this._ctx.plugin('database')) {
        errors.push('OAuth requires the database plugin to be configured');
      }

      const requiredEvents = [
        'oauth-client-register',
        'oauth-authorization-start',
        'oauth-authorize',
        'oauth-code-exchange',
        'oauth-refresh',
        'oauth-token-verify',
        'oauth-revoke',
        'oauth-grants-list',
        'oauth-grant-revoke'
      ];
      for (const event of requiredEvents) {
        if (!hasListener(event)) {
          errors.push(`Missing required OAuth runtime listener: ${event}`);
        }
      }

      if (errors.length) {
        this._finalizing = null;
        throw StackpressSessionException.for(
          `OAuth finalization failed: ${errors.join('; ')}`
        ).withCode(503).withErrors(
          Object.fromEntries(errors.map((error, index) => [index, error]))
        );
      }

      this._finalized = true;
    })();
    try {
      await this._finalizing;
    } finally {
      if (!this._finalized) {
        this._finalizing = null;
      }
    }
  }
}
