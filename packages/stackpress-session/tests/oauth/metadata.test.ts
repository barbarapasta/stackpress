import { describe, it } from 'mocha';
import { expect } from 'chai';
import normalizeOAuthConfig from '../../src/oauth/config.js';
import {
  issuerMetadataPath,
  resourceMetadataPath,
  ROOT_RESOURCE_METADATA_PATH,
  buildIssuerMetadata,
  buildProtectedResourceMetadata
} from '../../src/oauth/metadata.js';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return normalizeOAuthConfig({
    issuer: 'https://example.com',
    resources: [{
      resource: 'https://example.com/mcp',
      name: 'Example service',
      description: 'desc',
      scopes: [ 'articles:read', 'articles:write' ]
    }],
    scopes: {
      'articles:read': { name: 'Read', description: 'Read articles' },
      'articles:write': { name: 'Write', description: 'Change articles' }
    },
    policy: { approval: 'approval-event', access: 'access-event' },
    ...overrides
  });
}

describe('OAuth metadata paths', () => {
  it('reduces to the root well-known path for a bare-origin issuer', () => {
    expect(issuerMetadataPath('https://example.com')).to.equal(
      '/.well-known/oauth-authorization-server'
    );
  });

  it('inserts the well-known segment before a non-root issuer path', () => {
    expect(issuerMetadataPath('https://example.com/tenant')).to.equal(
      '/.well-known/oauth-authorization-server/tenant'
    );
  });

  it('derives the resource well-known path from the resource URL path', () => {
    expect(resourceMetadataPath('https://example.com/mcp')).to.equal(
      '/.well-known/oauth-protected-resource/mcp'
    );
  });

  it('exposes the fixed root resource metadata alias path', () => {
    expect(ROOT_RESOURCE_METADATA_PATH).to.equal('/.well-known/oauth-protected-resource');
  });
});

describe('OAuth buildIssuerMetadata', () => {
  it('advertises only the fixed, accepted feature set', () => {
    const config = baseConfig();
    const metadata = buildIssuerMetadata(config);
    expect(metadata.issuer).to.equal('https://example.com');
    expect(metadata.authorization_endpoint).to.equal('https://example.com/auth/oauth2/authorize');
    expect(metadata.token_endpoint).to.equal('https://example.com/auth/oauth2/token');
    expect(metadata.revocation_endpoint).to.equal('https://example.com/auth/oauth2/revoke');
    expect(metadata.registration_endpoint).to.equal('https://example.com/auth/oauth2/register');
    expect(metadata.response_types_supported).to.deep.equal([ 'code' ]);
    expect(metadata.grant_types_supported).to.deep.equal([ 'authorization_code', 'refresh_token' ]);
    expect(metadata.code_challenge_methods_supported).to.deep.equal([ 'S256' ]);
    expect(metadata.token_endpoint_auth_methods_supported).to.deep.equal([ 'none' ]);
    expect(metadata.scopes_supported).to.deep.equal([ 'articles:read', 'articles:write' ]);
    expect(metadata.authorization_response_iss_parameter_supported).to.equal(true);
    //never advertise an unimplemented feature:
    expect((metadata as Record<string, unknown>).response_modes_supported).to.equal(undefined);
    expect((metadata as Record<string, unknown>).grant_types_supported).to.not.include('client_credentials');
    expect((metadata as Record<string, unknown>).grant_types_supported).to.not.include('implicit');
  });

  it('omits registration_endpoint when registration is disabled', () => {
    const config = baseConfig({ registration: { enabled: false } });
    const metadata = buildIssuerMetadata(config);
    expect(metadata.registration_endpoint).to.equal(undefined);
  });
});

describe('OAuth buildProtectedResourceMetadata', () => {
  it('builds the fixed resource metadata shape', () => {
    const config = baseConfig();
    const metadata = buildProtectedResourceMetadata(config.resources[0], config);
    expect(metadata.resource).to.equal('https://example.com/mcp');
    expect(metadata.authorization_servers).to.deep.equal([ 'https://example.com' ]);
    expect(metadata.scopes_supported).to.deep.equal([ 'articles:read', 'articles:write' ]);
    expect(metadata.resource_name).to.equal('Example service');
    expect(metadata.resource_documentation).to.equal('desc');
    expect(metadata.bearer_methods_supported).to.deep.equal([ 'header' ]);
  });
});
