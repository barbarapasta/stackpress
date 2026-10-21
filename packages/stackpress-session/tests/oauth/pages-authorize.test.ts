import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import {
  BASE,
  CODE_VERIFIER,
  REDIRECT,
  RESOURCE,
  SESSION_SEED,
  allowAll,
  csrfOf,
  snapshotOf,
  startBrowserApp,
  startupProps
} from './browser-app.js';
import type { BrowserApp, TestBrowser } from './browser-app.js';

//J03/J04/J07 through the real HTTP stack: real session JWT from the real
//username sign-in page, real csrf plugin, real OAuthStore over PGlite.
describe('OAuth browser /authorize page (task 00007, real session/store)', function () {
  //real HTTP server + PGlite boot; slower than mocha's 2s default under load
  this.timeout(30_000);
  let app: BrowserApp;
  let clientId: string;

  before(async () => {
    app = await startBrowserApp();
    clientId = await app.registerClient('Claude <img src=x onerror=alert(1)>');
    await app.createAccount('alice');
    await app.createAccount('bobby');
    await app.createAccount('carol');
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    app.policy.approval = allowAll;
  });

  //J03 step 1-2: start signed out, save the request, sign in, return
  async function startSignedOut(browser: TestBrowser) {
    const start = await browser.get(app.authorizeQuery(clientId));
    expect(start.status).to.equal(303);
    expect(start.location).to.equal(`${BASE}/authorize`);
    return start;
  }

  async function openApproval(username = 'alice') {
    const browser = app.browser();
    await startSignedOut(browser);
    await app.signIn(browser, username, `${BASE}/authorize`);
    const page = await browser.get(`${BASE}/authorize`);
    return { browser, page };
  }

  it('J03: saves the request in an HttpOnly SameSite=Lax continuation cookie before sign-in and returns to the clean approval page', async () => {
    const browser = app.browser();
    const start = await startSignedOut(browser);
    const cookie = start.setCookies.find((line) => line.startsWith('oauth_continue='));
    expect(cookie).to.be.a('string');
    expect(cookie).to.match(/HttpOnly/i);
    expect(cookie).to.match(/SameSite=Lax/i);
    expect(cookie).to.match(new RegExp(`Path=${BASE.replace(/\//g, '\\/')}`));
    //no state or PKCE value remains in the address the browser continues on
    expect(start.location).to.not.contain('state');
    //guest is sent to the existing sign-in with a same-app return only
    const guest = await browser.get(`${BASE}/authorize`);
    expect(guest.status).to.equal(302);
    expect(guest.location).to.equal(
      `/auth/signin?redirect_uri=${encodeURIComponent(`${BASE}/authorize`)}`
    );
    //only the hash of the cookie value is stored
    const raw = decodeURIComponent(browser.cookies.get('oauth_continue')!);
    const rows = await app.engine.query<any>('SELECT binding_hash FROM oauth_pending');
    expect(rows.map((row: any) => row.binding_hash)).to.not.include(raw);
  });

  it('J04: shows escaped client name, hosts, exact service, scope labels and operations with the local-program notice', async () => {
    const { page } = await openApproval();
    expect(page.status).to.equal(200);
    expect(page.headers.get('cache-control')).to.equal('no-store');
    expect(page.headers.get('x-frame-options')).to.equal('DENY');
    const data = snapshotOf(page);
    expect(data.state).to.equal('approve');
    expect(data.client.name).to.equal('Claude <img src=x onerror=alert(1)>');
    expect(data.client.redirectHost).to.equal('127.0.0.1:47123');
    expect(data.client.local).to.equal(true);
    expect(data.resource.id).to.equal(RESOURCE);
    expect(data.scopes.map((s: any) => s.name)).to.deep.equal([ 'Read articles', 'Change articles' ]);
    expect(data.operations.map((o: any) => `${o.method} ${o.route}`)).to.deep.equal([ 'GET /api/articles/:id' ]);
    //client text is escaped in the server HTML (no live tag)
    expect(page.text).to.not.contain('<img src=x');
    expect(page.text).to.contain('Claude &lt;img src=x onerror=alert(1)&gt;');
    expect(page.text).to.contain('has not verified who published this program');
    expect(page.text).to.not.match(/verified publisher/i);
  });

  it('J04: client text cannot break out of the startup data script or the page markup', async () => {
    const hostile = '</script><script>alert(1)</script> $\' $& <b>x</b>';
    const hostileId = await app.registerClient(hostile);
    const browser = app.browser();
    await browser.get(app.authorizeQuery(hostileId));
    await app.signIn(browser, 'alice', `${BASE}/authorize`);
    const page = await browser.get(`${BASE}/authorize`);
    expect(page.status).to.equal(200);
    expect(page.text).to.not.contain('<script>alert(1)');
    expect(page.text).to.not.contain('<b>x</b>');
    //exactly one startup script, which still parses and round-trips
    expect(page.text.match(/<script/g)).to.have.length(1);
    expect(snapshotOf(page).client.name).to.equal(hostile);
    expect(page.text).to.contain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('J04: page HTML and startup data contain no session JWT, cookies, headers, PKCE/state or pending internals', async () => {
    const { browser, page } = await openApproval();
    const jwt = decodeURIComponent(browser.cookies.get('session')!);
    const continuation = decodeURIComponent(browser.cookies.get('oauth_continue')!);
    const props = startupProps(page.text);
    expect(page.text).to.not.contain(jwt);
    expect(page.text).to.not.contain(continuation);
    expect(page.text).to.not.contain(SESSION_SEED);
    expect(page.text).to.not.contain('state-123');
    expect(page.text).to.not.contain(CODE_VERIFIER);
    expect(page.text).to.not.match(/code_challenge|oauthp_|binding/i);
    expect(props.session.token).to.equal('');
    expect(props.request.headers).to.deep.equal({});
    expect(props.request.session).to.deep.equal({});
    expect(props.request.data).to.deep.equal({});
    expect(props.request.url.search).to.equal('');
    expect(Object.keys(props.data).sort()).to.deep.equal([ 'brand', 'language', 'oauth', 'view' ]);
  });

  it('J04: approving redirects to the checked return address with code, state and iss, and the code exchanges with the original verifier', async () => {
    const { browser, page } = await openApproval();
    const response = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page),
      action: 'approve',
      'scope[]': [ 'articles:read' ],
      'operation[]': [ 'articles.detail' ]
    });
    expect(response.status).to.equal(302);
    const location = new URL(response.location!);
    expect(`${location.origin}${location.pathname}`).to.equal(REDIRECT);
    expect(location.searchParams.get('state')).to.equal('state-123');
    expect(location.searchParams.get('iss')).to.equal('http://localhost');
    const code = location.searchParams.get('code')!;
    expect(code).to.be.a('string');
    //never a token in the browser redirect
    expect(response.location).to.not.match(/access_token|refresh_token/);
    const token = await app.browser().request('POST', `${BASE}/token`, {
      form: {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: CODE_VERIFIER,
        resource: RESOURCE
      }
    });
    expect(token.status).to.equal(200);
    const body = JSON.parse(token.text);
    expect(body.token_type).to.equal('Bearer');
    expect(body.scope).to.equal('articles:read');
    //the approved grant covers exactly the narrowed selection
    const grants = await app.store.listGrantsForProfile('alice');
    const latest = grants.find((grant) => grant.scopes.join(' ') === 'articles:read');
    expect(latest).to.not.equal(undefined);
  });

  it('J04: a duplicate submit shows the local completion page and issues no second code', async () => {
    const { browser, page } = await openApproval();
    const form = { ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ] };
    const first = await browser.post(`${BASE}/authorize`, form);
    expect(first.status).to.equal(302);
    const before = (await app.engine.query<any>('SELECT id FROM oauth_code')).length;
    const second = await browser.post(`${BASE}/authorize`, form);
    expect(second.status).to.equal(200);
    expect(snapshotOf(second).state).to.equal('completed');
    expect(second.text).to.contain('nothing new was issued');
    const after = (await app.engine.query<any>('SELECT id FROM oauth_code')).length;
    expect(after).to.equal(before);
    //revisiting after the program lost the callback explains restart
    const revisit = await browser.get(`${BASE}/authorize`);
    expect(snapshotOf(revisit).state).to.equal('completed');
    expect(revisit.text).to.contain('start signing in again');
  });

  it('J04: deny returns access_denied with the original state and iss to the checked address only', async () => {
    const { browser, page } = await openApproval();
    const response = await browser.post(`${BASE}/authorize`, { ...csrfOf(page), action: 'deny' });
    expect(response.status).to.equal(302);
    const location = new URL(response.location!);
    expect(`${location.origin}${location.pathname}`).to.equal(REDIRECT);
    expect(location.searchParams.get('error')).to.equal('access_denied');
    expect(location.searchParams.get('state')).to.equal('state-123');
    expect(location.searchParams.get('iss')).to.equal('http://localhost');
    expect(location.searchParams.has('code')).to.equal(false);
    const again = await browser.get(`${BASE}/authorize`);
    expect(snapshotOf(again).state).to.equal('denied');
  });

  it('tampered hidden fields cannot add access: an unrequested scope or operation redisplays and approves nothing', async () => {
    const { browser, page } = await openApproval();
    const grantsBefore = (await app.store.listGrantsForProfile('alice')).length;
    let latest = page;
    for (const form of [
      { 'scope[]': [ 'articles:read', 'admin:everything' ] },
      { 'scope[]': [ 'articles:read' ], 'operation[]': [ 'secret.operation' ] }
    ]) {
      const response = await browser.post(`${BASE}/authorize`, {
        ...csrfOf(latest), action: 'approve', ...form
      });
      latest = response;
      expect(response.status).to.equal(409);
      const data = snapshotOf(response);
      expect(data.state).to.equal('approve');
      expect(data.notice).to.equal('selection_changed');
      expect(data.scopes.map((s: any) => s.id)).to.not.include('admin:everything');
    }
    expect((await app.store.listGrantsForProfile('alice')).length).to.equal(grantsBefore);
  });

  it('forged forms: a missing or wrong CSRF token changes nothing and redisplays with a fresh token', async () => {
    const { browser, page } = await openApproval();
    const missing = await browser.post(`${BASE}/authorize`, { action: 'approve', 'scope[]': [ 'articles:read' ] });
    expect(missing.status).to.equal(419);
    expect(snapshotOf(missing).notice).to.equal('form_expired');
    const wrong = await browser.post(`${BASE}/authorize`, { csrf: 'forged', action: 'deny' });
    expect(wrong.status).to.equal(419);
    //a token passed only in the query string is not accepted
    const token = csrfOf(page).csrf;
    const query = await browser.request('POST', `${BASE}/authorize?csrf=${token}`, {
      form: { action: 'deny' }
    });
    expect(query.status).to.equal(419);
    //still pending: the real form works afterwards
    const latest = snapshotOf(query);
    const ok = await browser.post(`${BASE}/authorize`, { [latest.csrf.name]: latest.csrf.token, action: 'deny' });
    expect(ok.status).to.equal(302);
  });

  it('cross-browser pending reuse: another browser without the cookie gets the lost page; a copied cookie under another account is refused', async () => {
    const { browser, page } = await openApproval('alice');
    expect(snapshotOf(page).state).to.equal('approve');
    const other = app.browser();
    await app.signIn(other, 'bobby', `${BASE}/authorize`);
    const lost = await other.get(`${BASE}/authorize`);
    expect(lost.status).to.equal(400);
    expect(snapshotOf(lost).state).to.equal('lost');
    other.cookies.set('oauth_continue', browser.cookies.get('oauth_continue')!);
    const stolen = await other.get(`${BASE}/authorize`);
    expect(stolen.status).to.equal(403);
    expect(snapshotOf(stolen).state).to.equal('wrong_account');
    expect(snapshotOf(stolen).client).to.equal(undefined);
    //even a submit (here without any CSRF token) is refused as another
    //account's request before anything else is considered
    const submit = await other.post(`${BASE}/authorize`, { action: 'approve' });
    expect(submit.status).to.equal(403);
    expect(snapshotOf(submit).state).to.equal('wrong_account');
    expect((await app.store.listGrantsForProfile('bobby')).length).to.equal(0);
  });

  it('role/policy change between page load and submit redisplays instead of approving', async () => {
    const { browser, page } = await openApproval();
    //the app now only allows reading
    app.policy.approval = (input) => ({
      allowed: true,
      scopes: input.scopes.filter((scope) => scope === 'articles:read'),
      operations: []
    });
    const response = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve',
      'scope[]': [ 'articles:read', 'articles:write' ], 'operation[]': [ 'articles.detail' ]
    });
    expect(response.status).to.equal(409);
    const data = snapshotOf(response);
    expect(data.notice).to.equal('selection_changed');
    expect(data.scopes.map((s: any) => s.id)).to.deep.equal([ 'articles:read' ]);
    expect(data.operations).to.deep.equal([]);
  });

  it('client change between page load and submit (return address removed) stays on a local error page', async () => {
    const { browser, page } = await openApproval();
    const client = await app.store.getClientByClientId(clientId);
    await app.engine.query(
      'UPDATE oauth_client SET metadata = ? WHERE client_id = ?',
      [ JSON.stringify({ ...client!.metadata, redirect_uris: [ 'http://127.0.0.1:1/other' ] }), clientId ]
    );
    try {
      const response = await browser.post(`${BASE}/authorize`, { ...csrfOf(page), action: 'approve' });
      expect(response.status).to.equal(400);
      expect(response.location).to.equal(null);
      expect(snapshotOf(response).state).to.equal('invalid_request');
    } finally {
      await app.engine.query(
        'UPDATE oauth_client SET metadata = ? WHERE client_id = ?',
        [ JSON.stringify(client!.metadata), clientId ]
      );
    }
  });

  it('policy denial explains the refusal and offers only deny', async () => {
    app.policy.approval = () => ({ allowed: false });
    const { browser, page } = await openApproval();
    expect(page.status).to.equal(403);
    const data = snapshotOf(page);
    expect(data.state).to.equal('policy_denied');
    expect(page.text).to.not.contain('value="approve"');
    const denied = await browser.post(`${BASE}/authorize`, { ...csrfOf(page), action: 'approve' });
    expect(denied.status).to.equal(403);
    const deny = await browser.post(`${BASE}/authorize`, { ...csrfOf(denied), action: 'deny' });
    expect(new URL(deny.location!).searchParams.get('error')).to.equal('access_denied');
  });

  it('a policy narrowing a submitted selection redisplays for review instead of granting a different set', async () => {
    const { browser, page } = await openApproval();
    app.policy.approval = (input) => input.scopes.length === 2
      ? { allowed: true, scopes: input.scopes, operations: input.operations }
      : { allowed: true, scopes: [], operations: [] };
    const response = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(response.status).to.equal(409);
    expect(snapshotOf(response).notice).to.equal('selection_changed');
    app.policy.approval = (input) => input.scopes.length === 2
      ? { allowed: true, scopes: input.scopes, operations: input.operations }
      : { allowed: false };
    const refused = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(response), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(refused.status).to.equal(403);
    expect(snapshotOf(refused).notice).to.equal('selection_denied');
  });

  it('J07: a suspended account is refused on display and submit without approving or denying', async () => {
    const { browser, page } = await openApproval('carol');
    expect(snapshotOf(page).state).to.equal('approve');
    await app.suspend('carol');
    const shown = await browser.get(`${BASE}/authorize`);
    expect(shown.status).to.equal(403);
    expect(snapshotOf(shown).state).to.equal('inactive');
    const submit = await browser.post(`${BASE}/authorize`, { ...csrfOf(page), action: 'approve' });
    expect(submit.status).to.equal(403);
    expect(snapshotOf(submit).state).to.equal('inactive');
    const pending = await app.engine.query<any>(
      'SELECT status FROM oauth_pending WHERE profile_id = ?', [ 'carol' ]
    );
    expect(pending.map((row: any) => row.status)).to.deep.equal([ 'pending' ]);
  });

  it('expired and lost pending state show local restart instructions and issue nothing', async () => {
    const { browser } = await openApproval();
    await app.engine.query(
      'UPDATE oauth_pending SET expires = ? WHERE profile_id = ? AND status = ?',
      [ new Date(Date.now() - 1000), 'alice', 'pending' ]
    );
    const expired = await browser.get(`${BASE}/authorize`);
    expect(expired.status).to.equal(410);
    expect(snapshotOf(expired).state).to.equal('expired');
    expect(expired.text).to.contain('start signing in again');
    browser.cookies.delete('oauth_continue');
    const lost = await browser.get(`${BASE}/authorize`);
    expect(lost.status).to.equal(400);
    expect(snapshotOf(lost).state).to.equal('lost');
  });

  it('unsafe or unknown return addresses and clients stay on a local error page without redirecting', async () => {
    const browser = app.browser();
    for (const query of [
      app.authorizeQuery(clientId, { redirect_uri: 'https://evil.example/callback' }),
      app.authorizeQuery('unknown-client'),
      app.authorizeQuery(clientId, { redirect_uri: 'javascript:alert(1)' })
    ]) {
      const response = await browser.get(query);
      expect(response.status).to.equal(400);
      expect(response.location).to.equal(null);
      expect(snapshotOf(response).state).to.equal('invalid_request');
      expect(response.text).to.not.contain('evil.example');
    }
    expect(browser.cookies.has('oauth_continue')).to.equal(false);
    //repeated parameters are malformed
    const repeated = await browser.get(`${app.authorizeQuery(clientId)}&state=second`);
    expect(repeated.status).to.equal(400);
    //a problem after the client and return address are checked goes back
    //to the checked address with the original state and iss
    const badScope = await browser.get(app.authorizeQuery(clientId, { scope: 'not:configured' }));
    expect(badScope.status).to.equal(302);
    const location = new URL(badScope.location!);
    expect(location.searchParams.get('error')).to.equal('invalid_scope');
    expect(location.searchParams.get('state')).to.equal('state-123');
  });

  it('a guest POST is sent to sign-in and nothing changes', async () => {
    const browser = app.browser();
    await startSignedOut(browser);
    const response = await browser.post(`${BASE}/authorize`, { action: 'approve' });
    expect(response.status).to.equal(303);
    expect(response.location).to.contain('/auth/signin?redirect_uri=');
  });
});
