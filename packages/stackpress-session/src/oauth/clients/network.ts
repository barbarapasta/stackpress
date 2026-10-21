//modules
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

//SSRF-relevant address classification used before connecting a client
//document fetch to any resolved or literal address (configuration.md/
//storage.md: "Reject redirects, private/local/reserved targets,
//deceptive hostnames and malformed IPv4/IPv6 forms"). Deliberately
//conservative: anything not clearly public is rejected.

export type OAuthDnsAddress = { address: string, family: 4 | 6 };

export type OAuthDnsResolver = (hostname: string) => Promise<OAuthDnsAddress[]>;

/**
 * Production DNS resolver: a real `dns.lookup` with `all: true` so every
 * answer is checked, not only the first one a round-robin happens to
 * return first.
 */
export async function resolveHostname(hostname: string): Promise<OAuthDnsAddress[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4
  }));
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    //reject octal/hex/leading-zero/empty forms; dotted-decimal octets
    //only, exactly as DNS/IP literals should be written.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n < 0 || n > 255) {
      return null;
    }
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function inIpv4Range(value: number, base: string, bits: number): boolean {
  const baseValue = ipv4ToInt(base);
  if (baseValue === null) {
    return false;
  }
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

const IPV4_DISALLOWED_RANGES: Array<[string, number]> = [
  [ '0.0.0.0', 8 ],
  [ '10.0.0.0', 8 ],
  [ '100.64.0.0', 10 ],
  [ '127.0.0.0', 8 ],
  [ '169.254.0.0', 16 ],
  [ '172.16.0.0', 12 ],
  [ '192.0.0.0', 24 ],
  [ '192.0.2.0', 24 ],
  [ '192.168.0.0', 16 ],
  [ '198.18.0.0', 15 ],
  [ '198.51.100.0', 24 ],
  [ '203.0.113.0', 24 ],
  [ '224.0.0.0', 4 ],
  [ '240.0.0.0', 4 ],
  [ '255.255.255.255', 32 ]
];

/**
 * True when a dotted-decimal IPv4 literal is private, loopback,
 * link-local, documentation/test, multicast, reserved or otherwise not
 * a routable public address. Malformed forms (octal, hex, too few/many
 * octets, out-of-range octets) are also treated as disallowed rather
 * than parsed leniently.
 */
export function isDisallowedIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) {
    return true;
  }
  return IPV4_DISALLOWED_RANGES.some(
    ([ base, bits ]) => inIpv4Range(value, base, bits)
  );
}

function ipv6ToBytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) {
    return null;
  }
  //node:net has no byte accessor; use Buffer-free manual parse via the
  //canonical expansion. Reuse isIP only as the format gate, then expand
  //manually so this file has no dependency on a particular Node
  //internal representation.
  let body = address;
  const zoneIndex = body.indexOf('%');
  if (zoneIndex !== -1) {
    body = body.substring(0, zoneIndex);
  }
  let head = body;
  let tail = '';
  const collapse = body.indexOf('::');
  if (collapse !== -1) {
    head = body.substring(0, collapse);
    tail = body.substring(collapse + 2);
  }
  let headParts = head.length ? head.split(':') : [];
  let tailParts = tail.length ? tail.split(':') : [];
  //an embedded IPv4 tail (e.g. ::ffff:127.0.0.1) appears as the final
  //group containing dots, in whichever half of the address holds it.
  const expandEmbeddedV4 = (parts: string[]): string[] | null => {
    if (parts.length === 0 || !parts[parts.length - 1].includes('.')) {
      return parts;
    }
    const v4 = ipv4ToInt(parts[parts.length - 1]);
    if (v4 === null) {
      return null;
    }
    return [
      ...parts.slice(0, -1),
      ((v4 >>> 16) & 0xffff).toString(16),
      (v4 & 0xffff).toString(16)
    ];
  };
  const expandedHead = expandEmbeddedV4(headParts);
  const expandedTail = expandEmbeddedV4(tailParts);
  if (expandedHead === null || expandedTail === null) {
    return null;
  }
  headParts = expandedHead;
  tailParts = expandedTail;

  const missing = 8 - headParts.length - tailParts.length;
  if ((collapse === -1 && missing !== 0) || (collapse !== -1 && missing < 0)) {
    return null;
  }
  const filled = collapse === -1 ?
    headParts :
    [ ...headParts, ...new Array(missing).fill('0'), ...tailParts ];
  if (filled.length !== 8) {
    return null;
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(filled[i] || '0', 16);
    if (Number.isNaN(n) || n < 0 || n > 0xffff) {
      return null;
    }
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

/**
 * True when an IPv6 literal is loopback, unspecified, link-local,
 * unique-local, multicast, documentation, or an IPv4-mapped/
 * IPv4-compatible/6to4 form that itself unwraps to a disallowed IPv4
 * address ("IPv4 written as IPv6", per verification.md).
 */
export function isDisallowedIpv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (!bytes) {
    return true;
  }
  const isAllZero = (start: number, end: number) =>
    bytes.slice(start, end).every((b) => b === 0);

  //::
  if (isAllZero(0, 16)) {
    return true;
  }
  //::1 loopback
  if (isAllZero(0, 15) && bytes[15] === 1) {
    return true;
  }
  //fe80::/10 link-local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return true;
  }
  //fc00::/7 unique local
  if ((bytes[0] & 0xfe) === 0xfc) {
    return true;
  }
  //ff00::/8 multicast
  if (bytes[0] === 0xff) {
    return true;
  }
  //2001:db8::/32 documentation
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return true;
  }
  //::ffff:a.b.c.d IPv4-mapped
  if (isAllZero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isDisallowedIpv4(embedded);
  }
  //::a.b.c.d IPv4-compatible (deprecated but still resolvable)
  if (isAllZero(0, 12) && !isAllZero(12, 16)) {
    const embedded = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isDisallowedIpv4(embedded);
  }
  //2002::/16 6to4: embeds an IPv4 address in bytes 2-5
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const embedded = `${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`;
    return isDisallowedIpv4(embedded);
  }
  return false;
}

/**
 * True when the given address literal (IPv4 or IPv6) must never be
 * connected to by a client-document fetch: anything private, loopback,
 * link-local, reserved, documentation, multicast or malformed.
 */
export function isDisallowedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isDisallowedIpv4(address);
  }
  if (family === 6) {
    return isDisallowedIpv6(address);
  }
  return true;
}

/**
 * True when `hostname` parses as an IP literal at all (IPv4 or IPv6,
 * including bracketed/zoned IPv6 forms), as opposed to a DNS name that
 * still needs resolving.
 */
export function isIpLiteralHostname(hostname: string): boolean {
  return isIP(hostname) !== 0;
}
