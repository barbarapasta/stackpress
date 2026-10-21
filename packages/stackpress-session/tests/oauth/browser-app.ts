//Real-stack harness for the task 00007 browser pages. Not a *.test.ts file
//(mocha's unquoted glob never picks it up).
//
//Boots a real @stackpress/ingest HTTP server on an ephemeral loopback port
//with the real session, auth, csrf and oauth plugins, the real OAuthStore
//plus the real ProfileActions/AuthActions over one in-memory PGlite engine
//(corrected Inquire d5f5a07 override), and drives it with a cookie-keeping
//fetch client. Sign-in goes through the real /auth/signin/username page and
//`auth-signin` event, so the browser session is a real signed session JWT.
//
//The only stand-ins are what an app normally supplies itself: the generated
//`profile-detail`/`auth-search` events (thin listeners over the real
//ProfileActions/AuthActions), the two app policy listeners, and the view
//renderer, which server-renders the real OAuth view components with
//react-dom/server and embeds the exact props as startup JSON the way the
//Reactus document does, so tests can inspect both the HTML and the
//serialized startup data.
import type { AddressInfo } from 'node:net';
import type { Server as NodeServer } from 'node:http';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import Engine from '@stackpress/inquire/Engine';
import Connection from '@stackpress/inquire-pglite/Connection';
import { server as http, action } from '@stackpress/ingest/http';
import csrfPlugin from 'stackpress-csrf/plugin';
import authPlugin from '../../src/auth/plugin.js';
import sessionPlugin from '../../src/session/plugin.js';
import oauthPlugin from '../../src/oauth/plugin.js';
import AuthActions from '../../src/auth/AuthActions.js';
import ProfileActions from '../../src/profile/ProfileActions.js';
import OAuthStore from '../../src/oauth/storage/OAuthStore.js';
import { createAllOAuthTables } from '../../src/oauth/storage/tables.js';
import { computeS256Challenge } from '../../src/oauth/pkce.js';
import { generateTOTP } from '../../src/session/helpers.js';
import type {
  OAuthApprovalPolicyInput,
  OAuthApprovalPolicyResult,
  OAuthPlugin
} from '../../src/oauth/types.js';
import { decodeSnapshot } from '../../src/oauth/views/snapshot.js';
import * as AuthorizeView from '../../src/oauth/views/authorize.js';
import * as FactorView from '../../src/oauth/views/factor.js';
import * as ConnectionsView from '../../src/oauth/views/connections.js';

export const SESSION_SEED = 'browser-test-session-seed-0123456789';
export const RESOURCE = 'http://localhost/mcp';
export const BASE = '/auth/oauth2';
export const REDIRECT = 'http://127.0.0.1:47123/callback';
export const CODE_VERIFIER = 'browser-test-code-verifier-0123456789-abcdefghijklmnop';
export const CODE_CHALLENGE = computeS256Challenge(CODE_VERIFIER);
export const PASSWORD = 'Password1!';

export type PolicyFn = (input: OAuthApprovalPolicyInput) =>
  OAuthApprovalPolicyResult | Promise<OAuthApprovalPolicyResult>;

export const allowAll: PolicyFn = (input) => ({
  allowed: true,
  scopes: input.scopes,
  operations: input.operations
});

export const requireFactor: PolicyFn = (input) => ({
  allowed: true,
  scopes: input.scopes,
  operations: input.operations,
  requireFactor: true
});

const VIEWS: Record<string, any> = {
  'stackpress-session/esm/oauth/views/authorize': AuthorizeView,
  'stackpress-session/esm/oauth/views/factor': FactorView,
  'stackpress-session/esm/oauth/views/connections': ConnectionsView
};

/**
 * Server-renders the real view module and embeds the props exactly the
 * way Reactus' document template does: raw `JSON.stringify(props)` put
 * into `<script id="props" type="text/json">` with `String.replace` - no
 * `<` escaping - so tests see the same startup-data exposure a real page
 * has.
 */
export const DOCUMENT_TEMPLATE = '<!DOCTYPE html><html><head><!--document-head--></head>' +
  '<body><div id="root"><!--document-body--></div>' +
  '<script id="props" type="text/json"><!--document-props--></script></body></html>';

export function renderView(entry: string, props: any): string {
  const view = VIEWS[entry];
  if (!view) throw new Error(`unexpected view entry ${entry}`);
  const head = renderToString(createElement(view.Head, props));
  const body = renderToString(createElement(view.default, props));
  return DOCUMENT_TEMPLATE
    .replace('<!--document-head-->', head)
    .replace('<!--document-body-->', body)
    .replace('<!--document-props-->', JSON.stringify(props));
}

export type TestResponse = {
  status: number,
  location: string | null,
  text: string,
  headers: Headers,
  setCookies: string[]
};

/**
 * Minimal browser: keeps cookies per jar, never follows redirects.
 */
export class TestBrowser {
  public readonly cookies = new Map<string, string>();
  constructor(public readonly origin: string) {}

  async request(
    method: string,
    path: string,
    options: {
      form?: Record<string, string | string[]>,
      json?: unknown,
      headers?: Record<string, string>
    } = {}
  ): Promise<TestResponse> {
    const headers: Record<string, string> = { ...(options.headers || {}) };
    if (this.cookies.size) {
      headers.cookie = Array.from(this.cookies.entries())
        .map(([ name, value ]) => `${name}=${value}`).join('; ');
    }
    let body: string | undefined;
    if (options.form) {
      const params = new URLSearchParams();
      for (const [ name, value ] of Object.entries(options.form)) {
        for (const item of Array.isArray(value) ? value : [ value ]) {
          params.append(name, item);
        }
      }
      body = params.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (typeof options.json !== 'undefined') {
      body = JSON.stringify(options.json);
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(`${this.origin}${path}`, {
      method, headers, body, redirect: 'manual'
    });
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      const [ pair, ...attributes ] = line.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      const name = pair.substring(0, index);
      const value = pair.substring(index + 1);
      const expired = attributes.some((attribute) => {
        const lower = attribute.toLowerCase();
        return lower === 'max-age=0' || (lower.startsWith('expires=') &&
          new Date(attribute.substring(8)).getTime() <= Date.now());
      });
      if (expired || value === '') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return {
      status: response.status,
      location: response.headers.get('location'),
      text: await response.text(),
      headers: response.headers,
      setCookies
    };
  }

  get(path: string, headers?: Record<string, string>) {
    return this.request('GET', path, { headers });
  }

  post(path: string, form: Record<string, string | string[]>) {
    return this.request('POST', path, { form });
  }
}

/**
 * The startup JSON a page embedded (the exact props the view received).
 */
export function startupProps(html: string): any {
  const match = html.match(/<script id="props" type="text\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('no startup data in page');
  return JSON.parse(match[1]);
}

export function snapshotOf(response: TestResponse): any {
  return decodeSnapshot(startupProps(response.text).data.oauth);
}

export function csrfOf(response: TestResponse): Record<string, string> {
  const csrf = snapshotOf(response).csrf;
  return { [csrf.name]: csrf.token };
}

export type BrowserApp = Awaited<ReturnType<typeof startBrowserApp>>;

export async function startBrowserApp(options: {
  oauth?: Record<string, unknown>,
  access?: Record<string, unknown>,
  finalize?: boolean,
  render?: (entry: string, props: any) => string | null
} = {}) {
  const resource = new PGlite();
  const engine = new Engine(new Connection(resource));
  for (const create of createAllOAuthTables()) {
    create.engine = engine;
    await create;
  }
  const profiles = new ProfileActions(engine, 'db-seed');
  const auths = new AuthActions(engine, { seed: 'db-seed' });
  await profiles.install();
  await auths.install();

  const policy: { approval: PolicyFn, calls: OAuthApprovalPolicyInput[] } = {
    approval: allowAll,
    calls: []
  };

  const app = http();
  app.config.set({
    auth: { base: '/auth', password: {} },
    brand: { name: 'Test App' },
    cookie: { path: '/' },
    csrf: { name: 'csrf' },
    database: { seed: 'db-seed' },
    language: { key: 'locale', locale: 'en_US', languages: {} },
    session: {
      key: 'session',
      seed: SESSION_SEED,
      ...(options.access ? { access: options.access } : {}),
      oauth: {
        issuer: 'http://localhost',
        development: true,
        base: BASE,
        resources: [ {
          resource: RESOURCE,
          name: 'Blog service',
          description: 'Tools and approved API operations',
          scopes: [ 'articles:read', 'articles:write' ]
        } ],
        scopes: {
          'articles:read': { name: 'Read articles', description: 'Read your articles' },
          'articles:write': { name: 'Change articles', description: 'Change your articles' }
        },
        policy: {
          approval: 'test-oauth-approval',
          access: 'test-oauth-access',
          timeoutMs: 2000
        },
        limits: { authorization: 1000, registration: 1000, token: 1000 },
        ...(options.oauth || {})
      }
    }
  });
  app.register('database', engine);
  authPlugin(app as any);
  sessionPlugin(app as any);
  oauthPlugin(app as any);
  csrfPlugin(app as any);
  await app.resolve('config');
  await app.resolve('listen');
  await app.resolve('route');

  //the app's generated store events, backed by the real store actions
  app.on('profile-detail', action(async ({ req, res }) => {
    const found = await profiles.find({ eq: { id: String(req.data('id')) } });
    if (!found) {
      res.setError({ code: 404, error: 'Not Found' });
      return;
    }
    res.results(found as any);
  }));
  app.on('auth-search', action(async ({ req, res }) => {
    res.results(await auths.findAll(req.data() as any) as any);
  }));
  //the app's two policy listeners
  app.on('test-oauth-approval', action(async ({ req, res }) => {
    const input = req.data() as unknown as OAuthApprovalPolicyInput;
    policy.calls.push(input);
    res.results(await policy.approval(input) as any);
  }));
  app.on('test-oauth-access', action(async ({ res }) => {
    res.results({ allowed: true });
  }));
  const oauth = app.plugin<OAuthPlugin>('oauth');
  oauth.registerApiOperation({
    id: 'articles.detail',
    surface: 'api',
    method: 'GET',
    route: '/api/articles/:id',
    event: 'article-detail',
    resources: [ RESOURCE ],
    scopes: [ 'articles:read' ],
    data: {}
  });
  const rendered: Array<{ entry: string, props: any }> = [];
  app.view.render = (entry: string, props?: any) => {
    rendered.push({ entry, props });
    return options.render ? options.render(entry, props) : renderView(entry, props);
  };
  if (options.finalize !== false) {
    await oauth.finalize();
  }

  const listener: NodeServer = app.create();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const store = new OAuthStore(engine);

  const factorSecrets = new Map<string, string>();

  async function createAccount(id: string, extra: { twoFA?: string, roles?: string[] } = {}) {
    if (extra.twoFA) factorSecrets.set(id, extra.twoFA);
    await profiles.create({ id, name: `${id} name`, type: 'person', roles: extra.roles || [ 'USER' ] } as any);
    await auths.create({ profileId: id, type: 'username', token: id, secret: PASSWORD } as any);
    if (extra.twoFA) {
      await auths.create({ profileId: id, type: '2fa', token: extra.twoFA, secret: extra.twoFA } as any);
    }
  }

  async function suspend(id: string) {
    await profiles.update({ eq: { id } }, { active: false } as any);
  }

  async function signIn(browser: TestBrowser, username: string, redirect = '/') {
    const page = await browser.get(`/auth/signin/username?redirect_uri=${encodeURIComponent(redirect)}`);
    const token = browser.cookies.get('csrf');
    if (!token) throw new Error(`no csrf cookie from sign-in page (${page.status})`);
    const response = await browser.post(
      `/auth/signin/username?redirect_uri=${encodeURIComponent(redirect)}`,
      { csrf: decodeURIComponent(token), username, secret: PASSWORD }
    );
    //accounts with 2FA complete the app's existing sign-in 2FA step
    if (response.location && response.location.includes('/auth/signin/2fa/')) {
      const secret = factorSecrets.get(username);
      if (!secret) throw new Error('sign-in asked for 2FA on an account without a secret');
      await browser.get(response.location);
      const challenge = browser.cookies.get('csrf');
      const second = await browser.post(response.location, {
        csrf: decodeURIComponent(challenge || ''),
        code: generateTOTP(secret)
      });
      if (!browser.cookies.get('session')) {
        throw new Error(`2FA sign-in did not set a session cookie (${second.status})`);
      }
      return second;
    }
    if (!browser.cookies.get('session')) {
      throw new Error(`sign-in did not set a session cookie (${response.status})`);
    }
    return response;
  }

  async function registerClient(name: string, redirects = [ REDIRECT ]) {
    const response = await new TestBrowser(origin).request('POST', `${BASE}/register`, {
      json: { redirect_uris: redirects, client_name: name }
    });
    if (response.status !== 201) {
      throw new Error(`client registration failed: ${response.status} ${response.text}`);
    }
    return JSON.parse(response.text).client_id as string;
  }

  function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: 'S256',
      state: 'state-123',
      resource: RESOURCE,
      scope: 'articles:read articles:write',
      ...extra
    });
    return `${BASE}/authorize?${params.toString()}`;
  }

  async function close() {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await resource.close();
  }

  return {
    app, engine, store, origin, policy, rendered, oauth,
    createAccount, suspend, signIn, registerClient, authorizeQuery, close,
    browser: () => new TestBrowser(origin)
  };
}
