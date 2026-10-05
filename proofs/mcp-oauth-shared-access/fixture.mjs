//node
import { createServer } from 'node:http';
//modules
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
//client
import { createRecords, digest, failure, randomToken } from './access.mjs';

/** Reads the small JSON or form body used by this loopback-only fixture. */
async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16384) throw failure(413, 'too_large');
  }
  if (!body) return {};
  return request.headers['content-type']?.includes('application/json')
    ? JSON.parse(body)
    : readForm(body);
}

/** Rejects duplicate form fields instead of silently taking the last value. */
function readForm(body) {
  const values = new URLSearchParams(body);
  for (const key of values.keys()) {
    if (values.getAll(key).length > 1) throw failure(400, 'invalid_request');
  }
  return Object.fromEntries(values);
}

/** Sends one JSON reply without caching credentials. */
function reply(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(body));
}

/** Escapes client-controlled strings in the illustrative consent page. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

/** Starts the isolated candidate OAuth server; no Stackpress code is changed. */
export async function startFixture(settings = {}) {
  const options = {
    accessSeconds: 900,
    approvalSeconds: 604800,
    requireAuthOnInitialize: false,
    ...settings
  };
  const records = createRecords(options);
  const trace = [];
  let origin;
  let resource;
  let metadataUrl;

  // all membership is explicit, including routes outside the MCP path
  const routes = new Map([
    [ '/api/articles', { oauth: true, type: 'user', scopes: [ 'articles:read', 'other:read' ] } ],
    [ '/api/empty', { oauth: true, type: 'user', scopes: [] } ],
    [ '/api/admin', { oauth: true, type: 'user', scopes: [ 'admin:write' ] } ],
    [ '/api/app', { oauth: true, type: 'app', scopes: [ 'articles:read' ] } ],
    [ '/api/omitted', { type: 'user', scopes: [ 'articles:read' ] } ],
    [ '/api/disabled', { oauth: false, type: 'user', scopes: [ 'articles:read' ] } ],
    [ '/api/other', { oauth: true, type: 'user', scopes: [ 'articles:read' ], otherResource: true } ],
    [ '/mcp/unapproved', { oauth: true, type: 'user', scopes: [ 'articles:read' ], unapproved: true } ]
  ]);
  const tools = new Map([
    [ 'public_ping', { method: 'GET', type: 'public', scopes: [] } ],
    [ 'read_articles', { method: 'GET', type: 'user', scopes: [ 'articles:read', 'other:read' ] } ],
    [ 'write_articles', { method: 'POST', type: 'user', scopes: [ 'articles:write' ] } ],
    [ 'empty_permissions', { method: 'GET', type: 'user', scopes: [] } ],
    [ 'app_only', { method: 'GET', type: 'app', scopes: [ 'articles:read' ] } ],
    [ 'admin_only', { method: 'POST', type: 'user', scopes: [ 'admin:write' ] } ]
  ]);

  /** Builds the exact operation list shown and saved during approval. */
  function members() {
    return [ 'mcp', ...Array.from(routes).filter(([, route ]) =>
      route.oauth === true && route.type === 'user'
      && !route.otherResource && !route.unapproved
    ).flatMap(([ path ]) => [ `GET ${origin}${path}`, `POST ${origin}${path}` ]) ];
  }

  /** Rejects missing, repeated, or different resource values. */
  function checkResource(value) {
    if (value !== resource) throw failure(400, 'invalid_target');
  }

  /** Records protocol shape but never a credential, state, or verifier. */
  function record(stage, body = {}) {
    trace.push({
      stage,
      resource: body.resource,
      scope: body.scope,
      grantType: body.grant_type,
      pkceMethod: body.code_challenge_method,
      hasVerifier: !!body.code_verifier,
      tool: body.tool,
      user: body.user,
      method: body.method,
      status: body.status
    });
    options.onTrace?.(trace.at(-1));
  }

  /** Issues a code only after the illustrative user approval form is posted. */
  function approve(body, response) {
    const pending = records.pending.get(body.pending);
    if (!pending || pending.deadline <= Date.now()) throw failure(400, 'invalid_request');
    records.pending.delete(body.pending);
    const grant = {
      id: randomToken(),
      client: pending.client_id,
      user: 'fixture-user',
      type: 'user',
      active: true,
      revoked: false,
      resource: pending.resource,
      members: pending.members,
      scopes: pending.scope.split(' ').filter(Boolean),
      deadline: Date.now() + options.approvalSeconds * 1000
    };
    records.grants.set(grant.id, grant);
    const code = randomToken();
    records.codes.set(digest(code), { ...pending, grant, used: false });
    const redirect = new URL(pending.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('iss', origin);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    record('approval', pending);
    response.writeHead(302, { Location: redirect.href, 'Cache-Control': 'no-store' });
    response.end();
  }

  /** Exchanges PKCE codes and rotates renewals with unchanged resource bounds. */
  function exchange(body, response) {
    checkResource(body.resource);
    record('token', body);
    let grant;
    if (body.grant_type === 'authorization_code') {
      const code = records.codes.get(digest(body.code || ''));
      if (!code || code.used || code.deadline <= Date.now()
        || code.client_id !== body.client_id || code.redirect_uri !== body.redirect_uri
        || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier || '')
        || digest(body.code_verifier) !== code.code_challenge) {
        throw failure(400, 'invalid_grant');
      }
      code.used = true;
      grant = code.grant;
    } else if (body.grant_type === 'refresh_token') {
      const renewal = records.renewal.get(digest(body.refresh_token || ''));
      if (!renewal || renewal.grant.client !== body.client_id) {
        throw failure(400, 'invalid_grant');
      }
      grant = renewal.grant;
      if (renewal.used) grant.revoked = true;
      if (grant.revoked || !grant.active || grant.deadline <= Date.now()) {
        throw failure(400, 'invalid_grant');
      }
      if (body.scope && body.scope.split(' ').some(scope => !grant.scopes.includes(scope))) {
        throw failure(400, 'invalid_scope');
      }
      renewal.used = true;
      if (body.scope) grant.scopes = body.scope.split(' ');
      for (const record of records.access.values()) {
        if (record.grant === grant) record.expires = 0;
      }
    } else {
      throw failure(400, 'unsupported_grant_type');
    }
    if (grant.resource !== body.resource || grant.revoked || !grant.active
      || grant.deadline <= Date.now()) throw failure(400, 'invalid_grant');
    reply(response, 200, records.issue(grant));
  }

  /** Uses the real SDK transport after authorization completes before headers. */
  async function handleMcp(request, response, body) {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const name = body.params?.name;
    const tool = body.method === 'tools/call' ? tools.get(name) : undefined;
    if (body.method === 'tools/call' && !tool) throw failure(404, 'unknown_tool');
    const operation = {
      surface: 'mcp', resource, member: 'mcp', method: 'GET',
      type: options.requireAuthOnInitialize ? 'user' : 'public', scopes: [],
      ...tool
    };
    let identity;
    try {
      identity = records.authorize(token, operation);
    } catch (error) {
      record('mcp-refused', { tool: name, method: body.method, status: error.status });
      throw error;
    }
    record('mcp-accepted', { tool: name, method: body.method, user: identity.user });
    const server = new McpServer({ name: 'stackpress-oauth-proof', version: '0.0.0' });
    for (const [ toolName, config ] of tools) {
      server.registerTool(toolName, {
        description: `Proof ${toolName}; ${config.type} access`,
        inputSchema: {}
      }, async () => {
        record('mcp-tool-completed', { tool: toolName, user: identity.user, status: 200 });
        return {
          content: [ { type: 'text', text: JSON.stringify({ tool: toolName, ...identity }) } ]
        };
      });
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    response.on('close', () => { void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  /** Handles discovery, consent, tokens, API routes, and the MCP transport. */
  async function handle(request, response) {
    const url = new URL(request.url, origin);
    const path = url.pathname;
    const body = request.method === 'POST' ? await readBody(request) : {};
    if (path === '/.well-known/oauth-protected-resource/mcp'
      || path === '/.well-known/oauth-protected-resource') {
      record('resource-discovery');
      return reply(response, 200, {
        resource, resource_name: 'Fixture service: MCP and approved article API',
        authorization_servers: [ origin ],
        scopes_supported: [ 'articles:read', 'articles:write' ],
        bearer_methods_supported: [ 'header' ]
      });
    }
    if (path === '/.well-known/oauth-authorization-server') {
      record('server-discovery');
      return reply(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: [ 'code' ],
        grant_types_supported: [ 'authorization_code', 'refresh_token' ],
        token_endpoint_auth_methods_supported: [ 'none' ],
        code_challenge_methods_supported: [ 'S256' ],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: [ 'articles:read', 'articles:write' ]
      });
    }
    if (path === '/register' && request.method === 'POST') {
      if (!Array.isArray(body.redirect_uris) || !body.redirect_uris.length) {
        throw failure(400, 'invalid_client_metadata');
      }
      for (const uri of body.redirect_uris) {
        const target = new URL(uri);
        if (target.hash || target.username || target.password
          || (target.protocol !== 'https:' && !(target.protocol === 'http:'
            && [ 'localhost', '127.0.0.1', '[::1]' ].includes(target.hostname)))) {
          throw failure(400, 'invalid_redirect_uri');
        }
      }
      const client = { ...body, client_id: randomToken(), token_endpoint_auth_method: 'none' };
      records.clients.set(client.client_id, client);
      record('registration');
      return reply(response, 201, client);
    }
    if (path === '/authorize' && request.method === 'GET') {
      const query = readForm(url.searchParams.toString());
      checkResource(query.resource);
      const client = records.clients.get(query.client_id);
      if (!client || !client.redirect_uris.includes(query.redirect_uri)) {
        throw failure(400, 'invalid_redirect_uri');
      }
      if (query.response_type !== 'code' || query.code_challenge_method !== 'S256'
        || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge || '')) {
        throw failure(400, 'invalid_request');
      }
      const scope = query.scope || 'articles:read articles:write';
      if (scope.split(' ').some(value => ![ 'articles:read', 'articles:write' ].includes(value))) {
        throw failure(400, 'invalid_scope');
      }
      const pending = randomToken();
      records.pending.set(pending, {
        ...query, scope, members: members(), deadline: Date.now() + 60000
      });
      record('authorization', query);
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><title>OAuth proof approval</title>
        <h1>Proof only: simulated signed-in user</h1>
        <p>Approve ${escapeHtml(client.client_name || 'client')} for ${escapeHtml(resource)}.</p>
        <p>Permissions: ${escapeHtml(scope)}. Return host: ${escapeHtml(new URL(query.redirect_uri).hostname)}.</p>
        <p>This service includes MCP and these explicitly approved API operations:</p>
        <pre>${escapeHtml(members().join('\n'))}</pre>
        <form method="post" action="/approve">
          <input type="hidden" name="pending" value="${pending}">
          <button>Approve fixture access</button>
        </form>`);
      return;
    }
    if (path === '/approve' && request.method === 'POST') return approve(body, response);
    if (path === '/token' && request.method === 'POST') return exchange(body, response);
    if (path === '/mcp') return handleMcp(request, response, body);
    if (routes.has(path)) {
      const route = routes.get(path);
      const identity = records.authorize(request.headers.authorization?.replace(/^Bearer /, ''), {
        ...route, surface: 'api', method: request.method,
        member: `${request.method} ${origin}${path}`,
        resource: route.otherResource ? `${origin}/other` : resource
      });
      return reply(response, 200, { ok: true, identity });
    }
    throw failure(404, 'not_found');
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(error => {
      const status = error.status || 500;
      const headers = status === 401 || status === 403 ? {
        'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl}", error="${
          status === 401 ? 'invalid_token' : 'insufficient_scope'
        }", scope="articles:read articles:write"`
      } : {};
      record('error', { scope: error.error || error.message });
      if (!response.headersSent) reply(response, status, { error: error.error || error.message }, headers);
      else response.end();
    });
  });
  await new Promise(resolve => server.listen(options.port || 0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  resource = `${origin}/mcp`;
  metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  return {
    origin, resource, metadataUrl, mcpUrl: resource, records, routes, tools, trace,
    revokeAll: records.revokeAll,
    expireAll: records.expireAll,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })
  };
}
