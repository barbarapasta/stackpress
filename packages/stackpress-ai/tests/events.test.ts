//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import httpEvent, * as httpEventModule from '../src/events/http.js';
import sseEvent, * as sseEventModule from '../src/events/sse.js';
import stdioEvent from '../src/events/stdio.js';
import * as events from '../src/events/index.js';
import { http, sse, stdio } from '../src/events/index.js';
import { createCtxStub } from './helpers.js';

//this response slice is all the event adapters read and write
type ResStub = { code?: number };

describe('ai/events', () => {
  it('should re-export the three transport event handlers from the barrel', () => {
    expect(events.http).to.equal(httpEventModule.default);
    expect(events.sse).to.equal(sseEventModule.default);
    expect(events.stdio).to.be.a('function');
    expect(events.stdio).to.equal(stdioEvent);
  });

  it('should attach the http transport and mark the response ok', async () => {
    const ctx = createCtxStub();
    ctx.register('mcp', async () => null);
    const res: ResStub = {};

    await http({ ctx, res } as never, {} as never);

    //with no mcp port set the transport rides on the main server request hook
    expect(ctx.events).to.include('request');
    expect(res.code).to.equal(200);
  });

  it('should start the http transport and mark the response ok', async () => {
    const res: ResStub = {};
    //default host/port config makes shouldAttachHttpToServer true, so this
    // resolves immediately through the attach path instead of listening.
    const ctx = createCtxStub({ config: { mcp: {} } });
    await httpEvent({ ctx, res } as never);

    expect(res.code).to.equal(200);
  });

  it('should attach the sse transport and mark the response ok', async () => {
    const ctx = createCtxStub();
    ctx.register('mcp', async () => null);
    const res: ResStub = {};

    await sse({ ctx, res } as never, {} as never);

    expect(ctx.events).to.include('request');
    expect(res.code).to.equal(200);
  });

  it('should start the sse transport and mark the response ok', async () => {
    const res: ResStub = {};
    const ctx = createCtxStub({ config: { mcp: {} } });
    await sseEvent({ ctx, res } as never);

    expect(res.code).to.equal(200);
  });

  it('should stop when another listener already failed', async () => {
    const ctx = createCtxStub({ config: { 'mcp.tools': [] } });

    for (const event of [ http, sse, stdio ]) {
      const res: ResStub = { code: 500 };
      await event({ ctx, res } as never, {} as never);
      expect(res.code).to.equal(500);
    }
    expect(ctx.events).to.deep.equal([]);
  });

  it('should skip each transport before touching the context when a prior listener failed', async () => {
    for (const event of [ httpEvent, sseEvent, stdioEvent ]) {
      const res: ResStub = { code: 500 };
      //passing a broken ctx would throw if the guard did not stop the script
      // before it ever touches config, proving the early return actually ran.
      await event({ ctx: undefined, res } as never);
      expect(res.code).to.equal(500);
    }
  });

  it('should surface an empty registry from the stdio event', async () => {
    const ctx = createCtxStub({ config: { 'mcp.tools': [] } });
    const res: ResStub = {};

    try {
      await stdio({ ctx, res } as never, {} as never);
      expect.fail('Expected stdio to throw');
    } catch (error) {
      expect((error as Error).message)
        .to.equal('Resolved MCP tool registry is empty.');
    }
    expect(res.code).to.equal(undefined);
  });
});
