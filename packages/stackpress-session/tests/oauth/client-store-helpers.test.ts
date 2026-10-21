import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { hashWithDomain } from '../../src/oauth/storage/ids.js';

//Real-database coverage (PGlite) for the three OAuthStore additions
//task 00004 needed: document-cache revalidation reads regardless of
//freshness, and the shared unused-client capacity/touch primitives for
//both document and registered client identities. The in-memory fake
//stores in client-document.test.ts/client-register.test.ts exercise the
//calling contract; this file proves the same methods actually round-trip
//through a real adapter.
describe('OAuthStore client-registration/document helpers (PGlite, corrected Inquire d5f5a07)', () => {
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine = new Engine(connection);
  const store = new OAuthStore(engine);

  before(async () => {
    for (const create of createAllOAuthTables()) {
      create.engine = engine;
      await create;
    }
  });

  after(async () => {
    await resource.close();
  });

  it('getClientDocumentByUrlHash returns a stale row that getFreshClientDocument would miss', async () => {
    const urlHash = hashWithDomain('client-document-url', 'https://doc.example/metadata.json');
    const now = new Date();
    await store.saveClientDocument({
      urlHash,
      metadata: { client_id: 'https://doc.example/metadata.json' },
      etag: '"v1"',
      freshUntil: new Date(now.getTime() - 1000),
      now
    });
    expect(await store.getFreshClientDocument(urlHash, now)).to.equal(null);
    const stale = await store.getClientDocumentByUrlHash(urlHash);
    expect(stale).to.not.equal(null);
    expect(stale!.etag).to.equal('"v1"');
  });

  it('returns null for an unknown document url hash', async () => {
    expect(await store.getClientDocumentByUrlHash('no-such-hash')).to.equal(null);
  });

  it('touchUnusedClient creates then refreshes the same client identity', async () => {
    const now = new Date();
    const created = await store.touchUnusedClient(
      'oauthreg_abc', 'registered', { grant_types: [ 'authorization_code' ] },
      new Date(now.getTime() + 60_000), now
    );
    expect(created.kind).to.equal('registered');
    expect(created.unusedExpires?.getTime()).to.equal(new Date(now.getTime() + 60_000).getTime());

    const later = new Date(now.getTime() + 1000);
    const refreshed = await store.touchUnusedClient(
      'oauthreg_abc', 'registered', { grant_types: [ 'authorization_code', 'refresh_token' ] },
      new Date(later.getTime() + 60_000), later
    );
    expect(refreshed.id).to.equal(created.id);
    expect(refreshed.metadata).to.deep.equal({ grant_types: [ 'authorization_code', 'refresh_token' ] });
  });

  it('countUnusedClients counts only the matching kind with an unexpired deadline, per issuer-wide identity set', async () => {
    const now = new Date();
    const before = await store.countUnusedClients('document', now);
    await store.touchUnusedClient(
      'https://doc.example/count-a.json', 'document', {}, new Date(now.getTime() + 60_000), now
    );
    await store.touchUnusedClient(
      'https://doc.example/count-b.json', 'document', {}, new Date(now.getTime() - 1000), now
    );
    const after = await store.countUnusedClients('document', now);
    expect(after).to.equal(before + 1);
    //a different kind is not double-counted into the same bucket
    const registeredCount = await store.countUnusedClients('registered', now);
    await store.touchUnusedClient(
      'oauthreg_isolated', 'registered', {}, new Date(now.getTime() + 60_000), now
    );
    expect(await store.countUnusedClients('document', now)).to.equal(after);
    expect(await store.countUnusedClients('registered', now)).to.equal(registeredCount + 1);
  });
});
