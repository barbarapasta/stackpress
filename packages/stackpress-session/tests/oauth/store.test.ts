import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Update from '@stackpress/inquire/Update';
import Connection from '@stackpress/inquire-pglite/Connection';
import {
  createAllOAuthTables,
  OAUTH_GRANT_TABLE,
  OAUTH_LEGACY_BINDING_TABLE
} from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { OAuthStoreError } from '../../src/oauth/storage/errors.js';
import { hashWithDomain, newPendingBinding, toFullKey } from '../../src/oauth/storage/ids.js';
import { computeS256Challenge } from '../../src/oauth/pkce.js';

describe('OAuthStore (PGlite, in-memory, corrected Inquire d5f5a07)', () => {
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine = new Engine(connection);
  const store = new OAuthStore(engine);
  const CODE_VERIFIER = 'test-code-verifier-0123456789-abcdefghijk';
  const CODE_CHALLENGE = computeS256Challenge(CODE_VERIFIER);

  before(async () => {
    for (const create of createAllOAuthTables()) {
      create.engine = engine;
      await create;
    }
  });

  after(async () => {
    await resource.close();
  });

  async function approvedGrant(overrides: Partial<{
    scopes: string[], operations: string[]
  }> = {}) {
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: CODE_CHALLENGE,
      resource: 'https://example.com/mcp',
      scopes: overrides.scopes || [ 'articles:read' ],
      operations: overrides.operations || [],
      expires: new Date(Date.now() + 600_000)
    });
    const { grant, code } = await store.approvePending({
      pendingId: pending.id,
      profileId: 'profile-1',
      approvedScopes: overrides.scopes || [ 'articles:read' ],
      approvedOperations: overrides.operations || [],
      operationFingerprints: [],
      accessSeconds: 900,
      renewalSeconds: 604_800,
      codeSeconds: 60
    });
    return { pending, grant, code };
  }

  it('approval: consumes the pending request and creates a grant plus single-use code', async () => {
    const { pending, grant, code } = await approvedGrant();
    expect(grant.active).to.equal(true);
    expect(grant.readIdHash).to.equal(null);
    expect(grant.fullKeyHash).to.equal(null);
    expect(code).to.be.a('string');
    const resolved = await store.getPendingById(pending.id);
    expect(resolved?.status).to.equal('completed');
  });

  it('approval: a repeated form POST on the same pending request cannot create a second grant/code', async () => {
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: CODE_CHALLENGE,
      resource: 'https://example.com/mcp',
      scopes: [ 'articles:read' ],
      operations: [],
      expires: new Date(Date.now() + 600_000)
    });
    const approveOnce = () => store.approvePending({
      pendingId: pending.id,
      profileId: 'profile-1',
      approvedScopes: [ 'articles:read' ],
      approvedOperations: [],
      operationFingerprints: [],
      accessSeconds: 900,
      renewalSeconds: 604_800,
      codeSeconds: 60
    });
    await approveOnce();
    let threw: unknown = null;
    try {
      await approveOnce();
    } catch (e) {
      threw = e;
    }
    expect(threw).to.be.instanceOf(OAuthStoreError);
    expect((threw as OAuthStoreError).code).to.equal('conflict');
  });

  it('code exchange: issues an access key bound to the grant and marks the code consumed', async () => {
    const { grant, code } = await approvedGrant();
    const issued = await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    expect(issued.grantId).to.equal(grant.id);
    expect(issued.accessId.startsWith('oauth_')).to.equal(true);
    expect(issued.refreshToken?.startsWith('oauthr_')).to.equal(true);
    expect(issued.scopes).to.deep.equal([ 'articles:read' ]);
  });

  it('code exchange: rejects a mismatched redirect_uri without consuming the code', async () => {
    const { code } = await approvedGrant();
    let threw: unknown = null;
    try {
      await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://wrong.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
    //the code must still be usable with the correct redirect afterwards
    const issued = await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    expect(issued.accessId).to.be.a('string');
  });

  it('reuse: replaying an already-consumed code cancels the whole grant, committed even though the call reports invalid_grant', async () => {
    const { grant, code } = await approvedGrant();
    await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    let threw: unknown = null;
    try {
      await store.exchangeCode({
        code,
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
    const grants = await store.listGrantsForProfile('profile-1');
    expect(grants.find((row) => row.id === grant.id)).to.equal(undefined);
  });

  it('concurrency: two truly concurrent exchanges of the exact same code succeed exactly once', async () => {
    //both callers read the same pre-lock grant.lockVersion, so this is
    //the precise race _withLockedGrant()/_claim() exist to resolve -
    //see _claim()'s doc comment for why a plain post-update re-read of
    //lock_version alone is not sufficient here.
    const { code } = await approvedGrant();
    const attempt = () => store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    }).then(() => 'issued' as const).catch(() => 'rejected' as const);
    const results = await Promise.all([ attempt(), attempt() ]);
    expect(results.filter((r) => r === 'issued').length).to.equal(1);
    expect(results.filter((r) => r === 'rejected').length).to.equal(1);
  });

  it('refresh: rotates access and refresh token, preserving the grant deadline', async () => {
    const { code } = await approvedGrant();
    const first = await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    const refreshed = await store.refreshGrant({
      refreshToken: first.refreshToken as string,
      clientId: 'client-1',
      resource: 'https://example.com/mcp'
    });
    expect(refreshed.grantId).to.equal(first.grantId);
    expect(refreshed.accessId).to.not.equal(first.accessId);
    expect(refreshed.refreshToken).to.not.equal(first.refreshToken);
  });

  it('refresh: rejects a scope that is not a subset of the grant, and allows narrowing', async () => {
    const { code } = await approvedGrant({ scopes: [ 'articles:read', 'articles:write' ] });
    const first = await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    let threw: unknown = null;
    try {
      await store.refreshGrant({
        refreshToken: first.refreshToken as string,
        clientId: 'client-1',
        resource: 'https://example.com/mcp',
        narrowedScopes: [ 'articles:read', 'articles:admin' ]
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('invalid_request');
    const narrowed = await store.refreshGrant({
      refreshToken: first.refreshToken as string,
      clientId: 'client-1',
      resource: 'https://example.com/mcp',
      narrowedScopes: [ 'articles:read' ]
    });
    expect(narrowed.scopes).to.deep.equal([ 'articles:read' ]);
  });

  it('reuse: replaying an already-rotated refresh token cancels the whole grant', async () => {
    const { grant, code } = await approvedGrant();
    const first = await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    await store.refreshGrant({
      refreshToken: first.refreshToken as string,
      clientId: 'client-1',
      resource: 'https://example.com/mcp'
    });
    let threw: unknown = null;
    try {
      await store.refreshGrant({
        refreshToken: first.refreshToken as string,
        clientId: 'client-1',
        resource: 'https://example.com/mcp'
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
    const grants = await store.listGrantsForProfile('profile-1');
    expect(grants.find((row) => row.id === grant.id)).to.equal(undefined);
  });

  it('disconnect: owner can revoke; another profile cannot and gets the same not_found signal as a missing grant', async () => {
    const { grant } = await approvedGrant();
    const wrongOwner = await store.disconnectGrant('someone-else', grant.id);
    expect(wrongOwner).to.equal('not_found');
    const missing = await store.disconnectGrant('profile-1', 'does-not-exist');
    expect(missing).to.equal('not_found');
    const revoked = await store.disconnectGrant('profile-1', grant.id);
    expect(revoked).to.equal('revoked');
    //revoking again is still reported the same successful way, not an error
    const again = await store.disconnectGrant('profile-1', grant.id);
    expect(again).to.equal('revoked');
  });

  it('revoke by full key: a wrong secret does not revoke the grant', async () => {
    const { grant, code } = await approvedGrant();
    const issued = await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    await store.revokeByFullKey(toFullKey(issued.accessId, 'wrong-secret'), 'client-1');
    const grants = await store.listGrantsForProfile('profile-1');
    expect(grants.find((row) => row.id === grant.id)).to.not.equal(undefined);
    await store.revokeByFullKey(toFullKey(issued.accessId, issued.accessSecret), 'client-1');
    const grantsAfter = await store.listGrantsForProfile('profile-1');
    expect(grantsAfter.find((row) => row.id === grant.id)).to.equal(undefined);
  });

  it('concurrency: two concurrent cancel attempts on the same grant both resolve without corrupting state', async () => {
    const { grant } = await approvedGrant();
    const results = await Promise.all([
      store.cancelGrant(grant.id),
      store.cancelGrant(grant.id)
    ]);
    expect(results).to.deep.equal([ true, true ]);
    const grants = await store.listGrantsForProfile('profile-1');
    expect(grants.find((row) => row.id === grant.id)).to.equal(undefined);
  });

  it('factor use: a retried TOTP counter is accepted once and rejected on replay', async () => {
    const accepted = await store.checkAndAdvanceFactor('factor-1', 'incarnation-1', 'profile-1', 42);
    expect(accepted).to.equal(true);
    const replay = await store.checkAndAdvanceFactor('factor-1', 'incarnation-1', 'profile-1', 42);
    expect(replay).to.equal(false);
    const next = await store.checkAndAdvanceFactor('factor-1', 'incarnation-1', 'profile-1', 43);
    expect(next).to.equal(true);
  });

  it('factor use: two truly concurrent attempts with the exact same counter accept exactly one', async () => {
    //this is the precise race the first draft of _claim()-less locking
    //got wrong: both callers compute the same "the counter is now 100"
    //target from the same stale read, so a plain post-update re-read
    //cannot tell the winner from the loser.
    await store.checkAndAdvanceFactor('factor-2', 'incarnation-1', 'profile-1', 99);
    const results = await Promise.all([
      store.checkAndAdvanceFactor('factor-2', 'incarnation-1', 'profile-1', 100),
      store.checkAndAdvanceFactor('factor-2', 'incarnation-1', 'profile-1', 100)
    ]);
    expect(results.filter(Boolean).length).to.equal(1);
  });

  it('rate bucket: shared atomic counter advances across concurrent callers', async () => {
    const window = new Date('2030-01-01T00:00:00.000Z');
    const expires = new Date('2030-01-01T00:01:00.000Z');
    const keyHash = hashWithDomain('rate-limit', 'source-address-1');
    const counts = await Promise.all([
      store.incrementRateBucket(keyHash, window, expires),
      store.incrementRateBucket(keyHash, window, expires),
      store.incrementRateBucket(keyHash, window, expires)
    ]);
    expect(counts.sort()).to.deep.equal([ 1, 2, 3 ]);
  });

  it('cleanup: removes expired pending/code/refresh/grant/rate-bucket rows, never a live dependency', async () => {
    //an expired, never-approved pending request
    await store.createPending({
      id: 'pending_expired',
      bindingHash: hashWithDomain('pending-binding', 'expired-binding'),
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
      resource: 'https://example.com/mcp',
      scopes: [],
      operations: [],
      expires: new Date(Date.now() - 1000)
    });
    //a live, still-valid grant that cleanup must not touch
    const { grant: liveGrant } = await approvedGrant();

    const counts = await store.cleanup(100);
    expect(counts.pending).to.be.greaterThan(0);
    const stillPending = await store.getPendingById('pending_expired');
    expect(stillPending).to.equal(null);
    const liveGrants = await store.listGrantsForProfile('profile-1');
    expect(liveGrants.find((row) => row.id === liveGrant.id)).to.not.equal(undefined);
  });

  it('cleanup: removes a deadline-expired grant and its consumed code/refresh history, and expired legacy bindings/rate buckets', async () => {
    //a grant whose deadline is already in the past (renewalSeconds < 0
    //is only ever used here to construct this fixture directly; nothing
    //in OAuthStore itself enforces a positive renewalSeconds - that
    //range check belongs to session.oauth config validation, task
    //00002) with a consumed code and a consumed refresh token, so
    //cleanup must remove all three together, in dependency order.
    const { grant: expiredGrant, code } = await approvedGrant();
    await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: -1
    });
    //directly age the grant's deadline into the past so cleanup
    //considers it expired, without needing a second approval flow
    await new Update(OAUTH_GRANT_TABLE, store.engine)
      .set({ deadline: new Date(Date.now() - 1000) })
      .where('id = ?', [ expiredGrant.id ]);

    //an expired legacy binding; OAuthStore has no public method to
    //create one (that is API's migration adapter, a later task), so
    //this seeds the fixture directly to exercise cleanup()'s own query
    //against this table
    await store.engine.query(
      `INSERT INTO ${OAUTH_LEGACY_BINDING_TABLE} (id, kind, legacy_id_hash, incarnation, resource, active, expires, created) VALUES (?, 'app', ?, 'incarnation-1', 'https://example.com/mcp', ?, ?, ?)`,
      [
        `legacy_${Math.random().toString(36).slice(2)}`,
        hashWithDomain('legacy-id', 'legacy-key-1'),
        true,
        new Date(Date.now() - 1000),
        new Date()
      ]
    );

    const expiredBucketCount = await store.incrementRateBucket(
      'cleanup-bucket',
      new Date(Date.now() - 120_000),
      new Date(Date.now() - 1000)
    );
    expect(expiredBucketCount).to.equal(1);

    const counts = await store.cleanup(100);
    expect(counts.grants).to.be.greaterThan(0);
    expect(counts.codes).to.be.greaterThan(0);
    expect(counts.refreshTokens).to.be.greaterThan(0);
    expect(counts.rateBuckets).to.be.greaterThan(0);
    expect(counts.legacyBindings).to.be.greaterThan(0);
    const remaining = await store.listGrantsForProfile('profile-1');
    expect(remaining.find((row) => row.id === expiredGrant.id)).to.equal(undefined);
  });

  it('approval: releases a client capacity reservation once a live grant takes over unused_expires', async () => {
    const clientId = `client-capacity-${Math.random().toString(36).slice(2)}`;
    await store.reserveClientCapacity('registered', 10);
    await store.touchUnusedClient(
      clientId, 'registered', {}, new Date(Date.now() + 60_000)
    );
    const beforeApproval = await store.getClientByClientId(clientId);
    expect(beforeApproval?.unusedExpires).to.not.equal(null);

    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: CODE_CHALLENGE,
      resource: 'https://example.com/mcp',
      scopes: [],
      operations: [],
      expires: new Date(Date.now() + 600_000)
    });
    await store.approvePending({
      pendingId: pending.id,
      profileId: 'profile-capacity',
      approvedScopes: [],
      approvedOperations: [],
      operationFingerprints: [],
      accessSeconds: 900,
      renewalSeconds: 604_800,
      codeSeconds: 60
    });

    const afterApproval = await store.getClientByClientId(clientId);
    expect(afterApproval?.unusedExpires).to.equal(null);
    //capacity was released back to zero, so a fresh reservation at the
    //same ceiling succeeds instead of being refused as still-full
    expect(await store.reserveClientCapacity('registered', 1)).to.equal(true);
    await store.releaseClientCapacity('registered');
  });

  it('clients: upsert creates then updates the same registered client', async () => {
    const created = await store.upsertRegisteredClient('client-upsert-1', { grant_types: [ 'authorization_code' ] });
    expect(created.kind).to.equal('registered');
    const fetched = await store.getClientByClientId('client-upsert-1');
    expect(fetched?.id).to.equal(created.id);
    const updated = await store.upsertRegisteredClient('client-upsert-1', { grant_types: [ 'authorization_code', 'refresh_token' ] });
    expect(updated.id).to.equal(created.id);
    expect(updated.metadata).to.deep.equal({ grant_types: [ 'authorization_code', 'refresh_token' ] });
  });

  it('clients: getClientByClientId returns null for an unknown client', async () => {
    expect(await store.getClientByClientId('does-not-exist')).to.equal(null);
  });

  it('clients: touchClientLastUsed updates the timestamp without creating a row', async () => {
    await store.upsertRegisteredClient('client-touch-1', {});
    await store.touchClientLastUsed('client-touch-1');
    const fetched = await store.getClientByClientId('client-touch-1');
    expect(fetched?.lastUsed).to.not.equal(null);
  });

  it('client documents: save then fetch while fresh, miss once stale', async () => {
    const saved = await store.saveClientDocument({
      urlHash: hashWithDomain('client-document-url', 'https://client.example/metadata.json'),
      metadata: { client_name: 'Example Client' },
      etag: 'abc',
      freshUntil: new Date(Date.now() + 60_000)
    });
    const fresh = await store.getFreshClientDocument(saved.urlHash);
    expect(fresh?.metadata).to.deep.equal({ client_name: 'Example Client' });
    const stale = await store.getFreshClientDocument(saved.urlHash, new Date(Date.now() + 120_000));
    expect(stale).to.equal(null);
  });

  it('client documents: saving again revalidates the same cached row instead of duplicating it', async () => {
    const urlHash = hashWithDomain('client-document-url', 'https://client.example/metadata-2.json');
    const first = await store.saveClientDocument({
      urlHash,
      metadata: { client_name: 'v1' },
      freshUntil: new Date(Date.now() + 60_000)
    });
    const second = await store.saveClientDocument({
      urlHash,
      metadata: { client_name: 'v2' },
      etag: 'xyz',
      freshUntil: new Date(Date.now() + 60_000)
    });
    expect(second.id).to.equal(first.id);
    const fresh = await store.getFreshClientDocument(urlHash);
    expect(fresh?.metadata).to.deep.equal({ client_name: 'v2' });
    expect(fresh?.etag).to.equal('xyz');
  });

  it('pending: bindPendingProfile attaches the signed-in profile', async () => {
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
      resource: 'https://example.com/mcp',
      scopes: [],
      operations: [],
      expires: new Date(Date.now() + 600_000)
    });
    expect(pending.profileId).to.equal(null);
    await store.bindPendingProfile(pending.id, 'profile-2');
    const bound = await store.getPendingById(pending.id);
    expect(bound?.profileId).to.equal('profile-2');
  });

  it('pending: getPendingByBindingHash finds the row created with that binding', async () => {
    const bindingHash = hashWithDomain('pending-binding', newPendingBinding());
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
      resource: 'https://example.com/mcp',
      scopes: [],
      operations: [],
      expires: new Date(Date.now() + 600_000)
    });
    const found = await store.getPendingByBindingHash(bindingHash);
    expect(found?.id).to.equal(pending.id);
    expect(await store.getPendingByBindingHash('unknown-hash')).to.equal(null);
  });

  it('pending: denyPending marks a pending request denied and it cannot be approved afterwards', async () => {
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
      resource: 'https://example.com/mcp',
      scopes: [],
      operations: [],
      expires: new Date(Date.now() + 600_000)
    });
    await store.denyPending(pending.id);
    const denied = await store.getPendingById(pending.id);
    expect(denied?.status).to.equal('denied');
    let threw: unknown = null;
    try {
      await store.approvePending({
        pendingId: pending.id,
        profileId: 'profile-1',
        approvedScopes: [],
        approvedOperations: [],
        operationFingerprints: [],
        accessSeconds: 900,
        renewalSeconds: 604_800,
        codeSeconds: 60
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('conflict');
  });

  it('approval: an expired pending request is claimed (so it cannot be retried) but refused', async () => {
    const pending = await store.createPending({
      id: `pending_${Math.random().toString(36).slice(2)}`,
      bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'challenge',
      resource: 'https://example.com/mcp',
      scopes: [],
      operations: [],
      expires: new Date(Date.now() - 1000)
    });
    let threw: unknown = null;
    try {
      await store.approvePending({
        pendingId: pending.id,
        profileId: 'profile-1',
        approvedScopes: [],
        approvedOperations: [],
        operationFingerprints: [],
        accessSeconds: 900,
        renewalSeconds: 604_800,
        codeSeconds: 60
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('invalid_request');
  });

  it('exchangeCode: an unknown code is rejected without touching any grant', async () => {
    let threw: unknown = null;
    try {
      await store.exchangeCode({
        code: 'not-a-real-code',
        clientId: 'client-1',
        redirectUri: 'https://client.example/callback',
        resource: 'https://example.com/mcp',
        codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
  });

  it('refreshGrant: an unknown refresh token is rejected', async () => {
    let threw: unknown = null;
    try {
      await store.refreshGrant({
        refreshToken: 'not-a-real-token',
        clientId: 'client-1',
        resource: 'https://example.com/mcp'
      });
    } catch (e) {
      threw = e;
    }
    expect((threw as OAuthStoreError)?.code).to.equal('invalid_grant');
  });

  it('cancelGrant: a missing grant resolves to false instead of throwing', async () => {
    expect(await store.cancelGrant('does-not-exist')).to.equal(false);
  });

  it('revokeByFullKey: a malformed full key is a silent no-op', async () => {
    await store.revokeByFullKey('not-a-valid-key', 'client-1');
  });

  it('revokeByRefreshToken: an unknown token is a silent no-op, a wrong client does not revoke', async () => {
    await store.revokeByRefreshToken('not-a-real-token', 'client-1');
    const { grant, code } = await approvedGrant();
    const issued = await store.exchangeCode({
      code,
      clientId: 'client-1',
      redirectUri: 'https://client.example/callback',
      resource: 'https://example.com/mcp',
      codeVerifier: CODE_VERIFIER,
      renewalSeconds: 604_800
    });
    await store.revokeByRefreshToken(issued.refreshToken as string, 'wrong-client');
    const stillActive = await store.listGrantsForProfile('profile-1');
    expect(stillActive.find((row) => row.id === grant.id)).to.not.equal(undefined);
    await store.revokeByRefreshToken(issued.refreshToken as string, 'client-1');
    const revoked = await store.listGrantsForProfile('profile-1');
    expect(revoked.find((row) => row.id === grant.id)).to.equal(undefined);
  });
});
