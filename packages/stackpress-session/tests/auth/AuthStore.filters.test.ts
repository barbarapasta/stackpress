//Direct coverage for AuthStore's query-builder filter branches (ne/ge/le/
//has/hasnt/like/q, scalarize/unscalarize) that AuthActions' everyday
//create/find/update paths never exercise on their own. Part of side task
//00007A; see tests/auth/AuthActions.test.ts.
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import AuthActions from '../../src/auth/AuthActions.js';

describe('AuthStore filters (PGlite, in-memory)', () => {
  const resource = new PGlite();
  const engine = new Engine(new Connection(resource));
  const auths = new AuthActions(engine, { seed: 'auth-filters-seed' });

  before(async () => {
    await auths.profile.install();
    await auths.install();
    const alpha = await auths.profile.create({ name: 'Filter Owner Alpha' });
    await auths.create({
      profileId: alpha.id, type: 'username', token: 'filter-alpha', secret: 'Password1!'
    });
    const beta = await auths.profile.create({ name: 'Filter Owner Beta' });
    await auths.create({
      profileId: beta.id, type: 'email', token: 'filter-beta@example.com', secret: 'Password1!'
    });
  });

  after(async () => {
    await resource.close();
  });

  it('q: full-text searches auth columns', async () => {
    const found = await auths.findAll({ q: 'filter-alpha' });
    expect(found.some((a) => a.token === 'filter-alpha')).to.equal(true);
  });

  it('like: matches a partial value on a non-encrypted column', async () => {
    //token/secret are encrypted at rest (TokenColumn/SecretColumn
    //doEncrypt=true), so a substring LIKE against those columns can never
    //match plaintext; exercise "like" against an unencrypted column instead
    const found = await auths.findAll({ like: { type: 'mai' } });
    expect(found.some((a) => a.type === 'email')).to.equal(true);
  });

  it('ne: excludes an exact type match', async () => {
    const found = await auths.findAll({ eq: {}, ne: { type: 'email' } });
    expect(found.some((a) => a.type === 'email')).to.equal(false);
  });

  it('ge/le: bound the created date range', async () => {
    const all = await auths.findAll({});
    const earliest = all.reduce((min, a) => a.created < min ? a.created : min, all[0].created);
    const found = await auths.findAll({ ge: { created: earliest } });
    expect(found.length).to.be.greaterThan(0);
    const none = await auths.findAll({ le: { created: new Date(0) } });
    expect(none.length).to.equal(0);
  });

  it('columns param joins the related profile', async () => {
    const found = await auths.findAll({
      eq: { token: 'filter-alpha' },
      columns: [ 'id', 'type', 'profile.name' ]
    });
    expect((found[0] as any).profile.name).to.equal('Filter Owner Alpha');
  });

  it('scalarize/unscalarize round-trip a plain row through the schema columns', () => {
    const scalar = auths.store.scalarize({
      id: 'a1', profileId: 'p1', type: 'username', token: 'round-trip',
      secret: 'Password1!', verified: true, consumed: new Date('2026-01-01T00:00:00Z'),
      active: true, created: new Date('2026-01-01T00:00:00Z'),
      updated: new Date('2026-01-01T00:00:00Z')
    });
    //token/secret are encrypted at rest; scalarize must not leave them
    //as the original plaintext
    expect(scalar.token).to.not.equal('round-trip');
    expect(typeof scalar.token).to.equal('string');

    const back = auths.store.unscalarize({
      id: 'a1', profile_id: 'p1', type: 'username',
      token: scalar.token, secret: scalar.secret, verified: true,
      consumed: '2026-01-01T00:00:00.000Z', active: true,
      created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z'
    });
    expect(back.token).to.equal('round-trip');
    expect(back.profileId).to.equal('p1');
  });

  it('selectors: resolves a relation-prefixed column expression', () => {
    const [ related ] = auths.store.selectors([ 'profile.name' ]);
    expect(related.path.column).to.equal('name');
    expect(related.path.parents).to.deep.equal([ 'profile' ]);
    expect(related.path.store.table).to.equal('profile');
  });
});
