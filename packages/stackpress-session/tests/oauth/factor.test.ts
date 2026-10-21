import { describe, it } from 'mocha';
import { expect } from 'chai';
import { createFactorReceipt, verifyFactorReceipt } from '../../src/oauth/factor.js';

describe('OAuth factor receipt (events.md: server-bound, <=5min, never past pending expiry)', () => {
  const content = {
    profileId: 'profile-1',
    pendingId: 'pending-1',
    scopes: [ 'articles:read' ],
    operations: [ 'articles.detail' ]
  };

  it('verifies a freshly minted receipt against the exact same content', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const pendingExpires = new Date(now.getTime() + 10 * 60_000);
    const receipt = createFactorReceipt('seed-1', content, pendingExpires, now);
    expect(verifyFactorReceipt('seed-1', receipt, content, pendingExpires, now)).to.equal(true);
  });

  it('rejects a receipt signed with a different seed', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const pendingExpires = new Date(now.getTime() + 10 * 60_000);
    const receipt = createFactorReceipt('seed-1', content, pendingExpires, now);
    expect(verifyFactorReceipt('seed-2', receipt, content, pendingExpires, now)).to.equal(false);
  });

  it('rejects a malformed receipt', () => {
    const now = new Date();
    const pendingExpires = new Date(now.getTime() + 60_000);
    expect(verifyFactorReceipt('seed-1', 'not-a-receipt', content, pendingExpires, now)).to.equal(false);
    expect(verifyFactorReceipt('seed-1', 'a.b.c', content, pendingExpires, now)).to.equal(false);
  });

  it('rejects content that changed after the factor check (scope narrowing invalidates it)', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const pendingExpires = new Date(now.getTime() + 10 * 60_000);
    const receipt = createFactorReceipt('seed-1', content, pendingExpires, now);
    const narrowed = { ...content, scopes: [] };
    expect(verifyFactorReceipt('seed-1', receipt, narrowed, pendingExpires, now)).to.equal(false);
  });

  it('caps the receipt at 5 minutes even when the pending request lives longer', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const pendingExpires = new Date(now.getTime() + 60 * 60_000);
    const receipt = createFactorReceipt('seed-1', content, pendingExpires, now);
    const sixMinutesLater = new Date(now.getTime() + 6 * 60_000);
    expect(verifyFactorReceipt('seed-1', receipt, content, pendingExpires, sixMinutesLater)).to.equal(false);
  });

  it('never outlives the pending request even when under 5 minutes old', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const pendingExpires = new Date(now.getTime() + 60_000);
    const receipt = createFactorReceipt('seed-1', content, pendingExpires, now);
    const ninetySecondsLater = new Date(now.getTime() + 90_000);
    expect(verifyFactorReceipt('seed-1', receipt, content, pendingExpires, ninetySecondsLater)).to.equal(false);
  });
});
