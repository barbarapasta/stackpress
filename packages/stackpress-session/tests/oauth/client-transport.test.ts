import { describe, it } from 'mocha';
import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { drainCapped, decodeResponseBody } from '../../src/oauth/clients/transport.js';
import { OAuthClientError } from '../../src/oauth/clients/errors.js';

function streamOf(buffer: Buffer): PassThrough {
  const stream = new PassThrough();
  stream.end(buffer);
  return stream;
}

describe('OAuth Client Document Transport (decoding/byte-cap)', () => {
  describe('drainCapped', () => {
    it('resolves with the full buffer when under the cap', async () => {
      const body = Buffer.from('hello world');
      const result = await drainCapped(streamOf(body), 1024);
      expect(result.equals(body)).to.equal(true);
    });

    it('rejects and destroys the stream once bytes exceed the cap', async () => {
      const body = Buffer.alloc(100, 'x');
      const stream = streamOf(body);
      try {
        await drainCapped(stream, 10);
        expect.fail('expected a rejection');
      } catch (e) {
        expect(e).to.be.instanceOf(OAuthClientError);
        expect((e as OAuthClientError).code).to.equal('fetch_failed');
      }
      expect(stream.destroyed).to.equal(true);
    });
  });

  describe('decodeResponseBody', () => {
    const plain = Buffer.from(JSON.stringify({ hello: 'world' }));

    it('passes identity/absent encoding through unchanged', async () => {
      const result = await decodeResponseBody(streamOf(plain), undefined, 1024);
      expect(result.equals(plain)).to.equal(true);
      const result2 = await decodeResponseBody(streamOf(plain), 'identity', 1024);
      expect(result2.equals(plain)).to.equal(true);
    });

    it('decodes gzip, deflate and br', async () => {
      const gzip = await decodeResponseBody(streamOf(gzipSync(plain)), 'gzip', 1024);
      expect(gzip.equals(plain)).to.equal(true);
      const deflate = await decodeResponseBody(streamOf(deflateSync(plain)), 'deflate', 1024);
      expect(deflate.equals(plain)).to.equal(true);
      const br = await decodeResponseBody(streamOf(brotliCompressSync(plain)), 'br', 1024);
      expect(br.equals(plain)).to.equal(true);
    });

    it('enforces the decoded-byte ceiling on the expanded output, not the compressed input', async () => {
      const large = Buffer.alloc(100_000, 'a');
      const compressed = gzipSync(large);
      expect(compressed.length).to.be.lessThan(1000);
      try {
        await decodeResponseBody(streamOf(compressed), 'gzip', 1000);
        expect.fail('expected the decoded ceiling to reject this response');
      } catch (e) {
        expect((e as OAuthClientError).code).to.equal('fetch_failed');
      }
    });

    it('rejects an unsupported Content-Encoding', async () => {
      try {
        await decodeResponseBody(streamOf(plain), 'compress', 1024);
        expect.fail('expected a rejection');
      } catch (e) {
        expect((e as OAuthClientError).code).to.equal('fetch_failed');
      }
    });
  });
});
