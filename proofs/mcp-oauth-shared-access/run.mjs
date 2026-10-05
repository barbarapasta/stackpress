//node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
//modules
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
//client
import { digest } from './access.mjs';
import { startFixture } from './fixture.mjs';

const fixture = await startFixture();
const checks = [];
let client;
let tokens;
let information;
let verifier;
let redirect;
let redirects = 0;
let saves = 0;

// use the SDK OAuth protocol directly without a custom resource validator
const provider = {
  redirectUrl: 'http://127.0.0.1:19999/callback',
  clientMetadata: {
    client_name: 'SDK shared access proof',
    redirect_uris: [ 'http://127.0.0.1:19999/callback' ],
    grant_types: [ 'authorization_code', 'refresh_token' ],
    response_types: [ 'code' ],
    token_endpoint_auth_method: 'none'
  },
  clientInformation: () => information,
  saveClientInformation: value => { information = value; },
  tokens: () => tokens,
  saveTokens: value => { tokens = value; saves++; },
  saveCodeVerifier: value => { verifier = value; },
  codeVerifier: () => verifier,
  state: () => 'fixture-state',
  redirectToAuthorization: value => { redirect = value; redirects++; }
};

/** Saves only a test name and result, never credentials. */
async function check(name, run) {
  try {
    await run();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, error: error.code || error.name });
    throw error;
  }
}

/** Makes an ordinary API call with the current or supplied key. */
function api(path, method = 'GET', token = tokens.access_token) {
  return fetch(`${fixture.origin}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
}

/** Makes a raw MCP call to observe the exact HTTP status before SDK retries. */
function mcp(name, token = tokens.access_token) {
  return fetch(fixture.mcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} }
    })
  });
}

/** Posts a code or refresh request while preserving the exact resource field. */
function tokenRequest(body) {
  return fetch(`${fixture.origin}/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: information.client_id, ...body })
  });
}

/** Completes the explicit fixture approval form and validates its return state. */
async function approve(url) {
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('simulated signed-in user'));
  assert.ok(html.includes(`GET ${fixture.origin}/api/articles`));
  assert.ok(!html.includes(`GET ${fixture.origin}/api/omitted`));
  const pending = html.match(/name="pending" value="([^"]+)"/)[1];
  const approval = await fetch(`${fixture.origin}/approve`, {
    method: 'POST', body: new URLSearchParams({ pending }), redirect: 'manual'
  });
  assert.equal(approval.status, 302);
  const callback = new URL(approval.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'fixture-state');
  assert.equal(callback.searchParams.get('iss'), fixture.origin);
  return callback.searchParams.get('code');
}

try {
  await check('SDK discovery and registration select exact declared service', async () => {
    client = new Client({ name: 'anonymous-proof-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(fixture.mcpUrl), {
      authProvider: provider
    });
    await client.connect(transport);
    await client.callTool({ name: 'public_ping', arguments: {} });
    await assert.rejects(
      client.callTool({ name: 'read_articles', arguments: {} }),
      error => error.name === 'Error' && error.message === 'Unauthorized'
    );
    await client.close();
    assert.equal(redirect.searchParams.get('resource'), fixture.resource);
    assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(fixture.records.grants.size, 0);
  });
  let code;
  await check('Approval lists exact service members and preserves state and issuer', async () => {
    code = await approve(redirect);
  });
  await check('Authorization refuses a different return host or callback path', async () => {
    for (const uri of [ 'http://localhost:19999/callback', 'http://127.0.0.1:19999/other' ]) {
      const altered = new URL(redirect);
      altered.searchParams.set('redirect_uri', uri);
      assert.equal((await fetch(altered)).status, 400);
    }
  });
  await check('Code exchange cannot switch the approved resource', async () => {
    const response = await tokenRequest({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: provider.redirectUrl, resource: `${fixture.origin}/other`
    });
    assert.equal((await response.json()).error, 'invalid_target');
  });
  await check('PKCE mismatch refuses code before successful SDK exchange', async () => {
    const response = await tokenRequest({
      grant_type: 'authorization_code', code,
      redirect_uri: provider.redirectUrl, resource: fixture.resource,
      code_verifier: 'wrong-verifier-but-valid-format-aaaaaaaaaaaaaaaaa'
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_grant');
  });
  await check('SDK exchanges code for full id:secret and renewal token', async () => {
    assert.equal(await auth(provider, {
      serverUrl: fixture.mcpUrl, authorizationCode: code
    }), 'AUTHORIZED');
    assert.ok(tokens.access_token.includes(':'));
    assert.ok(tokens.refresh_token);
    assert.equal(tokens.scope, 'articles:read articles:write');
  });
  await check('Consumed authorization code cannot issue another key', async () => {
    const response = await tokenRequest({
      grant_type: 'authorization_code', code, code_verifier: verifier,
      redirect_uri: provider.redirectUrl, resource: fixture.resource
    });
    assert.equal(response.status, 400);
  });
  await check('SDK connects and calls a protected tool with issued key', async () => {
    client = new Client({ name: 'shared-proof-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(fixture.mcpUrl), {
      authProvider: provider
    }));
    const result = await client.callTool({ name: 'read_articles', arguments: {} });
    assert.equal(JSON.parse(result.content[0].text).user, 'fixture-user');
  });
  await check('Same key serves an explicitly enabled ordinary API route', async () => {
    assert.equal((await api('/api/articles')).status, 200);
  });
  await check('Read ID works for GET API and configured GET MCP tool', async () => {
    const id = tokens.access_token.split(':')[0];
    assert.equal((await api('/api/articles', 'GET', id)).status, 200);
    assert.equal((await mcp('read_articles', id)).status, 200);
  });
  await check('Read ID cannot write through either surface', async () => {
    const id = tokens.access_token.split(':')[0];
    assert.equal((await api('/api/articles', 'POST', id)).status, 401);
    assert.equal((await mcp('write_articles', id)).status, 401);
  });
  await check('Full key writes on both approved surfaces', async () => {
    assert.equal((await api('/api/articles', 'POST')).status, 200);
    assert.equal((await mcp('write_articles')).status, 200);
  });
  await check('Bad full key never falls back to its valid read ID or legacy entry', async () => {
    const invalid = `${tokens.access_token.split(':')[0]}:wrong`;
    fixture.records.legacy.set(invalid, true);
    assert.equal((await api('/api/articles', 'GET', invalid)).status, 401);
    assert.equal((await mcp('read_articles', invalid)).status, 401);
    assert.equal((await mcp('public_ping', invalid)).status, 401);
  });
  await check('One matching permission satisfies a nonempty list on both surfaces', async () => {
    const grant = Array.from(fixture.records.grants.values())[0];
    assert.ok(!grant.scopes.includes('other:read'));
    assert.equal((await api('/api/articles')).status, 200);
    assert.equal((await mcp('read_articles')).status, 200);
  });
  await check('Empty configured list refuses API but permits protected MCP', async () => {
    assert.equal((await api('/api/empty')).status, 403);
    assert.equal((await mcp('empty_permissions')).status, 200);
  });
  await check('User approval cannot become an application identity', async () => {
    const grant = Array.from(fixture.records.grants.values())[0];
    grant.members.push(`GET ${fixture.origin}/api/app`);
    assert.equal((await api('/api/app')).status, 403);
    assert.equal((await mcp('app_only')).status, 403);
  });
  await check('Wrong permission is refused on both surfaces', async () => {
    assert.equal((await api('/api/admin')).status, 403);
    assert.equal((await mcp('admin_only')).status, 403);
  });
  await check('Public MCP works anonymously but protected MCP refuses', async () => {
    assert.equal((await mcp('public_ping', '')).status, 200);
    assert.equal((await mcp('read_articles', '')).status, 401);
  });
  await check('Omitted and disabled route settings refuse OAuth keys', async () => {
    assert.equal((await api('/api/omitted')).status, 403);
    assert.equal((await api('/api/disabled')).status, 403);
    // even explicitly adding membership cannot bypass the opt-in setting
    const grant = Array.from(fixture.records.grants.values())[0];
    grant.members.push(`GET ${fixture.origin}/api/omitted`, `GET ${fixture.origin}/api/disabled`);
    assert.equal((await api('/api/omitted')).status, 403);
    assert.equal((await api('/api/disabled')).status, 403);
  });
  await check('Stub legacy dispatcher remains separate on omitted and disabled endpoints', async () => {
    fixture.records.legacy.set('legacy-fixture-key', true);
    assert.equal((await api('/api/omitted', 'GET', 'legacy-fixture-key')).status, 200);
    assert.equal((await api('/api/disabled', 'GET', 'legacy-fixture-key')).status, 200);
  });
  await check('Same host or a matching MCP path prefix grants no membership', async () => {
    assert.equal((await api('/api/other')).status, 403);
    assert.equal((await api('/mcp/unapproved')).status, 403);
  });
  await check('Adding an enabled route cannot expand an existing approval', async () => {
    fixture.routes.set('/api/later', { oauth: true, type: 'user', scopes: [ 'articles:read' ] });
    assert.equal((await api('/api/later')).status, 403);
  });
  await check('Resource and membership are independent checks', async () => {
    const grant = Array.from(fixture.records.grants.values())[0];
    grant.members.push(`GET ${fixture.origin}/api/other`);
    assert.equal((await api('/api/other')).status, 403);
  });
  await check('Wrong authorization resources are rejected exactly', async () => {
    for (const resource of [ fixture.origin, `${fixture.resource}/`, `${fixture.origin}/api/articles`, 'https://other.example/mcp' ]) {
      const altered = new URL(redirect);
      altered.searchParams.set('resource', resource);
      assert.equal((await fetch(altered)).status, 400);
    }
  });
  await check('Missing and duplicate resource indicators cannot be silently selected', async () => {
    const missing = new URL(redirect);
    missing.searchParams.delete('resource');
    assert.equal((await fetch(missing)).status, 400);
    const duplicate = new URL(redirect);
    duplicate.searchParams.append('resource', `${fixture.origin}/other`);
    assert.equal((await fetch(duplicate)).status, 400);
    const response = await fetch(`${fixture.origin}/token`, {
      method: 'POST',
      body: new URLSearchParams([
        [ 'grant_type', 'refresh_token' ],
        [ 'client_id', information.client_id ],
        [ 'refresh_token', tokens.refresh_token ],
        [ 'resource', `${fixture.origin}/other` ],
        [ 'resource', fixture.resource ]
      ])
    });
    assert.equal(response.status, 400);
  });
  const refresh = tokens.refresh_token;
  await check('Renewal cannot replace the approved resource or add permissions', async () => {
    for (const resource of [ fixture.origin, `${fixture.resource}/child`, 'https://other.example/mcp' ]) {
      const response = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, resource });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'invalid_target');
    }
    const response = await tokenRequest({
      grant_type: 'refresh_token', refresh_token: refresh,
      resource: fixture.resource, scope: 'articles:read admin:write'
    });
    assert.equal((await response.json()).error, 'invalid_scope');
  });
  const original = tokens.access_token;
  const grant = Array.from(fixture.records.grants.values())[0];
  const deadline = grant.deadline;
  await check('SDK automatically renews expired key and retries MCP call', async () => {
    fixture.expireAll();
    const before = saves;
    await client.callTool({ name: 'read_articles', arguments: {} });
    assert.equal(saves, before + 1);
    assert.equal(redirects, 1);
    assert.notEqual(tokens.access_token, original);
    assert.equal(grant.deadline, deadline);
  });
  await check('Renewal preserves both surfaces and exact membership', async () => {
    assert.equal((await api('/api/articles')).status, 200);
    assert.equal((await api('/api/later')).status, 403);
    assert.equal((await api('/api/other')).status, 403);
    assert.equal((await mcp('write_articles')).status, 200);
    const requests = fixture.trace.filter(entry => entry.stage === 'token');
    assert.ok(requests.some(entry => entry.grantType === 'refresh_token' && entry.resource === fixture.resource));
  });
  await check('Old full key and old read ID stay invalid after renewal', async () => {
    assert.equal((await api('/api/articles', 'GET', original)).status, 401);
    assert.equal((await mcp('read_articles', original.split(':')[0])).status, 401);
  });
  await check('Removed permissions take effect on the next API and MCP call', async () => {
    const originalScopes = grant.scopes;
    grant.scopes = [];
    assert.equal((await api('/api/articles')).status, 403);
    assert.equal((await mcp('read_articles')).status, 403);
    assert.equal((await mcp('empty_permissions')).status, 200);
    grant.scopes = originalScopes;
  });
  await check('Inactive user blocks API and MCP immediately', async () => {
    grant.active = false;
    assert.equal((await api('/api/articles')).status, 401);
    assert.equal((await mcp('read_articles')).status, 401);
    grant.active = true;
  });
  await check('Approval deadline caps issuance and stops access and renewal', async () => {
    grant.deadline = Date.now() + 2500;
    const short = fixture.records.issue(grant);
    assert.ok(short.expires_in <= 2);
    grant.deadline = Date.now() - 1;
    assert.equal((await api('/api/articles', 'GET', short.access_token)).status, 401);
    assert.equal((await mcp('read_articles', short.access_token.split(':')[0])).status, 401);
    const response = await tokenRequest({
      grant_type: 'refresh_token', refresh_token: short.refresh_token, resource: fixture.resource
    });
    assert.equal(response.status, 400);
    grant.deadline = deadline;
  });
  await check('Reusing a spent renewal token cancels its family on both surfaces', async () => {
    const response = await tokenRequest({
      grant_type: 'refresh_token', refresh_token: refresh, resource: fixture.resource
    });
    assert.equal(response.status, 400);
    assert.equal((await api('/api/articles')).status, 401);
    assert.equal((await mcp('read_articles')).status, 401);
  });
  await check('Explicit disconnect stops both surfaces and renewal', async () => {
    // reset only to isolate the separate disconnect operation from reuse detection
    grant.revoked = false;
    fixture.revokeAll();
    assert.equal((await api('/api/articles')).status, 401);
    assert.equal((await mcp('read_articles')).status, 401);
    const response = await tokenRequest({
      grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: fixture.resource
    });
    assert.equal(response.status, 400);
  });
  await check('Record maps store hashes of read IDs, secrets, and renewals', async () => {
    assert.ok(!fixture.records.access.has(tokens.access_token.split(':')[0]));
    const access = fixture.records.access.get(digest(tokens.access_token.split(':')[0]));
    assert.equal(access.secret, digest(tokens.access_token.split(':')[1]));
    assert.ok(!fixture.records.renewal.has(tokens.refresh_token));
  });
} catch (error) {
  process.stderr.write(`${checks.at(-1)?.name}: ${error.name}\n`);
  process.exitCode = 1;
} finally {
  await client?.close();
  await fixture.close();
  const sdk = JSON.parse(await readFile(new URL('../../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url)));
  const result = {
    node: process.version, sdk: sdk.version,
    passed: checks.filter(check => check.passed).length,
    failed: checks.filter(check => !check.passed).length,
    candidateOnly: true,
    checks,
    trace: fixture.trace
  };
  await writeFile(new URL('./results.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ passed: result.passed, failed: result.failed })}\n`);
}
