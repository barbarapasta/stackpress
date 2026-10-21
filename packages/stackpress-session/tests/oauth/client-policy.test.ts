import { describe, it } from 'mocha';
import { expect } from 'chai';
import { isClientAllowed } from '../../src/oauth/clients/policy.js';

describe('OAuth Client Admission Policy', () => {
  it('admits any client when clients.allowed is omitted', () => {
    expect(isClientAllowed('any-client', undefined)).to.equal(true);
    expect(isClientAllowed('any-client', {})).to.equal(true);
  });

  it('admits only exact listed client IDs when clients.allowed is set', () => {
    const clients = { allowed: [ 'client-a', 'https://doc.example/client.json' ] };
    expect(isClientAllowed('client-a', clients)).to.equal(true);
    expect(isClientAllowed('https://doc.example/client.json', clients)).to.equal(true);
    expect(isClientAllowed('client-b', clients)).to.equal(false);
  });

  it('denies every client when clients.allowed is explicitly empty', () => {
    expect(isClientAllowed('client-a', { allowed: [] })).to.equal(false);
  });

  it('uses exact string matching, no normalization leniency', () => {
    const clients = { allowed: [ 'https://doc.example/client.json' ] };
    expect(isClientAllowed('https://doc.example/client.json/', clients)).to.equal(false);
  });
});
