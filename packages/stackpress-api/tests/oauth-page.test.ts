import { describe, it } from 'mocha';
import { expect } from 'chai';
import oauthPage from '../src/pages/oauth.js';
import { createRequest, createResponse, createCtxStub } from './mocks.js';

const baseConfig = {
  view: { base: '/', props: {}, notify: {} },
  brand: { name: 'Stackpress' },
  api: { scopes: {}, endpoints: [] }
};

describe('api/pages/oauth', () => {
  it('should pass through when the response already has a body', async () => {
    const req = createRequest();
    const res = createResponse();
    res.html('already handled');
    const ctx = createCtxStub({ config: baseConfig });
    await oauthPage({ req, res, ctx } as any);
    expect(res.body).to.equal('already handled');
  });

  it('should pass through when the response already has a non-200 error code', async () => {
    const req = createRequest();
    const res = createResponse();
    res.setError('boom', {}, [], 500);
    const ctx = createCtxStub({ config: baseConfig });
    await oauthPage({ req, res, ctx } as any);
    expect(res.code).to.equal(500);
    expect(res.error).to.equal('boom');
  });

  it('should return unauthorized when client_id is missing', async () => {
    const req = createRequest({ data: { redirect_uri: 'http://client/cb' } });
    const res = createResponse();
    const ctx = createCtxStub({ config: baseConfig });
    await oauthPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should return unauthorized when redirect_uri is missing', async () => {
    const req = createRequest({ data: { client_id: 'app1' } });
    const res = createResponse();
    const ctx = createCtxStub({ config: baseConfig });
    await oauthPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should redirect to signin when there is no signed-in session', async () => {
    const req = createRequest({
      url: 'http://localhost/auth/oauth?client_id=app1&redirect_uri=http://client/cb',
      data: { client_id: 'app1', redirect_uri: 'http://client/cb' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      config: baseConfig,
      resolves: {
        me: () => ({ results: undefined })
      }
    });
    await oauthPage({ req, res, ctx } as any);
    const location = res.headers.get('Location') as string;
    expect(location).to.match(/^\/auth\/signin\?redirect_uri=/);
    const encoded = location.split('redirect_uri=')[1];
    expect(decodeURIComponent(encoded)).to.equal(
      '/auth/oauth?client_id=app1&redirect_uri=http://client/cb'
    );
  });

  it('should return unauthorized when the application lookup fails', async () => {
    const req = createRequest({
      data: { client_id: 'app1', redirect_uri: 'http://client/cb' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      config: baseConfig,
      resolves: {
        me: () => ({ results: { id: 'profile1' } }),
        'application-detail': (_data: unknown, res: any) => {
          res.setError('Not Found', {}, [], 404);
          return { results: undefined };
        }
      }
    });
    await oauthPage({ req, res, ctx } as any);
    expect(res.code).to.equal(401);
  });

  it('should set api/view/brand data and fall through on a GET with a valid session and app', async () => {
    const req = createRequest({
      method: 'GET',
      data: { client_id: 'app1', redirect_uri: 'http://client/cb' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      config: {
        view: { base: '/app', props: { x: 1 }, notify: { y: 2 } },
        brand: { name: 'Acme', logo: '/l.png', icon: '/i.png', favicon: '/f.ico' },
        api: { scopes: { read: { name: 'Read', description: 'Read data' } }, endpoints: [] }
      },
      resolves: {
        me: () => ({ results: { id: 'profile1' } }),
        'application-detail': (_data: unknown, res: any) => {
          res.code = 200;
          return { results: { id: 'app1', name: 'App' } };
        }
      }
    });
    await oauthPage({ req, res, ctx } as any);
    expect(res.data.get('api')).to.deep.equal({
      scopes: { read: { name: 'Read', description: 'Read data' } },
      endpoints: []
    });
    expect(res.data.get('view')).to.deep.equal({
      base: '/app',
      props: { x: 1 },
      notify: { y: 2 }
    });
    expect(res.data.get('brand')).to.deep.equal({
      name: 'Acme',
      logo: '/l.png',
      icon: '/i.png',
      favicon: '/f.ico'
    });
    //GET falls through without redirecting
    expect(res.headers.get('Location')).to.equal(undefined);
  });

  it('should default brand fields when brand config is empty', async () => {
    const req = createRequest({
      method: 'GET',
      data: { client_id: 'app1', redirect_uri: 'http://client/cb' }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      config: { view: {}, brand: {}, api: {} },
      resolves: {
        me: () => ({ results: { id: 'profile1' } }),
        'application-detail': (_data: unknown, res: any) => {
          res.code = 200;
          return { results: { id: 'app1' } };
        }
      }
    });
    await oauthPage({ req, res, ctx } as any);
    expect(res.data.get('brand')).to.deep.equal({
      name: 'Stackpress',
      logo: '/logo.png',
      icon: '/icon.png',
      favicon: '/favicon.ico'
    });
  });

  it('should create a session and redirect with a code on POST success', async () => {
    const req = createRequest({
      method: 'POST',
      data: {
        client_id: 'app1',
        redirect_uri: 'http://client/cb?existing=1',
        state: 'xyz'
      }
    });
    const res = createResponse();
    let createPayload: any;
    const ctx = createCtxStub({
      config: baseConfig,
      resolves: {
        me: () => ({ results: { id: 'profile1' } }),
        'application-detail': (_data: unknown, res: any) => {
          res.code = 200;
          return { results: { id: 'app1' } };
        },
        'session-create': (data: unknown) => {
          createPayload = data;
          return { results: { id: 'session-code-1' } };
        }
      }
    });
    await oauthPage({ req, res, ctx } as any);
    expect(createPayload).to.include({
      applicationId: 'app1',
      profileId: 'profile1'
    });
    expect(createPayload.expires).to.be.instanceOf(Date);
    const location = res.headers.get('Location') as string;
    expect(location).to.include('http://client/cb?');
    expect(location).to.include('code=session-code-1');
    expect(location).to.include('state=xyz');
  });

  it('should not set state in the redirect when state is absent', async () => {
    const req = createRequest({
      method: 'POST',
      data: {
        client_id: 'app1',
        redirect_uri: 'http://client/cb'
      }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      config: baseConfig,
      resolves: {
        me: () => ({ results: { id: 'profile1' } }),
        'application-detail': (_data: unknown, res: any) => {
          res.code = 200;
          return { results: { id: 'app1' } };
        },
        'session-create': () => ({ results: { id: 'session-code-2' } })
      }
    });
    await oauthPage({ req, res, ctx } as any);
    const location = res.headers.get('Location') as string;
    expect(location).to.equal('http://client/cb?code=session-code-2');
  });

  it('should not redirect when session-create returns no results', async () => {
    const req = createRequest({
      method: 'POST',
      data: {
        client_id: 'app1',
        redirect_uri: 'http://client/cb'
      }
    });
    const res = createResponse();
    const ctx = createCtxStub({
      config: baseConfig,
      resolves: {
        me: () => ({ results: { id: 'profile1' } }),
        'application-detail': (_data: unknown, res: any) => {
          res.code = 200;
          return { results: { id: 'app1' } };
        },
        'session-create': () => ({ results: undefined })
      }
    });
    await oauthPage({ req, res, ctx } as any);
    expect(res.headers.get('Location')).to.equal(undefined);
  });
});
