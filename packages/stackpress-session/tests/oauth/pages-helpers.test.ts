import { describe, it } from 'mocha';
import { expect } from 'chai';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import {
  sourceAddress,
  setNoStore,
  writeEventResult,
  applyOAuthCors,
  applyOAuthPreflight,
  singleFormField
} from '../../src/oauth/pages/helpers.js';
import { makePageReq, makePageRes } from './pages-test-helpers.js';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: [{
      resource: 'https://example.com/mcp',
      name: 'Example', description: 'desc',
      scopes: [ 'articles:read' ]
    }],
    scopes: { 'articles:read': { name: 'Read', description: 'Read' } },
    policy: { approval: 'approval-event', access: 'access-event' },
    ...overrides
  });
}

describe('OAuth pages/helpers sourceAddress', () => {
  it('reads the underlying connection peer address', () => {
    const req = makePageReq({ remoteAddress: '198.51.100.9' });
    expect(sourceAddress(req)).to.equal('198.51.100.9');
  });

  it('falls back to "unknown" when no socket is available', () => {
    const req = makePageReq({});
    (req as any).resource = {};
    expect(sourceAddress(req)).to.equal('unknown');
  });

  it('ignores a spoofed X-Forwarded-For header entirely', () => {
    //configuration.md: "Never trust arbitrary forwarded headers" - no
    //trusted-proxy setting exists in NormalizedOAuthSessionConfig, so the
    //real peer address is always used regardless of what a caller claims.
    const req = makePageReq({
      remoteAddress: '198.51.100.9',
      headers: { 'X-Forwarded-For': '10.0.0.1, 203.0.113.99' }
    });
    expect(sourceAddress(req)).to.equal('198.51.100.9');
  });

  it('ignores a spoofed Forwarded header entirely', () => {
    const req = makePageReq({
      remoteAddress: '198.51.100.9',
      headers: { Forwarded: 'for=203.0.113.99;proto=https' }
    });
    expect(sourceAddress(req)).to.equal('198.51.100.9');
  });

  it('two requests from the same real peer with different spoofed forwarding headers share one identity', () => {
    const first = sourceAddress(makePageReq({
      remoteAddress: '198.51.100.9', headers: { 'X-Forwarded-For': '1.1.1.1' }
    }));
    const second = sourceAddress(makePageReq({
      remoteAddress: '198.51.100.9', headers: { 'X-Forwarded-For': '2.2.2.2' }
    }));
    expect(first).to.equal(second);
  });
});

describe('OAuth pages/helpers setNoStore', () => {
  it('sets Cache-Control and Pragma no-cache headers', () => {
    const res = makePageRes();
    setNoStore(res);
    expect(res.headers.get('Cache-Control')).to.equal('no-store');
    expect(res.headers.get('Pragma')).to.equal('no-cache');
  });
});

describe('OAuth pages/helpers writeEventResult', () => {
  it('writes a success result as top-level JSON, not an envelope', () => {
    const res = makePageRes();
    writeEventResult(res, { code: 200, results: { access_token: 'abc' } });
    expect(res.code).to.equal(200);
    expect(res.body).to.deep.equal({ access_token: 'abc' });
    expect(res.headers.get('Cache-Control')).to.equal('no-store');
  });

  it('writes a failure as { error, error_description }', () => {
    const res = makePageRes();
    writeEventResult(res, {
      code: 400,
      error: 'invalid_grant',
      errors: { error_description: 'Code already used' }
    });
    expect(res.code).to.equal(400);
    expect(res.body).to.deep.equal({
      error: 'invalid_grant',
      error_description: 'Code already used'
    });
  });

  it('omits error_description when none was supplied', () => {
    const res = makePageRes();
    writeEventResult(res, { code: 400, error: 'invalid_request' });
    expect(res.body).to.deep.equal({ error: 'invalid_request' });
  });

  it('defaults to a 500 status when the resolved response carries none', () => {
    const res = makePageRes();
    writeEventResult(res, { error: 'server_error' });
    expect(res.code).to.equal(500);
  });

  it('promotes a rate-limit retryAfterSeconds onto a real Retry-After header', () => {
    const res = makePageRes();
    writeEventResult(res, {
      code: 429,
      error: 'rate_limited',
      errors: { error_description: 'Rate limit exceeded', retryAfterSeconds: '30' }
    });
    expect(res.code).to.equal(429);
    expect(res.headers.get('Retry-After')).to.equal('30');
    expect(res.body).to.deep.equal({
      error: 'rate_limited', error_description: 'Rate limit exceeded'
    });
  });

  it('sets no Retry-After header for a non-rate-limited failure', () => {
    const res = makePageRes();
    writeEventResult(res, { code: 400, error: 'invalid_request' });
    expect(res.headers.get('Retry-After')).to.equal(undefined);
  });
});

describe('OAuth pages/helpers applyOAuthCors', () => {
  it('permits a native request with no Origin header', () => {
    const config = baseConfig();
    const req = makePageReq({});
    const res = makePageRes();
    expect(applyOAuthCors(req, res, config)).to.equal(true);
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal(undefined);
  });

  it('allows the issuer origin and reflects it back', () => {
    const config = baseConfig();
    const req = makePageReq({ headers: { Origin: 'https://example.com' } });
    const res = makePageRes();
    expect(applyOAuthCors(req, res, config)).to.equal(true);
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal('https://example.com');
    expect(res.headers.get('Vary')).to.equal('Origin');
  });

  it('exposes WWW-Authenticate/Retry-After/Mcp-Session-Id/MCP-Protocol-Version for an allowed origin', () => {
    const config = baseConfig();
    const req = makePageReq({ headers: { Origin: 'https://example.com' } });
    const res = makePageRes();
    applyOAuthCors(req, res, config);
    expect(res.headers.get('Access-Control-Expose-Headers')).to.equal(
      'WWW-Authenticate, Retry-After, Mcp-Session-Id, MCP-Protocol-Version'
    );
  });

  it('does not expose headers for a disallowed origin', () => {
    const config = baseConfig();
    const req = makePageReq({ headers: { Origin: 'https://evil.example' } });
    const res = makePageRes();
    applyOAuthCors(req, res, config);
    expect(res.headers.get('Access-Control-Expose-Headers')).to.equal(undefined);
  });

  it('allows an explicitly configured additional browser origin', () => {
    const config = baseConfig({ browserOrigins: [ 'https://app.example.org' ] });
    const req = makePageReq({ headers: { Origin: 'https://app.example.org' } });
    const res = makePageRes();
    expect(applyOAuthCors(req, res, config)).to.equal(true);
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal('https://app.example.org');
  });

  it('rejects a disallowed origin without reflecting it back', () => {
    const config = baseConfig();
    const req = makePageReq({ headers: { Origin: 'https://evil.example' } });
    const res = makePageRes();
    expect(applyOAuthCors(req, res, config)).to.equal(false);
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal(undefined);
  });

  it('rejects the literal "null" origin', () => {
    const config = baseConfig();
    const req = makePageReq({ headers: { Origin: 'null' } });
    const res = makePageRes();
    expect(applyOAuthCors(req, res, config)).to.equal(false);
  });

  it('rejects a malformed origin', () => {
    const config = baseConfig();
    const req = makePageReq({ headers: { Origin: 'not-a-url' } });
    const res = makePageRes();
    expect(applyOAuthCors(req, res, config)).to.equal(false);
  });

  it('rejects an origin value that carries a path', () => {
    const config = baseConfig();
    const req = makePageReq({ headers: { Origin: 'https://example.com/path' } });
    const res = makePageRes();
    expect(applyOAuthCors(req, res, config)).to.equal(false);
  });
});

describe('OAuth pages/helpers applyOAuthPreflight', () => {
  it('responds 204 with the allowed methods/headers for an allowed origin', () => {
    const config = baseConfig();
    const req = makePageReq({ method: 'OPTIONS', headers: { Origin: 'https://example.com' } });
    const res = makePageRes();
    applyOAuthPreflight(req, res, config, [ 'POST', 'OPTIONS' ]);
    expect(res.code).to.equal(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).to.equal('POST, OPTIONS');
    expect(res.headers.get('Access-Control-Expose-Headers')).to.equal(
      'WWW-Authenticate, Retry-After, Mcp-Session-Id, MCP-Protocol-Version'
    );
  });

  it('refuses a disallowed origin with 403', () => {
    const config = baseConfig();
    const req = makePageReq({ method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    const res = makePageRes();
    applyOAuthPreflight(req, res, config, [ 'POST', 'OPTIONS' ]);
    expect(res.code).to.equal(403);
  });

  it('permits a native preflight with no Origin', () => {
    const config = baseConfig();
    const req = makePageReq({ method: 'OPTIONS' });
    const res = makePageRes();
    applyOAuthPreflight(req, res, config, [ 'POST', 'OPTIONS' ]);
    expect(res.code).to.equal(204);
  });
});

describe('OAuth pages/helpers singleFormField', () => {
  it('reads a single string field', () => {
    const req = makePageReq({ post: { grant_type: 'authorization_code' } });
    expect(singleFormField(req, 'grant_type')).to.equal('authorization_code');
  });

  it('returns undefined for a missing field', () => {
    const req = makePageReq({ post: {} });
    expect(singleFormField(req, 'grant_type')).to.equal(undefined);
  });

  it('returns null for a repeated/duplicate field', () => {
    const req = makePageReq({ post: { grant_type: [ 'a', 'b' ] } });
    expect(singleFormField(req, 'grant_type')).to.equal(null);
  });
});
