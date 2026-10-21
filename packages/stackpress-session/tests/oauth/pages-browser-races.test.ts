import { describe, it, before, after, beforeEach } from 'mocha';
import { expect } from 'chai';
import { generateTOTP, generateSecret } from '../../src/session/helpers.js';
import type { OAuthApprovalPolicyInput } from '../../src/oauth/types.js';
import {
  BASE,
  allowAll,
  csrfOf,
  requireFactor,
  snapshotOf,
  startBrowserApp
} from './browser-app.js';
import type { BrowserApp } from './browser-app.js';

//Changes that land between the page's own fresh checks and the
//`oauth-authorize` event's re-check, plus store outages, against the real
//store. The page's submit invokes the approval policy twice (offered set,
//then the exact selection); the third call is the event's own re-check.
describe('OAuth browser pages: races and store failures (task 00007)', function () {
  //real HTTP server + PGlite boot; slower than mocha's 2s default under load
  this.timeout(30_000);
  let app: BrowserApp;
  let clientId: string;
  const secret = generateSecret();

  before(async () => {
    app = await startBrowserApp();
    clientId = await app.registerClient('Race Program');
    await app.createAccount('racer');
    await app.createAccount('factorace', { twoFA: secret });
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    app.policy.approval = allowAll;
  });

  async function openApproval(username = 'racer') {
    const browser = app.browser();
    await app.signIn(browser, username);
    await browser.get(app.authorizeQuery(clientId));
    const page = await browser.get(`${BASE}/authorize`);
    return { browser, page };
  }

  //runs `onEventCall` when the policy is asked for the third time
  function onEventRecheck(onEventCall: (input: OAuthApprovalPolicyInput) => any) {
    let calls = 0;
    app.policy.approval = async (input) => {
      calls++;
      if (calls === 3) return await onEventCall(input);
      return { allowed: true, scopes: input.scopes, operations: input.operations };
    };
  }

  async function pendingId() {
    const rows = await app.engine.query<any>(
      'SELECT id FROM oauth_pending WHERE profile_id = ? AND status = ? ORDER BY created DESC',
      [ 'racer', 'pending' ]
    );
    return rows[0].id as string;
  }

  it('a policy change caught only by the event re-check redisplays instead of approving', async () => {
    const { browser, page } = await openApproval();
    onEventRecheck(() => ({ allowed: false }));
    const response = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(response.status).to.equal(409);
    expect(snapshotOf(response).notice).to.equal('selection_changed');
    expect((await app.store.listGrantsForProfile('racer')).length).to.equal(0);
  });

  it('a request resolved elsewhere at the same moment shows the completion page', async () => {
    const { browser, page } = await openApproval();
    const id = await pendingId();
    onEventRecheck(async () => {
      await app.store.denyPending(id);
      return { allowed: false };
    });
    const response = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(response.status).to.equal(200);
    expect(snapshotOf(response).state).to.equal('completed');
  });

  it('a request expiring at the same moment shows the restart page and issues nothing', async () => {
    const { browser, page } = await openApproval();
    const id = await pendingId();
    onEventRecheck(async (input) => {
      await app.engine.query('UPDATE oauth_pending SET expires = ? WHERE id = ?', [ new Date(Date.now() - 1000), id ]);
      return { allowed: true, scopes: input.scopes, operations: input.operations };
    });
    const response = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(response.status).to.equal(410);
    expect(snapshotOf(response).state).to.equal('expired');
    expect((await app.store.listGrantsForProfile('racer')).length).to.equal(0);
  });

  it('a failed approval write issues no code and offers another attempt while the request is valid', async () => {
    const { browser, page } = await openApproval();
    await app.engine.query(`CREATE OR REPLACE FUNCTION oauth_test_refuse_grant() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated storage failure'; END; $$ LANGUAGE plpgsql`);
    await app.engine.query(`CREATE TRIGGER oauth_test_refuse_grant BEFORE INSERT ON oauth_grant
      FOR EACH ROW EXECUTE FUNCTION oauth_test_refuse_grant()`);
    let retry;
    try {
      retry = await browser.post(`${BASE}/authorize`, {
        ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
      });
      expect(retry.status).to.equal(503);
      expect(snapshotOf(retry).notice).to.equal('retry');
      expect(retry.text).to.contain('Nothing was approved');
      expect(retry.location).to.equal(null);
    } finally {
      await app.engine.query('DROP TRIGGER oauth_test_refuse_grant ON oauth_grant');
      await app.engine.query('DROP FUNCTION oauth_test_refuse_grant()');
    }
    //the saved request is still usable: the retry now succeeds
    const again = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(retry!), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    expect(again.status).to.equal(302);
  });

  it('store outages on start, approval POST and factor checks refuse with a retry page (never skip the limit)', async () => {
    const { browser, page } = await openApproval();
    await app.engine.query('ALTER TABLE oauth_rate_bucket RENAME TO oauth_rate_bucket_hidden');
    try {
      const start = await app.browser().get(app.authorizeQuery(clientId));
      expect(start.status).to.equal(503);
      expect(snapshotOf(start).state).to.equal('unavailable');
      const post = await browser.post(`${BASE}/authorize`, {
        ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
      });
      expect(post.status).to.equal(503);
      expect(snapshotOf(post).state).to.equal('unavailable');
    } finally {
      await app.engine.query('ALTER TABLE oauth_rate_bucket_hidden RENAME TO oauth_rate_bucket');
    }
    await app.engine.query('ALTER TABLE oauth_pending RENAME TO oauth_pending_hidden');
    try {
      const start = await app.browser().get(app.authorizeQuery(clientId));
      expect(start.status).to.equal(500);
      expect(snapshotOf(start).state).to.equal('error');
    } finally {
      await app.engine.query('ALTER TABLE oauth_pending_hidden RENAME TO oauth_pending');
    }
  });

  it('factor page: store outages refuse without accepting the code; a denied or broken request is shown as finished/error', async () => {
    app.policy.approval = requireFactor;
    const browser = app.browser();
    await app.signIn(browser, 'factorace');
    await browser.get(app.authorizeQuery(clientId));
    const page = await browser.get(`${BASE}/authorize`);
    const toFactor = await browser.post(`${BASE}/authorize`, {
      ...csrfOf(page), action: 'approve', 'scope[]': [ 'articles:read' ]
    });
    const factor = await browser.get(toFactor.location!);
    const form = () => ({
      ...csrfOf(factor), code: generateTOTP(secret), 'scope[]': [ 'articles:read' ]
    });
    await app.engine.query('ALTER TABLE oauth_rate_bucket RENAME TO oauth_rate_bucket_hidden');
    try {
      const limited = await browser.post(`${BASE}/factor`, form());
      expect(limited.status).to.equal(503);
      expect(snapshotOf(limited).state).to.equal('unavailable_service');
    } finally {
      await app.engine.query('ALTER TABLE oauth_rate_bucket_hidden RENAME TO oauth_rate_bucket');
    }
    const again = await browser.get(toFactor.location!);
    await app.engine.query('ALTER TABLE oauth_factor_use RENAME TO oauth_factor_use_hidden');
    try {
      const failed = await browser.post(`${BASE}/factor`, {
        ...csrfOf(again), code: generateTOTP(secret), 'scope[]': [ 'articles:read' ]
      });
      expect(failed.status).to.equal(503);
      expect(snapshotOf(failed).state).to.equal('unavailable_service');
    } finally {
      await app.engine.query('ALTER TABLE oauth_factor_use_hidden RENAME TO oauth_factor_use');
    }
    const receipts = await app.engine.query<any>(
      'SELECT factor_receipt FROM oauth_pending WHERE profile_id = ? AND factor_receipt IS NOT NULL',
      [ 'factorace' ]
    );
    expect(receipts).to.have.length(0);
    //the client lost its return address: factor page shows an error
    const client = await app.store.getClientByClientId(clientId);
    await app.engine.query('UPDATE oauth_client SET metadata = ? WHERE client_id = ?', [
      JSON.stringify({ ...client!.metadata, redirect_uris: [] }), clientId
    ]);
    try {
      const broken = await browser.get(toFactor.location!);
      expect(broken.status).to.equal(400);
      expect(snapshotOf(broken).state).to.equal('error');
    } finally {
      await app.engine.query('UPDATE oauth_client SET metadata = ? WHERE client_id = ?', [
        JSON.stringify(client!.metadata), clientId
      ]);
    }
    //denied requests are finished
    const deny = await browser.post(`${BASE}/authorize`, { ...csrfOf(again), action: 'deny' });
    expect(deny.status).to.equal(302);
    const finished = await browser.get(`${BASE}/factor`);
    expect(snapshotOf(finished).state).to.equal('completed');
  });
});
