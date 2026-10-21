import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  isLocalMachineHost,
  validateReturnAddress,
  isAcceptableRegisteredRedirect
} from '../../src/oauth/clients/redirect.js';

describe('OAuth Return Address Validation', () => {
  describe('isLocalMachineHost', () => {
    it('recognizes exactly the three local-machine spellings', () => {
      expect(isLocalMachineHost('localhost')).to.equal(true);
      expect(isLocalMachineHost('127.0.0.1')).to.equal(true);
      expect(isLocalMachineHost('::1')).to.equal(true);
    });

    it('rejects deceptive lookalikes', () => {
      expect(isLocalMachineHost('localhost.evil.example')).to.equal(false);
      expect(isLocalMachineHost('127.0.0.1.evil.example')).to.equal(false);
      expect(isLocalMachineHost('0.0.0.0')).to.equal(false);
    });
  });

  describe('validateReturnAddress', () => {
    const registered = [ 'https://client.example/callback' ];

    it('accepts an exact match', () => {
      expect(validateReturnAddress('https://client.example/callback', registered)).to.equal(true);
    });

    it('rejects any changed component: scheme, path, query, unrelated host', () => {
      expect(validateReturnAddress('http://client.example/callback', registered)).to.equal(false);
      expect(validateReturnAddress('https://client.example/callback/', registered)).to.equal(false);
      expect(validateReturnAddress('https://client.example/callback?x=1', registered)).to.equal(false);
      expect(validateReturnAddress('https://evil.example/callback', registered)).to.equal(false);
    });

    it('rejects a fragment or embedded credentials', () => {
      expect(validateReturnAddress('https://client.example/callback#frag', registered)).to.equal(false);
      expect(validateReturnAddress('https://user:pass@client.example/callback', registered)).to.equal(false);
    });

    it('rejects a changed port on a non-local-machine host', () => {
      expect(validateReturnAddress('https://client.example:8443/callback', registered)).to.equal(false);
    });

    it('allows a different port only when the registered host is an explicit local-machine host', () => {
      const loopback = [ 'http://127.0.0.1:8080/callback' ];
      expect(validateReturnAddress('http://127.0.0.1:51234/callback', loopback)).to.equal(true);
      expect(validateReturnAddress('http://127.0.0.1:51234/other', loopback)).to.equal(false);
    });

    it('treats localhost, 127.0.0.1 and ::1 as separate identities', () => {
      const loopback = [ 'http://localhost:8080/callback' ];
      expect(validateReturnAddress('http://127.0.0.1:8080/callback', loopback)).to.equal(false);
      expect(validateReturnAddress('http://[::1]:8080/callback', loopback)).to.equal(false);
      expect(validateReturnAddress('http://localhost:9999/callback', loopback)).to.equal(true);
    });

    it('rejects everything when the registered list is empty', () => {
      expect(validateReturnAddress('https://client.example/callback', [])).to.equal(false);
    });

    it('rejects a malformed candidate', () => {
      expect(validateReturnAddress('not a url', registered)).to.equal(false);
    });

    it('ignores a malformed registered entry rather than matching it', () => {
      expect(validateReturnAddress('https://client.example/callback', [ 'not a url' ])).to.equal(false);
    });
  });

  describe('isAcceptableRegisteredRedirect', () => {
    it('accepts HTTPS and local-machine HTTP', () => {
      expect(isAcceptableRegisteredRedirect('https://client.example/callback')).to.equal(true);
      expect(isAcceptableRegisteredRedirect('http://127.0.0.1:51234/callback')).to.equal(true);
    });

    it('rejects plain HTTP on a non-local host, a fragment, and credentials', () => {
      expect(isAcceptableRegisteredRedirect('http://client.example/callback')).to.equal(false);
      expect(isAcceptableRegisteredRedirect('https://client.example/callback#x')).to.equal(false);
      expect(isAcceptableRegisteredRedirect('https://u:p@client.example/callback')).to.equal(false);
      expect(isAcceptableRegisteredRedirect('not a url')).to.equal(false);
    });
  });
});
