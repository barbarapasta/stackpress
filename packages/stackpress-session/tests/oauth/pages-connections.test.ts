import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import {
  BASE,
  CODE_VERIFIER,
  REDIRECT,
  RESOURCE,
  csrfOf,
  snapshotOf,
  startBrowserApp,
  startupProps
} from './browser-app.js';
import type { BrowserApp, TestBrowser } from './browser-app.js';

//J13/J14 (and J07 for the list) through the real stack.
describe('OAuth browser /connections pages (task 00007, real session/store)', function () {
  //real HTTP server + PGlite boot; slower than mocha's 2s default under load
  this.timeout(30_000);
  let app: BrowserApp;
  let clientId: string;

  before(async () => {
    app = await startBrowserApp();
    clientId = await app.registerClient('Connected <b>Program</b>');
    for (const id of [ 'connie', 'conrad', 'emptyuser', 'sleepy' ]) {
      await app.createAccount(id);
    }
  });

  after(async () => {
    await app.close();
  });

  //full real approval + token exchange; returns the issued access key
  async function connect(browser: TestBrowser) {
    await browser.get(app.authorizeQuery(clientId));
    const page = await browser.get(`${BASE}/authorize`);
    const approved = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ], 'operation[]': [ 'articles.detail' ]
    });
    const code = new URL(approved.location!).searchParams.get('code')!;
    const token = await app.browser().request('POST', `${BASE}/token`, {
      form: {
        grant_type: 'authorization_code', client_id: clientId, code,
        redirect_uri: REDIRECT, code_verifier: CODE_VERIFIER, resource: RESOURCE
      }
    });
    return JSON.parse(token.text) as { access_token: string, refresh_token?: string };
  }

  async function signedIn(username: string) {
    const browser = app.browser();
    await app.signIn(browser, username);
    return browser;
  }

  function verify(accessToken: string) {
    return app.app.resolve('oauth-token-verify', {
      token: accessToken, resource: RESOURCE, surface: 'api', method: 'GET',
      requiredCredential: 'read', operation: 'articles.detail'
    });
  }

  it('J14: a signed-out person is sent to sign-in with a safe return to the list', async () => {
    const response = await app.browser().get(`${BASE}/connections`);
    expect(response.status).to.equal(302);
    expect(response.location).to.equal(
      `/auth/signin?redirect_uri=${encodeURIComponent(`${BASE}/connections`)}`
    );
    const post = await app.browser().post(`${BASE}/connections/revoke`, { grant: 'x' });
    expect(post.status).to.equal(303);
  });

  it('J13: shows an empty state with a link back to account settings', async () => {
    const browser = await signedIn('emptyuser');
    const response = await browser.get(`${BASE}/connections`);
    expect(response.status).to.equal(200);
    expect(response.headers.get('cache-control')).to.equal('no-store');
    const data = snapshotOf(response);
    expect(data.state).to.equal('list');
    expect(data.connections).to.deep.equal([]);
    expect(response.text).to.contain('No programs are connected to your account.');
    expect(response.text).to.contain('href="/auth/account"');
    expect(response.text).to.contain('Back to account settings');
  });

  it('J13: lists only the person\'s own approvals as safe summaries with escaped names and no key material', async () => {
    const browser = await signedIn('connie');
    const issued = await connect(browser);
    const other = await signedIn('conrad');
    await connect(other);
    const response = await browser.get(`${BASE}/connections`);
    const data = snapshotOf(response);
    expect(data.connections).to.have.length(1);
    const row = data.connections[0];
    expect(row.client.name).to.equal('Connected <b>Program</b>');
    expect(row.resource.name).to.equal('Blog service');
    expect(row.scopes).to.deep.equal([ { id: 'articles:read', name: 'Read articles' } ]);
    expect(row.operations).to.deep.equal([ 'articles.detail' ]);
    expect(response.text).to.not.contain('<b>Program</b>');
    expect(response.text).to.contain('Connected &lt;b&gt;Program&lt;/b&gt;');
    expect(response.text).to.match(/aria-label="Disconnect Connected &lt;b&gt;Program&lt;\/b&gt;"/);
    //no access key, renewal token, hash or session JWT in HTML/startup data
    const [ grant ] = await app.store.listGrantsForProfile('connie');
    expect(response.text).to.not.contain(issued.access_token.split(':')[0]);
    expect(response.text).to.not.contain(issued.access_token);
    if (issued.refresh_token) expect(response.text).to.not.contain(issued.refresh_token);
    expect(response.text).to.not.contain(String(grant.readIdHash));
    expect(response.text).to.not.contain(String(grant.fullKeyHash));
    expect(response.text).to.not.contain(decodeURIComponent(browser.cookies.get('session')!));
    expect(response.text).to.not.contain('conrad');
    const props = startupProps(response.text);
    expect(props.session.token).to.equal('');
    expect(props.request.headers).to.deep.equal({});
  });

  it('J13: disconnect is confirmed only after it is saved, ends API/MCP access and can be repeated', async () => {
    const browser = await signedIn('connie');
    const issued = await connect(browser);
    expect((await verify(issued.access_token)).code).to.equal(200);
    const list = await browser.get(`${BASE}/connections`);
    const target = snapshotOf(list).connections.find((row: any) => row.grantId)!;
    const grants = await app.store.listGrantsForProfile('connie');
    const newest = grants.sort((a, b) => b.approved.getTime() - a.approved.getTime())[0];
    const response = await browser.post(`${BASE}/connections/revoke`, {
      ...csrfOf(list), grant: newest.id
    });
    expect(response.status).to.equal(200);
    const data = snapshotOf(response);
    expect(data.result).to.equal('disconnected');
    expect(data.resultName).to.equal('Connected <b>Program</b>');
    expect(response.text).to.contain('role="status"');
    expect(data.connections.map((row: any) => row.grantId)).to.not.include(newest.id);
    expect(target).to.not.equal(undefined);
    //the cancellation is saved: the issued key no longer verifies
    expect((await verify(issued.access_token)).code).to.not.equal(200);
    const [ row ] = await app.engine.query<any>('SELECT active FROM oauth_grant WHERE id = ?', [ newest.id ]);
    expect(row.active).to.equal(false);
    //repeating the cancellation of an already-cancelled own approval succeeds
    const again = await browser.post(`${BASE}/connections/revoke`, {
      ...csrfOf(response), grant: newest.id
    });
    expect(again.status).to.equal(200);
    expect(snapshotOf(again).result).to.equal('disconnected');
  });

  it('J13: another person\'s or an unknown approval is reported unavailable without revealing its owner', async () => {
    const browser = await signedIn('connie');
    const list = await browser.get(`${BASE}/connections`);
    const [ foreign ] = await app.store.listGrantsForProfile('conrad');
    const response = await browser.post(`${BASE}/connections/revoke`, {
      ...csrfOf(list), grant: foreign.id
    });
    expect(response.status).to.equal(404);
    expect(snapshotOf(response).result).to.equal('not_found');
    expect(response.text).to.not.contain('conrad');
    const [ row ] = await app.engine.query<any>('SELECT active FROM oauth_grant WHERE id = ?', [ foreign.id ]);
    expect(row.active).to.equal(true);
    const unknown = await browser.post(`${BASE}/connections/revoke`, {
      ...csrfOf(response), grant: 'oauthgrant_does_not_exist'
    });
    expect(unknown.status).to.equal(404);
    const missing = await browser.post(`${BASE}/connections/revoke`, { ...csrfOf(unknown) });
    expect(missing.status).to.equal(404);
  });

  it('J13: a forged disconnect form (no or wrong CSRF) changes nothing', async () => {
    const browser = await signedIn('conrad');
    const [ grant ] = await app.store.listGrantsForProfile('conrad');
    for (const form of [ { grant: grant.id }, { csrf: 'forged', grant: grant.id } ]) {
      const response = await browser.post(`${BASE}/connections/revoke`, form);
      expect(response.status).to.equal(419);
      expect(snapshotOf(response).result).to.equal('form_expired');
    }
    const [ row ] = await app.engine.query<any>('SELECT active FROM oauth_grant WHERE id = ?', [ grant.id ]);
    expect(row.active).to.equal(true);
  });

  it('J13: when saving fails, offers retry without claiming the cancellation succeeded', async () => {
    const browser = await signedIn('conrad');
    const list = await browser.get(`${BASE}/connections`);
    const [ grant ] = await app.store.listGrantsForProfile('conrad');
    await app.engine.query(`CREATE OR REPLACE FUNCTION oauth_test_refuse() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated storage failure'; END; $$ LANGUAGE plpgsql`);
    await app.engine.query(`CREATE TRIGGER oauth_test_refuse BEFORE UPDATE ON oauth_grant
      FOR EACH ROW WHEN (OLD.active AND NOT NEW.active) EXECUTE FUNCTION oauth_test_refuse()`);
    try {
      const response = await browser.post(`${BASE}/connections/revoke`, {
        ...csrfOf(list), grant: grant.id
      });
      expect(response.status).to.equal(503);
      const data = snapshotOf(response);
      expect(data.result).to.equal('failed');
      expect(response.text).to.contain('its access was not changed');
      expect(response.text).to.not.contain('was disconnected');
      expect(data.connections.map((row: any) => row.grantId)).to.include(grant.id);
    } finally {
      await app.engine.query('DROP TRIGGER oauth_test_refuse ON oauth_grant');
      await app.engine.query('DROP FUNCTION oauth_test_refuse()');
    }
  });

  it('J07: a suspended account cannot list or disconnect approvals', async () => {
    const browser = await signedIn('sleepy');
    await connect(browser);
    const list = await browser.get(`${BASE}/connections`);
    const [ grant ] = await app.store.listGrantsForProfile('sleepy');
    await app.suspend('sleepy');
    const shown = await browser.get(`${BASE}/connections`);
    expect(shown.status).to.equal(403);
    expect(snapshotOf(shown).state).to.equal('inactive');
    expect(snapshotOf(shown).connections).to.deep.equal([]);
    const post = await browser.post(`${BASE}/connections/revoke`, { ...csrfOf(list), grant: grant.id });
    expect(post.status).to.equal(403);
    const [ row ] = await app.engine.query<any>('SELECT active FROM oauth_grant WHERE id = ?', [ grant.id ]);
    expect(row.active).to.equal(true);
  });

  it('a program access key does not authorize the connections list', async () => {
    const browser = await signedIn('conrad');
    const issued = await connect(browser);
    const response = await app.browser().get(`${BASE}/connections`, {
      authorization: `Bearer ${issued.access_token}`
    });
    expect(response.status).to.equal(302);
    expect(response.location).to.contain('/auth/signin');
  });

  it('a store outage while listing shows a retry page', async () => {
    const browser = await signedIn('conrad');
    await app.engine.query('ALTER TABLE oauth_grant RENAME TO oauth_grant_hidden');
    try {
      const response = await browser.get(`${BASE}/connections`);
      expect(response.status).to.equal(503);
      expect(snapshotOf(response).state).to.equal('error');
      expect(response.text).to.contain('could not be loaded');
    } finally {
      await app.engine.query('ALTER TABLE oauth_grant_hidden RENAME TO oauth_grant');
    }
  });
});
