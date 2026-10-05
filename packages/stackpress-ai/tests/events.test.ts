//modules
import { describe, it } from 'mocha';
import { expect } from 'chai';
//client
import httpEvent, * as httpEventModule from '../src/events/http.js';
import sseEvent, * as sseEventModule from '../src/events/sse.js';
import stdioEvent from '../src/events/stdio.js';
import * as events from '../src/events/index.js';
import { createCtxStub } from './helpers.js';

//this narrow response shape mirrors what the Stackpress event runtime passes
// into every route action as `res`.
type ResStub = { code?: number };

describe('ai/events', () => {
  it('should re-export the three transport event handlers from the barrel', () => {
    expect(events.http).to.equal(httpEventModule.default);
    expect(events.sse).to.equal(sseEventModule.default);
    expect(events.stdio).to.be.a('function');
    expect(events.stdio).to.equal(stdioEvent);
  });

  it('should skip starting the http transport when a prior listener already failed', async () => {
    const res: ResStub = { code: 500 };
    //passing a broken ctx would throw if the guard did not stop the script
    // before it ever touches config, proving the early return actually ran.
    await httpEvent({ ctx: undefined, res } as never);

    expect(res.code).to.equal(500);
  });

  it('should start the http transport and mark the response ok', async () => {
    const res: ResStub = {};
    //default host/port config makes shouldAttachHttpToServer true, so this
    // resolves immediately through the attach path instead of listening.
    const ctx = createCtxStub({ config: { mcp: {} } });
    await httpEvent({ ctx, res } as never);

    expect(res.code).to.equal(200);
  });

  it('should skip starting the sse transport when a prior listener already failed', async () => {
    const res: ResStub = { code: 500 };
    await sseEvent({ ctx: undefined, res } as never);

    expect(res.code).to.equal(500);
  });

  it('should start the sse transport and mark the response ok', async () => {
    const res: ResStub = {};
    const ctx = createCtxStub({ config: { mcp: {} } });
    await sseEvent({ ctx, res } as never);

    expect(res.code).to.equal(200);
  });

  it('should skip starting the stdio transport when a prior listener already failed', async () => {
    const res: ResStub = { code: 500 };
    await stdioEvent({ ctx: undefined, res } as never);

    expect(res.code).to.equal(500);
  });
});
