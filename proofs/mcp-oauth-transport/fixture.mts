//node
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
//modules
import { server } from '@stackpress/ingest/http';
//client
import type { AuthContext, ToolResolverServer }
  from '../../packages/stackpress-ai/src/types.js';
import { createMcpServer } from '../../packages/stackpress-ai/src/plugin.js';

//these fixed strings are disposable fixture credentials, never real tokens
export const keys = {
  alice: 'alice:fixture-secret',
  bob: 'bob:fixture-secret'
};

//the protocol version is supported by the pinned SDK used in this proof
export const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'transport-proof', version: '1' }
  }
};

/** Create an actual Ingest context and actual Stackpress MCP factory. */
export function context() {
  const ctx = server();
  const sessions = new Map([ 'alice', 'bob' ].map(id => [ id, {
    id, profileId: id, applicationId: 'fixture-client',
    secret: 'fixture-secret', scopes: [ 'read', 'write' ]
  } ]));
  ctx.config.set('mcp', { route: '/mcp', mode: 'stateful', tools: [
    { name: 'public', event: 'fixture-public', type: 'public', method: 'GET' },
    { name: 'read', event: 'fixture-identity', type: 'user', method: 'GET',
      scopes: [ 'read' ] },
    { name: 'write', event: 'fixture-identity', type: 'user', method: 'POST',
      scopes: [ 'write' ] }
  ] });
  ctx.on('application-detail', ({ res }) => { res.code = 404; });
  ctx.on('session-detail', ({ req, res }) => {
    const value = sessions.get(req.data('id'));
    //real stores return fresh objects; avoid sharing mutable test row objects
    if (value) res.results(structuredClone(value));
  });
  ctx.on('fixture-public', ({ res }) => {
    res.results({ message: 'public' });
  });
  ctx.on('fixture-identity', ({ req, res }) => {
    res.results({ person: req.data('profileId') });
  });
  //the production API erases Ingest adapter generics; preserve its cast here
  const resolver = ctx as unknown as ToolResolverServer;
  ctx.register('mcp', (auth?: AuthContext) => createMcpServer(resolver, auth));
  return { ctx, resolver, sessions };
}

/** Listen only on an ephemeral loopback port. */
export async function listen(service: Server) {
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  const address = service.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

/** Close network listeners even when a request has failed. */
export async function close(service: Server) {
  service.closeAllConnections();
  await new Promise<void>(resolve => service.close(() => resolve()));
}

/** Make a real HTTP request and decode JSON or SDK SSE replies. */
export async function rpc(
  base: string,
  body: object,
  token?: string,
  session?: string,
  extra: Record<string, string> = {}
) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(5000),
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
      ...extra
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const data = text.startsWith('event:') || text.startsWith('id:')
    ? text.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6))).at(-1)
    : text ? JSON.parse(text) : undefined;
  return { response, data };
}

/** Build one tool call with a distinct JSON-RPC request ID. */
export function call(id: number, name = 'read', args = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args } };
}

/** Save only observations, never request headers or issued credentials. */
export async function report(name: string, checks: object[]) {
  await writeFile(new URL(`./${name}-results.json`, import.meta.url),
    JSON.stringify({ node: process.version, sdk: '1.29.0',
      ingest: '0.10.8', checks }, null, 2) + '\n');
  process.stdout.write(`${name}: ${checks.length} observations passed\n`);
}
