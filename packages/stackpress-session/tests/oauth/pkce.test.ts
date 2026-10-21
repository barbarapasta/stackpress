import { describe, it } from 'mocha';
import { expect } from 'chai';
import { computeS256Challenge, verifyPkceS256 } from '../../src/oauth/pkce.js';

describe('OAuth PKCE (S256)', () => {
  it('accepts a matching verifier/challenge pair', () => {
    const verifier = 'a-real-code-verifier-with-enough-entropy-0123456789';
    const challenge = computeS256Challenge(verifier);
    expect(verifyPkceS256(verifier, challenge)).to.equal(true);
  });

  it('rejects a wrong verifier', () => {
    const challenge = computeS256Challenge('verifier-one');
    expect(verifyPkceS256('verifier-two', challenge)).to.equal(false);
  });

  it('rejects an empty verifier or challenge', () => {
    expect(verifyPkceS256('', 'something')).to.equal(false);
    expect(verifyPkceS256('something', '')).to.equal(false);
    expect(verifyPkceS256('', '')).to.equal(false);
  });

  it('never throws on a malformed challenge of mismatched length', () => {
    expect(verifyPkceS256('verifier', 'not-a-real-challenge')).to.equal(false);
  });
});
