import { describe, it } from 'mocha';
import { expect } from 'chai';
import tokenPage from '../src/pages/token.js';
import { createRequest, createResponse, createCtxStub } from './mocks.js';

describe('api/pages/token', () => {
  it('should pass through when the response already has a body', async () => {
    const req = createRequest();
    const res = createResponse();
    res.html('already handled');
    const ctx = createCtxStub();
    await tokenPage({ req, res, ctx } as any);
    expect(res.body).to.equal('already handled');
  });

  it('should pass through when the response already has a non-200 error code', async () => {
    const req = createRequest();
    const res = createResponse();
    res.setError('boom', {}, [], 500);
    const ctx = createCtxStub();
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(500);
  });

  it('should return unauthorized when the authorization header is missing', async () => {
    const req = createRequest({ method: 'POST' });
    const res = createResponse();
    const ctx = createCtxStub();
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when code is missing', async () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:secret1' }
    });
    const res = createResponse();
    const ctx = createCtxStub();
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when secret is missing (GET without secret)', async () => {
    const req = createRequest({
      method: 'GET',
      headers: { authorization: 'Bearer id1' },
      data: { code: 'session1' }
    });
    const res = createResponse();
    const ctx = createCtxStub();
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when the session lookup returns nothing', async () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:secret1' },
      data: { code: 'session1' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      resolves: { 'session-detail': () => ({ results: undefined }) }
    });
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when the session applicationId does not match', async () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:secret1' },
      data: { code: 'session1' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: {
            id: 'session1',
            applicationId: 'other-app',
            secret: 'shh',
            expires: new Date(Date.now() + 100000),
            profile: { id: 'p1', name: 'Bob', image: '', created: new Date() }
          }
        })
      }
    });
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when the session is expired', async () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:secret1' },
      data: { code: 'session1' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: {
            id: 'session1',
            applicationId: 'id1',
            secret: 'shh',
            expires: new Date(Date.now() - 1000),
            profile: { id: 'p1', name: 'Bob', image: '', created: new Date() }
          }
        })
      }
    });
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should return the token payload on success', async () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:secret1' },
      data: { code: 'session1' }
    });
    const res = createResponse();
    const expires = new Date(Date.now() + 3600 * 1000);
    const created = new Date('2020-01-01T00:00:00Z');
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: {
            id: 'session1',
            applicationId: 'id1',
            secret: 'session-secret',
            expires,
            profile: { id: 'p1', name: 'Bob', image: '/avatar.png', created }
          }
        })
      }
    });
    await tokenPage({ req, res, ctx } as any);
    expect(res.code).to.equal(200);
    const body = res.body as Record<string, any>;
    expect(body.token_type).to.equal('Bearer');
    expect(body.access_token).to.equal('session1');
    expect(body.access_secret).to.equal('session-secret');
    expect(body.expires_in).to.be.a('number');
    expect(body.expires_in).to.be.closeTo(3600, 2);
    expect(body.user).to.deep.equal({
      id: 'p1',
      name: 'Bob',
      image: '/avatar.png',
      created
    });
  });

  it('should return expires_in 0 when the session never expires', async () => {
    const req = createRequest({
      method: 'POST',
      headers: { authorization: 'Bearer id1:secret1' },
      data: { code: 'session1' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      resolves: {
        'session-detail': () => ({
          results: {
            id: 'session1',
            applicationId: 'id1',
            secret: 'session-secret',
            expires: undefined,
            profile: { id: 'p1', name: 'Bob', image: '', created: new Date() }
          }
        })
      }
    });
    await tokenPage({ req, res, ctx } as any);
    const body = res.body as Record<string, any>;
    expect(body.expires_in).to.equal(0);
  });
});
