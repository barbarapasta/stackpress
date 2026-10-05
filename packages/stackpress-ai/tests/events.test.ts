//modules
import { expect } from 'chai';
import { describe, it } from 'mocha';
//client
import { http, sse, stdio } from '../src/events/index.js';
import { createCtxStub } from './helpers.js';

//this response slice is all the event adapters read and write
type ResStub = { code?: number };

describe('ai/events', () => {
  it('should attach the http transport and mark the response ok', async () => {
    const ctx = createCtxStub();
    ctx.register('mcp', async () => null);
    const res: ResStub = {};

    await http({ ctx, res } as never, {} as never);

    //with no mcp port set the transport rides on the main server request hook
    expect(ctx.events).to.include('request');
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

  it('should stop when another listener already failed', async () => {
    const ctx = createCtxStub({ config: { 'mcp.tools': [] } });

    for (const event of [ http, sse, stdio ]) {
      const res: ResStub = { code: 500 };
      await event({ ctx, res } as never, {} as never);
      expect(res.code).to.equal(500);
    }
    expect(ctx.events).to.deep.equal([]);
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
