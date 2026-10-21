import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import { generateTOTP, generateSecret } from '../../src/session/helpers.js';
import { matchTotpCounter, factorIncarnation } from '../../src/oauth/pages/browser.js';
import {
  BASE,
  allowAll,
  csrfOf,
  requireFactor,
  snapshotOf,
  startBrowserApp
} from './browser-app.js';
import type { BrowserApp, TestBrowser } from './browser-app.js';

//J05/J06 with the existing TOTP mechanism, real session/store.
describe('OAuth browser /factor page (task 00007, real session/store)', function () {
  //real HTTP server + PGlite boot; slower than mocha's 2s default under load
  this.timeout(30_000);
  let app: BrowserApp;
  let clientId: string;
  const secrets: Record<string, string> = {};

  before(async () => {
    app = await startBrowserApp();
    clientId = await app.registerClient('Factor Test Program');
    for (const id of [ 'fiona', 'frank', 'felix', 'flora', 'fritz' ]) {
      secrets[id] = generateSecret();
      await app.createAccount(id, { twoFA: secrets[id] });
    }
    await app.createAccount('nofactor');
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    app.policy.approval = requireFactor;
  });

  async function openApproval(username: string) {
    const browser = app.browser();
    await browser.get(app.authorizeQuery(clientId));
    await app.signIn(browser, username, `${BASE}/authorize`);
    const page = await browser.get(`${BASE}/authorize`);
    return { browser, page };
  }

  async function toFactor(browser: TestBrowser, page: any, scopes: string[], operations: string[] = []) {
    const response = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': scopes, 'operation[]': operations
    });
    expect(response.status).to.equal(303);
    expect(response.location).to.match(new RegExp(`^${BASE}/factor\\?`));
    const factor = await browser.get(response.location!);
    return factor;
  }

  function factorForm(page: any, code: string) {
    const data = snapshotOf(page);
    return {
      [data.csrf.name]: data.csrf.token,
      code,
      'scope[]': data.scopes.map((scope: any) => scope.id),
      'operation[]': data.operations.map((operation: any) => operation.id)
    };
  }

  it('J05: requires the separate check, verifies a real TOTP code, saves a bound receipt and returns to approval', async () => {
    const { browser, page } = await openApproval('fiona');
    const approval = snapshotOf(page);
    expect(approval.factor).to.deep.equal({ required: true, verified: false });
    expect(page.text).to.contain('Continue to identity check');
    const factor = await toFactor(browser, page, [ 'articles:read' ]);
    expect(factor.status).to.equal(200);
    const data = snapshotOf(factor);
    expect(data.state).to.equal('verify');
    expect(data.scopes.map((s: any) => s.id)).to.deep.equal([ 'articles:read' ]);
    //accessible field: label, help text, one-time-code input
    expect(factor.text).to.contain('for="oauth-factor-code"');
    expect(factor.text).to.match(/autocomplete="one-time-code"/i);
    //a wrong code is a field error with retry
    const wrong = await browser.post(`${BASE}/factor`, factorForm(factor, '000000' === generateTOTP(secrets.fiona) ? '111111' : '000000'));
    expect(wrong.status).to.equal(400);
    expect(snapshotOf(wrong).error).to.equal('invalid_code');
    expect(wrong.text).to.contain('aria-invalid="true"');
    expect(wrong.text).to.contain('role="alert"');
    //the factor value never appears in the page
    expect(wrong.text).to.not.contain(secrets.fiona);
    const ok = await browser.post(`${BASE}/factor`, factorForm(wrong, generateTOTP(secrets.fiona)));
    expect(ok.status).to.equal(303);
    expect(ok.location).to.equal(`${BASE}/authorize`);
    const uses = await app.engine.query<any>('SELECT * FROM oauth_factor_use WHERE profile_id = ?', [ 'fiona' ]);
    expect(uses).to.have.length(1);
    expect(Number(uses[0].counter)).to.be.greaterThan(0);
    expect(JSON.stringify(uses[0])).to.not.contain(secrets.fiona);
    //Auth.consumed is untouched by the approval check
    const back = await browser.get(`${BASE}/authorize`);
    const verified = snapshotOf(back);
    expect(verified.factor).to.deep.equal({ required: true, verified: true });
    expect(verified.scopes.filter((s: any) => s.checked).map((s: any) => s.id)).to.deep.equal([ 'articles:read' ]);
    expect(back.text).to.not.match(/factorReceipt|receipt/i);
    const approve = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(back), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(approve.status).to.equal(302);
    expect(new URL(approve.location!).searchParams.get('code')).to.be.a('string');
  });

  it('J05: a receipt for the full selection (every scope and operation) is saved and approves', async () => {
    const { browser, page } = await openApproval('fiona');
    const factor = await toFactor(browser, page, [ 'articles:read', 'articles:write' ], [ 'articles.detail' ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    //a later time step than the code used in the first J05 test
    const ok = await browser.post(`${BASE}/factor`, factorForm(factor, generateTOTP(secrets.fiona, 1)));
    expect(ok.status).to.equal(303);
    const back = await browser.get(`${BASE}/authorize`);
    expect(snapshotOf(back).factor.verified).to.equal(true);
    const approve = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(back), action: 'approve',
      'scope[]': [ 'articles:read', 'articles:write' ], 'operation[]': [ 'articles.detail' ]
    });
    expect(approve.status).to.equal(302);
  });

  it('J05: changing the selection after the check invalidates the receipt and asks for a new check; nothing is approved', async () => {
    const { browser, page } = await openApproval('frank');
    const factor = await toFactor(browser, page, [ 'articles:read' ]);
    const ok = await browser.post(`${BASE}/factor`, factorForm(factor, generateTOTP(secrets.frank)));
    expect(ok.status).to.equal(303);
    const back = await browser.get(`${BASE}/authorize`);
    const widened = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(back), action: 'approve', 'scope[]': [ 'articles:read', 'articles:write' ]
    });
    expect(widened.status).to.equal(303);
    expect(widened.location).to.contain(`${BASE}/factor?`);
    expect((await app.store.listGrantsForProfile('frank')).length).to.equal(0);
    //a narrower selection than the one verified is also a change
    const back2 = await browser.get(`${BASE}/authorize`);
    const narrowed = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(back2), action: 'approve', 'scope[]': []
    });
    expect(narrowed.status).to.equal(303);
    expect(narrowed.location).to.contain(`${BASE}/factor?`);
    expect((await app.store.listGrantsForProfile('frank')).length).to.equal(0);
  });

  it('J05: the same TOTP code cannot mint a second receipt, even for a new request, and concurrent submits accept it once', async () => {
    const first = await openApproval('felix');
    const firstFactor = await toFactor(first.browser, first.page, [ 'articles:read' ]);
    const second = await openApproval('felix');
    const secondFactor = await toFactor(second.browser, second.page, [ 'articles:read' ]);
    const code = generateTOTP(secrets.felix);
    //two truly concurrent submissions of one code across two requests
    const [ a, b ] = await Promise.all([
      first.browser.post(`${BASE}/factor`, factorForm(firstFactor, code)),
      second.browser.post(`${BASE}/factor`, factorForm(secondFactor, code))
    ]);
    const statuses = [ a.status, b.status ].sort();
    expect(statuses).to.deep.equal([ 303, 409 ]);
    const loser = a.status === 409 ? a : b;
    expect(snapshotOf(loser).error).to.equal('code_reused');
    expect(loser.text).to.contain('already used');
    //retrying the same code later is still refused
    const retry = await (a.status === 409 ? first : second).browser.post(
      `${BASE}/factor`, factorForm(loser, code)
    );
    expect(retry.status).to.equal(409);
    const receipts = await app.engine.query<any>(
      'SELECT factor_receipt FROM oauth_pending WHERE profile_id = ? AND factor_receipt IS NOT NULL',
      [ 'felix' ]
    );
    expect(receipts).to.have.length(1);
  });

  it('J05: a receipt copied onto another request cannot approve it', async () => {
    const first = await openApproval('flora');
    const factor = await toFactor(first.browser, first.page, [ 'articles:read' ]);
    expect((await first.browser.post(`${BASE}/factor`, factorForm(factor, generateTOTP(secrets.flora)))).status).to.equal(303);
    const [ source ] = await app.engine.query<any>(
      'SELECT factor_receipt FROM oauth_pending WHERE profile_id = ? AND factor_receipt IS NOT NULL',
      [ 'flora' ]
    );
    const second = await openApproval('flora');
    await app.engine.query(
      'UPDATE oauth_pending SET factor_receipt = ? WHERE profile_id = ? AND factor_receipt IS NULL AND status = ?',
      [ source.factor_receipt, 'flora', 'pending' ]
    );
    const page = await second.browser.get(`${BASE}/authorize`);
    expect(snapshotOf(page).factor.verified).to.equal(false);
    const attempt = await second.browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(attempt.status).to.equal(303);
    expect(attempt.location).to.contain(`${BASE}/factor?`);
    expect((await app.store.listGrantsForProfile('flora')).length).to.equal(0);
  });

  it('J05: limits attempts per request before checking the code and says when to retry', async () => {
    const { browser, page } = await openApproval('fritz');
    let latest = await toFactor(browser, page, [ 'articles:read' ]);
    const valid = generateTOTP(secrets.fritz);
    const wrong = valid === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i++) {
      latest = await browser.post(`${BASE}/factor`, factorForm(latest, wrong));
      expect(latest.status).to.equal(400);
    }
    const limited = await browser.post(`${BASE}/factor`, factorForm(latest, valid));
    expect(limited.status).to.equal(429);
    expect(Number(limited.headers.get('retry-after'))).to.be.greaterThan(0);
    expect(snapshotOf(limited).error).to.equal('rate_limited');
    //even the valid code was not consumed or accepted while limited
    const uses = await app.engine.query<any>('SELECT * FROM oauth_factor_use WHERE profile_id = ?', [ 'fritz' ]);
    expect(uses).to.have.length(0);
  });

  it('J05: a forged factor form (no CSRF) changes nothing', async () => {
    const { browser, page } = await openApproval('fiona');
    const factor = await toFactor(browser, page, [ 'articles:read' ]);
    const { csrf, ...form } = factorForm(factor, generateTOTP(secrets.fiona)) as any;
    const forged = await browser.post(`${BASE}/factor`, form);
    expect(forged.status).to.equal(419);
    expect(snapshotOf(forged).error).to.equal('form_expired');
  });

  it('J06: a missing factor never approves silently on /authorize or /factor', async () => {
    const { browser, page } = await openApproval('nofactor');
    expect(page.status).to.equal(403);
    const data = snapshotOf(page);
    expect(data.state).to.equal('factor_unavailable');
    expect(page.text).to.not.contain('value="approve"');
    expect(data.links.factorSetup).to.contain('/auth/account/security/2fa?redirect_uri=');
    const forced = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(forced.status).to.equal(403);
    expect(snapshotOf(forced).state).to.equal('factor_unavailable');
    const factor = await browser.get(`${BASE}/factor?selected=1&scope=articles%3Aread`);
    expect(factor.status).to.equal(403);
    expect(snapshotOf(factor).state).to.equal('unavailable');
    expect((await app.store.listGrantsForProfile('nofactor')).length).to.equal(0);
    const pending = await app.engine.query<any>(
      'SELECT status FROM oauth_pending WHERE profile_id = ?', [ 'nofactor' ]
    );
    expect(pending.every((row: any) => row.status === 'pending')).to.equal(true);
    //cancelling sends the refusal back to the program
    const cancel = await browser.post(`${BASE}/authorize`, { ...csrfOf(forced), action: 'deny' });
    expect(new URL(cancel.location!).searchParams.get('error')).to.equal('access_denied');
  });

  it('J06: an app policy may explicitly allow ordinary approval without the factor', async () => {
    app.policy.approval = (input) => ({
      allowed: true, scopes: input.scopes, operations: input.operations, requireFactor: false
    });
    const { browser, page } = await openApproval('nofactor');
    expect(snapshotOf(page).state).to.equal('approve');
    expect(snapshotOf(page).factor.required).to.equal(false);
    //and the factor page sends the person back to approval
    const factor = await browser.get(`${BASE}/factor`);
    expect(factor.status).to.equal(303);
    expect(factor.location).to.equal(`${BASE}/authorize`);
  });

  it('factor page refuses stale selections, other accounts and suspended accounts', async () => {
    const { browser } = await openApproval('frank');
    const stale = await browser.get(`${BASE}/factor?selected=1&scope=admin%3Aall`);
    expect(stale.status).to.equal(303);
    expect(stale.location).to.equal(`${BASE}/authorize`);
    const guest = await app.browser().get(`${BASE}/factor`);
    expect(guest.status).to.equal(302);
    expect(guest.location).to.contain('/auth/signin?redirect_uri=');
    const lost = app.browser();
    await app.signIn(lost, 'flora', `${BASE}/authorize`);
    expect(snapshotOf(await lost.get(`${BASE}/factor`)).state).to.equal('lost');
    lost.cookies.set('oauth_continue', browser.cookies.get('oauth_continue')!);
    const other = await lost.get(`${BASE}/factor`);
    expect(other.status).to.equal(403);
    expect(snapshotOf(other).state).to.equal('wrong_account');
    await app.suspend('frank');
    const inactive = await browser.get(`${BASE}/factor`);
    expect(inactive.status).to.equal(403);
    expect(snapshotOf(inactive).state).to.equal('inactive');
  });

  it('matchTotpCounter uses the existing TOTP window and rejects malformed secrets', () => {
    const secret = generateSecret();
    const step = Math.floor(Date.now() / 30000);
    const counter = matchTotpCounter(generateTOTP(secret), secret);
    expect([ step, step + 1 ]).to.include(counter);
    expect(matchTotpCounter(generateTOTP(secret, -1), secret)).to.be.oneOf([ step - 1, step ]);
    expect(matchTotpCounter('000000', '!!!not-base32!!!')).to.equal(null);
    expect(factorIncarnation(secret)).to.not.contain(secret);
    expect(factorIncarnation(secret)).to.not.equal(factorIncarnation(generateSecret()));
  });

  it('when the policy no longer requires a factor, approval works without one (allowAll)', async () => {
    app.policy.approval = allowAll;
    const { page } = await openApproval('fiona');
    expect(snapshotOf(page).factor.required).to.equal(false);
  });
});
