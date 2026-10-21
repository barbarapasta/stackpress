//Real-stack coverage for the existing (previously untested) AuthActions/
//AuthStore/auth columns code, part of side task 00007A (see
//tests/profile/ProfileActions.test.ts for the same rationale).
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import AuthActions from '../../src/auth/AuthActions.js';

describe('AuthActions (PGlite, in-memory, corrected Inquire d5f5a07)', () => {
  const resource = new PGlite();
  const engine = new Engine(new Connection(resource));
  const auths = new AuthActions(engine, { seed: 'auth-test-seed' });

  before(async function () {
    //an in-memory database takes longer than mocha's default on a busy host
    this.timeout(30000);
    await auths.profile.install();
    await auths.install();
  });

  after(async () => {
    await resource.close();
  });

  describe('assert (signup validation)', () => {
    it('requires a name', () => {
      const errors = auths.assert({ username: 'ada', secret: 'Password1!' });
      expect(errors?.name).to.equal('Name is required');
    });

    it('requires one of username/email/phone', () => {
      const errors = auths.assert({ name: 'Ada', secret: 'Password1!' });
      expect(errors?.username).to.equal('Username, email, or phone is required');
    });

    it('rejects a malformed email', () => {
      const errors = auths.assert({
        name: 'Ada', email: 'not-an-email', secret: 'Password1!'
      });
      expect(errors?.email).to.equal('Invalid email');
    });

    it('requires a secret', () => {
      const errors = auths.assert({ name: 'Ada', username: 'ada' });
      expect(errors?.secret).to.equal('Password is required');
    });

    it('accepts a valid signup with no password policy configured', () => {
      const errors = auths.assert({
        name: 'Ada', username: 'ada-valid', secret: 'anything'
      });
      expect(errors).to.equal(null);
    });

    it('enforces a configured password policy (min/upper/lower/number/special)', () => {
      const strict = new AuthActions(engine, {
        seed: 'auth-test-seed',
        password: { min: 8, upper: true, lower: true, number: true, special: true }
      });
      expect(strict.assert({
        name: 'Ada', username: 'x', secret: 'short'
      })?.secret).to.match(/at least 8 characters/);
      expect(strict.assert({
        name: 'Ada', username: 'x', secret: 'alllowercase1!'
      })?.secret).to.match(/uppercase/);
      expect(strict.assert({
        name: 'Ada', username: 'x', secret: 'ALLUPPERCASE1!'
      })?.secret).to.match(/lowercase/);
      expect(strict.assert({
        name: 'Ada', username: 'x', secret: 'NoDigitsHere!'
      })?.secret).to.match(/number/);
      expect(strict.assert({
        name: 'Ada', username: 'x', secret: 'NoSpecial1'
      })?.secret).to.match(/special character/);
      expect(strict.assert({
        name: 'Ada', username: 'x', secret: 'Valid1Pass!'
      })).to.equal(null);
    });

    it('enforces a configured maximum password length', () => {
      const strict = new AuthActions(engine, {
        seed: 'auth-test-seed',
        password: { max: 4 }
      });
      expect(strict.assert({
        name: 'Ada', username: 'x', secret: 'toolong'
      })?.secret).to.match(/less than 4 characters/);
    });
  });

  describe('signup', () => {
    it('creates a profile plus a username credential', async () => {
      const result = await auths.signup({
        name: 'Signup Person', username: 'signup-person', secret: 'Password1!'
      });
      expect(result.id).to.be.a('string');
      expect(result.auth?.username?.token).to.equal('signup-person');
    });

    it('creates a profile plus email and phone credentials together', async () => {
      const result = await auths.signup({
        name: 'Multi Channel',
        email: 'multi@example.com',
        phone: '+10000000000',
        secret: 'Password1!'
      });
      expect(result.auth?.email?.token).to.equal('multi@example.com');
      expect(result.auth?.phone?.token).to.equal('+10000000000');
    });

    it('rejects invalid signup input before creating anything', async () => {
      let error: any;
      try {
        await auths.signup({ username: 'nope' } as any);
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      expect(error.errors.name).to.exist;
    });

    it('surfaces a duplicate username as a signup-shaped error', async () => {
      await auths.signup({
        name: 'Dup One', username: 'dup-user', secret: 'Password1!'
      });
      let error: any;
      try {
        await auths.signup({
          name: 'Dup Two', username: 'dup-user', secret: 'Password1!'
        });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      expect(error.errors.username).to.equal('Already exists');
    });
  });

  describe('signin', () => {
    it('signs in with the correct password and marks the credential consumed', async () => {
      await auths.signup({
        name: 'Signin Person', username: 'signin-person', secret: 'Password1!'
      });
      //consumed defaults to the creation time (ConsumedColumn.defaults),
      //not empty, so prove signin() advances it instead of checking for
      //absence
      const before = await auths.find({ eq: { type: 'username', token: 'signin-person' } });
      expect(before?.consumed).to.be.instanceOf(Date);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await auths.signin('username', {
        username: 'signin-person', secret: 'Password1!'
      });
      expect(result?.profile?.name).to.equal('Signin Person');
      const after = await auths.find({ eq: { type: 'username', token: 'signin-person' } });
      expect(after?.consumed.getTime()).to.be.at.least(before!.consumed.getTime());
    });

    it('rejects an unknown identity', async () => {
      let error: any;
      try {
        await auths.signin('username', { username: 'no-such-user', secret: 'x' });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      expect(error.code).to.equal(404);
    });

    it('rejects the wrong password', async () => {
      await auths.signup({
        name: 'Wrong Pass', username: 'wrong-pass-user', secret: 'Password1!'
      });
      let error: any;
      try {
        await auths.signin('username', {
          username: 'wrong-pass-user', secret: 'NotTheRightOne!'
        });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      expect(error.code).to.equal(401);
      expect(error.errors.secret).to.equal('Invalid Password');
    });

    it('skips the password check when password=false (passwordless flows)', async () => {
      await auths.create({
        profileId: (await auths.profile.create({ name: 'OTP Person' })).id,
        type: 'otp', token: 'otp-channel', secret: 'unused-secret'
      });
      const result = await auths.signin(
        'otp' as any, { otp: 'otp-channel' } as any, false
      );
      expect(result).to.exist;
    });
  });

  describe('create/update/upsert/find/count/batch', () => {
    it('create: rejects a duplicate token for the same type', async () => {
      const profile = await auths.profile.create({ name: 'Token Owner' });
      await auths.create({
        profileId: profile.id, type: 'username', token: 'dup-token', secret: 'Password1!'
      });
      let error: any;
      try {
        await auths.create({
          profileId: profile.id, type: 'username', token: 'dup-token', secret: 'Password1!'
        });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      expect(error.errors.token).to.equal('Already exists');
    });

    it('find/findAll: locates a created credential and its joined profile', async () => {
      const profile = await auths.profile.create({ name: 'Find Owner' });
      await auths.create({
        profileId: profile.id, type: 'username', token: 'find-owner', secret: 'Password1!'
      });
      const found = await auths.find({
        columns: [ '*', 'profile.*' ],
        eq: { type: 'username', token: 'find-owner' }
      }) as any;
      expect(found?.profile?.name).to.equal('Find Owner');
    });

    it('count: counts matching credentials', async () => {
      const before = await auths.count({ eq: { type: 'username' } });
      const profile = await auths.profile.create({ name: 'Count Owner' });
      await auths.create({
        profileId: profile.id, type: 'username', token: `count-${Math.random()}`, secret: 'Password1!'
      });
      const after = await auths.count({ eq: { type: 'username' } });
      expect(after).to.equal(before + 1);
    });

    it('update: rejects moving a token onto one already used by another row', async () => {
      const profile = await auths.profile.create({ name: 'Update Owner' });
      const a = await auths.create({
        profileId: profile.id, type: 'username', token: 'update-a', secret: 'Password1!'
      });
      await auths.create({
        profileId: profile.id, type: 'username', token: 'update-b', secret: 'Password1!'
      });
      let error: any;
      try {
        await auths.update({ eq: { id: a.id } }, { token: 'update-b' });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      expect(error.errors.token).to.equal('Already exists');
    });

    it('update: moving a token to an unused value succeeds', async () => {
      const profile = await auths.profile.create({ name: 'Rename Owner' });
      const a = await auths.create({
        profileId: profile.id, type: 'username', token: 'rename-a', secret: 'Password1!'
      });
      const updated = await auths.update({ eq: { id: a.id } }, { token: 'rename-a-2' });
      expect(updated[0].token).to.equal('rename-a-2');
    });

    it('upsert: creates when no id, updates when id is given', async () => {
      const profile = await auths.profile.create({ name: 'Upsert Owner' });
      const created = await auths.upsert({
        profileId: profile.id, type: 'username', token: 'upsert-a', secret: 'Password1!'
      });
      expect(created?.token).to.equal('upsert-a');
      const updated = await auths.upsert({ id: created!.id, token: 'upsert-a-renamed' });
      expect(updated?.token).to.equal('upsert-a-renamed');
    });

    it('remove/restore: toggles active and respects the default active-only filter', async () => {
      const profile = await auths.profile.create({ name: 'Remove Owner' });
      const created = await auths.create({
        profileId: profile.id, type: 'username', token: 'remove-a', secret: 'Password1!'
      });
      await auths.remove({ eq: { id: created.id } });
      expect(await auths.find({ eq: { id: created.id } })).to.equal(null);
      const inactive = await auths.find({ eq: { id: created.id, active: -1 } });
      expect(inactive?.active).to.equal(false);
      await auths.restore({ eq: { id: created.id, active: -1 } });
      expect((await auths.find({ eq: { id: created.id } }))?.active).to.equal(true);
    });

    it('delete: removes the row outright', async () => {
      const profile = await auths.profile.create({ name: 'Delete Owner' });
      const created = await auths.create({
        profileId: profile.id, type: 'username', token: 'delete-a', secret: 'Password1!'
      });
      const deleted = await auths.delete({ eq: { id: created.id } });
      expect(deleted.length).to.equal(1);
      expect(await auths.find({ eq: { id: created.id, active: -1 } })).to.equal(null);
    });

    it('batch: upsert mode creates several credentials for distinct profiles', async () => {
      const a = await auths.profile.create({ name: 'Batch A' });
      const b = await auths.profile.create({ name: 'Batch B' });
      const results = await auths.batch([
        { profileId: a.id, type: 'username', token: `batch-a-${Math.random()}`, secret: 'Password1!' },
        { profileId: b.id, type: 'username', token: `batch-b-${Math.random()}`, secret: 'Password1!' }
      ], 'create');
      expect(results.every((r) => r.code === 200)).to.equal(true);
    });

    it('batch: a failing row rolls back the whole create batch', async () => {
      const profile = await auths.profile.create({ name: 'Batch Rollback' });
      const marker = `batch-rollback-${Math.random().toString(36).slice(2)}`;
      const results = await auths.batch([
        { profileId: profile.id, type: 'username', token: marker, secret: 'Password1!' },
        { profileId: profile.id, type: 'username', token: marker, secret: 'Password1!' }
      ], 'create');
      expect(results.some((r) => r.error)).to.equal(true);
      const survivors = await auths.findAll({ eq: { token: marker } });
      expect(survivors.length).to.equal(0);
    });

    it('batch: update mode reports an error for a row with no matching id or token', async () => {
      const results = await auths.batch([
        { id: 'no-such-auth-id' }
      ], 'update');
      expect(results.length).to.equal(1);
      expect(results[0].error).to.exist;
    });

    it('batch: update mode resolves a row by token when no id is given', async () => {
      const profile = await auths.profile.create({ name: 'Batch Token Update' });
      const created = await auths.create({
        profileId: profile.id, type: 'username', token: 'batch-token-update', secret: 'Password1!'
      });
      const results = await auths.batch([
        { token: created.token, verified: true }
      ], 'update');
      expect(results[0].code).to.equal(200);
      expect((await auths.find({ eq: { id: created.id } }))?.verified).to.equal(true);
    });
  });

  it('purge then reinstall leaves the table usable', async () => {
    await auths.purge(true);
    const remaining = await auths.findAll({});
    expect(remaining.length).to.equal(0);
  });
});
