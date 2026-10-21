import { describe, it, after } from 'mocha';
import { expect } from 'chai';
import { createOAuthFixture, RESOURCE } from './oauth-fixture.js';

describe('ai/oauth-fixture smoke', () => {
  it('issues a real access token and verifies it through the real store', async () => {
    const fixture = await createOAuthFixture();
    try {
      const { accessToken, refreshToken, grantId } = await fixture.issueGrant();
      expect(accessToken).to.be.a('string');
      expect(accessToken.startsWith('oauth_')).to.equal(true);
      expect(refreshToken).to.be.a('string');

      const verify = await fixture.ctx.resolve<{ profileId: string, grantId: string }>(
        'oauth-token-verify',
        {
          token: accessToken, resource: RESOURCE, surface: 'mcp',
          method: 'GET', requiredCredential: 'read'
        }
      );
      expect(verify?.code).to.equal(200);
      expect(verify?.results?.grantId).to.equal(grantId);
    } finally {
      await fixture.close();
    }
  });
});
