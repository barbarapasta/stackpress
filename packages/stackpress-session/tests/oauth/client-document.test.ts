import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { fetchClientDocument } from '../../src/oauth/clients/document.js';
import { OAuthClientError } from '../../src/oauth/clients/errors.js';
import type { OAuthTransportResponse } from '../../src/oauth/clients/transport.js';
import type { OAuthClientDocumentRow, OAuthClientRow } from '../../src/oauth/storage/types.js';
import type { NormalizedOAuthSessionConfig } from '../../src/oauth/types.js';
import { hashWithDomain } from '../../src/oauth/storage/ids.js';

//Fully in-memory, injectable substitutes for the database, DNS resolver
//and HTTPS transport - this suite never opens a socket or resolves a
//real hostname, per sprint.md's "controllable test substitutes kept
//near the tests, never runtime fallbacks".
class FakeDocumentStore {
  public documents = new Map<string, OAuthClientDocumentRow>();
  public clients = new Map<string, OAuthClientRow>();
  public rateCounts = new Map<string, number>();
  public saveCalls = 0;

  async incrementRateBucket(keyHash: string): Promise<number> {
    const next = (this.rateCounts.get(keyHash) || 0) + 1;
    this.rateCounts.set(keyHash, next);
    return next;
  }

  async getClientDocumentByUrlHash(urlHash: string): Promise<OAuthClientDocumentRow | null> {
    return this.documents.get(urlHash) || null;
  }

  async saveClientDocument(input: {
    urlHash: string, metadata: Record<string, unknown>,
    etag?: string | null, lastModified?: string | null,
    freshUntil: Date, now?: Date
  }): Promise<OAuthClientDocumentRow> {
    this.saveCalls++;
    const row: OAuthClientDocumentRow = {
      id: `doc_${this.documents.size}`,
      urlHash: input.urlHash,
      metadata: input.metadata,
      etag: input.etag ?? null,
      lastModified: input.lastModified ?? null,
      freshUntil: input.freshUntil,
      lastUsed: input.now || new Date(),
      created: input.now || new Date(),
      updated: input.now || new Date()
    };
    this.documents.set(input.urlHash, row);
    return row;
  }

  public capacity = new Map<string, number>();

  async getClientByClientId(clientId: string): Promise<OAuthClientRow | null> {
    return this.clients.get(clientId) || null;
  }

  async reserveClientCapacity(kind: 'document' | 'registered', max: number): Promise<boolean> {
    const current = this.capacity.get(kind) || 0;
    if (current >= max) {
      return false;
    }
    this.capacity.set(kind, current + 1);
    return true;
  }

  async releaseClientCapacity(kind: 'document' | 'registered'): Promise<void> {
    const current = this.capacity.get(kind) || 0;
    this.capacity.set(kind, Math.max(0, current - 1));
  }

  async touchUnusedClient(
    clientId: string, kind: 'document' | 'registered',
    metadata: Record<string, unknown>, unusedExpires: Date, now = new Date()
  ): Promise<OAuthClientRow> {
    const row: OAuthClientRow = {
      id: `client_${this.clients.size}`, clientId, kind, metadata,
      created: now, lastUsed: now, unusedExpires
    };
    this.clients.set(clientId, row);
    return row;
  }
}

function makeConfig(overrides: Partial<NormalizedOAuthSessionConfig> = {}): NormalizedOAuthSessionConfig {
  return {
    issuer: 'https://example.com',
    base: '/auth/oauth2',
    resources: [],
    scopes: {},
    policy: { approval: 'a', access: 'b', timeoutMs: 5000 },
    clients: {},
    registration: { enabled: true, bodyBytes: 16384, redirects: 10, unusedSeconds: 86400, maxUnused: 10000 },
    clientMetadata: { timeoutMs: 5000, bodyBytes: 5120, maxEntries: 1000, maxAgeSeconds: 3600 },
    limits: {
      windowSeconds: 60, registration: 10, authorization: 30, token: 60,
      factor: { attempts: 5, source: 20 }, clientMetadata: 30
    },
    accessSeconds: 900, renewalSeconds: 604800, codeSeconds: 60, pendingSeconds: 600,
    browserOrigins: [], development: false,
    ...overrides
  };
}

const DOC_URL = 'https://client.example/metadata.json';
const DOC_BODY = JSON.stringify({
  client_id: DOC_URL,
  redirect_uris: [ 'https://client.example/callback' ]
});

function okResponse(body: string, headers: Record<string, string> = {}): OAuthTransportResponse {
  return { status: 200, headers, body: Buffer.from(body) };
}

describe('OAuth Client Document Fetch', () => {
  let store: FakeDocumentStore;
  const now = new Date('2026-10-15T00:00:00Z');
  const resolvePublic = async () => [ { address: '93.184.216.34' as const, family: 4 as const } ];

  beforeEach(() => {
    store = new FakeDocumentStore();
  });

  it('serves a fresh cached copy without any network call', async () => {
    const urlHash = hashWithDomain('client-document-url', DOC_URL);
    await store.saveClientDocument({
      urlHash, metadata: { cached: true },
      freshUntil: new Date(now.getTime() + 60_000), now
    });
    let transportCalled = false;
    const result = await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
      store, resolveHost: resolvePublic,
      transport: async () => { transportCalled = true; return okResponse(DOC_BODY); },
      now: () => now
    });
    expect(result.cached).to.equal(true);
    expect(result.metadata).to.deep.equal({ cached: true });
    expect(transportCalled).to.equal(false);
  });

  it('fetches, validates and caches a fresh document using Cache-Control max-age', async () => {
    const result = await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
      store, resolveHost: resolvePublic,
      transport: async () => okResponse(DOC_BODY, { 'cache-control': 'max-age=120' }),
      now: () => now
    });
    expect(result.cached).to.equal(false);
    expect(result.metadata.client_id).to.equal(DOC_URL);
    expect(store.saveCalls).to.equal(1);
  });

  it('never persists a no-store response', async () => {
    await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
      store, resolveHost: resolvePublic,
      transport: async () => okResponse(DOC_BODY, { 'cache-control': 'no-store' }),
      now: () => now
    });
    expect(store.saveCalls).to.equal(0);
  });

  it('revalidates a stale entry on 304 and extends freshness without re-fetching the body', async () => {
    const urlHash = hashWithDomain('client-document-url', DOC_URL);
    await store.saveClientDocument({
      urlHash, metadata: { client_id: DOC_URL, redirect_uris: [] },
      etag: '"abc"', freshUntil: new Date(now.getTime() - 1000), now: new Date(now.getTime() - 10_000)
    });
    const result = await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
      store, resolveHost: resolvePublic,
      transport: async (req) => {
        expect(req.headers['If-None-Match']).to.equal('"abc"');
        return { status: 304, headers: { 'cache-control': 'max-age=60' }, body: Buffer.alloc(0) };
      },
      now: () => now
    });
    expect(result.cached).to.equal(true);
    expect(result.metadata).to.deep.equal({ client_id: DOC_URL, redirect_uris: [] });
  });

  it('never serves stale data and never follows a redirect on failure, and never caches the error', async () => {
    try {
      await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
        store, resolveHost: resolvePublic,
        transport: async () => ({ status: 302, headers: { location: 'https://elsewhere.example' }, body: Buffer.alloc(0) }),
        now: () => now
      });
      expect.fail('expected fetch_failed');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('fetch_failed');
    }
    expect(store.saveCalls).to.equal(0);
  });

  it('re-validates the resolved address fresh on every call, so a host changing its DNS answer is checked again rather than trusting a previous result', async () => {
    const config = makeConfig();
    let lastAddress = '';
    const deps = (resolved: string) => ({
      store, resolveHost: async () => [ { address: resolved, family: 4 as const } ],
      transport: async (req: { address: string }) => { lastAddress = req.address; return okResponse(DOC_BODY, { 'cache-control': 'no-store' }); },
      now: () => now
    });
    await fetchClientDocument(DOC_URL, '1.2.3.4', config, deps('93.184.216.34'));
    expect(lastAddress).to.equal('93.184.216.34');
    //the host's DNS answer changes to a private address on the next
    //lookup; the earlier successful public answer must not be reused.
    try {
      await fetchClientDocument('https://client.example/other.json', '1.2.3.4', config, deps('192.168.0.1'));
      expect.fail('expected unsafe_target for the new, unsafe DNS answer');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('unsafe_target');
    }
  });

  it('rejects a resolved private/reserved address without ever calling the transport', async () => {
    let transportCalled = false;
    try {
      await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
        store,
        resolveHost: async () => [ { address: '10.0.0.5', family: 4 } ],
        transport: async () => { transportCalled = true; return okResponse(DOC_BODY); },
        now: () => now
      });
      expect.fail('expected unsafe_target');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('unsafe_target');
    }
    expect(transportCalled).to.equal(false);
  });

  it('rejects a disallowed IP-literal hostname without ever calling the DNS resolver', async () => {
    let resolveCalled = false;
    try {
      await fetchClientDocument('https://127.0.0.1/metadata.json', '1.2.3.4', makeConfig(), {
        store,
        resolveHost: async () => { resolveCalled = true; return []; },
        transport: async () => okResponse(DOC_BODY),
        now: () => now
      });
      expect.fail('expected unsafe_target');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('unsafe_target');
    }
    expect(resolveCalled).to.equal(false);
  });

  it('rejects a root-path document URL', async () => {
    try {
      await fetchClientDocument('https://client.example/', '1.2.3.4', makeConfig(), {
        store, resolveHost: resolvePublic, transport: async () => okResponse(DOC_BODY), now: () => now
      });
      expect.fail('expected invalid_request');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_request');
    }
  });

  it('rejects plain HTTP outside development/loopback', async () => {
    try {
      await fetchClientDocument('http://client.example/metadata.json', '1.2.3.4', makeConfig(), {
        store, resolveHost: resolvePublic, transport: async () => okResponse(DOC_BODY), now: () => now
      });
      expect.fail('expected invalid_request');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_request');
    }
  });

  it('rejects a document whose client_id does not match its own URL', async () => {
    try {
      await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
        store, resolveHost: resolvePublic,
        transport: async () => okResponse(JSON.stringify({
          client_id: 'https://someone-else.example/metadata.json',
          redirect_uris: [ 'https://client.example/callback' ]
        })),
        now: () => now
      });
      expect.fail('expected invalid_client_metadata');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
  });

  it('rejects bad JSON and an unsupported login method', async () => {
    try {
      await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
        store, resolveHost: resolvePublic, transport: async () => okResponse('not json'), now: () => now
      });
      expect.fail('expected invalid_client_metadata');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
    try {
      await fetchClientDocument(DOC_URL, '1.2.3.4', makeConfig(), {
        store, resolveHost: resolvePublic,
        transport: async () => okResponse(JSON.stringify({
          client_id: DOC_URL,
          redirect_uris: [ 'https://client.example/callback' ],
          token_endpoint_auth_method: 'client_secret_basic'
        })),
        now: () => now
      });
      expect.fail('expected invalid_client_metadata');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
  });

  it('enforces the configured allowed-client list before any network call', async () => {
    let resolveCalled = false;
    const config = makeConfig({ clients: { allowed: [ 'only-this-client' ] } });
    try {
      await fetchClientDocument(DOC_URL, '1.2.3.4', config, {
        store, resolveHost: async () => { resolveCalled = true; return []; },
        transport: async () => okResponse(DOC_BODY), now: () => now
      });
      expect.fail('expected invalid_request');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_request');
    }
    expect(resolveCalled).to.equal(false);
  });

  it('refuses a cache-miss fetch once the clientMetadata rate limit is exhausted', async () => {
    const config = makeConfig({ limits: { windowSeconds: 60, registration: 10, authorization: 30, token: 60, factor: { attempts: 5, source: 20 }, clientMetadata: 1 } });
    let transportCalls = 0;
    const deps = {
      store, resolveHost: resolvePublic,
      transport: async () => { transportCalls++; return okResponse(DOC_BODY); },
      now: () => now
    };
    await fetchClientDocument(DOC_URL, '1.2.3.4', config, deps);
    try {
      await fetchClientDocument('https://client.example/other.json', '1.2.3.4', config, deps);
      expect.fail('expected rate_limited');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('rate_limited');
    }
    expect(transportCalls).to.equal(1);
  });

  it('refuses a new document identity once unused-client capacity is exhausted', async () => {
    const config = makeConfig({ registration: { enabled: true, bodyBytes: 16384, redirects: 10, unusedSeconds: 86400, maxUnused: 0 } });
    try {
      await fetchClientDocument(DOC_URL, '1.2.3.4', config, {
        store, resolveHost: resolvePublic, transport: async () => okResponse(DOC_BODY), now: () => now
      });
      expect.fail('expected unsafe_target');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('unsafe_target');
    }
  });
});
