//node
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
//modules
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport }
  from '@modelcontextprotocol/sdk/client/streamableHttp.js';
//client
import type { Grant } from './candidate.mjs';
import { Candidate } from './candidate.mjs';
import { LegacyCandidate } from './legacy-candidate.mjs';
import { close, listen, report } from './fixture.mjs';

const legacy = process.argv.includes('--legacy');
const path = legacy ? '/sse' : '/mcp';
const candidate = legacy ? new LegacyCandidate() : new Candidate('stateful');
const grant: Grant = { person: 'alice', client: 'fixture-client', approval: 'a',
  scopes: [ 'read' ], revoked: false, active: true };
let tokens: OAuthTokens | undefined;
let verifier = '';
let redirect: URL | undefined;
let exchanges = 0;
let renewals = 0;
const resources: string[] = [];

/** Read callback state after the asynchronous SDK operation completes. */
function authorizationUrl() {
  assert.ok(redirect);
  return redirect;
}

//this deliberately tiny authorization server proves SDK transport behavior;
// it does not claim to implement approval pages, secure codes or persistence
const service = createServer(async (req, res) => {
  const base = candidate.base;
  const pathname = req.url?.split('?')[0];
  const json = (value: object, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json',
      'cache-control': 'no-store' }).end(JSON.stringify(value));
  };
  if (pathname === `/.well-known/oauth-protected-resource${path}`) {
    json({ resource: `${base}${path}`, authorization_servers: [ base ],
      scopes_supported: [ 'read', 'write' ], bearer_methods_supported: [ 'header' ] });
  } else if (pathname === '/.well-known/oauth-authorization-server') {
    json({ issuer: base, authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`, response_types_supported: [ 'code' ],
      grant_types_supported: [ 'authorization_code', 'refresh_token' ],
      token_endpoint_auth_methods_supported: [ 'none' ],
      code_challenge_methods_supported: [ 'S256' ],
      scopes_supported: [ 'read', 'write' ] });
  } else if (pathname === '/token') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    resources.push(body.get('resource') || '');
    if (body.get('grant_type') === 'refresh_token') {
      renewals++;
      if (grant.revoked) { json({ error: 'invalid_grant' }, 400); return; }
    } else {
      exchanges++;
      assert.equal(body.get('code'), 'fixture-code');
      assert.equal(body.get('code_verifier'), verifier);
      if (redirect?.searchParams.get('scope')?.includes('write')) {
        grant.scopes = [ 'read', 'write' ];
      }
    }
    const access = candidate.issue(grant);
    json({ access_token: access, token_type: 'Bearer', expires_in: 900,
      refresh_token: 'disposable-fixture-refresh', scope: grant.scopes.join(' ') });
  } else {
    await candidate.dispatch(req, res);
  }
});
candidate.base = await listen(service);

const provider: OAuthClientProvider = {
  redirectUrl: 'http://127.0.0.1:39871/callback',
  clientMetadata: { redirect_uris: [ 'http://127.0.0.1:39871/callback' ],
    token_endpoint_auth_method: 'none', grant_types: [ 'authorization_code',
      'refresh_token' ], response_types: [ 'code' ] },
  clientInformation() { return { client_id: 'fixture-client' }; },
  tokens() { return tokens; },
  saveTokens(value) { tokens = value; },
  redirectToAuthorization(url) { redirect = url; },
  saveCodeVerifier(value) { verifier = value; },
  codeVerifier() { return verifier; },
  invalidateCredentials(scope) {
    if (scope === 'tokens' || scope === 'all') tokens = undefined;
  }
};
const transport = legacy
  ? new SSEClientTransport(new URL(`${candidate.base}${path}`), { authProvider: provider })
  : new StreamableHTTPClientTransport(
  new URL(`${candidate.base}${path}`), { authProvider: provider,
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1,
      maxReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 } });
const client = new Client({ name: 'real-sdk-client-proof', version: '1' });
const checks: object[] = [];
try {
  await client.connect(transport);
  assert.equal(redirect, undefined);
  const publicCall = await client.callTool({ name: 'public' });
  assert.match(JSON.stringify(publicCall), /public/);
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(tool => tool.name), [ 'public', 'read', 'write' ]);
  await assert.rejects(client.callTool({ name: 'read' }), /Unauthorized/);
  assert.ok(redirect);
  assert.equal(authorizationUrl().searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl().searchParams.get('resource'), `${candidate.base}${path}`);
  checks.push({ name: 'anonymous mixed tools', result:
    'initialize and public call do not login; protected call triggers SDK authorization URL with resource and S256' });
  //the real application would open a browser and receive a real issued code
  // feeding a fixture code here tests the client continuation only
  await transport.finishAuth('fixture-code');
  const approved = await client.callTool({ name: 'read' });
  assert.match(JSON.stringify(approved), /alice/);
  assert.equal(exchanges, 1);
  checks.push({ name: 'approval continuation', result:
    'SDK code exchange and retry succeed on previously anonymous session' });
  candidate.now += 901;
  const renewed = await client.callTool({ name: 'read' });
  assert.match(JSON.stringify(renewed), /alice/);
  assert.equal(renewals, 1);
  checks.push({ name: 'automatic renewal', result:
    'HTTP401 causes SDK refresh and automatic retry; approval identity stays the same' });
  grant.scopes = [ 'read' ];
  redirect = undefined;
  await assert.rejects(client.callTool({ name: 'write' }),
    legacy ? /HTTP 403/ : /403 after trying upscoping/);
  assert.equal(redirect, undefined);
  assert.deepEqual(grant.scopes, [ 'read' ]);
  checks.push({ name: 'automatic permission escalation with refresh token',
    result: 'SDK limitation reproduced', observation: legacy
      ? 'older SSE client does not handle403 for OAuth; no approval opens'
      : '403 causes refresh with old scope; repeated403 stops without opening approval' });
  //prove the consumer can explicitly restart consent, without widening refresh
  // this is a client recovery action, not an automatic server guarantee
  tokens = { ...tokens!, refresh_token: undefined };
  await client.callTool({ name: 'public' });
  if (legacy) {
    assert.equal(await auth(provider, {
      serverUrl: new URL(`${candidate.base}${path}`), scope: 'write'
    }), 'REDIRECT');
  } else {
    await assert.rejects(client.callTool({ name: 'write' }), /Unauthorized/);
  }
  assert.ok(redirect);
  assert.match(authorizationUrl().searchParams.get('scope') || '', /write/);
  checks.push({ name: 'explicit client permission recovery', result: legacy
    ? 'client explicitly calls SDK auth helper after discarding refresh credential'
    : 'after client discards refresh credential,403 starts approval for write' });
  await transport.finishAuth('fixture-code');
  assert.match(JSON.stringify(await client.callTool({ name: 'write' })), /alice/);
  grant.revoked = true;
  redirect = undefined;
  await assert.rejects(client.callTool({ name: 'read' }), /Unauthorized/);
  assert.ok(redirect);
  checks.push({ name: 'disconnect', result:
    'revoked key denied; failed refresh starts approval again, no protected effect' });
  assert.ok(resources.length >= 4);
  assert.ok(resources.every(resource => resource === `${candidate.base}${path}`));
  checks.push({ name: 'resource binding', result:
    'SDK sends exact MCP resource on every tested exchange and renewal' });
} finally {
  await client.close();
  await candidate.close();
  await close(service);
}
await report(legacy ? 'legacy-sdk-client' : 'sdk-client', checks);
