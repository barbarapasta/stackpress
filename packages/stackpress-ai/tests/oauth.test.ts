import { describe, it } from 'mocha';
import { expect } from 'chai';
import { registerOAuthResources } from '../src/plugin.js';
import type { ToolResolverServer } from '../src/types.js';
import { createCtxStub } from './helpers.js';

describe('ai/oauth', () => {
  it('should no-op when mcp.oauth and mcp.sse.oauth are absent', () => {
    const ctx = createCtxStub({ config: { mcp: {} } });
    expect(() => registerOAuthResources(ctx as unknown as ToolResolverServer))
      .to.not.throw();
  });

  it('should throw when mcp.oauth is set but session.oauth is not configured', () => {
    const ctx = createCtxStub({
      config: { mcp: { oauth: { resource: 'https://example.com/mcp' } } }
    });
    expect(() => registerOAuthResources(ctx as unknown as ToolResolverServer))
      .to.throw(/requires session.oauth to be configured/);
  });

  it('should register the configured mcp resource with the oauth service', () => {
    const ctx = createCtxStub({
      config: {
        mcp: { route: '/mcp', oauth: { resource: 'https://example.com/mcp' } }
      }
    });
    const registered: unknown[] = [];
    ctx.registered.oauth = {
      registerMcpResource: (descriptor: unknown) => registered.push(descriptor)
    };
    registerOAuthResources(ctx as unknown as ToolResolverServer);
    expect(registered).to.deep.equal([{
      surface: 'mcp',
      route: '/mcp',
      resource: 'https://example.com/mcp'
    }]);
  });

  it('should register the configured sse resource with the oauth service', () => {
    const ctx = createCtxStub({
      config: {
        mcp: {
          sse: { route: '/sse', oauth: { resource: 'https://example.com/mcp' } }
        }
      }
    });
    const registered: unknown[] = [];
    ctx.registered.oauth = {
      registerMcpResource: (descriptor: unknown) => registered.push(descriptor)
    };
    registerOAuthResources(ctx as unknown as ToolResolverServer);
    expect(registered).to.deep.equal([{
      surface: 'sse',
      route: '/sse',
      resource: 'https://example.com/mcp'
    }]);
  });

  it('should register both transports when both declare oauth', () => {
    const ctx = createCtxStub({
      config: {
        mcp: {
          oauth: { resource: 'https://example.com/mcp' },
          sse: { oauth: { resource: 'https://example.com/mcp' } }
        }
      }
    });
    const registered: unknown[] = [];
    ctx.registered.oauth = {
      registerMcpResource: (descriptor: unknown) => registered.push(descriptor)
    };
    registerOAuthResources(ctx as unknown as ToolResolverServer);
    expect(registered).to.have.length(2);
  });

  it('should propagate a route-collision error raised by the oauth service', () => {
    const ctx = createCtxStub({
      config: { mcp: { oauth: { resource: 'https://example.com/mcp' } } }
    });
    ctx.registered.oauth = {
      registerMcpResource: () => {
        throw new Error('OAuth MCP route collision on /mcp');
      }
    };
    expect(() => registerOAuthResources(ctx as unknown as ToolResolverServer))
      .to.throw(/route collision/);
  });
});
