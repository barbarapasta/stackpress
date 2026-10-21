import { describe, it } from 'mocha';
import { expect } from 'chai';
import {
  isDisallowedIpv4,
  isDisallowedIpv6,
  isDisallowedAddress,
  isIpLiteralHostname
} from '../../src/oauth/clients/network.js';

describe('OAuth Client Network Safety', () => {
  describe('isDisallowedIpv4', () => {
    it('rejects private, loopback, link-local and reserved ranges', () => {
      const disallowed = [
        '10.0.0.1', '172.16.5.5', '192.168.1.1', '127.0.0.1',
        '169.254.1.1', '0.0.0.0', '100.64.0.1', '192.0.2.1',
        '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255'
      ];
      for (const address of disallowed) {
        expect(isDisallowedIpv4(address), address).to.equal(true);
      }
    });

    it('allows ordinary public addresses', () => {
      expect(isDisallowedIpv4('8.8.8.8')).to.equal(false);
      expect(isDisallowedIpv4('93.184.216.34')).to.equal(false);
    });

    it('rejects malformed octets (octal, out-of-range, wrong count)', () => {
      expect(isDisallowedIpv4('010.0.0.1')).to.equal(true);
      expect(isDisallowedIpv4('256.0.0.1')).to.equal(true);
      expect(isDisallowedIpv4('1.2.3')).to.equal(true);
      expect(isDisallowedIpv4('1.2.3.4.5')).to.equal(true);
    });
  });

  describe('isDisallowedIpv6', () => {
    it('rejects loopback, unspecified, link-local and unique-local', () => {
      expect(isDisallowedIpv6('::1')).to.equal(true);
      expect(isDisallowedIpv6('::')).to.equal(true);
      expect(isDisallowedIpv6('fe80::1')).to.equal(true);
      expect(isDisallowedIpv6('fd00::1')).to.equal(true);
      expect(isDisallowedIpv6('ff02::1')).to.equal(true);
    });

    it('rejects IPv4 written as IPv6 (mapped, compatible, 6to4) when the embedded address is disallowed', () => {
      expect(isDisallowedIpv6('::ffff:127.0.0.1')).to.equal(true);
      expect(isDisallowedIpv6('::ffff:10.0.0.1')).to.equal(true);
      expect(isDisallowedIpv6('::127.0.0.1')).to.equal(true);
      expect(isDisallowedIpv6('2002:7f00:0001::')).to.equal(true);
    });

    it('allows a public address embedded via IPv4-mapped form', () => {
      expect(isDisallowedIpv6('::ffff:8.8.8.8')).to.equal(false);
    });

    it('allows an ordinary public IPv6 address', () => {
      expect(isDisallowedIpv6('2001:4860:4860::8888')).to.equal(false);
    });

    it('rejects documentation-range and malformed literals', () => {
      expect(isDisallowedIpv6('2001:db8::1')).to.equal(true);
      expect(isDisallowedIpv6('not-an-address')).to.equal(true);
    });
  });

  describe('isDisallowedAddress', () => {
    it('dispatches by family and rejects anything unparseable', () => {
      expect(isDisallowedAddress('127.0.0.1')).to.equal(true);
      expect(isDisallowedAddress('::1')).to.equal(true);
      expect(isDisallowedAddress('8.8.8.8')).to.equal(false);
      expect(isDisallowedAddress('example.com')).to.equal(true);
    });
  });

  describe('isIpLiteralHostname', () => {
    it('distinguishes IP literals from DNS names', () => {
      expect(isIpLiteralHostname('127.0.0.1')).to.equal(true);
      expect(isIpLiteralHostname('::1')).to.equal(true);
      expect(isIpLiteralHostname('example.com')).to.equal(false);
    });
  });
});
