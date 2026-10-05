import { describe, it } from 'mocha';
import { expect } from 'chai';
import { authorize, unauthorized, validData } from '../src/helpers.js';
import { createRequest, createResponse } from './mocks.js';

describe('api/helpers authorize', () => {
  it('should reject when the authorization header is missing', () => {
    const req = createRequest();
    const res = createResponse();
    expect(authorize(req, res)).to.equal(false);
    expect(res.code).to.equal(401);
    expect(res.error).to.equal('Unauthorized');
  });

  it('should reject an empty token', () => {
    const req = createRequest({ headers: { authorization: 'Bearer   ' } });
    const res = createResponse();
    expect(authorize(req, res)).to.equal(false);
    expect(res.code).to.equal(401);
  });

  it('should reject a token missing an id', () => {
    const req = createRequest({ headers: { authorization: 'Bearer :secret1' } });
    const res = createResponse();
    expect(authorize(req, res)).to.equal(false);
    expect(res.code).to.equal(401);
  });

  it('should allow a GET request without a secret', () => {
    const req = createRequest({
      method: 'GET',
      headers: { authorization: 'Bearer id1' }
    });
    const res = createResponse();
    const result = authorize(req, res);
    expect(result).to.deep.equal({ token: 'id1', id: 'id1', secret: '' });
    expect(res.code).to.equal(0);
  });

  it('should reject a non-GET request without a secret', () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1' }
    });
    const res = createResponse();
    expect(authorize(req, res)).to.equal(false);
    expect(res.code).to.equal(401);
  });

  it('should succeed with an id and secret on a non-GET request', () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:secret1' }
    });
    const res = createResponse();
    const result = authorize(req, res);
    expect(result).to.deep.equal({ token: 'id1:secret1', id: 'id1', secret: 'secret1' });
    expect(res.code).to.equal(0);
  });
});

describe('api/helpers unauthorized', () => {
  it('should set a 401 error on the response', () => {
    const res = createResponse();
    unauthorized(res);
    expect(res.code).to.equal(401);
    expect(res.error).to.equal('Unauthorized');
  });
});

describe('api/helpers validData', () => {
  it('should return false when a key is missing from data', () => {
    expect(validData({ foo: 'bar' }, {})).to.equal(false);
  });

  it('should return false when an array assertion is not fully contained', () => {
    expect(validData({ scopes: [ 'read', 'write' ] }, { scopes: [ 'read' ] }))
      .to.equal(false);
  });

  it('should return false when data does not have an array for an array assertion', () => {
    expect(validData({ scopes: [ 'read' ] }, { scopes: 'read' })).to.equal(false);
  });

  it('should return true when an array assertion is fully contained', () => {
    expect(validData({ scopes: [ 'read' ] }, { scopes: [ 'read', 'write' ] }))
      .to.equal(true);
  });

  it('should return false when a nested object assertion mismatches', () => {
    expect(validData(
      { profile: { name: 'Bob' } },
      { profile: { name: 'Alice' } }
    )).to.equal(false);
  });

  it('should return false when data is not an object for a nested assertion', () => {
    expect(validData(
      { profile: { name: 'Bob' } },
      { profile: 'Bob' }
    )).to.equal(false);
  });

  it('should return true when a nested object assertion matches', () => {
    expect(validData(
      { profile: { name: 'Bob' } },
      { profile: { name: 'Bob', extra: true } }
    )).to.equal(true);
  });

  it('should return false when a plain value assertion mismatches', () => {
    expect(validData({ status: 'active' }, { status: 'inactive' })).to.equal(false);
  });

  it('should return true when a plain value assertion matches', () => {
    expect(validData({ status: 'active' }, { status: 'active' })).to.equal(true);
  });

  it('should return true when all assertions are valid', () => {
    expect(validData(
      { status: 'active', scopes: [ 'read' ], profile: { name: 'Bob' } },
      { status: 'active', scopes: [ 'read', 'write' ], profile: { name: 'Bob' } }
    )).to.equal(true);
  });
});
