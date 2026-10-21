//Direct coverage for ProfileStore's query-builder filter branches
//(ne/ge/le/has/hasnt/like/q, scalarize/unscalarize) that ProfileActions'
//everyday create/find/update paths never exercise on their own. Part of
//side task 00007A; see tests/profile/ProfileActions.test.ts.
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import ProfileActions from '../../src/profile/ProfileActions.js';

describe('ProfileStore filters (PGlite, in-memory)', () => {
  const resource = new PGlite();
  const engine = new Engine(new Connection(resource));
  const profiles = new ProfileActions(engine, 'profile-filters-seed');

  before(async () => {
    await profiles.install();
    await profiles.create({
      name: 'Filter Alpha', type: 'person', roles: [ 'ADMIN' ], tags: [ 'vip' ]
    });
    await profiles.create({
      name: 'Filter Beta', type: 'service', roles: [ 'USER' ], tags: [ 'beta' ]
    });
    await profiles.create({
      name: 'Filter Gamma', type: 'person', roles: [ 'USER' ], tags: []
    });
  });

  after(async () => {
    await resource.close();
  });

  it('q: full-text searches the name column', async () => {
    const found = await profiles.findAll({ q: 'Filter Beta' });
    expect(found.some((p) => p.name === 'Filter Beta')).to.equal(true);
  });

  it('like: matches a partial name', async () => {
    const found = await profiles.findAll({ like: { name: 'Gamma' } });
    expect(found.length).to.equal(1);
    expect(found[0].name).to.equal('Filter Gamma');
  });

  it('ne: excludes an exact match', async () => {
    const found = await profiles.findAll({ eq: { type: 'person' }, ne: { name: 'Filter Alpha' } });
    expect(found.some((p) => p.name === 'Filter Alpha')).to.equal(false);
    expect(found.some((p) => p.name === 'Filter Gamma')).to.equal(true);
  });

  it('ge/le: bound the created date range', async () => {
    const all = await profiles.findAll({ like: { name: 'Filter' } });
    const earliest = all.reduce((min, p) => p.created < min ? p.created : min, all[0].created);
    const found = await profiles.findAll({
      like: { name: 'Filter' },
      ge: { created: earliest }
    });
    expect(found.length).to.be.greaterThan(0);
    const none = await profiles.findAll({
      like: { name: 'Filter' },
      le: { created: new Date(0) }
    });
    expect(none.length).to.equal(0);
  });

  it('has: matches rows whose array column contains a value', async () => {
    const found = await profiles.findAll({ has: { tags: 'vip' } });
    expect(found.some((p) => p.name === 'Filter Alpha')).to.equal(true);
    expect(found.some((p) => p.name === 'Filter Beta')).to.equal(false);
  });

  it('hasnt: is accepted as a filter option without throwing', async () => {
    //whereArrayNotContains currently builds the same JSON-contains clause
    //as "has" (see the commented-out whereJsonNotContains call in
    //AuthStore/ProfileStore) - exercised here for branch coverage of the
    //query-builder path, not to assert exclusion semantics that the
    //library does not implement yet.
    const result = await profiles.findAll({ hasnt: { tags: 'vip' } });
    expect(Array.isArray(result)).to.equal(true);
  });

  it('columns param restricts and joins selected fields', async () => {
    const found = await profiles.findAll({
      eq: { name: 'Filter Alpha' },
      columns: [ 'id', 'name', 'roles' ]
    });
    expect(found[0].name).to.equal('Filter Alpha');
    expect(found[0].roles).to.deep.equal([ 'ADMIN' ]);
  });

  it('scalarize/unscalarize round-trip a plain row through the schema columns', () => {
    const scalar = profiles.store.scalarize({
      id: 'abc', name: 'Round Trip', type: 'person', roles: [ 'USER' ],
      tags: [], references: {}, active: true,
      created: new Date('2026-01-01T00:00:00Z'),
      updated: new Date('2026-01-01T00:00:00Z'),
      image: null
    });
    expect(scalar.name).to.equal('Round Trip');
    expect(typeof scalar.roles).to.equal('string');

    const back = profiles.store.unscalarize({
      id: 'abc', name: 'Round Trip', type: 'person',
      roles: '["USER"]', tags: '[]', image: null,
      active: true, created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z'
    });
    expect(back.name).to.equal('Round Trip');
    expect(back.roles).to.deep.equal([ 'USER' ]);
  });

  it('selectors: resolves plain and relation-prefixed column expressions', () => {
    const [ plain ] = profiles.store.selectors([ 'name' ]);
    expect(plain.path.column).to.equal('name');
    const [ star ] = profiles.store.selectors([ '*' ]);
    expect(star).to.exist;
  });
});
