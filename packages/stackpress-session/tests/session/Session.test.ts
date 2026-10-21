//Coverage for the existing (previously untested) session/Session.ts
//SessionServer class: token creation/verification, permission checks and
//the static authorize() guard. Part of side task 00007A.
import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import SessionServer from '../../src/session/Session.js';

function fakeRequest(options: {
  method?: string,
  path?: string,
  sessionToken?: string | null
} = {}) {
  const store: Record<string, string> = {};
  if (options.sessionToken) store.session = options.sessionToken;
  const session = (key: string) => store[key];
  (session as any).has = (key: string) => key in store;
  return {
    method: options.method || 'GET',
    url: { pathname: options.path || '/' },
    session
  } as any;
}

function fakeResponse() {
  const sessionStore: Record<string, string> = {};
  return {
    _error: undefined as any,
    _results: undefined as any,
    setError(error: any) { this._error = error; },
    results(value: any) { this._results = value; },
    session: { set(key: string, value: string) { sessionStore[key] = value; } },
    _sessionStore: sessionStore
  } as any;
}

describe('session/Session (SessionServer)', () => {
  beforeEach(() => {
    //reset static config between tests since it's process-wide state
    SessionServer.configure('session', 'test-seed-0123456789', {});
    SessionServer.expires = 0;
  });

  it('create/load: a signed token round-trips its data', async () => {
    const token = await SessionServer.create({ id: 1, roles: [ 'USER' ] } as any);
    const server = SessionServer.load(token);
    const data = await server.data();
    expect(data?.id).to.equal(1);
    expect(data?.roles).to.deep.equal([ 'USER' ]);
  });

  it('create: honors a configured expiry', async () => {
    SessionServer.expires = Math.floor(Date.now() / 1000) + 60;
    const token = await SessionServer.create({ id: 2, roles: [ 'USER' ] } as any);
    const server = SessionServer.load(token);
    expect(await server.data()).to.not.equal(null);
  });

  it('load(request): reads the token from the request session store', async () => {
    const token = await SessionServer.create({ id: 3, roles: [ 'USER' ] } as any);
    const request = fakeRequest({ sessionToken: token });
    const server = SessionServer.load(request);
    expect(await server.guest()).to.equal(false);
  });

  it('token(): returns null when the request has no session cookie', () => {
    const request = fakeRequest({});
    expect(SessionServer.token(request)).to.equal(null);
  });

  it('guest(): true for an empty/invalid token, false for a valid one', async () => {
    expect(await SessionServer.load('').guest()).to.equal(true);
    expect(await SessionServer.load('not-a-real-jwt').guest()).to.equal(true);
    const token = await SessionServer.create({ id: 4, roles: [ 'USER' ] } as any);
    expect(await SessionServer.load(token).guest()).to.equal(false);
  });

  it('data(): caches the decoded payload across repeated calls', async () => {
    const token = await SessionServer.create({ id: 5, roles: [ 'USER' ] } as any);
    const server = SessionServer.load(token);
    const first = await server.data();
    const second = await server.data();
    expect(first).to.equal(second);
  });

  it('permits/can: resolves event and route permissions by role', async () => {
    SessionServer.configure('session', 'test-seed-0123456789', {
      USER: [ 'article-read', { method: 'GET', route: '/api/articles/:id' } ],
      ADMIN: [ 'article-write' ]
    });
    const token = await SessionServer.create({ id: 6, roles: [ 'USER' ] } as any);
    const server = SessionServer.load(token);
    const permits = await server.permits();
    expect(permits).to.include('article-read');
    expect(await server.can('article-read')).to.equal(true);
    expect(await server.can('article-write')).to.equal(false);
    expect(await server.can({ method: 'GET', route: '/api/articles/5' })).to.equal(true);
    expect(await server.can()).to.equal(true);
  });

  it('permits: a guest (no token) defaults to the GUEST role list', async () => {
    SessionServer.configure('session', 'test-seed-0123456789', {
      GUEST: [ 'public-read' ]
    });
    const server = SessionServer.load('');
    expect(await server.permits()).to.deep.equal([ 'public-read' ]);
  });

  it('authorization(): merges defaults, session data, token and permits', async () => {
    SessionServer.configure('session', 'test-seed-0123456789', {
      USER: [ 'article-read' ]
    });
    const token = await SessionServer.create({ id: 7, roles: [ 'USER' ] } as any);
    const server = SessionServer.load(token);
    const auth = await server.authorization();
    expect(auth.id).to.equal(7);
    expect(auth.token).to.equal(token);
    expect(auth.permits).to.include('article-read');
  });

  it('save(): writes the token into the response session', async () => {
    const token = await SessionServer.create({ id: 8, roles: [ 'USER' ] } as any);
    const server = SessionServer.load(token);
    const res = fakeResponse();
    server.save(res);
    expect(res._sessionStore.session).to.equal(token);
  });

  describe('authorize() static guard', () => {
    it('allows everything when no access list is configured', async () => {
      SessionServer.configure('session', 'test-seed-0123456789', {});
      const req = fakeRequest({});
      const res = fakeResponse();
      const allowed = await SessionServer.authorize(req, res);
      expect(allowed).to.equal(true);
      expect(res._error).to.equal(undefined);
    });

    it('denies an unauthorized request with a 401 and no results', async () => {
      SessionServer.configure('session', 'test-seed-0123456789', {
        GUEST: [ 'public-read' ]
      });
      const req = fakeRequest({ method: 'POST', path: '/api/articles' });
      const res = fakeResponse();
      const allowed = await SessionServer.authorize(req, res, [ 'article-write' ]);
      expect(allowed).to.equal(false);
      expect(res._error.code).to.equal(401);
      expect(res._results).to.equal(undefined);
    });

    it('allows a signed-in request whose role covers the exact route', async () => {
      SessionServer.configure('session', 'test-seed-0123456789', {
        USER: [ { method: 'GET', route: '/api/articles/:id' } ]
      });
      const token = await SessionServer.create({ id: 9, roles: [ 'USER' ] } as any);
      const req = fakeRequest({ method: 'GET', path: '/api/articles/5', sessionToken: token });
      const res = fakeResponse();
      const allowed = await SessionServer.authorize(req, res);
      expect(allowed).to.equal(true);
      expect(res._results.id).to.equal(9);
    });
  });
});
