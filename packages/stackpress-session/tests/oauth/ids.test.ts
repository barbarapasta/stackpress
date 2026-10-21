import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  OAUTH_ACCESS_PREFIX,
  OAUTH_REFRESH_PREFIX,
  randomToken,
  newAccessId,
  newAccessSecret,
  toFullKey,
  splitFullKey,
  newRefreshToken,
  newCode,
  newPendingBinding,
  hashWithDomain,
  hashesEqual,
  isOAuthNamespace
} from '../../src/oauth/storage/ids.js';

describe('OAuth ID/Hash Helpers', () => {
  it('generates oauth_ prefixed access ids of consistent, unguessable shape', () => {
    const id = newAccessId();
    expect(id.startsWith(OAUTH_ACCESS_PREFIX)).to.equal(true);
    expect(id).to.not.equal(newAccessId());
    //32 raw bytes, unpadded base64url: no padding or URL-unsafe chars
    expect(id).to.not.match(/[+/=]/);
  });

  it('generates oauthr_ prefixed refresh tokens', () => {
    const token = newRefreshToken();
    expect(token.startsWith(OAUTH_REFRESH_PREFIX)).to.equal(true);
    expect(token).to.not.equal(newRefreshToken());
  });

  it('generates unprefixed codes and pending bindings that differ per call', () => {
    expect(newCode()).to.not.equal(newCode());
    expect(newPendingBinding()).to.not.equal(newPendingBinding());
  });

  it('builds and splits a full id:secret key losslessly', () => {
    const id = newAccessId();
    const secret = newAccessSecret();
    const full = toFullKey(id, secret);
    expect(full).to.equal(`${id}:${secret}`);
    const split = splitFullKey(full);
    expect(split).to.deep.equal({ id, secret });
  });

  it('rejects malformed full keys instead of degrading to an id-only read', () => {
    expect(splitFullKey('no-colon-here')).to.equal(null);
    expect(splitFullKey(':missing-id')).to.equal(null);
    expect(splitFullKey('missing-secret:')).to.equal(null);
    expect(splitFullKey('too:many:colons')).to.equal(null);
    expect(splitFullKey('')).to.equal(null);
  });

  it('applies an optional fixed prefix via randomToken', () => {
    const token = randomToken('custom_');
    expect(token.startsWith('custom_')).to.equal(true);
    expect(randomToken()).to.not.match(/^custom_/);
  });

  it('domain-separates hashes so the same value differs per credential kind', () => {
    const value = 'shared-raw-value';
    const access = hashWithDomain('access-read', value);
    const code = hashWithDomain('code', value);
    const refresh = hashWithDomain('refresh', value);
    expect(access).to.not.equal(code);
    expect(code).to.not.equal(refresh);
    expect(access).to.not.equal(refresh);
    //deterministic for the same domain/value
    expect(hashWithDomain('access-read', value)).to.equal(access);
  });

  it('compares hashes in constant time and never throws on bad input', () => {
    const a = hashWithDomain('access-read', 'one');
    const b = hashWithDomain('access-read', 'one');
    const c = hashWithDomain('access-read', 'two');
    expect(hashesEqual(a, b)).to.equal(true);
    expect(hashesEqual(a, c)).to.equal(false);
    //mismatched length must not throw
    expect(hashesEqual(a, 'ab')).to.equal(false);
    expect(hashesEqual('', '')).to.equal(false);
  });

  it('identifies the oauth_ namespace without touching legacy ids', () => {
    expect(isOAuthNamespace(newAccessId())).to.equal(true);
    expect(isOAuthNamespace('legacy-application-id')).to.equal(false);
    expect(isOAuthNamespace(newRefreshToken())).to.equal(false);
  });
});
