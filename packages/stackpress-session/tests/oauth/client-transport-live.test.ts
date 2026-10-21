import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { createServer, type Server } from 'node:https';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTransport } from '../../src/oauth/clients/transport.js';
import { OAuthClientError } from '../../src/oauth/clients/errors.js';

//Real-network coverage for `defaultTransport` (transport.ts's actual
//production `https.request` wiring), using a real local HTTPS server
//with a freshly generated self-signed certificate - "deterministic
//network failures plus real local fixtures" per sprint.md, rather than
//a production fallback. The server's CA is passed to `defaultTransport`
//via the test-only `ca` field (production callers never set it, so a
//real client-document fetch still verifies against Node's default
//public CA trust store); TLS certificate verification itself is never
//disabled. Scratch (the generated key/cert) lives under
//`/tmp/oauth-00004-tls-*` and is removed in `after`.
describe('OAuth Client Document Transport (defaultTransport, real local HTTPS fixture)', function () {
  this.timeout(20_000);

  let scratchDir: string;
  let server: Server;
  let port: number;
  let caPem: string;

  before(function () {
    let hasOpenssl = true;
    try {
      execFileSync('openssl', [ 'version' ], { stdio: 'ignore' });
    } catch {
      hasOpenssl = false;
    }
    if (!hasOpenssl) {
      this.skip();
      return;
    }
    scratchDir = mkdtempSync(join(tmpdir(), 'oauth-00004-tls-'));
    const keyPath = join(scratchDir, 'key.pem');
    const certPath = join(scratchDir, 'cert.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-days', '1', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ], { stdio: 'ignore' });
    const key = readFileSync(keyPath, 'utf8');
    caPem = readFileSync(certPath, 'utf8');

    server = createServer({ key, cert: caPem }, (req, res) => {
      if (req.url === '/doc.json') {
        const body = Buffer.from(JSON.stringify({ client_id: 'https://localhost/doc.json', ok: true }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=30' });
        res.end(body);
        return;
      }
      if (req.url === '/doc.json.gz') {
        const body = gzipSync(Buffer.from(JSON.stringify({ client_id: 'https://localhost/doc.json.gz' })));
        res.writeHead(200, { 'content-encoding': 'gzip' });
        res.end(body);
        return;
      }
      if (req.url === '/oversized.gz') {
        const body = gzipSync(Buffer.alloc(200_000, 'a'));
        res.writeHead(200, { 'content-encoding': 'gzip' });
        res.end(body);
        return;
      }
      if (req.url === '/slow') {
        //never responds within the test's configured timeout
        setTimeout(() => { res.writeHead(200); res.end('{}'); }, 10_000);
        return;
      }
      if (req.url === '/not-found') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(400);
      res.end();
    });
  });

  before((done) => {
    if (!server) {
      done();
      return;
    }
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      done();
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (scratchDir) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it('performs a real HTTPS request bound to the given address, verifying the self-signed CA rather than disabling verification', async () => {
    const response = await defaultTransport({
      address: '127.0.0.1', hostname: 'localhost', port, path: '/doc.json',
      headers: {}, timeoutMs: 5000, maxDecodedBytes: 4096, ca: caPem
    });
    expect(response.status).to.equal(200);
    expect(JSON.parse(response.body.toString('utf8'))).to.deep.equal({
      client_id: 'https://localhost/doc.json', ok: true
    });
  });

  it('rejects the connection when the CA is not trusted (certificate verification is real, not bypassed)', async () => {
    try {
      await defaultTransport({
        address: '127.0.0.1', hostname: 'localhost', port, path: '/doc.json',
        headers: {}, timeoutMs: 5000, maxDecodedBytes: 4096
        //no `ca`: Node's default public trust store will not trust this
        //self-signed certificate.
      });
      expect.fail('expected the real TLS handshake to fail');
    } catch (e) {
      expect(e).to.be.instanceOf(OAuthClientError);
      expect((e as OAuthClientError).code).to.equal('fetch_failed');
    }
  });

  it('decodes a real gzip response end-to-end over a real TLS connection', async () => {
    const response = await defaultTransport({
      address: '127.0.0.1', hostname: 'localhost', port, path: '/doc.json.gz',
      headers: {}, timeoutMs: 5000, maxDecodedBytes: 4096, ca: caPem
    });
    expect(response.status).to.equal(200);
    expect(JSON.parse(response.body.toString('utf8'))).to.deep.equal({
      client_id: 'https://localhost/doc.json.gz'
    });
  });

  it('enforces the decoded-byte ceiling on a real response, not merely the simulated stream in client-transport.test.ts', async () => {
    try {
      await defaultTransport({
        address: '127.0.0.1', hostname: 'localhost', port, path: '/oversized.gz',
        headers: {}, timeoutMs: 5000, maxDecodedBytes: 4096, ca: caPem
      });
      expect.fail('expected the decoded ceiling to reject this response');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('fetch_failed');
    }
  });

  it('enforces the configured timeout against a real server that never responds', async () => {
    const started = Date.now();
    try {
      await defaultTransport({
        address: '127.0.0.1', hostname: 'localhost', port, path: '/slow',
        headers: {}, timeoutMs: 300, maxDecodedBytes: 4096, ca: caPem
      });
      expect.fail('expected a timeout');
    } catch (e) {
      expect((e as OAuthClientError).code).to.equal('fetch_failed');
      expect(Date.now() - started).to.be.lessThan(5000);
    }
  });

  it('passes a non-2xx status straight through without throwing, so the caller decides', async () => {
    const response = await defaultTransport({
      address: '127.0.0.1', hostname: 'localhost', port, path: '/not-found',
      headers: {}, timeoutMs: 5000, maxDecodedBytes: 4096, ca: caPem
    });
    expect(response.status).to.equal(404);
  });
});
