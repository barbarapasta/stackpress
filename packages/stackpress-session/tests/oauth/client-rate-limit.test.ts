import { describe, it } from 'mocha';
import { expect } from 'chai';
import { enforceRateLimit } from '../../src/oauth/clients/rateLimit.js';
import { OAuthClientError } from '../../src/oauth/clients/errors.js';

//in-memory, injectable rate-bucket substitute: never touches a real
//database or clock. Mirrors OAuthStore.incrementRateBucket's shape
//only closely enough to exercise enforceRateLimit's decisions.
class FakeRateBucketStore {
  public counts = new Map<string, number>();
  public failNext = false;
  public calls: string[] = [];

  async incrementRateBucket(keyHash: string, _windowStart: Date, _expires: Date): Promise<number> {
    this.calls.push(keyHash);
    if (this.failNext) {
      throw new Error('simulated store failure');
    }
    const next = (this.counts.get(keyHash) || 0) + 1;
    this.counts.set(keyHash, next);
    return next;
  }
}

describe('OAuth Rate Limit Enforcement', () => {
  it('allows requests under the limit', async () => {
    const store = new FakeRateBucketStore();
    await enforceRateLimit(store, [ { key: 'a', limit: 3 } ], 60, new Date());
    await enforceRateLimit(store, [ { key: 'a', limit: 3 } ], 60, new Date());
    await enforceRateLimit(store, [ { key: 'a', limit: 3 } ], 60, new Date());
  });

  it('refuses once a stage exceeds its limit, with a positive Retry-After', async () => {
    const store = new FakeRateBucketStore();
    const now = new Date();
    for (let i = 0; i < 2; i++) {
      await enforceRateLimit(store, [ { key: 'a', limit: 2 } ], 60, now);
    }
    try {
      await enforceRateLimit(store, [ { key: 'a', limit: 2 } ], 60, now);
      expect.fail('expected rate_limited');
    } catch (e) {
      expect(e).to.be.instanceOf(OAuthClientError);
      expect((e as OAuthClientError).code).to.equal('rate_limited');
      expect((e as OAuthClientError).retryAfterSeconds).to.be.greaterThan(0);
    }
  });

  it('checks stages in order and never allocates a later stage once an earlier one refuses', async () => {
    const store = new FakeRateBucketStore();
    const now = new Date();
    await enforceRateLimit(store, [ { key: 'source', limit: 1 } ], 60, now);
    try {
      await enforceRateLimit(
        store,
        [ { key: 'source', limit: 1 }, { key: 'unknown-client', limit: 1000 } ],
        60,
        now
      );
      expect.fail('expected rate_limited');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('rate_limited');
    }
    //the source stage ran twice (both calls), the client stage never did
    expect(store.calls.filter((k) => store.counts.has(k)).length).to.be.greaterThan(0);
    const clientStageCalls = store.calls.length;
    expect(clientStageCalls).to.equal(2);
  });

  it('maps a store failure to store_unavailable rather than allowing the request through', async () => {
    const store = new FakeRateBucketStore();
    store.failNext = true;
    try {
      await enforceRateLimit(store, [ { key: 'a', limit: 10 } ], 60, new Date());
      expect.fail('expected store_unavailable');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('store_unavailable');
    }
  });

  it('hashes the bucket key rather than storing it in the clear', async () => {
    const store = new FakeRateBucketStore();
    await enforceRateLimit(store, [ { key: 'issuer:1.2.3.4', limit: 10 } ], 60, new Date());
    expect(store.calls[0]).to.not.include('1.2.3.4');
    expect(store.calls[0]).to.match(/^[0-9a-f]{64}$/);
  });
});
