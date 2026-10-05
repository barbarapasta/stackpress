import { describe, it } from 'mocha';
import { expect } from 'chai';
import finalize from '../../src/oauth/events/finalize.js';

describe('session/oauth/events/finalize', () => {
  it('should no-op when oauth was never registered', async () => {
    const ctx = { plugin: () => undefined };
    await finalize({ ctx: ctx as never });
  });

  it('should call the registered service finalize()', async () => {
    let called = false;
    const oauth = {
      finalize: async () => { called = true; }
    };
    const ctx = { plugin: () => oauth };
    await finalize({ ctx: ctx as never });
    expect(called).to.equal(true);
  });

  it('should propagate a finalize() rejection', async () => {
    const oauth = {
      finalize: async () => { throw new Error('not ready'); }
    };
    const ctx = { plugin: () => oauth };
    let caught: unknown;
    try {
      await finalize({ ctx: ctx as never });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.not.equal(undefined);
  });
});
