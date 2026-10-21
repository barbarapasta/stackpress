import { describe, it } from 'mocha';
import { expect } from 'chai';
import { oauthError, mapKnownError, toEventErrorResponse } from '../../src/oauth/events/errors.js';
import { OAuthStoreError } from '../../src/oauth/storage/errors.js';
import { OAuthClientError } from '../../src/oauth/clients/errors.js';

describe('OAuth event error mapping', () => {
  it('oauthError sets the machine code as the message and the right status', () => {
    const exception = oauthError('invalid_token', 'bad token');
    expect(exception.message).to.equal('invalid_token');
    expect(exception.code).to.equal(401);
    expect(exception.toResponse().error).to.equal('invalid_token');
    expect(exception.toResponse().errors).to.deep.equal({ error_description: 'bad token' });
  });

  it('mapKnownError passes an OAuthStoreError code straight through', () => {
    const exception = mapKnownError(new OAuthStoreError('conflict', 'already resolved'));
    expect(exception.message).to.equal('conflict');
    expect(exception.code).to.equal(409);
  });

  it('mapKnownError folds client-metadata/unsafe-target/fetch errors into invalid_client', () => {
    expect(mapKnownError(new OAuthClientError('invalid_client_metadata')).message).to.equal('invalid_client');
    expect(mapKnownError(new OAuthClientError('unsafe_target')).message).to.equal('invalid_client');
    expect(mapKnownError(new OAuthClientError('fetch_failed')).message).to.equal('invalid_client');
  });

  it('mapKnownError keeps rate_limited with its retryAfterSeconds', () => {
    const exception = mapKnownError(new OAuthClientError('rate_limited', 'slow down', 30));
    expect(exception.message).to.equal('rate_limited');
    expect(exception.code).to.equal(429);
    expect(exception.toResponse().errors).to.deep.equal({
      error_description: 'slow down',
      retryAfterSeconds: '30'
    });
  });

  it('mapKnownError folds an unknown thrown value into a redacted server_error', () => {
    const exception = mapKnownError(new Error('some internal detail'));
    expect(exception.message).to.equal('server_error');
    expect(exception.code).to.equal(500);
  });

  it('toEventErrorResponse reuses an already-raised oauthError instead of re-mapping it', () => {
    const response = toEventErrorResponse(oauthError('access_denied', 'nope'));
    expect(response.error).to.equal('access_denied');
    expect(response.code).to.equal(403);
  });
});
