//modules
import type Engine from '@stackpress/inquire/Engine';
import type { FlatValue, Value, QueryObject } from '@stackpress/inquire/types';
import Select from '@stackpress/inquire/Select';
import Insert from '@stackpress/inquire/Insert';
import Update from '@stackpress/inquire/Update';
import Delete from '@stackpress/inquire/Delete';
//stackpress-session/oauth/storage
import {
  OAUTH_CLIENT_TABLE,
  OAUTH_CLIENT_DOCUMENT_TABLE,
  OAUTH_PENDING_TABLE,
  OAUTH_GRANT_TABLE,
  OAUTH_CODE_TABLE,
  OAUTH_REFRESH_TOKEN_TABLE,
  OAUTH_LEGACY_BINDING_TABLE,
  OAUTH_FACTOR_USE_TABLE,
  OAUTH_RATE_BUCKET_TABLE,
  OAUTH_CLIENT_CAPACITY_TABLE,
  createOAuthClientCapacity
} from './tables.js';
import {
  newAccessId,
  newAccessSecret,
  newRefreshToken,
  newCode,
  randomToken,
  hashWithDomain,
  hashesEqual,
  splitFullKey,
  isOAuthNamespace
} from './ids.js';
import { toJsonColumn, fromJsonArray, fromJsonHash } from './json.js';
import { OAuthStoreError, OAuthLockConflict } from './errors.js';
import { verifyPkceS256 } from '../pkce.js';
import type {
  OAuthClientRow,
  OAuthClientDocumentRow,
  OAuthPendingRow,
  OAuthGrantRow,
  OAuthCodeRow,
  OAuthRefreshTokenRow,
  OAuthLegacyBindingRow,
  OAuthFactorUseRow,
  OAuthRateBucketRow,
  OAuthTokenIssued,
  OAuthCleanupCounts
} from './types.js';

//This file implements storage.md's "Atomic Operations" section using only
//Inquire's public `engine.transaction()` entry point and its ordinary
//`Select`/`Insert`/`Update`/`Delete` query builders (the same ones
//AuthStore.ts already uses) - never `@stackpress/inquire/Lock` or any
//other internal of the d5f5a07 fix. The transaction-ownership guarantee
//(a callback's statements all run on one reserved native connection) is
//the adapter's job, reached through `engine.transaction()` alone; this
//file keeps working unmodified once the CTO's own upstream fix replaces
//the local override pinned in the root `package.json` resolutions.

const MAX_LOCK_RETRIES = 3;
//Capacity reservation (unlike grant locking/rate buckets) is not on a
//per-request hot path and genuinely needs to survive many truly
//concurrent callers contending on one shared counter row near the
//configured ceiling, so it gets a higher retry budget than
//MAX_LOCK_RETRIES's 3 plus a small jittered backoff between attempts.
const CAPACITY_MAX_RETRIES = 50;

function capacityBackoff(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1 + Math.floor(Math.random() * 4)));
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string);
}

function toNullableDate(value: unknown): Date | null {
  return value === null || typeof value === 'undefined' ? null : toDate(value);
}

function toBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't';
}

function toInt(value: unknown): number {
  return typeof value === 'number' ? value : parseInt(String(value), 10);
}

function fromClientRow(row: Record<string, unknown>): OAuthClientRow {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    kind: row.kind === 'document' ? 'document' : 'registered',
    metadata: fromJsonHash(row.metadata),
    created: toDate(row.created),
    lastUsed: toNullableDate(row.last_used),
    unusedExpires: toNullableDate(row.unused_expires)
  };
}

function fromClientDocumentRow(row: Record<string, unknown>): OAuthClientDocumentRow {
  return {
    id: String(row.id),
    urlHash: String(row.url_hash),
    metadata: fromJsonHash(row.metadata),
    etag: row.etag === null ? null : String(row.etag),
    lastModified: row.last_modified === null ? null : String(row.last_modified),
    freshUntil: toNullableDate(row.fresh_until),
    lastUsed: toNullableDate(row.last_used),
    created: toDate(row.created),
    updated: toDate(row.updated)
  };
}

function fromPendingRow(row: Record<string, unknown>): OAuthPendingRow {
  return {
    id: String(row.id),
    bindingHash: String(row.binding_hash),
    clientId: String(row.client_id),
    redirectUri: String(row.redirect_uri),
    state: row.state === null ? null : String(row.state),
    codeChallenge: String(row.code_challenge),
    codeChallengeMethod: String(row.code_challenge_method),
    resource: String(row.resource),
    scopes: fromJsonArray(row.scopes),
    operations: fromJsonArray(row.operations),
    profileId: row.profile_id === null ? null : String(row.profile_id),
    approvedScopes: fromJsonArray(row.approved_scopes),
    approvedOperations: fromJsonArray(row.approved_operations),
    factorReceipt: row.factor_receipt === null ? null : String(row.factor_receipt),
    status: row.status as OAuthPendingRow['status'],
    expires: toDate(row.expires),
    created: toDate(row.created),
    updated: toDate(row.updated)
  };
}

function fromGrantRow(row: Record<string, unknown>): OAuthGrantRow {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    clientId: String(row.client_id),
    resource: String(row.resource),
    scopes: fromJsonArray(row.scopes),
    operationFingerprints: fromJsonArray(row.operation_fingerprints),
    approved: toDate(row.approved),
    deadline: toDate(row.deadline),
    accessSeconds: toInt(row.access_seconds),
    readIdHash: row.read_id_hash === null ? null : String(row.read_id_hash),
    fullKeyHash: row.full_key_hash === null ? null : String(row.full_key_hash),
    accessExpires: toNullableDate(row.access_expires),
    generation: toInt(row.generation),
    lockVersion: toInt(row.lock_version),
    revision: toInt(row.revision),
    active: toBool(row.active),
    created: toDate(row.created),
    updated: toDate(row.updated)
  };
}

function fromCodeRow(row: Record<string, unknown>): OAuthCodeRow {
  return {
    id: String(row.id),
    codeHash: String(row.code_hash),
    grantId: String(row.grant_id),
    clientId: String(row.client_id),
    resource: String(row.resource),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    expires: toDate(row.expires),
    consumed: toNullableDate(row.consumed),
    created: toDate(row.created)
  };
}

function fromRefreshTokenRow(row: Record<string, unknown>): OAuthRefreshTokenRow {
  return {
    id: String(row.id),
    tokenHash: String(row.token_hash),
    grantId: String(row.grant_id),
    clientId: String(row.client_id),
    resource: String(row.resource),
    generation: toInt(row.generation),
    issued: toDate(row.issued),
    consumed: toNullableDate(row.consumed),
    expires: toDate(row.expires)
  };
}

function fromLegacyBindingRow(row: Record<string, unknown>): OAuthLegacyBindingRow {
  return {
    id: String(row.id),
    kind: row.kind === 'app' ? 'app' : 'session',
    legacyIdHash: String(row.legacy_id_hash),
    incarnation: String(row.incarnation),
    resource: String(row.resource),
    active: toBool(row.active),
    expires: toNullableDate(row.expires),
    created: toDate(row.created)
  };
}

function fromFactorUseRow(row: Record<string, unknown>): OAuthFactorUseRow {
  return {
    id: String(row.id),
    factorId: String(row.factor_id),
    incarnation: String(row.incarnation),
    profileId: String(row.profile_id),
    counter: toInt(row.counter),
    updated: toDate(row.updated)
  };
}

function fromRateBucketRow(row: Record<string, unknown>): OAuthRateBucketRow {
  return {
    id: String(row.id),
    keyHash: String(row.key_hash),
    window: toDate(row.window_start),
    count: toInt(row.count),
    expires: toDate(row.expires)
  };
}

export type NewPendingInput = {
  id: string,
  bindingHash: string,
  clientId: string,
  redirectUri: string,
  state?: string | null,
  codeChallenge: string,
  codeChallengeMethod?: string,
  resource: string,
  scopes: string[],
  operations: string[],
  expires: Date
};

export type ApprovePendingInput = {
  pendingId: string,
  profileId: string,
  approvedScopes: string[],
  approvedOperations: string[],
  operationFingerprints: string[],
  accessSeconds: number,
  renewalSeconds: number,
  codeSeconds: number,
  now?: Date
};

export type ExchangeCodeInput = {
  code: string,
  clientId: string,
  redirectUri: string,
  resource: string,
  //required S256 PKCE verifier (events.md `oauth-code-exchange`
  //input); verified inside the grant-locked transaction against the
  //code's own stored `codeChallenge`, per storage.md's "re-read and
  //validate...PKCE" wording - never pre-checked outside the lock.
  codeVerifier: string,
  //accepted but intentionally unused by exchangeCode itself: the issued
  //refresh token's expiry is always derived from the grant's own
  //immutable `deadline` (set once at approval time), never recomputed
  //at exchange time. Kept on this input type only so callers do not
  //need two different shapes between approval and exchange; see task
  //00003's notes for why this was kept rather than removed.
  renewalSeconds: number
};

export type RefreshInput = {
  refreshToken: string,
  clientId: string,
  resource: string,
  narrowedScopes?: string[]
};

/**
 * Optional app-boundary checks threaded through the grant lock so
 * storage.md's "current account...and current app access policy" is
 * re-verified on the exact fresh grant row this transaction already
 * holds, not on a stale pre-check outside it. OAuthStore itself has no
 * notion of a Profile record or an app policy listener - both live
 * above session's private runtime - so task 00005's event handlers pass
 * them in; omitting `deps` (as every one of task 00003's own tests
 * does) preserves that task's already-verified exchange/refresh
 * behavior unchanged.
 */
export type OAuthAccessDeps = {
  checkAccount: (profileId: string) => Promise<boolean>,
  checkAccess: (grant: OAuthGrantRow) => Promise<{ allowed: boolean, scopes?: string[] } | null>
};

/**
 * Task 00008 (storage.md "Upgrade Existing MCP Keys Explicitly"). API
 * submits the legacy record's raw ID over this trusted in-process call
 * (never over HTTP, never persisted anywhere outside this hash); session
 * owns the hashing/storage so the `legacy-id` domain-separated hash
 * algorithm stays in one place rather than being duplicated across
 * packages. `incarnation` is the legacy record's own immutable creation
 * reference (API supplies it; this store never guesses one), so a
 * deleted-and-recreated legacy ID cannot inherit a stale binding.
 */
export type CreateLegacyBindingInput = {
  kind: 'app' | 'session',
  legacyId: string,
  incarnation: string,
  resource: string,
  expires?: Date | null
};

export type LegacyBindingOutcome = {
  bound: boolean,
  reason?: 'namespace_conflict' | 'incarnation_mismatch'
};

export type VerifyLegacyBindingInput = {
  kind: 'app' | 'session',
  legacyId: string,
  incarnation: string,
  resource: string
};

/**
 * Focused, hand-written store methods over the nine private OAuth tables.
 * Not a generic Store/Actions implementation: every method here maps
 * directly to one named operation in storage.md, never to a reusable
 * find/create/update/delete surface, so nothing generic exists for an
 * admin/API/MCP layer to pick up and expose (storage.md "no generated
 * admin/API/MCP exposure").
 */
/**
 * The installed `@stackpress/inquire-mysql2` adapter's `Connection.format()`
 * converts every `Date` value to `date.toISOString()` (e.g.
 * `"2026-10-15T02:45:05.805Z"`) before sending it to the driver -
 * correct for PostgreSQL/PGlite/SQLite, but real MySQL's `DATETIME`
 * literal syntax rejects the `T`/`Z` punctuation outright ("Incorrect
 * datetime value"), confirmed directly against a disposable `mysql:8.4`
 * container. This is a confirmed adapter defect, not an OAuthStore
 * design choice, and not something fixable without editing
 * `@stackpress/inquire-mysql2` itself (out of this task's scope; see the
 * task notes for the minimal reproduction to hand off).
 *
 * Rather than touch every call site that passes a `Date` value (which
 * would also make this file dialect-aware throughout, defeating the
 * point of a single portable store), this transparently intercepts
 * `engine.query()` - the one choke point every builder's `.then()`
 * already funnels through - and rewrites any `Date` value in the
 * outgoing parameter list into MySQL's accepted
 * `"YYYY-MM-DD HH:MM:SS.sss"` form (still UTC wall-clock digits, just
 * without `T`/`Z`) only when the engine's dialect is `mysql`; every
 * other dialect passes through completely untouched.
 *
 * This only fixes the write side. Reading a `DATETIME` value back as a
 * correctly-UTC `Date` also requires the mysql2 connection itself to be
 * constructed with `{ timezone: 'Z' }` - mysql2's default `'local'`
 * setting would otherwise reinterpret these UTC wall-clock digits using
 * the Node process's local timezone. That option is set where the
 * connection is constructed (this file never does so itself), so it is
 * documented here and in the task notes as a required production
 * setting, not enforced by this wrapper.
 */
function withMysqlDateSafety(engine: Engine): Engine {
  if (engine.dialect.name !== 'mysql') {
    return engine;
  }
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (query: string | QueryObject, values: Value[] = []) => {
          if (typeof query === 'string') {
            return target.query(query, values.map(toMysqlSafeDate));
          }
          return target.query({
            query: query.query,
            values: (query.values || []).map(toMysqlSafeDate)
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });
}

function toMysqlSafeDate(value: Value): Value {
  if (!(value instanceof Date)) {
    return value;
  }
  return value.toISOString().replace('T', ' ').replace('Z', '');
}

export default class OAuthStore {
  public readonly engine: Engine;
  private _capacityTableEnsured = false;

  public constructor(engine: Engine) {
    this.engine = withMysqlDateSafety(engine);
  }

  /**
   * `oauth_client_capacity` (task 00004) is a private counter table that
   * holds no identity/credential/approval data, so it is not one of
   * storage.md's nine named models and is never declared in `oauth.idea` -
   * the generated schema/migration path (`yarn generate`/`push`/`migrate`)
   * never creates it. Found during task 00011's real-generated-store
   * verification: a freshly generated+pushed app has every other OAuth
   * table but not this one, so the first real client introduction to
   * reach `reserveClientCapacity` would fail with a raw "table does not
   * exist" error. Every dialect's `Create` builder emits
   * `CREATE TABLE IF NOT EXISTS`, so ensuring it here - once per store
   * instance, before the table is ever touched - is safe to run
   * concurrently and a no-op for every existing test that already creates
   * it via `createAllOAuthTables()` in its own setup.
   */
  private async _ensureCapacityTable(): Promise<void> {
    if (this._capacityTableEnsured) return;
    const create = createOAuthClientCapacity();
    create.engine = this.engine;
    await create;
    this._capacityTableEnsured = true;
  }

  // ------------------------------------------------------------------
  // Clients

  public async getClientByClientId(clientId: string): Promise<OAuthClientRow | null> {
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_CLIENT_TABLE)
      .where('client_id = ?', [ clientId ])
      .limit(1);
    const rows = await select;
    return rows.length > 0 ? fromClientRow(rows[0]) : null;
  }

  public async upsertRegisteredClient(
    clientId: string,
    metadata: Record<string, unknown>,
    now = new Date()
  ): Promise<OAuthClientRow> {
    const existing = await this.getClientByClientId(clientId);
    if (existing) {
      const update = new Update(OAUTH_CLIENT_TABLE, this.engine)
        .set({ metadata: toJsonColumn(metadata), last_used: now })
        .where('id = ?', [ existing.id ]);
      await update;
      return { ...existing, metadata, lastUsed: now };
    }
    const id = `oauthclient_${newAccessId()}`;
    const insert = new Insert(OAUTH_CLIENT_TABLE, this.engine).values({
      id,
      client_id: clientId,
      kind: 'registered',
      metadata: toJsonColumn(metadata),
      created: now,
      last_used: now
    });
    await insert;
    return {
      id, clientId, kind: 'registered', metadata, created: now,
      lastUsed: now, unusedExpires: null
    };
  }

  public async touchClientLastUsed(clientId: string, now = new Date()): Promise<void> {
    const update = new Update(OAUTH_CLIENT_TABLE, this.engine)
      .set({ last_used: now })
      .where('client_id = ?', [ clientId ]);
    await update;
  }

  /**
   * Informational count of this issuer-wide `kind`'s currently-unused
   * client identities, for diagnostics/reporting only. Not used to gate
   * any reservation decision: `reserveClientCapacity`/
   * `releaseClientCapacity` below are the atomic primitive storage.md's
   * "reserve...atomically, not COUNT then insert" requires. Kept
   * separate from the counter row those two methods maintain because a
   * row-count scan and a dedicated gauge can briefly disagree (for
   * example immediately after `releaseClientCapacity` but before
   * cleanup has actually deleted the expired row) without that
   * disagreement affecting correctness of the reservation itself.
   */
  public async countUnusedClients(
    kind: 'document' | 'registered',
    now = new Date()
  ): Promise<number> {
    const rows = await new Select<Record<string, unknown>>('id', this.engine)
      .from(OAUTH_CLIENT_TABLE)
      .where('kind = ? AND unused_expires IS NOT NULL AND unused_expires > ?', [ kind, now ]);
    return rows.length;
  }

  /**
   * Creates or refreshes a client identity that is not itself a durable
   * approval (a dynamically registered client, or a client-document URL
   * acting as a client ID), tagging it with an `unused_expires`
   * cleanup deadline. Clearing that deadline once a live grant
   * references the client is the approval flow's responsibility
   * (task 00005), not this method's.
   */
  public async touchUnusedClient(
    clientId: string,
    kind: 'document' | 'registered',
    metadata: Record<string, unknown>,
    unusedExpires: Date,
    now = new Date()
  ): Promise<OAuthClientRow> {
    const existing = await this.getClientByClientId(clientId);
    if (existing) {
      await new Update(OAUTH_CLIENT_TABLE, this.engine)
        .set({
          metadata: toJsonColumn(metadata),
          last_used: now,
          unused_expires: unusedExpires
        })
        .where('id = ?', [ existing.id ]);
      return { ...existing, metadata, lastUsed: now, unusedExpires };
    }
    const id = `oauthclient_${newAccessId()}`;
    await new Insert(OAUTH_CLIENT_TABLE, this.engine).values({
      id,
      client_id: clientId,
      kind,
      metadata: toJsonColumn(metadata),
      created: now,
      last_used: now,
      unused_expires: unusedExpires
    });
    return { id, clientId, kind, metadata, created: now, lastUsed: now, unusedExpires };
  }

  private async _selectCapacity(kind: 'document' | 'registered'): Promise<{ count: number } | null> {
    const rows = await new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_CLIENT_CAPACITY_TABLE)
      .where('id = ?', [ kind ])
      .limit(1);
    return rows.length > 0 ? { count: toInt(rows[0].count) } : null;
  }

  /**
   * Atomically reserves one unit of unused-client capacity for `kind`
   * (storage.md: "Reserve unused-client and cache capacity atomically,
   * not COUNT then insert"). Returns `false` without reserving anything
   * once the counter is already at `max` - the caller must not insert a
   * new client identity in that case. On success, the caller owns one
   * reserved slot and must either complete the corresponding insert or
   * call `releaseClientCapacity(kind)` to give it back (for example
   * when the insert that was supposed to follow this reservation
   * itself fails).
   *
   * Uses the same `_claim()` CAS-token pattern as grant locking and
   * rate buckets, for the same reason: none of Inquire's four adapters
   * exposes an affected-row count or a portable advisory lock, so a
   * plain "read count, write count+1" is unsound under true
   * concurrency - two callers reading the same stale count would both
   * compute the same next value and both believe they won. The first
   * creation of the counter row relies on its primary key: a losing
   * concurrent insert fails with a constraint violation, caught and
   * retried against the now-existing row, exactly like
   * `checkAndAdvanceFactor`'s first-use path.
   */
  public async reserveClientCapacity(
    kind: 'document' | 'registered',
    max: number
  ): Promise<boolean> {
    await this._ensureCapacityTable();
    for (let attempt = 0; attempt < CAPACITY_MAX_RETRIES; attempt++) {
      const existing = await this._selectCapacity(kind);

      if (!existing) {
        try {
          return await this.engine.transaction(async () => {
            await new Insert(OAUTH_CLIENT_CAPACITY_TABLE, this.engine).values({
              id: kind, count: 1
            });
            return true;
          });
        } catch (e) {
          if (attempt > 0) {
            await capacityBackoff();
          }
          continue;
        }
      }

      if (existing.count >= max) {
        return false;
      }
      try {
        const claimed = await this.engine.transaction(async () => {
          return this._claim(
            OAUTH_CLIENT_CAPACITY_TABLE,
            kind,
            { count: existing.count + 1 },
            'id = ? AND count = ?',
            [ kind, existing.count ]
          );
        });
        if (!claimed) {
          await capacityBackoff();
          continue;
        }
        return true;
      } catch (e) {
        await capacityBackoff();
        continue;
      }
    }
    throw new OAuthStoreError('conflict', 'Could not reserve client capacity');
  }

  /**
   * Gives back one previously reserved unit of unused-client capacity
   * for `kind` - called when an insert that followed a successful
   * `reserveClientCapacity` fails, and by bounded cleanup when an
   * unused client identity's own deadline passes. Best-effort: a
   * missing counter row or a counter already at zero is treated as
   * already released rather than an error, since this always runs
   * after the fact and must never itself block the caller's own
   * success/failure outcome.
   */
  public async releaseClientCapacity(kind: 'document' | 'registered'): Promise<void> {
    await this._ensureCapacityTable();
    for (let attempt = 0; attempt < CAPACITY_MAX_RETRIES; attempt++) {
      const existing = await this._selectCapacity(kind);
      if (!existing || existing.count <= 0) {
        return;
      }
      try {
        const claimed = await this.engine.transaction(async () => {
          return this._claim(
            OAUTH_CLIENT_CAPACITY_TABLE,
            kind,
            { count: existing.count - 1 },
            'id = ? AND count = ?',
            [ kind, existing.count ]
          );
        });
        if (!claimed) {
          await capacityBackoff();
          continue;
        }
        return;
      } catch (e) {
        await capacityBackoff();
        continue;
      }
    }
  }

  // ------------------------------------------------------------------
  // Client documents (bounded cache, separate from live client identity)

  public async getFreshClientDocument(
    urlHash: string,
    now = new Date()
  ): Promise<OAuthClientDocumentRow | null> {
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_CLIENT_DOCUMENT_TABLE)
      .where('url_hash = ?', [ urlHash ])
      .where('fresh_until > ?', [ now ])
      .limit(1);
    const rows = await select;
    return rows.length > 0 ? fromClientDocumentRow(rows[0]) : null;
  }

  /**
   * Returns the cached document row regardless of freshness, so a
   * caller can revalidate (If-None-Match/If-Modified-Since) a stale
   * entry instead of only ever seeing fresh-or-nothing.
   */
  public async getClientDocumentByUrlHash(
    urlHash: string
  ): Promise<OAuthClientDocumentRow | null> {
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_CLIENT_DOCUMENT_TABLE)
      .where('url_hash = ?', [ urlHash ])
      .limit(1);
    const rows = await select;
    return rows.length > 0 ? fromClientDocumentRow(rows[0]) : null;
  }

  public async saveClientDocument(input: {
    urlHash: string,
    metadata: Record<string, unknown>,
    etag?: string | null,
    lastModified?: string | null,
    freshUntil: Date,
    now?: Date
  }): Promise<OAuthClientDocumentRow> {
    const now = input.now || new Date();
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_CLIENT_DOCUMENT_TABLE)
      .where('url_hash = ?', [ input.urlHash ])
      .limit(1);
    const rows = await select;
    if (rows.length > 0) {
      const id = String(rows[0].id);
      const update = new Update(OAUTH_CLIENT_DOCUMENT_TABLE, this.engine)
        .set({
          metadata: toJsonColumn(input.metadata),
          etag: input.etag ?? null,
          last_modified: input.lastModified ?? null,
          fresh_until: input.freshUntil,
          last_used: now,
          updated: now
        })
        .where('id = ?', [ id ]);
      await update;
      return fromClientDocumentRow({
        ...rows[0],
        metadata: toJsonColumn(input.metadata),
        etag: input.etag ?? null,
        last_modified: input.lastModified ?? null,
        fresh_until: input.freshUntil,
        last_used: now,
        updated: now
      });
    }
    const id = `oauthdoc_${newAccessId()}`;
    const insert = new Insert(OAUTH_CLIENT_DOCUMENT_TABLE, this.engine).values({
      id,
      url_hash: input.urlHash,
      metadata: toJsonColumn(input.metadata),
      etag: input.etag ?? null,
      last_modified: input.lastModified ?? null,
      fresh_until: input.freshUntil,
      last_used: now,
      created: now,
      updated: now
    });
    await insert;
    return {
      id, urlHash: input.urlHash, metadata: input.metadata,
      etag: input.etag ?? null, lastModified: input.lastModified ?? null,
      freshUntil: input.freshUntil, lastUsed: now, created: now, updated: now
    };
  }

  // ------------------------------------------------------------------
  // Pending authorization requests

  public async createPending(input: NewPendingInput): Promise<OAuthPendingRow> {
    const now = new Date();
    const row = {
      id: input.id,
      binding_hash: input.bindingHash,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.state ?? null,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod || 'S256',
      resource: input.resource,
      scopes: toJsonColumn(input.scopes),
      operations: toJsonColumn(input.operations),
      profile_id: null,
      approved_scopes: toJsonColumn([]),
      approved_operations: toJsonColumn([]),
      factor_receipt: null,
      status: 'pending',
      expires: input.expires,
      created: now,
      updated: now
    };
    const insert = new Insert(OAUTH_PENDING_TABLE, this.engine).values(row);
    await insert;
    return fromPendingRow(row);
  }

  public async getPendingById(id: string): Promise<OAuthPendingRow | null> {
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_PENDING_TABLE)
      .where('id = ?', [ id ])
      .limit(1);
    const rows = await select;
    return rows.length > 0 ? fromPendingRow(rows[0]) : null;
  }

  public async getPendingByBindingHash(bindingHash: string): Promise<OAuthPendingRow | null> {
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_PENDING_TABLE)
      .where('binding_hash = ?', [ bindingHash ])
      .limit(1);
    const rows = await select;
    return rows.length > 0 ? fromPendingRow(rows[0]) : null;
  }

  public async bindPendingProfile(pendingId: string, profileId: string): Promise<void> {
    const update = new Update(OAUTH_PENDING_TABLE, this.engine)
      .set({ profile_id: profileId, updated: new Date() })
      .where('id = ?', [ pendingId ]);
    await update;
  }

  /**
   * Persists the server-signed factor receipt (`factor.ts`) minted
   * after a real verified-factor check, so a later approval submission
   * can read it back from the pending row itself rather than relying on
   * a client-resubmitted value. Only applies while the pending request
   * is still `pending`; a completed/denied row is never mutated.
   */
  public async setPendingFactorReceipt(
    pendingId: string,
    factorReceipt: string,
    now = new Date()
  ): Promise<void> {
    await new Update(OAUTH_PENDING_TABLE, this.engine)
      .set({ factor_receipt: factorReceipt, updated: now })
      .where('id = ? AND status = ?', [ pendingId, 'pending' ]);
  }

  /**
   * Approval (storage.md #1): validate current browser/person/client/
   * policy/factor happens in the caller before this is invoked; this
   * method atomically consumes the pending request and creates the
   * grant plus single-use code. No token exists yet. A repeated form
   * POST (pending already not "pending") cannot create another
   * grant/code - it throws `conflict` instead.
   */
  public async approvePending(
    input: ApprovePendingInput
  ): Promise<{ grant: OAuthGrantRow, code: string }> {
    const now = input.now || new Date();
    //task 00004's handoff: once a live grant takes over a client
    //identity's `unused_expires`, this method - not cleanup - is the
    //one place that releases its capacity reservation, so the atomic
    //counter never depends on cleanup ever running to stay accurate.
    let releaseCapacityKind: 'document' | 'registered' | null = null;
    const result = await this.engine.transaction(async () => {
      //first table operation: claim the pending row by flipping its
      //status with a WHERE that only matches while it is still
      //"pending" - this is the portable first-row UPDATE lock. Verified
      //through `_claim()`'s token, not by re-reading `status` alone:
      //two truly concurrent submissions both target the exact same
      //"pending" -> "completed" transition, so a plain re-read cannot
      //tell the caller who actually committed it apart from the caller
      //who merely observed someone else's committed change (see
      //_claim()'s doc comment and the regression test this was found
      //from).
      const claimed = await this._claim(
        OAUTH_PENDING_TABLE,
        input.pendingId,
        { status: 'completed', updated: now },
        'id = ? AND status = ?',
        [ input.pendingId, 'pending' ]
      );
      if (!claimed) {
        //either never existed, already completed/denied by a prior
        //call, or lost the race to a concurrent duplicate submission.
        throw new OAuthStoreError('conflict', 'Pending request already resolved');
      }
      const pending = fromPendingRow(claimed);
      if (pending.expires.getTime() <= now.getTime()) {
        throw new OAuthStoreError('invalid_request', 'Pending request expired');
      }

      const deadline = new Date(now.getTime() + input.renewalSeconds * 1000);
      const grantId = `oauthgrant_${newAccessId()}`;
      const grantRow = {
        id: grantId,
        profile_id: input.profileId,
        client_id: pending.clientId,
        resource: pending.resource,
        scopes: toJsonColumn(input.approvedScopes),
        operation_fingerprints: toJsonColumn(input.operationFingerprints),
        approved: now,
        deadline,
        access_seconds: input.accessSeconds,
        read_id_hash: null,
        full_key_hash: null,
        access_expires: null,
        generation: 0,
        lock_version: 0,
        revision: 0,
        active: true,
        created: now,
        updated: now
      };
      await new Insert(OAUTH_GRANT_TABLE, this.engine).values(grantRow);

      const code = newCode();
      const codeRow = {
        id: `oauthcode_${newAccessId()}`,
        code_hash: hashWithDomain('code', code),
        grant_id: grantId,
        client_id: pending.clientId,
        resource: pending.resource,
        redirect_uri: pending.redirectUri,
        code_challenge: pending.codeChallenge,
        expires: new Date(now.getTime() + input.codeSeconds * 1000),
        consumed: null,
        created: now
      };
      await new Insert(OAUTH_CODE_TABLE, this.engine).values(codeRow);

      await new Update(OAUTH_PENDING_TABLE, this.engine)
        .set({
          approved_scopes: toJsonColumn(input.approvedScopes),
          approved_operations: toJsonColumn(input.operationFingerprints),
          updated: now
        })
        .where('id = ?', [ input.pendingId ]);

      //storage.md: "Active registrations referenced by unexpired
      //grants are retained." A live grant now exists for this client
      //identity, so its unused-cleanup deadline no longer applies;
      //clear it inside this same transaction so cleanup can never race
      //ahead of this and delete it first.
      const clientRows = await new Select<Record<string, unknown>>('*', this.engine)
        .from(OAUTH_CLIENT_TABLE)
        .where('client_id = ?', [ pending.clientId ])
        .limit(1);
      if (clientRows.length > 0 && clientRows[0].unused_expires !== null) {
        await new Update(OAUTH_CLIENT_TABLE, this.engine)
          .set({ unused_expires: null })
          .where('id = ?', [ String(clientRows[0].id) ]);
        releaseCapacityKind = clientRows[0].kind === 'document' ? 'document' : 'registered';
      }

      return { grant: fromGrantRow(grantRow), code };
    });
    //best-effort, outside the transaction, mirroring cleanup()'s own
    //use of releaseClientCapacity - never allowed to affect this
    //call's own success/failure outcome.
    if (releaseCapacityKind) {
      await this.releaseClientCapacity(releaseCapacityKind);
    }
    return result;
  }

  public async denyPending(pendingId: string, now = new Date()): Promise<void> {
    await new Update(OAUTH_PENDING_TABLE, this.engine)
      .set({ status: 'denied', updated: now })
      .where('id = ? AND status = ?', [ pendingId, 'pending' ]);
  }

  // ------------------------------------------------------------------
  // Grant locking (the shared "portable first-row UPDATE lock" primitive
  // every atomic operation below is built on)

  private async _selectGrantById(grantId: string): Promise<OAuthGrantRow | null> {
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_GRANT_TABLE)
      .where('id = ?', [ grantId ])
      .limit(1);
    const rows = await select;
    return rows.length > 0 ? fromGrantRow(rows[0]) : null;
  }

  /**
   * Conditionally updates one row, then proves - via a fresh,
   * unguessable per-attempt token written in the same UPDATE and
   * re-read afterwards - that *this* call is the one whose WHERE clause
   * actually matched, as opposed to a concurrent call that merely
   * observes a different writer's already-committed result.
   *
   * This distinction matters because none of Inquire's four adapters
   * exposes an affected-row count through the public `engine.query()`/
   * builder surface (confirmed by reading all four `Connection.query()`
   * implementations; PGlite's returns only `.rows`). Without it, the
   * tempting portable substitute - re-read the row and compare it to
   * the value this call expected to have written - is unsound whenever
   * two concurrent callers compute the *same* expected value from the
   * *same* stale "before" read (which happens on every true race this
   * lock exists to prevent): the loser's blocked UPDATE re-evaluates
   * its WHERE clause against the winner's already-committed row,
   * matches nothing, and writes nothing - but the loser's post-UPDATE
   * re-read still sees the winner's value, which is indistinguishable
   * from its own success unless something written by the UPDATE is
   * provably unique per attempt. A first implementation of this file
   * compared `lock_version` to a deterministic `+1` and was wrong for
   * exactly this reason; `tests/oauth/store.test.ts`'s concurrency
   * cases caught it. The random `lock_token` written here is that
   * unique-per-attempt proof.
   *
   * Returns the fresh row on success, `null` on a lost race or a
   * missing row (never throws for either - callers decide what a lost
   * race means for them: retry, or report not-found).
   */
  private async _claim(
    table: string,
    id: string,
    setValues: Record<string, unknown>,
    whereClause: string,
    whereValues: FlatValue[]
  ): Promise<Record<string, unknown> | null> {
    const token = randomToken();
    await new Update(table, this.engine)
      .set({ ...setValues, lock_token: token })
      .where(whereClause, whereValues);
    const rows = await new Select<Record<string, unknown>>('*', this.engine)
      .from(table)
      .where('id = ?', [ id ])
      .limit(1);
    if (rows.length === 0) {
      return null;
    }
    return rows[0].lock_token === token ? rows[0] : null;
  }

  /**
   * Runs `work` once this grant's row-level write lock is held, having
   * first bumped `lock_version` with a conditional, `_claim()`-verified
   * UPDATE (WHERE id = ? AND lock_version = ?). The UPDATE is
   * deliberately the very first table operation inside the
   * transaction, matching storage.md's code exchange/refresh wording
   * ("the grant lockVersion UPDATE is the first table operation, then
   * re-read and validate"). A lost race retries with fresh state, up to
   * `MAX_LOCK_RETRIES` times. This is the "tested portable first-row
   * UPDATE lock" storage.md calls for, as opposed to PostgreSQL-only
   * `SELECT ... FOR UPDATE`.
   */
  private async _withLockedGrant<T>(
    grantId: string,
    work: (grant: OAuthGrantRow) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const before = await this._selectGrantById(grantId);
      if (!before) {
        throw new OAuthStoreError('invalid_grant', 'Grant not found');
      }
      try {
        return await this.engine.transaction(async () => {
          const claimed = await this._claim(
            OAUTH_GRANT_TABLE,
            grantId,
            { lock_version: before.lockVersion + 1, updated: new Date() },
            'id = ? AND lock_version = ?',
            [ grantId, before.lockVersion ]
          );
          if (!claimed) {
            throw new OAuthLockConflict();
          }
          return await work(fromGrantRow(claimed));
        });
      } catch (e) {
        if (e instanceof OAuthLockConflict) {
          continue;
        }
        throw e;
      }
    }
    throw new OAuthStoreError('conflict', 'Could not acquire grant lock');
  }

  /**
   * Issues a fresh full access key + optional refresh token onto an
   * already-locked, already-validated grant row. Shared by approval's
   * sibling code-exchange flow and by refresh rotation.
   */
  private async _issueAccess(
    grant: OAuthGrantRow,
    scopes: string[],
    now: Date,
    issueRefresh: boolean
  ): Promise<OAuthTokenIssued> {
    const accessId = newAccessId();
    const accessSecret = newAccessSecret();
    const accessExpires = new Date(Math.min(
      now.getTime() + grant.accessSeconds * 1000,
      grant.deadline.getTime()
    ));
    const generation = grant.generation + 1;

    await new Update(OAUTH_GRANT_TABLE, this.engine)
      .set({
        read_id_hash: hashWithDomain('access-read', accessId),
        full_key_hash: hashWithDomain('access-full', accessSecret),
        access_expires: accessExpires,
        scopes: toJsonColumn(scopes),
        generation,
        revision: grant.revision + 1,
        updated: now
      })
      .where('id = ?', [ grant.id ]);

    let refreshToken: string | null = null;
    if (issueRefresh) {
      refreshToken = newRefreshToken();
      await new Insert(OAUTH_REFRESH_TOKEN_TABLE, this.engine).values({
        id: `oauthrt_${newAccessId()}`,
        token_hash: hashWithDomain('refresh', refreshToken),
        grant_id: grant.id,
        client_id: grant.clientId,
        resource: grant.resource,
        generation,
        issued: now,
        consumed: null,
        expires: accessExpires.getTime() < grant.deadline.getTime() ?
          grant.deadline : accessExpires
      });
    }

    return {
      grantId: grant.id,
      accessId,
      accessSecret,
      accessExpires,
      scopes,
      refreshToken
    };
  }

  private async _cancelGrantRow(grant: OAuthGrantRow, now: Date): Promise<void> {
    await new Update(OAUTH_GRANT_TABLE, this.engine)
      .set({
        active: false,
        read_id_hash: null,
        full_key_hash: null,
        access_expires: null,
        revision: grant.revision + 1,
        updated: now
      })
      .where('id = ?', [ grant.id ]);
  }

  // ------------------------------------------------------------------
  // Code exchange (storage.md #2)

  public async exchangeCode(
    input: ExchangeCodeInput,
    now = new Date(),
    deps?: OAuthAccessDeps
  ): Promise<OAuthTokenIssued> {
    //locate the code-to-grant reference outside the transaction
    const codeHash = hashWithDomain('code', input.code);
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_CODE_TABLE)
      .where('code_hash = ?', [ codeHash ])
      .limit(1);
    const rows = await select;
    if (rows.length === 0) {
      throw new OAuthStoreError('invalid_grant', 'Unknown code');
    }
    const codeOutside = fromCodeRow(rows[0]);

    const result = await this._withLockedGrant(codeOutside.grantId, async (grant) => {
      //recheck binding after the lock; the preliminary lookup above is
      //not authority
      const codeSelect = new Select<Record<string, unknown>>('*', this.engine)
        .from(OAUTH_CODE_TABLE)
        .where('id = ?', [ codeOutside.id ])
        .limit(1);
      const codeRows = await codeSelect;
      if (codeRows.length === 0) {
        throw new OAuthStoreError('invalid_grant', 'Unknown code');
      }
      const code = fromCodeRow(codeRows[0]);

      //reuse (storage.md #4): an authenticated code replay cancels the
      //grant's whole chain. Commit the cancellation, then report
      //invalid_grant - do not throw here, or the cancellation itself
      //would be rolled back with it.
      if (code.consumed !== null) {
        await this._cancelGrantRow(grant, now);
        return { reused: true as const };
      }
      if (
        code.expires.getTime() <= now.getTime() ||
        code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri ||
        code.resource !== input.resource ||
        !grant.active ||
        grant.deadline.getTime() <= now.getTime()
      ) {
        throw new OAuthStoreError('invalid_grant', 'Code/grant no longer valid');
      }
      if (!verifyPkceS256(input.codeVerifier, code.codeChallenge)) {
        throw new OAuthStoreError('invalid_grant', 'PKCE verification failed');
      }

      let scopes = grant.scopes;
      if (deps) {
        const accountOk = await deps.checkAccount(grant.profileId);
        if (!accountOk) {
          throw new OAuthStoreError('invalid_grant', 'Account is not active');
        }
        const access = await deps.checkAccess(grant);
        if (!access || access.allowed !== true) {
          throw new OAuthStoreError('invalid_grant', 'Access policy denied exchange');
        }
        if (access.scopes) {
          scopes = access.scopes;
        }
      }

      await new Update(OAUTH_CODE_TABLE, this.engine)
        .set({ consumed: now })
        .where('id = ?', [ code.id ]);

      const issued = await this._issueAccess(grant, scopes, now, true);
      return { reused: false as const, issued };
    });

    if (result.reused) {
      throw new OAuthStoreError('invalid_grant', 'Code already used; approval cancelled');
    }
    return result.issued;
  }

  // ------------------------------------------------------------------
  // Refresh (storage.md #3)

  public async refreshGrant(
    input: RefreshInput,
    now = new Date(),
    deps?: OAuthAccessDeps
  ): Promise<OAuthTokenIssued> {
    const tokenHash = hashWithDomain('refresh', input.refreshToken);
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_REFRESH_TOKEN_TABLE)
      .where('token_hash = ?', [ tokenHash ])
      .limit(1);
    const rows = await select;
    if (rows.length === 0) {
      throw new OAuthStoreError('invalid_grant', 'Unknown refresh token');
    }
    const tokenOutside = fromRefreshTokenRow(rows[0]);

    const result = await this._withLockedGrant(tokenOutside.grantId, async (grant) => {
      const tokenSelect = new Select<Record<string, unknown>>('*', this.engine)
        .from(OAUTH_REFRESH_TOKEN_TABLE)
        .where('id = ?', [ tokenOutside.id ])
        .limit(1);
      const tokenRows = await tokenSelect;
      if (tokenRows.length === 0) {
        throw new OAuthStoreError('invalid_grant', 'Unknown refresh token');
      }
      const token = fromRefreshTokenRow(tokenRows[0]);

      //reuse (storage.md #4): refresh-token replay also cancels the
      //whole chain, committed even though the overall call reports
      //invalid_grant.
      if (token.consumed !== null) {
        await this._cancelGrantRow(grant, now);
        return { reused: true as const };
      }
      if (
        token.expires.getTime() <= now.getTime() ||
        token.clientId !== input.clientId ||
        token.resource !== input.resource ||
        token.generation !== grant.generation ||
        !grant.active ||
        grant.deadline.getTime() <= now.getTime()
      ) {
        throw new OAuthStoreError('invalid_grant', 'Refresh token/grant no longer valid');
      }

      //scope may narrow; membership and deadline cannot grow
      let scopes = grant.scopes;
      if (input.narrowedScopes) {
        const allowed = new Set(grant.scopes);
        const narrowed = input.narrowedScopes.filter((scope) => allowed.has(scope));
        if (narrowed.length !== input.narrowedScopes.length) {
          throw new OAuthStoreError('invalid_request', 'Requested scope is not a subset of the grant');
        }
        scopes = narrowed;
      }

      if (deps) {
        const accountOk = await deps.checkAccount(grant.profileId);
        if (!accountOk) {
          throw new OAuthStoreError('invalid_grant', 'Account is not active');
        }
        const access = await deps.checkAccess({ ...grant, scopes });
        if (!access || access.allowed !== true) {
          throw new OAuthStoreError('invalid_grant', 'Access policy denied refresh');
        }
        if (access.scopes) {
          const allowed = new Set(scopes);
          const narrowed = access.scopes.filter((scope) => allowed.has(scope));
          if (narrowed.length !== access.scopes.length) {
            throw new OAuthStoreError('invalid_grant', 'Access policy expanded scope');
          }
          scopes = narrowed;
        }
      }

      await new Update(OAUTH_REFRESH_TOKEN_TABLE, this.engine)
        .set({ consumed: now })
        .where('id = ?', [ token.id ]);

      const issued = await this._issueAccess(grant, scopes, now, true);
      return { reused: false as const, issued };
    });

    if (result.reused) {
      throw new OAuthStoreError('invalid_grant', 'Refresh token already used; approval cancelled');
    }
    return result.issued;
  }

  // ------------------------------------------------------------------
  // Disconnect / revoke (storage.md #5)

  public async cancelGrant(grantId: string, now = new Date()): Promise<boolean> {
    return this._withLockedGrant(grantId, async (grant) => {
      await this._cancelGrantRow(grant, now);
      return true;
    }).catch((e) => {
      if (e instanceof OAuthStoreError && e.code === 'invalid_grant') {
        return false;
      }
      throw e;
    });
  }

  /**
   * Browser-authenticated disconnect. Returns `'not_found'` without
   * distinguishing "does not exist" from "belongs to someone else" so a
   * caller can report another person's grant as unavailable without
   * revealing its owner (events.md).
   */
  public async disconnectGrant(
    profileId: string,
    grantId: string,
    now = new Date()
  ): Promise<'revoked' | 'not_found'> {
    const grant = await this._selectGrantById(grantId);
    if (!grant || grant.profileId !== profileId) {
      return 'not_found';
    }
    await this._withLockedGrant(grantId, async (locked) => {
      await this._cancelGrantRow(locked, now);
    });
    return 'revoked';
  }

  /**
   * `/revoke` with a full access key. A wrong secret must not revoke
   * the grant; an unknown token is also "successful" (events.md), so
   * this never throws for a bad credential - it just silently does
   * nothing.
   */
  public async revokeByFullKey(fullKey: string, clientId: string, now = new Date()): Promise<void> {
    const split = splitFullKey(fullKey);
    if (!split) {
      return;
    }
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_GRANT_TABLE)
      .where('read_id_hash = ?', [ hashWithDomain('access-read', split.id) ])
      .limit(1);
    const rows = await select;
    if (rows.length === 0) {
      return;
    }
    const grant = fromGrantRow(rows[0]);
    if (
      grant.clientId !== clientId ||
      !grant.fullKeyHash ||
      !hashesEqual(grant.fullKeyHash, hashWithDomain('access-full', split.secret))
    ) {
      return;
    }
    await this._withLockedGrant(grant.id, async (locked) => {
      await this._cancelGrantRow(locked, now);
    });
  }

  public async revokeByRefreshToken(token: string, clientId: string, now = new Date()): Promise<void> {
    const tokenHash = hashWithDomain('refresh', token);
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_REFRESH_TOKEN_TABLE)
      .where('token_hash = ?', [ tokenHash ])
      .limit(1);
    const rows = await select;
    if (rows.length === 0) {
      return;
    }
    const refresh = fromRefreshTokenRow(rows[0]);
    if (refresh.clientId !== clientId) {
      return;
    }
    await this._withLockedGrant(refresh.grantId, async (locked) => {
      await this._cancelGrantRow(locked, now);
    });
  }

  /**
   * Looks up a grant by its access read-ID (events.md `oauth-token-verify`).
   * Returns the row regardless of the grant's current active/expiry
   * state - the caller (task 00005's verify event) performs every
   * freshness/authorization check itself, since those depend on
   * app-boundary facts (current account state, access policy) this
   * storage layer has no visibility into.
   */
  public async getGrantByAccessId(accessId: string): Promise<OAuthGrantRow | null> {
    const rows = await new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_GRANT_TABLE)
      .where('read_id_hash = ?', [ hashWithDomain('access-read', accessId) ])
      .limit(1);
    return rows.length > 0 ? fromGrantRow(rows[0]) : null;
  }

  public async listGrantsForProfile(profileId: string): Promise<OAuthGrantRow[]> {
    const select = new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_GRANT_TABLE)
      .where('profile_id = ?', [ profileId ])
      .where('active = ?', [ true ]);
    const rows = await select;
    return rows.map(fromGrantRow);
  }

  // ------------------------------------------------------------------
  // Legacy key bindings (storage.md "Upgrade Existing MCP Keys Explicitly")

  private async _selectLegacyBinding(
    kind: 'app' | 'session',
    legacyIdHash: string,
    resource: string
  ): Promise<OAuthLegacyBindingRow | null> {
    const rows = await new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_LEGACY_BINDING_TABLE)
      .where('kind = ? AND legacy_id_hash = ? AND resource = ?', [ kind, legacyIdHash, resource ])
      .limit(1);
    return rows.length > 0 ? fromLegacyBindingRow(rows[0]) : null;
  }

  /**
   * Operator-only, repeatable binding creation (API's migration adapter
   * is the only intended caller). Rejects a legacy ID that collides with
   * the `oauth_` namespace outright (storage.md: "Validate namespace
   * collisions during upgrade and prevent creating conflicting legacy
   * IDs thereafter"). Repeating the same still-matching bind is
   * idempotent (reactivates/refreshes the row); a legacy ID reused by a
   * genuinely different source record (different `incarnation`) is
   * rejected rather than silently overwritten, so "a recreated ID cannot
   * inherit access" - the operator must re-run against the correct
   * current record, which naturally produces a fresh incarnation value.
   */
  public async createLegacyBinding(
    input: CreateLegacyBindingInput,
    now = new Date()
  ): Promise<LegacyBindingOutcome> {
    if (isOAuthNamespace(input.legacyId)) {
      return { bound: false, reason: 'namespace_conflict' };
    }
    const legacyIdHash = hashWithDomain('legacy-id', input.legacyId);
    const existing = await this._selectLegacyBinding(input.kind, legacyIdHash, input.resource);
    if (existing) {
      if (existing.incarnation !== input.incarnation) {
        return { bound: false, reason: 'incarnation_mismatch' };
      }
      await new Update(OAUTH_LEGACY_BINDING_TABLE, this.engine)
        .set({ active: true, expires: input.expires ?? null })
        .where('id = ?', [ existing.id ]);
      return { bound: true };
    }
    await new Insert(OAUTH_LEGACY_BINDING_TABLE, this.engine).values({
      id: `oauthlb_${newAccessId()}`,
      kind: input.kind,
      legacy_id_hash: legacyIdHash,
      incarnation: input.incarnation,
      resource: input.resource,
      active: true,
      expires: input.expires ?? null,
      created: now
    });
    return { bound: true };
  }

  /**
   * The "ask session to verify its exact active binding" half of
   * storage.md's hardened legacy validation path. API performs its own
   * record/secret/active/expiry/scopes checks first; once those pass, it
   * calls this (through the `oauth-legacy-verify` event) with the exact
   * same raw legacy ID/incarnation/resource. A namespace collision, a
   * missing/inactive/expired binding or an incarnation mismatch
   * (deletion/recreation reusing the same ID) are all reported the same
   * way - `false` - never distinguishing why, so an unbound key cannot
   * be used to probe which failure mode applies.
   */
  public async verifyLegacyBinding(
    input: VerifyLegacyBindingInput,
    now = new Date()
  ): Promise<boolean> {
    if (isOAuthNamespace(input.legacyId)) {
      return false;
    }
    const legacyIdHash = hashWithDomain('legacy-id', input.legacyId);
    const existing = await this._selectLegacyBinding(input.kind, legacyIdHash, input.resource);
    if (!existing || !existing.active) {
      return false;
    }
    if (existing.incarnation !== input.incarnation) {
      return false;
    }
    if (existing.expires && existing.expires.getTime() <= now.getTime()) {
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Shared atomic counters: factor-use replay guard and rate buckets

  private async _selectFactorUse(
    factorId: string,
    incarnation: string
  ): Promise<OAuthFactorUseRow | null> {
    const rows = await new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_FACTOR_USE_TABLE)
      .where('factor_id = ? AND incarnation = ?', [ factorId, incarnation ])
      .limit(1);
    return rows.length > 0 ? fromFactorUseRow(rows[0]) : null;
  }

  /**
   * Atomically advances a single verified factor's accepted counter.
   * Returns `true` the first time a given `counter` value is accepted
   * for this `factorId`/`incarnation` pair, `false` on every retry of
   * the same or an older code - so a retried TOTP code cannot mint
   * multiple approval receipts (events.md).
   *
   * Portable across all four adapters without relying on dialect-
   * specific upsert syntax: the row's first creation relies on the
   * unique `(factor_id, incarnation)` index itself (a losing concurrent
   * insert fails with a constraint violation, which is caught and
   * retried against the now-existing row); every later advance uses
   * `_claim()` so two concurrent callers racing on the exact same
   * `counter` value cannot both be told they won (see `_claim()`'s doc
   * comment).
   */
  public async checkAndAdvanceFactor(
    factorId: string,
    incarnation: string,
    profileId: string,
    counter: number,
    now = new Date()
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const existing = await this._selectFactorUse(factorId, incarnation);

      if (!existing) {
        try {
          return await this.engine.transaction(async () => {
            await new Insert(OAUTH_FACTOR_USE_TABLE, this.engine).values({
              id: `oauthfu_${newAccessId()}`,
              factor_id: factorId,
              incarnation,
              profile_id: profileId,
              counter,
              updated: now
            });
            return true;
          });
        } catch (e) {
          //lost the create race to a concurrent first-use; fall through
          //to the update path against whatever row it created
          continue;
        }
      }

      if (counter <= existing.counter) {
        return false;
      }
      try {
        return await this.engine.transaction(async () => {
          const claimed = await this._claim(
            OAUTH_FACTOR_USE_TABLE,
            existing.id,
            { counter, updated: now },
            'id = ? AND counter = ?',
            [ existing.id, existing.counter ]
          );
          if (!claimed) {
            throw new OAuthLockConflict();
          }
          return fromFactorUseRow(claimed).counter === counter;
        });
      } catch (e) {
        if (e instanceof OAuthLockConflict) {
          continue;
        }
        throw e;
      }
    }
    throw new OAuthStoreError('conflict', 'Could not advance factor counter');
  }

  private async _selectRateBucket(
    keyHash: string,
    windowStart: Date
  ): Promise<OAuthRateBucketRow | null> {
    const rows = await new Select<Record<string, unknown>>('*', this.engine)
      .from(OAUTH_RATE_BUCKET_TABLE)
      .where('key_hash = ? AND window_start = ?', [ keyHash, windowStart ])
      .limit(1);
    return rows.length > 0 ? fromRateBucketRow(rows[0]) : null;
  }

  /**
   * Shared atomic rate-limiter counter (configuration.md limits.*).
   * Returns the bucket's count *after* this call's attempt is counted,
   * so the caller compares it against the configured limit. Same
   * insert-then-`_claim()` shape as `checkAndAdvanceFactor`, for the
   * same cross-dialect portability and correctness reason: `count` is
   * a real value every caller legitimately wants incremented, so (unlike
   * the grant lock's `lock_version`) it cannot double as its own CAS
   * proof - two concurrent callers reading the same `before.count` would
   * both compute the same `next` value, and `_claim()`'s random token is
   * what actually tells them apart.
   */
  public async incrementRateBucket(
    keyHash: string,
    windowStart: Date,
    expires: Date
  ): Promise<number> {
    for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
      const existing = await this._selectRateBucket(keyHash, windowStart);

      if (!existing) {
        try {
          return await this.engine.transaction(async () => {
            await new Insert(OAUTH_RATE_BUCKET_TABLE, this.engine).values({
              id: `oauthrb_${newAccessId()}`,
              key_hash: keyHash,
              window_start: windowStart,
              count: 1,
              expires
            });
            return 1;
          });
        } catch (e) {
          continue;
        }
      }

      const next = existing.count + 1;
      try {
        return await this.engine.transaction(async () => {
          const claimed = await this._claim(
            OAUTH_RATE_BUCKET_TABLE,
            existing.id,
            { count: next },
            'id = ? AND count = ?',
            [ existing.id, existing.count ]
          );
          if (!claimed) {
            throw new OAuthLockConflict();
          }
          return fromRateBucketRow(claimed).count;
        });
      } catch (e) {
        if (e instanceof OAuthLockConflict) {
          continue;
        }
        throw e;
      }
    }
    throw new OAuthStoreError('conflict', 'Could not advance rate bucket');
  }

  // ------------------------------------------------------------------
  // Bounded cleanup

  /**
   * Bounded cleanup (storage.md): never removes a live-grant dependency
   * or replay history early. Unused expired codes/refresh tokens are
   * removed on their own short expiry; *consumed* ones are preserved
   * until their owning grant's final deadline has passed, so replay
   * stays detectable for the full window storage.md requires. Grants
   * are only removed once their own deadline has passed (by then any
   * dependent codes/refresh tokens have already been cleaned in the
   * same pass, in dependency order).
   */
  public async cleanup(batchSize: number, now = new Date()): Promise<OAuthCleanupCounts> {
    const limitClause = (ids: string[]) => ids.slice(0, batchSize);

    const expiredGrantIds = async () => {
      const rows = await new Select<Record<string, unknown>>('id', this.engine)
        .from(OAUTH_GRANT_TABLE)
        .where('deadline <= ?', [ now ])
        .limit(batchSize);
      return rows.map((row: Record<string, unknown>) => String(row.id));
    };
    const grantIdsForDependents = await expiredGrantIds();

    const removeBounded = async (table: string, ids: string[]): Promise<number> => {
      if (ids.length === 0) {
        return 0;
      }
      const bounded = limitClause(ids);
      const placeholders = bounded.map(() => '?').join(', ');
      await new Delete(table, this.engine).where(`id IN (${placeholders})`, bounded);
      return bounded.length;
    };

    //1. unused expired codes/refresh tokens (never touched a grant), and
    //any code/refresh token - consumed or not - whose owning grant has
    //itself already passed its final deadline: once a grant is gone,
    //none of its remaining codes/tokens (used or unused) can ever be
    //exchanged again (exchangeCode/refreshGrant both reject on
    //`grant.deadline <= now`), so they are all reclaimable together,
    //not only the ones that happen to have already been consumed.
    const unusedCodes = await new Select<Record<string, unknown>>('id', this.engine)
      .from(OAUTH_CODE_TABLE)
      .where('consumed IS NULL AND expires <= ?', [ now ])
      .limit(batchSize);
    const codesForExpiredGrants = grantIdsForDependents.length > 0 ?
      await new Select<Record<string, unknown>>('id', this.engine)
        .from(OAUTH_CODE_TABLE)
        .where(
          `grant_id IN (${grantIdsForDependents.map(() => '?').join(', ')})`,
          grantIdsForDependents
        )
        .limit(batchSize)
      : [];
    const codeIds = [ ...new Set([
      ...unusedCodes.map((row: Record<string, unknown>) => String(row.id)),
      ...codesForExpiredGrants.map((row: Record<string, unknown>) => String(row.id))
    ]) ];
    const codes = await removeBounded(OAUTH_CODE_TABLE, codeIds);

    const unusedRefresh = await new Select<Record<string, unknown>>('id', this.engine)
      .from(OAUTH_REFRESH_TOKEN_TABLE)
      .where('consumed IS NULL AND expires <= ?', [ now ])
      .limit(batchSize);
    const refreshForExpiredGrants = grantIdsForDependents.length > 0 ?
      await new Select<Record<string, unknown>>('id', this.engine)
        .from(OAUTH_REFRESH_TOKEN_TABLE)
        .where(
          `grant_id IN (${grantIdsForDependents.map(() => '?').join(', ')})`,
          grantIdsForDependents
        )
        .limit(batchSize)
      : [];
    const refreshIds = [ ...new Set([
      ...unusedRefresh.map((row: Record<string, unknown>) => String(row.id)),
      ...refreshForExpiredGrants.map((row: Record<string, unknown>) => String(row.id))
    ]) ];
    const refreshTokens = await removeBounded(OAUTH_REFRESH_TOKEN_TABLE, refreshIds);

    //2. expired pending requests (both resolved and abandoned-unresolved)
    const expiredPending = await new Select<Record<string, unknown>>('id', this.engine)
      .from(OAUTH_PENDING_TABLE)
      .where('expires <= ?', [ now ])
      .limit(batchSize);
    const pending = await removeBounded(
      OAUTH_PENDING_TABLE,
      expiredPending.map((row: Record<string, unknown>) => String(row.id))
    );

    //3. grants whose final deadline has passed (dependents removed above)
    const grants = await removeBounded(OAUTH_GRANT_TABLE, grantIdsForDependents);

    //4. expired rate buckets
    const expiredBuckets = await new Select<Record<string, unknown>>('id', this.engine)
      .from(OAUTH_RATE_BUCKET_TABLE)
      .where('expires <= ?', [ now ])
      .limit(batchSize);
    const rateBuckets = await removeBounded(
      OAUTH_RATE_BUCKET_TABLE,
      expiredBuckets.map((row: Record<string, unknown>) => String(row.id))
    );

    //5. legacy bindings that were given their own expiry and it passed
    //(a binding with no expiry never outlives the original key only in
    //the sense that it is removed when the key itself is revoked -
    //that removal is this same `legacy_binding` table, driven by API's
    //migration adapter in a later task, not a time-based cleanup here)
    const expiredBindings = await new Select<Record<string, unknown>>('id', this.engine)
      .from(OAUTH_LEGACY_BINDING_TABLE)
      .where('expires IS NOT NULL AND expires <= ?', [ now ])
      .limit(batchSize);
    const legacyBindings = await removeBounded(
      OAUTH_LEGACY_BINDING_TABLE,
      expiredBindings.map((row: Record<string, unknown>) => String(row.id))
    );

    //6. unused client identities (document or registered) whose
    //unused_expires has passed. Task 00005's approval flow is expected
    //to clear `unused_expires` once a live grant references a client
    //("Active registrations referenced by unexpired grants are
    //retained" - storage.md), so anything still carrying a passed
    //`unused_expires` here was genuinely never promoted to an active
    //approval. Release the matching capacity-counter slot for each row
    //removed, so the atomic counter this task's reservation primitive
    //maintains stays in sync with what is actually still in the table.
    const expiredClients = await new Select<Record<string, unknown>>('id, kind', this.engine)
      .from(OAUTH_CLIENT_TABLE)
      .where('unused_expires IS NOT NULL AND unused_expires <= ?', [ now ])
      .limit(batchSize);
    const clients = await removeBounded(
      OAUTH_CLIENT_TABLE,
      expiredClients.map((row: Record<string, unknown>) => String(row.id))
    );
    for (const row of expiredClients.slice(0, batchSize)) {
      const kind = row.kind === 'document' ? 'document' : 'registered';
      await this.releaseClientCapacity(kind);
    }

    return { pending, codes, refreshTokens, grants, rateBuckets, legacyBindings, clients };
  }
}
