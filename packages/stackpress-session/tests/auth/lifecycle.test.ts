//Coverage for the existing (previously untested) install/upgrade/uninstall
//schema-lifecycle methods on AuthActions/ProfileActions, which no other
//suite calls since they build/drop the table itself. Part of side task
//00007A. Uses its own disposable engine so it never interferes with the
//shared-table suites in AuthActions.test.ts/ProfileActions.test.ts.
import { describe, it, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import AuthActions from '../../src/auth/AuthActions.js';

describe('AuthActions/ProfileActions schema lifecycle (install/upgrade/uninstall)', () => {
  const resource = new PGlite();
  const engine = new Engine(new Connection(resource));
  const auths = new AuthActions(engine, { seed: 'lifecycle-seed' });

  after(async () => {
    await resource.close();
  });

  it('profile: install, upgrade against its own current shape (no-op alter), then uninstall/reinstall', async () => {
    await auths.profile.install();
    const created = await auths.profile.create({ name: 'Lifecycle Person' });
    expect(created.id).to.be.a('string');

    //alter() compares "from" (current table) against "to" (target); passing
    //the store's own create() definition exercises the field-diff loop with
    //a stable, always-valid target instead of hand-rolling one. Comparing a
    //table against itself has no column differences, so Inquire's dialect
    //refuses to run an empty ALTER - that rejection happens after the
    //field-diff loop already ran, which is the part this test covers.
    let noopAlterRejected = false;
    try {
      await auths.profile.upgrade(auths.profile.store.create());
    } catch (e: any) {
      noopAlterRejected = /No alterations made/.test(String(e?.message || e));
    }
    expect(noopAlterRejected).to.equal(true);

    await auths.profile.uninstall();
    await auths.profile.install();
    const after = await auths.profile.find({ eq: { id: created.id } });
    expect(after).to.equal(null); //dropped with the table
  });

  it('auth: install, upgrade against its own current shape (no-op alter), then uninstall/reinstall', async () => {
    await auths.install();
    const profile = await auths.profile.create({ name: 'Lifecycle Owner' });
    const created = await auths.create({
      profileId: profile.id, type: 'username', token: 'lifecycle-token', secret: 'Password1!'
    });
    expect(created.id).to.be.a('string');

    let noopAlterRejected = false;
    try {
      await auths.upgrade(auths.store.create());
    } catch (e: any) {
      noopAlterRejected = /No alterations made/.test(String(e?.message || e));
    }
    expect(noopAlterRejected).to.equal(true);

    await auths.uninstall();
    await auths.install();
    const after = await auths.find({ eq: { id: created.id } });
    expect(after).to.equal(null);
  });

  it('alter(): with no target returns an empty Alter for the current table', () => {
    const alter = auths.store.alter();
    expect(alter).to.exist;
    const profileAlter = auths.profile.store.alter();
    expect(profileAlter).to.exist;
  });
});
