import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { registerClient } from '../../src/oauth/clients/register.js';
import { OAuthClientError } from '../../src/oauth/clients/errors.js';
import type { OAuthClientRow } from '../../src/oauth/storage/types.js';
import type { NormalizedOAuthSessionConfig } from '../../src/oauth/types.js';

class FakeRegisterStore {
  public clients = new Map<string, OAuthClientRow>();
  public rateCounts = new Map<string, number>();

  async incrementRateBucket(keyHash: string): Promise<number> {
    const next = (this.rateCounts.get(keyHash) || 0) + 1;
    this.rateCounts.set(keyHash, next);
    return next;
  }

  public capacity = new Map<string, number>();
  public released: string[] = [];

  async reserveClientCapacity(kind: 'document' | 'registered', max: number): Promise<boolean> {
    const current = this.capacity.get(kind) || 0;
    if (current >= max) {
      return false;
    }
    this.capacity.set(kind, current + 1);
    return true;
  }

  async releaseClientCapacity(kind: 'document' | 'registered'): Promise<void> {
    this.released.push(kind);
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

const now = new Date('2026-10-15T00:00:00Z');

function body(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

describe('OAuth Client Registration', () => {
  let store: FakeRegisterStore;

  beforeEach(() => {
    store = new FakeRegisterStore();
  });

  it('registers a public client with accepted defaults and issues no secret', async () => {
    const result = await registerClient(
      body({ redirect_uris: [ 'https://client.example/callback' ] }),
      '1.2.3.4', makeConfig(), { store, now: () => now }
    );
    expect(result.client_id.startsWith('oauthreg_')).to.equal(true);
    expect(result.grant_types).to.deep.equal([ 'authorization_code' ]);
    expect(result.response_types).to.deep.equal([ 'code' ]);
    expect(result.token_endpoint_auth_method).to.equal('none');
    expect(result.client_id_issued_at).to.equal(Math.floor(now.getTime() / 1000));
    expect(Object.keys(result)).to.not.include('client_secret');
  });

  it('accepts refresh_token alongside authorization_code', async () => {
    const result = await registerClient(
      body({
        redirect_uris: [ 'https://client.example/callback' ],
        grant_types: [ 'authorization_code', 'refresh_token' ]
      }),
      '1.2.3.4', makeConfig(), { store, now: () => now }
    );
    expect(result.grant_types).to.deep.equal([ 'authorization_code', 'refresh_token' ]);
  });

  it('generates a different client_id on every call', async () => {
    const config = makeConfig();
    const a = await registerClient(body({ redirect_uris: [ 'https://client.example/a' ] }), '1.2.3.4', config, { store, now: () => now });
    const b = await registerClient(body({ redirect_uris: [ 'https://client.example/b' ] }), '1.2.3.4', config, { store, now: () => now });
    expect(a.client_id).to.not.equal(b.client_id);
  });

  it('rejects registration when disabled', async () => {
    try {
      await registerClient(
        body({ redirect_uris: [ 'https://client.example/callback' ] }),
        '1.2.3.4', makeConfig({ registration: { enabled: false, bodyBytes: 16384, redirects: 10, unusedSeconds: 86400, maxUnused: 10000 } }),
        { store, now: () => now }
      );
      expect.fail('expected registration_disabled');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('registration_disabled');
    }
  });

  it('enforces the body byte limit', async () => {
    const big = body({ redirect_uris: [ 'https://client.example/callback' ], client_name: 'x'.repeat(100000) });
    try {
      await registerClient(big, '1.2.3.4', makeConfig({ registration: { enabled: true, bodyBytes: 64, redirects: 10, unusedSeconds: 86400, maxUnused: 10000 } }), { store, now: () => now });
      expect.fail('expected invalid_request');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_request');
    }
  });

  it('rejects malformed JSON', async () => {
    try {
      await registerClient(Buffer.from('not json'), '1.2.3.4', makeConfig(), { store, now: () => now });
      expect.fail('expected invalid_client_metadata');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
  });

  it('requires at least one redirect_uris entry and enforces the configured count limit', async () => {
    try {
      await registerClient(body({ redirect_uris: [] }), '1.2.3.4', makeConfig(), { store, now: () => now });
      expect.fail('expected invalid_client_metadata for empty redirect_uris');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
    const tooMany = Array.from({ length: 3 }, (_, i) => `https://client.example/cb${i}`);
    try {
      await registerClient(
        body({ redirect_uris: tooMany }), '1.2.3.4',
        makeConfig({ registration: { enabled: true, bodyBytes: 16384, redirects: 2, unusedSeconds: 86400, maxUnused: 10000 } }),
        { store, now: () => now }
      );
      expect.fail('expected invalid_client_metadata for too many redirects');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
  });

  it('rejects an unacceptable or duplicate redirect_uris entry', async () => {
    try {
      await registerClient(body({ redirect_uris: [ 'http://client.example/callback' ] }), '1.2.3.4', makeConfig(), { store, now: () => now });
      expect.fail('expected invalid_client_metadata');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
    try {
      await registerClient(
        body({ redirect_uris: [ 'https://client.example/callback', 'https://client.example/callback' ] }),
        '1.2.3.4', makeConfig(), { store, now: () => now }
      );
      expect.fail('expected invalid_client_metadata for duplicate');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
    }
  });

  it('rejects unsupported grant types, response types and auth methods; requires no client secret', async () => {
    const base = { redirect_uris: [ 'https://client.example/callback' ] };
    for (const bad of [
      { ...base, grant_types: [ 'client_credentials' ] },
      { ...base, grant_types: [ 'refresh_token' ] },
      { ...base, response_types: [ 'token' ] },
      { ...base, response_types: [ 'code', 'token' ] },
      { ...base, token_endpoint_auth_method: 'client_secret_basic' }
    ]) {
      try {
        await registerClient(body(bad), '1.2.3.4', makeConfig(), { store, now: () => now });
        expect.fail(`expected invalid_client_metadata for ${JSON.stringify(bad)}`);
      } catch (e) {
        expect((e as OAuthClientError).code).to.equal('invalid_client_metadata');
      }
    }
  });

  it('enforces a per-issuer, per-source registration rate limit', async () => {
    const config = makeConfig({ limits: { windowSeconds: 60, registration: 1, authorization: 30, token: 60, factor: { attempts: 5, source: 20 }, clientMetadata: 30 } });
    await registerClient(body({ redirect_uris: [ 'https://client.example/a' ] }), '1.2.3.4', config, { store, now: () => now });
    try {
      await registerClient(body({ redirect_uris: [ 'https://client.example/b' ] }), '1.2.3.4', config, { store, now: () => now });
      expect.fail('expected rate_limited');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('rate_limited');
    }
  });

  it('refuses registration once unused-client capacity is exhausted; registration never grants access', async () => {
    const config = makeConfig({ registration: { enabled: true, bodyBytes: 16384, redirects: 10, unusedSeconds: 86400, maxUnused: 0 } });
    try {
      await registerClient(body({ redirect_uris: [ 'https://client.example/callback' ] }), '1.2.3.4', config, { store, now: () => now });
      expect.fail('expected unsafe_target');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('unsafe_target');
    }
    expect(store.clients.size).to.equal(0);
  });
});
