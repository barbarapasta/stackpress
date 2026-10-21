import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Select from '@stackpress/inquire/Select';
import Connection from '@stackpress/inquire-pglite/Connection';
import {
  createOAuthClient,
  createOAuthClientDocument,
  createOAuthPending,
  createOAuthGrant,
  createOAuthCode,
  createOAuthRefreshToken,
  createOAuthLegacyBinding,
  createOAuthFactorUse,
  createOAuthRateBucket
} from '../../src/oauth/storage/tables.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';

//Found during task 00011's real-generated-store verification: `oauth.idea`
//only declares storage.md's nine named models, so `yarn generate`/`push`/
//`migrate` never create the private `oauth_client_capacity` counter table
//task 00004 added. Every prior task's own tests always called
//`createAllOAuthTables()` in their own setup, which includes the capacity
//table, so this gap never surfaced until a real generated app's database
//was checked directly. This suite deliberately creates every table
//*except* the capacity one - mirroring exactly what `yarn generate`+
//`yarn push`/`yarn migrate` leave behind in a real app - and proves
//`OAuthStore` now self-heals instead of throwing a raw "table does not
//exist" error on the very first client introduction.
describe('OAuthStore capacity table self-bootstrap (missing-table production gap)', () => {
  const resource = new PGlite();
  const connection = new Connection(resource);
  const engine = new Engine(connection);

  before(async () => {
    const createsWithoutCapacity = [
      createOAuthClient(),
      createOAuthClientDocument(),
      createOAuthPending(),
      createOAuthGrant(),
      createOAuthCode(),
      createOAuthRefreshToken(),
      createOAuthLegacyBinding(),
      createOAuthFactorUse(),
      createOAuthRateBucket()
    ];
    for (const create of createsWithoutCapacity) {
      create.engine = engine;
      await create;
    }
  });

  after(async () => {
    await resource.close();
  });

  it('confirms the capacity table does not exist yet (same gap a real generated+pushed app has)', async () => {
    let threw = false;
    try {
      await new Select('*', engine).from('oauth_client_capacity').limit(1);
    } catch (e) {
      threw = true;
    }
    expect(threw).to.equal(true);
  });

  it('reserveClientCapacity self-creates the missing table on first use instead of throwing', async () => {
    const store = new OAuthStore(engine);
    const granted = await store.reserveClientCapacity('document', 5);
    expect(granted).to.equal(true);
    const rows = await new Select<Record<string, unknown>>('*', engine)
      .from('oauth_client_capacity')
      .where('id = ?', [ 'document' ]);
    expect(rows).to.deep.equal([ { id: 'document', count: 1, lock_token: null } ]);
  });

  it('a second store instance against the same already-created table is unaffected (idempotent CREATE)', async () => {
    const store = new OAuthStore(engine);
    const granted = await store.reserveClientCapacity('registered', 5);
    expect(granted).to.equal(true);
  });

  it('releaseClientCapacity also self-heals when called first, on a fresh table-less engine', async () => {
    const resource2 = new PGlite();
    const connection2 = new Connection(resource2);
    const engine2 = new Engine(connection2);
    const creates = [
      createOAuthClient(), createOAuthClientDocument(), createOAuthPending(),
      createOAuthGrant(), createOAuthCode(), createOAuthRefreshToken(),
      createOAuthLegacyBinding(), createOAuthFactorUse(), createOAuthRateBucket()
    ];
    for (const create of creates) {
      create.engine = engine2;
      await create;
    }
    const store2 = new OAuthStore(engine2);
    //no throw, even though nothing reserved anything yet on this engine
    await store2.releaseClientCapacity('document');
    const rows = await new Select('*', engine2).from('oauth_client_capacity');
    expect(Array.isArray(rows)).to.equal(true);
    await resource2.close();
  });
});
