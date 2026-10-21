import { describe, it } from 'mocha';
import { expect } from 'chai';
import { resolveResource } from '../../src/oauth/events/resource.js';
import normalizeOAuthConfig from '../../src/oauth/config.js';

function configWith(resources: { resource: string, scopes: string[] }[]) {
  return normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: resources.map((r, i) => ({
      resource: r.resource, name: `R${i}`, description: 'd', scopes: r.scopes
    })),
    scopes: { 'a': { name: 'A', description: 'a' } },
    policy: { approval: 'approval-event', access: 'access-event' }
  });
}

describe('OAuth resolveResource', () => {
  it('defaults to the single configured resource when omitted', () => {
    const config = configWith([{ resource: 'https://example.com/mcp', scopes: [ 'a' ] }]);
    expect(resolveResource(config)).to.equal('https://example.com/mcp');
  });

  it('refuses to default when more than one resource is configured', () => {
    const config = configWith([
      { resource: 'https://example.com/mcp', scopes: [ 'a' ] },
      { resource: 'https://example.com/other', scopes: [ 'a' ] }
    ]);
    expect(resolveResource(config)).to.equal(null);
  });

  it('accepts an explicit, exact, known resource', () => {
    const config = configWith([
      { resource: 'https://example.com/mcp', scopes: [ 'a' ] },
      { resource: 'https://example.com/other', scopes: [ 'a' ] }
    ]);
    expect(resolveResource(config, 'https://example.com/other')).to.equal('https://example.com/other');
  });

  it('rejects an unknown resource', () => {
    const config = configWith([{ resource: 'https://example.com/mcp', scopes: [ 'a' ] }]);
    expect(resolveResource(config, 'https://example.com/unknown')).to.equal(null);
  });
});
