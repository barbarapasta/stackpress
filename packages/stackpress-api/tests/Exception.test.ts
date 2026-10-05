import { describe, it } from 'mocha';
import { expect } from 'chai';
import StackpressApiException from '../src/Exception.js';

describe('api/Exception', () => {
  it('should construct with a message', () => {
    const error = new StackpressApiException('Something went wrong');
    expect(error).to.be.instanceOf(Error);
    expect(error.message).to.equal('Something went wrong');
  });

  it('should support the static for() helper with interpolation', () => {
    const error = StackpressApiException.for('Missing %s', 'client_id');
    expect(error.message).to.equal('Missing client_id');
  });

  it('should support withCode()/toResponse() used by helpers.unauthorized', () => {
    const error = StackpressApiException.for('Unauthorized').withCode(401);
    expect(error.code).to.equal(401);
    const response = error.toResponse();
    expect(response.code).to.equal(401);
    expect(response.error).to.equal('Unauthorized');
  });
});
