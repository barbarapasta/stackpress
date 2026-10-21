import { describe, it, after } from 'mocha';
import { expect } from 'chai';
import { hashWithDomain } from '../../src/oauth/storage/ids.js';
import {
  buildViewProps,
  continuationSecure,
  readSelection,
  receiptSelection
} from '../../src/oauth/pages/browser.js';
import { factorAddress } from '../../src/oauth/pages/authorize.js';
import { createFactorReceipt } from '../../src/oauth/factor.js';
import {
  BASE,
  REDIRECT,
  SESSION_SEED,
  csrfOf,
  renderView,
  snapshotOf,
  startBrowserApp
} from './browser-app.js';
import type { BrowserApp } from './browser-app.js';

describe('OAuth browser pages: guards, fallbacks and limits (task 00007)', function () {
  //real HTTP server + PGlite boot; slower than mocha's 2s default under load
  this.timeout(30_000);
  const apps: BrowserApp[] = [];
  after(async () => {
    for (const app of apps) await app.close();
  });

  it('every page refuses with 503 until OAuthService.finalize() succeeds', async () => {
    const app = await startBrowserApp({ finalize: false });
    apps.push(app);
    await app.createAccount('unfinal');
    const browser = app.browser();
    await app.signIn(browser, 'unfinal');
    for (const [ path, state ] of [
      [ `${BASE}/authorize`, 'unavailable' ],
      [ `${BASE}/factor`, 'unavailable_service' ],
      [ `${BASE}/connections`, 'unavailable' ]
    ]) {
      const response = await browser.get(path);
      expect(response.status).to.equal(503);
      expect(snapshotOf(response).state).to.equal(state);
    }
  });

  it('these pages are never native routes, and under session.access a guest is stopped by the ordinary browser authorizer', async () => {
    const app = await startBrowserApp({
      access: {
        GUEST: [
          { method: 'ALL', route: '/auth/signin/**' },
          { method: 'GET', route: `${BASE}/authorize` }
        ],
        USER: [ { method: 'ALL', route: '/**' } ]
      }
    });
    apps.push(app);
    for (const [ method, path ] of [
      [ 'GET', `${BASE}/authorize` ], [ 'POST', `${BASE}/authorize` ],
      [ 'GET', `${BASE}/factor` ], [ 'POST', `${BASE}/factor` ],
      [ 'GET', `${BASE}/connections` ], [ 'POST', `${BASE}/connections/revoke` ]
    ]) {
      expect(app.oauth.isNativeRoute(method, path), `${method} ${path}`).to.equal(false);
    }
    //native protocol routes still bypass the cookie check
    expect(app.oauth.isNativeRoute('POST', `${BASE}/token`)).to.equal(true);
    const guest = app.browser();
    const blocked = await guest.get(`${BASE}/connections`);
    expect(blocked.status).to.equal(401);
    const blockedFactor = await guest.post(`${BASE}/factor`, { code: '123456' });
    expect(blockedFactor.status).to.equal(401);
    //the app granted guests the approval start, so J03 still works
    const clientId = await app.registerClient('Access Test');
    const start = await guest.get(app.authorizeQuery(clientId));
    expect(start.status).to.equal(303);
    await app.createAccount('accessuser');
    await app.signIn(guest, 'accessuser', `${BASE}/authorize`);
    const page = await guest.get(`${BASE}/authorize`);
    expect(page.status).to.equal(200);
    expect(snapshotOf(page).state).to.equal('approve');
  });

  it('applies limits.authorization to the start and to approval POSTs (429 with Retry-After)', async () => {
    const app = await startBrowserApp({ oauth: { limits: { authorization: 2, registration: 100, token: 100 } } });
    apps.push(app);
    const clientId = await app.registerClient('Limited');
    await app.createAccount('limited');
    const browser = app.browser();
    await app.signIn(browser, 'limited');
    expect((await browser.get(app.authorizeQuery(clientId))).status).to.equal(303);
    const page = await browser.get(`${BASE}/authorize`);
    //second unit of the budget: this POST is counted and allowed
    const shown = await browser.post(`${BASE}/authorize`, { ...csrfOf(page), action: 'neither' });
    expect(shown.status).to.equal(400);
    const limited = await browser.post(`${BASE}/authorize`, { ...csrfOf(shown), action: 'approve' });
    expect(limited.status).to.equal(429);
    expect(Number(limited.headers.get('retry-after'))).to.be.greaterThan(0);
    expect(snapshotOf(limited).state).to.equal('rate_limited');
    const start = await app.browser().get(app.authorizeQuery(clientId));
    expect(start.status).to.equal(429);
    expect(snapshotOf(start).state).to.equal('rate_limited');
    expect(start.text).to.contain('seconds');
  });

  it('shows a client-document program by its checked host and refuses on a failed metadata refresh (no stale fallback)', async () => {
    const app = await startBrowserApp();
    apps.push(app);
    const clientId = 'http://127.0.0.1:9/oauth-client.json';
    await app.store.saveClientDocument({
      urlHash: hashWithDomain('client-document-url', clientId),
      metadata: {
        client_id: clientId,
        client_name: 'Document Program',
        redirect_uris: [ REDIRECT ]
      },
      freshUntil: new Date(Date.now() + 60_000)
    });
    await app.createAccount('docuser');
    const browser = app.browser();
    await app.signIn(browser, 'docuser');
    expect((await browser.get(app.authorizeQuery(clientId))).status).to.equal(303);
    const page = await browser.get(`${BASE}/authorize`);
    const data = snapshotOf(page);
    expect(data.client.kind).to.equal('document');
    expect(data.client.host).to.equal('127.0.0.1:9');
    expect(data.client.name).to.equal('Document Program');
    //the cached document is now stale; the refresh target is refused
    await app.engine.query(
      'UPDATE oauth_client_document SET fresh_until = ?', [ new Date(Date.now() - 1000) ]
    );
    const stale = await browser.get(`${BASE}/authorize`);
    expect(stale.status).to.equal(503);
    expect(snapshotOf(stale).state).to.equal('unavailable');
    //and the connections page names it from saved data only
    await app.engine.query(
      'UPDATE oauth_client_document SET fresh_until = ?', [ new Date(Date.now() + 60_000) ]
    );
    const fresh = await browser.get(`${BASE}/authorize`);
    const approved = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(fresh), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(approved.status).to.equal(302);
    const list = await browser.get(`${BASE}/connections`);
    const [ row ] = snapshotOf(list).connections;
    expect(row.client).to.deep.equal({ id: clientId, name: 'Document Program', host: '127.0.0.1:9' });
  });

  it('returns the same safe snapshot as JSON with the no-view flag or without a renderer', async () => {
    const app = await startBrowserApp({ render: () => null });
    apps.push(app);
    await app.createAccount('jsonuser');
    const browser = app.browser();
    await app.signIn(browser, 'jsonuser');
    const response = await browser.get(`${BASE}/connections`);
    expect(response.status).to.equal(200);
    const body = JSON.parse(response.text);
    expect(body.oauth.state).to.equal('list');
    expect(Object.keys(body)).to.deep.equal([ 'oauth' ]);
    expect(response.text).to.not.contain(decodeURIComponent(browser.cookies.get('session')!));
    const flagged = await browser.get(`${BASE}/connections?json`);
    expect(JSON.parse(flagged.text).oauth.state).to.equal('list');
  });

  it('renders translated text from the app language configuration (including the factor error and connections states)', () => {
    const links = { authorize: '/a', factor: '/f', connections: '/c', account: '/acc', factorSetup: '/2fa' };
    const languages = { th_TH: { label: 'TH', translations: {
      'Approve': 'TH-Approve',
      'Deny': 'TH-Deny',
      'Approve program access': 'TH-Title',
      '%s wants to use your account.': 'TH %s wants',
      'That code is not valid. Check your authenticator app and enter the current 6-digit code.': 'TH-invalid-code',
      'No programs are connected to your account.': 'TH-empty'
    } } };
    const req: any = { url: new URL('http://x/a'), method: 'GET', session: { get: () => undefined } };
    const ctx: any = { config: { path: (key: string, fallback: unknown) =>
      key === 'language' ? { key: 'locale', locale: 'th_TH', languages } : fallback } };
    const approve = renderView('stackpress-session/esm/oauth/views/authorize', buildViewProps(req, ctx, {
      state: 'approve', scopes: [], operations: [], factor: { required: false, verified: false }, links,
      client: { id: 'c1', name: 'Prog', kind: 'registered', redirect: 'http://127.0.0.1/cb', redirectHost: '127.0.0.1', local: true }
    }, 200));
    expect(approve).to.contain('TH-Approve');
    expect(approve).to.contain('TH-Deny');
    expect(approve).to.contain('TH-Title');
    expect(approve).to.contain('TH Prog wants');
    const factor = renderView('stackpress-session/esm/oauth/views/factor', buildViewProps(req, ctx, {
      state: 'verify', error: 'invalid_code', scopes: [], operations: [], links
    }, 400));
    expect(factor).to.contain('TH-invalid-code');
    const empty = renderView('stackpress-session/esm/oauth/views/connections', buildViewProps(req, ctx, {
      state: 'list', connections: [], links
    }, 200));
    expect(empty).to.contain('TH-empty');
  });

  it('helpers: Secure cookie outside development, strict selection parsing, receipt decoding and minimal view props', () => {
    const config: any = { development: false, issuer: 'https://example.com' };
    expect(continuationSecure(config)).to.equal(true);
    expect(continuationSecure({ ...config, development: true })).to.equal(true);
    expect(continuationSecure({ development: true, issuer: 'http://localhost' } as any)).to.equal(false);
    expect(readSelection(undefined)).to.deep.equal([]);
    expect(readSelection('a')).to.deep.equal([ 'a' ]);
    expect(readSelection([ 'a', 'a', 5, '' ])).to.deep.equal([ 'a', '5' ]);
    expect(readSelection([ { nested: true } ])).to.equal(null);
    const pending: any = {
      id: 'p1', expires: new Date(Date.now() + 60_000), factorReceipt: null
    };
    expect(receiptSelection(SESSION_SEED, pending, 'u1', new Date())).to.equal(null);
    expect(receiptSelection(SESSION_SEED, { ...pending, factorReceipt: 'garbage' }, 'u1', new Date())).to.equal(null);
    expect(receiptSelection(SESSION_SEED, { ...pending, factorReceipt: `${Buffer.from('{"x":1}').toString('base64url')}.sig` }, 'u1', new Date())).to.equal(null);
    const receipt = createFactorReceipt(SESSION_SEED, {
      profileId: 'u1', pendingId: 'p1', scopes: [ 'a' ], operations: []
    }, pending.expires);
    expect(receiptSelection(SESSION_SEED, { ...pending, factorReceipt: receipt }, 'u1', new Date()))
      .to.deep.equal({ scopes: [ 'a' ], operations: [] });
    //bound to the person: another profile cannot reuse it
    expect(receiptSelection(SESSION_SEED, { ...pending, factorReceipt: receipt }, 'u2', new Date())).to.equal(null);
    expect(factorAddress({ factor: '/f' } as any, [ 'a b' ], [ 'op' ]))
      .to.equal('/f?scope=a+b&operation=op&selected=1');
    const req: any = {
      url: new URL('http://host.example/auth/oauth2/authorize?state=secret'),
      method: 'GET',
      session: { get: (name: string) => name === 'theme' ? 'dark' : 'cookie-secret' }
    };
    const ctx: any = { config: { path: (_key: string, fallback: unknown) => fallback } };
    const props = buildViewProps(req, ctx, { state: 'x' }, 200);
    expect(props.request.session).to.deep.equal({ theme: 'dark' });
    expect(props.request.url.href).to.equal('http://host.example/auth/oauth2/authorize');
    expect(JSON.stringify(props)).to.not.contain('secret');
  });
});
