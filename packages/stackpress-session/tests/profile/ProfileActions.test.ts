//Real-stack coverage for the existing (previously untested) ProfileActions/
//ProfileStore/profile columns code, part of side task 00007A
//(packages 00007's new browser-page tests pulled this code into the
//package-wide coverage figure for the first time; this file exercises it
//directly instead of only incidentally through OAuth tests).
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import ProfileActions from '../../src/profile/ProfileActions.js';

describe('ProfileActions (PGlite, in-memory, corrected Inquire d5f5a07)', () => {
  const resource = new PGlite();
  const engine = new Engine(new Connection(resource));
  const profiles = new ProfileActions(engine, 'profile-test-seed');

  before(async () => {
    await profiles.install();
  });

  after(async () => {
    await resource.close();
  });

  it('create: rejects a missing name', async () => {
    let error: any;
    try {
      await profiles.create({ type: 'person' });
    } catch (e) {
      error = e;
    }
    expect(error).to.exist;
    expect(error.errors.name).to.exist;
  });

  it('create: fills defaults (id, type, roles, tags, active) and returns the saved row', async () => {
    const profile = await profiles.create({ name: 'Ada Lovelace' });
    expect(profile.id).to.be.a('string').that.is.not.empty;
    expect(profile.name).to.equal('Ada Lovelace');
    expect(profile.type).to.equal('person');
    expect(profile.active).to.equal(true);
    expect(profile.roles).to.be.an('array');
    expect(profile.tags).to.be.an('array');
  });

  it('create: accepts explicit image, roles, tags and references', async () => {
    const profile = await profiles.create({
      name: 'Grace Hopper',
      image: 'https://example.com/avatar.png',
      roles: [ 'ADMIN', 'USER' ],
      tags: [ 'navy', 'compiler' ],
      references: { employeeId: 'E-1' }
    });
    expect(profile.image).to.equal('https://example.com/avatar.png');
    expect(profile.roles).to.deep.equal([ 'ADMIN', 'USER' ]);
    expect(profile.tags).to.deep.equal([ 'navy', 'compiler' ]);
    expect(profile.references).to.deep.equal({ employeeId: 'E-1' });
  });

  it('find/findAll: locates a created profile by id and by name', async () => {
    const created = await profiles.create({ name: 'Margaret Hamilton' });
    const byId = await profiles.find({ eq: { id: created.id } });
    expect(byId?.id).to.equal(created.id);
    const byName = await profiles.findAll({ eq: { name: 'Margaret Hamilton' } });
    expect(byName.length).to.equal(1);
  });

  it('find: returns null for an unknown id', async () => {
    const found = await profiles.find({ eq: { id: 'no-such-profile' } });
    expect(found).to.equal(null);
  });

  it('count: counts matching rows', async () => {
    const before = await profiles.count({ eq: { type: 'person' } });
    await profiles.create({ name: 'Count Target', type: 'person' });
    const after = await profiles.count({ eq: { type: 'person' } });
    expect(after).to.equal(before + 1);
  });

  it('update: changes fields and persists them', async () => {
    const created = await profiles.create({ name: 'Updatable Person' });
    const updated = await profiles.update(
      { eq: { id: created.id } },
      { name: 'Updated Person' }
    );
    expect(updated[0].name).to.equal('Updated Person');
    const row = await profiles.find({ eq: { id: created.id } });
    expect(row?.name).to.equal('Updated Person');
  });

  it('store.assert: a required name failure is reported directly by the schema', () => {
    const errors = profiles.store.assert({ name: '' }, true);
    expect(errors?.name).to.equal('Name is required');
    expect(profiles.store.assert({
      name: 'Ok', type: 'person', roles: [], tags: [],
      active: true, created: new Date(), updated: new Date(),
      id: 'x', image: null, references: {}
    }, true)).to.equal(null);
  });

  it('update: a query matching no rows returns an empty array without error', async () => {
    const result = await profiles.update(
      { eq: { id: 'no-such-profile' } },
      { name: 'Nobody' }
    );
    expect(result).to.deep.equal([]);
  });

  it('remove/restore: toggles active without deleting the row; find hides inactive rows by default', async () => {
    const created = await profiles.create({ name: 'Togglable Person' });
    await profiles.remove({ eq: { id: created.id } });
    //default find() only matches active=true rows (ProfileStore.where's
    //"default active value" rule), so a removed row disappears from an
    //ordinary lookup unless the caller explicitly opts in with active: -1
    const hidden = await profiles.find({ eq: { id: created.id } });
    expect(hidden).to.equal(null);
    const inactive = await profiles.find({ eq: { id: created.id, active: -1 } });
    expect(inactive?.active).to.equal(false);
    await profiles.restore({ eq: { id: created.id, active: -1 } });
    const active = await profiles.find({ eq: { id: created.id } });
    expect(active?.active).to.equal(true);
  });

  it('upsert: creates when no id, updates when id is given', async () => {
    const created = await profiles.upsert({ name: 'Upserted Person' });
    expect(created.name).to.equal('Upserted Person');
    const updated = await profiles.upsert({
      id: created.id,
      name: 'Upserted Person Renamed'
    });
    expect(updated?.name).to.equal('Upserted Person Renamed');
  });

  it('upsert: an id with no matching row still returns null, never throws', async () => {
    const result = await profiles.upsert({ id: 'missing-id', name: 'Ghost' });
    expect(result).to.equal(null);
  });

  it('delete: removes matching rows and returns what was deleted', async () => {
    const created = await profiles.create({ name: 'Deletable Person' });
    const deleted = await profiles.delete({ eq: { id: created.id } });
    expect(deleted.length).to.equal(1);
    const found = await profiles.find({ eq: { id: created.id } });
    expect(found).to.equal(null);
  });

  it('delete: a query matching nothing is a no-op', async () => {
    const deleted = await profiles.delete({ eq: { id: 'no-such-profile' } });
    expect(deleted).to.deep.equal([]);
  });

  it('batch: upsert mode creates several profiles in one transaction', async () => {
    const results = await profiles.batch([
      { name: 'Batch One' },
      { name: 'Batch Two' }
    ], 'create');
    expect(results.length).to.equal(2);
    expect(results.every((r) => r.code === 200)).to.equal(true);
  });

  it('batch: update mode reports an error result for a row with no matching id', async () => {
    const results = await profiles.batch([
      { id: 'missing-batch-id', name: 'Nope' }
    ], 'update');
    expect(results.length).to.equal(1);
    expect(results[0].error).to.exist;
  });

  it('batch: a failing row rolls back the whole create batch', async () => {
    const marker = `batch-rollback-${Math.random().toString(36).slice(2)}`;
    const results = await profiles.batch([
      { name: marker },
      { type: 'person' } //missing required name throws from create()
    ], 'create');
    expect(results.some((r) => r.error)).to.equal(true);
    //the valid row ahead of the failing one must not have been committed
    const survivors = await profiles.findAll({ eq: { name: marker } });
    expect(survivors.length).to.equal(0);
  });

  it('purge then reinstall leaves the table usable', async () => {
    await profiles.purge(true);
    const remaining = await profiles.findAll({});
    expect(remaining.length).to.equal(0);
    //re-seed one row so later suites in the same run (if any) still have data
    await profiles.create({ name: 'Post Purge Person' });
  });
});
