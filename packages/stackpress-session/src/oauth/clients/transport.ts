//modules
import { request as httpsRequest } from 'node:https';
import {
  createGunzip, createInflate, createBrotliDecompress
} from 'node:zlib';
import type { Readable, Duplex } from 'node:stream';
//stackpress-session/oauth/clients
import { OAuthClientError } from './errors.js';

//The network edge of client-document fetching: bind a single HTTPS
//request to an already-checked address (configuration.md: "Bind the
//network connection to the checked DNS address...without accepting a
//later unchecked address"), enforce one timeout across connect/
//headers/body, cap decoded bytes including decompression expansion,
//and never follow a redirect. Kept as a thin, swappable function so
//tests inject a fully in-memory substitute instead of touching a real
//socket or DNS resolver (per sprint.md: controllable test substitutes
//kept near the tests, never a production fallback).

export type OAuthTransportRequest = {
  //the checked, resolved IP this connection must bind to - never the
  //hostname, so no later DNS answer can silently redirect the socket.
  address: string,
  //original hostname: used only for the TLS SNI/certificate check and
  //the HTTP Host header.
  hostname: string,
  port: number,
  path: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxDecodedBytes: number,
  //only ever set by a test fixture's local HTTPS server (see
  //tests/oauth/client-transport-live.test.ts); production callers
  //never set this, so every real client-document fetch is verified
  //against Node's default, well-known public CA trust store.
  ca?: string | Buffer
};

export type OAuthTransportResponse = {
  status: number,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer
};

export type OAuthTransport =
  (request: OAuthTransportRequest) => Promise<OAuthTransportResponse>;

/**
 * Drains a readable stream into a single buffer, destroying it and
 * rejecting the moment accumulated bytes exceed `maxBytes`. Used both
 * for an uncompressed response body and for the output side of a
 * decompression stream, so a compressed response cannot expand past
 * the configured decoded-byte ceiling even though the bytes actually
 * received over the wire were small.
 */
export function drainCapped(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(new OAuthClientError(
          'fetch_failed',
          'Response exceeded the configured decoded-byte ceiling'
        ));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', fail);
  });
}

/**
 * Decodes a raw response body according to `contentEncoding`
 * (`gzip`/`x-gzip`, `deflate`, `br`, or absent/`identity`), enforcing
 * `maxDecodedBytes` on the decoded output regardless of how small the
 * compressed input was.
 */
export function decodeResponseBody(
  raw: Readable,
  contentEncoding: string | undefined,
  maxDecodedBytes: number
): Promise<Buffer> {
  const encoding = (contentEncoding || '').toLowerCase().trim();
  if (!encoding || encoding === 'identity') {
    return drainCapped(raw, maxDecodedBytes);
  }
  let decoder: Duplex;
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    decoder = createGunzip();
  } else if (encoding === 'deflate') {
    decoder = createInflate();
  } else if (encoding === 'br') {
    decoder = createBrotliDecompress();
  } else {
    return Promise.reject(new OAuthClientError(
      'fetch_failed',
      `Unsupported Content-Encoding: ${contentEncoding}`
    ));
  }
  raw.on('error', (e) => decoder.destroy(e));
  raw.pipe(decoder);
  return drainCapped(decoder, maxDecodedBytes);
}

/**
 * Production transport: a single HTTPS request bound to the checked
 * `address`, with `hostname` used only for SNI/Host, one timeout
 * spanning connect through body, no redirect following (the caller
 * treats any 3xx as a failure, this function simply never issues a
 * second request), and the shared decoded-byte ceiling above.
 */
export const defaultTransport: OAuthTransport = (req) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    const httpRequest = httpsRequest({
      host: req.address,
      port: req.port,
      path: req.path,
      method: 'GET',
      servername: req.hostname,
      headers: { Host: req.hostname, ...req.headers },
      timeout: req.timeoutMs,
      ca: req.ca
    }, (response) => {
      decodeResponseBody(
        response,
        Array.isArray(response.headers['content-encoding']) ?
          response.headers['content-encoding'][0] :
          response.headers['content-encoding'],
        req.maxDecodedBytes
      ).then((body) => {
        finish(() => resolve({
          status: response.statusCode || 0,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body
        }));
      }).catch((e) => finish(() => reject(e)));
    });

    httpRequest.on('timeout', () => {
      finish(() => reject(new OAuthClientError(
        'fetch_failed', 'Client document fetch timed out'
      )));
      httpRequest.destroy();
    });
    httpRequest.on('error', (e) => {
      finish(() => reject(new OAuthClientError(
        'fetch_failed', `Client document fetch failed: ${e.message}`
      )));
    });
    httpRequest.end();
  });
};
