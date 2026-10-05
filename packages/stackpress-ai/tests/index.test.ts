//modules
import { describe, it } from 'mocha';
import { expect } from 'chai';
//client
import defaultPlugin, { createMcpServer } from '../src/index.js';
import plugin from '../src/plugin.js';

describe('ai/index', () => {
  it('should export the plugin default and the mcp server factory', () => {
    expect(defaultPlugin).to.equal(plugin);
    expect(createMcpServer).to.be.a('function');
  });
});
