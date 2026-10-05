//node
import { createHash, randomBytes } from 'node:crypto';

/** Returns an unguessable fixture credential. */
export function randomToken() {
  return randomBytes(32).toString('base64url');
}

/** Hashes credentials before using them as lookup keys. */
export function digest(value) {
  return createHash('sha256').update(value).digest('base64url');
}

/** Makes an error that the HTTP fixture can return before streaming. */
export function failure(status, error) {
  return Object.assign(new Error(error), { status, error });
}

/** Creates candidate session-owned records without a database dependency. */
export function createRecords(options) {
  const grants = new Map();
  const access = new Map();
  const renewal = new Map();
  const codes = new Map();
  const clients = new Map();
  const pending = new Map();
  const legacy = new Map();

  /** Issues a fresh ID and secret; rotating never revives an old read ID. */
  function issue(grant) {
    const id = `oauth_${randomToken()}`;
    const secret = randomToken();
    const refresh = randomToken();
    const expires = Math.min(Date.now() + options.accessSeconds * 1000, grant.deadline);
    access.set(digest(id), { grant, secret: digest(secret), expires });
    renewal.set(digest(refresh), { grant, used: false });
    return {
      access_token: `${id}:${secret}`,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((expires - Date.now()) / 1000)),
      refresh_token: refresh,
      scope: grant.scopes.join(' ')
    };
  }

  /** Ends access without deleting renewal reuse evidence. */
  function revokeAll() {
    for (const grant of grants.values()) grant.revoked = true;
  }

  /** Expires access only so a real client can demonstrate renewal. */
  function expireAll() {
    for (const record of access.values()) record.expires = Date.now() - 1;
  }

  /** Checks exact membership independently of permission and request method. */
  function authorize(token, operation) {
    if (!token) {
      if (operation.type === 'public') return { type: 'public' };
      throw failure(401, 'invalid_token');
    }

    // a presented OAuth key never falls through into the legacy store
    const [ id, secret, extra ] = token.split(':');
    if (!id.startsWith('oauth_')) {
      const previous = legacy.get(token);
      if (!previous) throw failure(401, 'invalid_token');
      return { type: 'user', legacy: true };
    }
    const record = access.get(digest(id));
    if (!record || extra !== undefined || secret === '') {
      throw failure(401, 'invalid_token');
    }
    const grant = record.grant;
    if (record.expires <= Date.now() || grant.deadline <= Date.now()
      || grant.revoked || !grant.active) {
      throw failure(401, 'invalid_token');
    }

    // bad full keys fail even when an ID alone would permit a read
    if (secret !== undefined && digest(secret) !== record.secret) {
      throw failure(401, 'invalid_token');
    }
    if (operation.method !== 'GET' && secret === undefined) {
      throw failure(401, 'invalid_token');
    }
    if (operation.resource !== grant.resource
      || !grant.members.includes(operation.member)) {
      throw failure(403, 'invalid_target');
    }
    if (operation.surface === 'api' && operation.oauth !== true) {
      throw failure(403, 'oauth_disabled');
    }
    if (operation.type !== 'public' && operation.type !== grant.type) {
      throw failure(403, 'wrong_caller_type');
    }
    const required = operation.scopes || [];
    if (operation.type !== 'public' && (!required.length
      ? operation.surface === 'api'
      : !required.some(scope => grant.scopes.includes(scope)))) {
      throw failure(403, 'insufficient_scope');
    }
    return { type: grant.type, user: grant.user, grantId: grant.id };
  }

  return {
    grants, access, renewal, codes, clients, pending, legacy,
    issue, revokeAll, expireAll, authorize
  };
}
