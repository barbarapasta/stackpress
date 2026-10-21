import { describe, it } from 'mocha';
import { expect } from 'chai';
import { toJsonColumn, fromJsonArray, fromJsonHash } from '../../src/oauth/storage/json.js';
import { OAuthStoreError, OAuthLockConflict } from '../../src/oauth/storage/errors.js';

describe('OAuth JSON column helpers', () => {
  it('toJsonColumn encodes any value as a JSON string', () => {
    expect(toJsonColumn([ 'a', 'b' ])).to.equal('["a","b"]');
    expect(toJsonColumn({})).to.equal('{}');
  });

  it('fromJsonArray treats null/undefined as an empty array', () => {
    expect(fromJsonArray(null)).to.deep.equal([]);
    expect(fromJsonArray(undefined)).to.deep.equal([]);
  });

  it('fromJsonArray passes an already-parsed array through unchanged', () => {
    expect(fromJsonArray([ 'x', 'y' ])).to.deep.equal([ 'x', 'y' ]);
  });

  it('fromJsonArray parses a JSON-encoded array string', () => {
    expect(fromJsonArray('["a","b"]')).to.deep.equal([ 'a', 'b' ]);
  });

  it('fromJsonArray falls back to an empty array for a non-array JSON value', () => {
    expect(fromJsonArray('{"a":1}')).to.deep.equal([]);
  });

  it('fromJsonArray falls back to an empty array for malformed JSON', () => {
    expect(fromJsonArray('not json')).to.deep.equal([]);
  });

  it('fromJsonHash treats null/undefined as an empty object', () => {
    expect(fromJsonHash(null)).to.deep.equal({});
    expect(fromJsonHash(undefined)).to.deep.equal({});
  });

  it('fromJsonHash passes an already-parsed object through unchanged', () => {
    expect(fromJsonHash({ a: 1 })).to.deep.equal({ a: 1 });
  });

  it('fromJsonHash parses a JSON-encoded object string', () => {
    expect(fromJsonHash('{"a":1}')).to.deep.equal({ a: 1 });
  });

  it('fromJsonHash falls back to an empty object for a non-object JSON value', () => {
    expect(fromJsonHash('"just a string"')).to.deep.equal({});
    expect(fromJsonHash('42')).to.deep.equal({});
  });

  it('fromJsonHash falls back to an empty object for malformed JSON', () => {
    expect(fromJsonHash('not json')).to.deep.equal({});
  });
});

describe('OAuth store error types', () => {
  it('OAuthStoreError carries a machine-readable code and defaults its message to it', () => {
    const error = new OAuthStoreError('invalid_grant');
    expect(error.code).to.equal('invalid_grant');
    expect(error.message).to.equal('invalid_grant');
    expect(error.name).to.equal('OAuthStoreError');
  });

  it('OAuthStoreError accepts an explicit message', () => {
    const error = new OAuthStoreError('conflict', 'Already resolved');
    expect(error.message).to.equal('Already resolved');
  });

  it('OAuthLockConflict is an internal-only Error subtype', () => {
    const error = new OAuthLockConflict();
    expect(error).to.be.instanceOf(Error);
    expect(error.name).to.equal('OAuthLockConflict');
  });
});
