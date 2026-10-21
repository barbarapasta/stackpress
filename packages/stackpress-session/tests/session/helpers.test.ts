//Coverage for the existing (previously untested) session/helpers.ts pure
//functions: route/event permission matching and the TOTP helpers. Part of
//side task 00007A.
import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  matchEvent,
  matchAnyEvent,
  matchRoute,
  matchAnyRoute,
  base32Decode,
  generateTOTP,
  verifyTOTP,
  generateSecret
} from '../../src/session/helpers.js';

describe('session/helpers', () => {
  describe('matchEvent/matchAnyEvent', () => {
    it('matches an exact event name', () => {
      expect(matchEvent('article-detail', 'article-detail')).to.equal(true);
    });

    it('matches a single-segment wildcard', () => {
      expect(matchEvent('article-detail', 'article-*')).to.equal(true);
      expect(matchEvent('article-detail-extra', 'article-*')).to.equal(false);
    });

    it('matches a double-star wildcard across segments', () => {
      expect(matchEvent('article-detail-extra', 'article-**')).to.equal(true);
    });

    it('accepts a literal regexp-string permission', () => {
      expect(matchEvent('article-detail', '/^article-.+$/i')).to.equal(true);
    });

    it('rejects a non-matching pattern', () => {
      expect(matchEvent('profile-detail', 'article-*')).to.equal(false);
    });

    it('matchAnyEvent: true on an obvious list match, false otherwise', () => {
      expect(matchAnyEvent('profile-detail', [ 'article-*', 'profile-detail' ])).to.equal(true);
      expect(matchAnyEvent('profile-detail', [ 'article-*' ])).to.equal(false);
    });
  });

  describe('matchRoute/matchAnyRoute', () => {
    const permit = { method: 'GET', route: '/api/articles/5' };

    it('matches an exact route and method', () => {
      expect(matchRoute(permit, { method: 'GET', route: '/api/articles/5' })).to.equal(true);
    });

    it('ALL method matches any request method', () => {
      expect(matchRoute(permit, { method: 'ALL', route: '/api/articles/5' })).to.equal(true);
    });

    it('rejects a mismatched method even with a matching route', () => {
      expect(matchRoute(permit, { method: 'POST', route: '/api/articles/5' })).to.equal(false);
    });

    it('matches a :param route template', () => {
      expect(matchRoute(permit, { method: 'GET', route: '/api/articles/:id' })).to.equal(true);
    });

    it('matches a single-segment wildcard route', () => {
      expect(matchRoute(permit, { method: 'GET', route: '/api/articles/*' })).to.equal(true);
    });

    it('matches a double-star wildcard route across segments', () => {
      expect(matchRoute(permit, { method: 'GET', route: '/api/**' })).to.equal(true);
    });

    it('rejects a non-matching route', () => {
      expect(matchRoute(permit, { method: 'GET', route: '/api/profiles/:id' })).to.equal(false);
    });

    it('matchAnyRoute: true if any permission matches', () => {
      expect(matchAnyRoute(permit, [
        { method: 'GET', route: '/api/profiles/:id' },
        { method: 'GET', route: '/api/articles/:id' }
      ])).to.equal(true);
      expect(matchAnyRoute(permit, [
        { method: 'GET', route: '/api/profiles/:id' }
      ])).to.equal(false);
    });
  });

  describe('base32Decode', () => {
    it('decodes a base32 string back to the original bytes', () => {
      //"hello" base32-encoded (RFC 4648, no padding kept)
      const decoded = base32Decode('NBSWY3DP');
      expect(decoded.toString('utf8')).to.equal('hello');
    });

    it('ignores trailing padding characters', () => {
      const decoded = base32Decode('NBSWY3DP===');
      expect(decoded.toString('utf8')).to.equal('hello');
    });

    it('throws on an invalid base32 character', () => {
      expect(() => base32Decode('NOT-VALID-1')).to.throw('Invalid base32 character');
    });
  });

  describe('TOTP (generateSecret/generateTOTP/verifyTOTP)', () => {
    it('generateSecret returns a base32-alphabet string of the requested length', () => {
      const secret = generateSecret(20);
      expect(secret).to.have.length(20);
      expect(secret).to.match(/^[A-Z2-7]+$/);
    });

    it('generateTOTP is deterministic for the same secret and time window', () => {
      const secret = generateSecret();
      const a = generateTOTP(secret, 0);
      const b = generateTOTP(secret, 0);
      expect(a).to.equal(b);
      expect(a).to.match(/^\d{6}$/);
    });

    it('verifyTOTP accepts the current code and a code within the window', () => {
      const secret = generateSecret();
      const current = generateTOTP(secret, 0);
      expect(verifyTOTP(current, secret)).to.equal(true);
      const next = generateTOTP(secret, 1);
      expect(verifyTOTP(next, secret, 1)).to.equal(true);
    });

    it('verifyTOTP rejects a code outside the window and an unrelated secret', () => {
      const secret = generateSecret();
      const farFuture = generateTOTP(secret, 5);
      expect(verifyTOTP(farFuture, secret, 1)).to.equal(false);
      expect(verifyTOTP('000000', generateSecret())).to.equal(false);
    });
  });
});
