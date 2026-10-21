//modules
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, it } from 'mocha';
import { expect } from 'chai';
//client
import {
  assertNoReservedOAuthFields,
  createOAuthMcpServer,
  extractAuthContext,
  isOriginAllowed,
  OAuthMcpRefusal,
  projectToolForListing,
  watchGrantForChanges,
  writeCorsPreflight,
  writeOAuthRefusal
} from '../src/oauth.js';
import type { AuthContext, NormalizedToolConfig, ToolResolverServer } from '../src/types.js';
import { MockResponse, createCtxStub } from './helpers.js';

const CONFIG = { issuer: 'https://example.com', browserOrigins: [ 'https://app.example.com' ] };

describe('ai/oauth helpers (direct unit tests)', () => {
  describe('isOriginAllowed', () => {
    it('allows the configured issuer origin', () => {
      expect(isOriginAllowed('https://example.com', CONFIG)).to.equal(true);
    });

    it('allows an explicit additional browser origin', () => {
      expect(isOriginAllowed('https://app.example.com', CONFIG)).to.equal(true);
    });

    it('rejects null and wildcard origins', () => {
      expect(isOriginAllowed('null', CONFIG)).to.equal(false);
      expect(isOriginAllowed('*', CONFIG)).to.equal(false);
    });

    it('rejects a malformed origin', () => {
      expect(isOriginAllowed('not a url', CONFIG)).to.equal(false);
    });

    it('rejects an unrelated origin', () => {
      expect(isOriginAllowed('https://evil.example', CONFIG)).to.equal(false);
    });
  });

  describe('writeCorsPreflight', () => {
    it('sets the expected CORS and exposed headers and ends with 204', () => {
      const res = new MockResponse();
      writeCorsPreflight(res as never, 'https://example.com', 'GET, POST, DELETE, OPTIONS');
      expect(res.statusCode).to.equal(204);
      expect(res.headers.get('access-control-allow-origin')).to.equal('https://example.com');
      expect(res.headers.get('access-control-allow-methods')).to.equal('GET, POST, DELETE, OPTIONS');
      expect(res.headers.get('vary')).to.equal('Origin');
      expect(res.headers.get('access-control-expose-headers')).to.include('WWW-Authenticate');
    });

    it('omits Access-Control-Allow-Origin when no Origin was presented', () => {
      const res = new MockResponse();
      writeCorsPreflight(res as never, null, 'POST, OPTIONS');
      expect(res.headers.has('access-control-allow-origin')).to.equal(false);
    });
  });

  describe('writeOAuthRefusal', () => {
    it('only closes the socket once headers have already been sent', () => {
      const res = new MockResponse();
      res.writeHead(200, {});
      writeOAuthRefusal(res as never, new OAuthMcpRefusal(401, 'invalid_token'), 'https://example.com', 'https://example.com/mcp');
      //status is left at whatever was already sent; no new body is written
      expect(res.statusCode).to.equal(200);
    });

    it('includes the insufficient_scope challenge and the configured scope', () => {
      const res = new MockResponse();
      writeOAuthRefusal(
        res as never,
        new OAuthMcpRefusal(403, 'insufficient_scope', 'need scope', 'articles:read'),
        'https://example.com', 'https://example.com/mcp'
      );
      expect(res.statusCode).to.equal(403);
      expect(res.headers.get('www-authenticate')).to.include('insufficient_scope');
      expect(res.headers.get('www-authenticate')).to.include('articles:read');
    });

    it('sets Allow: POST for a 405 refusal', () => {
      const res = new MockResponse();
      writeOAuthRefusal(res as never, new OAuthMcpRefusal(405, 'invalid_token'), undefined, 'https://example.com/mcp');
      expect(res.statusCode).to.equal(405);
      expect(res.headers.get('allow')).to.equal('POST');
    });

    it('wraps a plain JS error into a generic 500 refusal when no issuer is configured', () => {
      const res = new MockResponse();
      writeOAuthRefusal(res as never, new Error('boom'), undefined, 'https://example.com/mcp');
      expect(res.statusCode).to.equal(500);
      expect(res.headers.has('www-authenticate')).to.equal(false);
    });

    it('preserves a numeric .code on an unexpected error as its HTTP status', () => {
      const res = new MockResponse();
      const error = Object.assign(new Error('not finalized'), { code: 503 });
      writeOAuthRefusal(res as never, error, 'https://example.com', 'https://example.com/mcp');
      expect(res.statusCode).to.equal(503);
    });
  });

  describe('watchGrantForChanges', () => {
    it('sends one generic signal when the polled grant snapshot changes, and stops cleanly', async () => {
      let call = 0;
      const ctx = {
        resolve: async () => {
          call++;
          //first poll: active true; second poll: revoked - a real change
          return {
            code: 200,
            results: call === 1
              ? [ { grantId: 'g1', active: true, scopes: [ 'a' ], expires: new Date(1000) } ]
              : [ { grantId: 'g1', active: false, scopes: [ 'a' ], expires: new Date(1000) } ]
          };
        }
      } as unknown as ToolResolverServer;

      let changed = 0;
      const handle = watchGrantForChanges(ctx, 'profile-1', 'g1', () => { changed++; }, 10);
      await new Promise(resolve => setTimeout(resolve, 60));
      handle.stop();
      expect(changed).to.be.greaterThan(0);
      //a missed/failed check never retries forever past stop()
      const afterStop = changed;
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(changed).to.equal(afterStop);
    });

    it('never signals a change, and never throws, when the lookup consistently fails', async () => {
      const ctx = {
        resolve: async () => { throw new Error('store unavailable'); }
      } as unknown as ToolResolverServer;
      let changed = 0;
      const handle = watchGrantForChanges(ctx, 'profile-1', 'g1', () => { changed++; }, 10);
      await new Promise(resolve => setTimeout(resolve, 40));
      handle.stop();
      expect(changed).to.equal(0);
    });
  });

  describe('assertNoReservedOAuthFields', () => {
    it('passes through ordinary input untouched', () => {
      expect(() => assertNoReservedOAuthFields({ id: 'a1' })).to.not.throw();
    });

    for (const field of [ 'profileId', 'applicationId', 'sessionId', 'oauth' ]) {
      it(`rejects a caller-submitted "${field}" field`, () => {
        expect(() => assertNoReservedOAuthFields({ [field]: 'x' }))
          .to.throw(OAuthMcpRefusal);
      });
    }
  });

  describe('extractAuthContext', () => {
    it('defaults to public when no authInfo is present', () => {
      expect(extractAuthContext({})).to.deep.equal({ kind: 'public' });
    });

    it('defaults to public when authInfo.extra.context is not a well-formed AuthContext', () => {
      expect(extractAuthContext({ authInfo: { token: '', clientId: '', scopes: [], extra: { context: 42 } } }))
        .to.deep.equal({ kind: 'public' });
    });

    it('round-trips a real AuthContext through extra.context', () => {
      const auth: AuthContext = { kind: 'public' };
      expect(extractAuthContext({
        authInfo: { token: '', clientId: '', scopes: [], extra: { context: auth } }
      })).to.deep.equal(auth);
    });
  });

  describe('projectToolForListing', () => {
    const tool: NormalizedToolConfig = {
      mode: 'event', type: 'user', name: 'articles_read', title: 'Read',
      event: 'articles-read', method: 'GET', scopes: [ 'articles:read' ], data: {},
      input: { type: 'object', required: [ 'id' ] },
      output: { type: 'object' }
    };

    it('projects a protected tool to the minimal schema for an unauthorized caller', () => {
      const entry = projectToolForListing(tool, { kind: 'public' });
      expect(entry.inputSchema).to.deep.equal({ type: 'object' });
      expect(entry.outputSchema).to.equal(undefined);
    });

    it('exposes the full contract once the caller is authorized', () => {
      const entry = projectToolForListing(tool, {
        kind: 'oauth',
        identity: {
          profileId: 'p1', clientId: 'c1', grantId: 'g1',
          resource: 'https://example.com/mcp', scopes: [ 'articles:read' ],
          expires: new Date(), deadline: new Date(), credential: 'read'
        }
      });
      expect(entry.inputSchema).to.deep.equal(tool.input);
      expect(entry.outputSchema).to.deep.equal(tool.output);
    });

    it('always exposes the full contract for a public tool', () => {
      const publicTool: NormalizedToolConfig = { ...tool, type: 'public', scopes: [] };
      const entry = projectToolForListing(publicTool, { kind: 'public' });
      expect(entry.inputSchema).to.deep.equal(tool.input);
    });
  });

  describe('createOAuthMcpServer', () => {
    it('serves an empty tool list when the registry has no usable tools', async () => {
      //a caller that sees no tools still connects, like the plain transports
      const ctx = createCtxStub({ config: { 'mcp.tools': [] } });
      const server = await createOAuthMcpServer(ctx as unknown as ToolResolverServer);
      expect(server).to.not.equal(null);

      const [ near, far ] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([ server.connect(near), client.connect(far) ]);
      const listed = await client.listTools();
      expect(listed.tools).to.deep.equal([]);
      await client.close();
    });
  });
});
