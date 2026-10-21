import { describe, it } from 'mocha';
import { expect } from 'chai';
import finalize from '../../src/oauth/events/finalize.js';

function createResStub() {
  const res: { results?: unknown, error?: unknown } = {};
  return {
    res: {
      results: (data: unknown) => { res.results = data; },
      setError: (data: unknown) => { res.error = data; }
    },
    state: res
  };
}

describe('session/oauth/events/finalize', () => {
  it('should no-op when oauth was never registered', async () => {
    const ctx = { plugin: () => undefined };
    const { res, state } = createResStub();
    await finalize({ ctx: ctx as never, res: res as never });
    expect(state.results).to.deep.equal({ finalized: false });
  });

  it('should call the registered service finalize() and report success', async () => {
    let called = false;
    const oauth = {
      finalize: async () => { called = true; }
    };
    const ctx = { plugin: () => oauth };
    const { res, state } = createResStub();
    await finalize({ ctx: ctx as never, res: res as never });
    expect(called).to.equal(true);
    expect(state.results).to.deep.equal({ finalized: true });
  });

  it('should report a finalize() rejection as a response error, not a throw', async () => {
    const oauth = {
      finalize: async () => { throw new Error('not ready'); }
    };
    const ctx = { plugin: () => oauth };
    const { res, state } = createResStub();
    await finalize({ ctx: ctx as never, res: res as never });
    expect(state.error).to.not.equal(undefined);
  });
});
