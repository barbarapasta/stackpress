//node
import type { ServerResponse } from 'node:http';
//modules
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
//client
import type { AuthRequest, RpcBody } from './candidate.mjs';
import { Candidate, Refusal } from './candidate.mjs';

type LegacySession = {
  server: Server, transport: SSEServerTransport, owner?: string
};

/** Prove fresh POST authentication while replies use the older GET stream. */
export class LegacyCandidate extends Candidate {
  //these are SDK connection records, not proof of current access
  public legacySessions = new Map<string, LegacySession>();

  /** Older SSE always has a saved connection and a separate message endpoint. */
  public constructor() {
    super('stateful');
  }

  /** Publish a generic change signal without sensitive account data. */
  public override async changed() {
    await Promise.all([ ...this.legacySessions.values() ].map(session =>
      session.server.sendToolListChanged()));
  }

  /** Close every long-lived GET stream and its SDK server. */
  public override async close() {
    await Promise.all([ ...this.legacySessions.values() ].map(session =>
      session.transport.close()));
  }

  /** Authenticate each GET and POST before SDK headers or accepted replies. */
  public override async dispatch(
    req: AuthRequest, res: ServerResponse, parsed?: RpcBody
  ) {
    try {
      const url = new URL(req.url || '/', this.base);
      const isStream = req.method === 'GET' && url.pathname === '/sse';
      const isMessage = req.method === 'POST' && url.pathname === '/messages';
      if (!isStream && !isMessage) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.origin && req.headers.origin !== this.base) {
        throw new Refusal(403, 'origin_not_allowed');
      }
      const header = req.headers.authorization;
      if (header && (!header.startsWith('Bearer ') || !header.slice(7))) {
        throw new Refusal(401, 'invalid_token');
      }
      const auth = this.verify(header?.slice(7));
      req.auth = auth;
      const owner = auth ? this._owner(auth) : undefined;
      if (isStream) {
        //the GET stream carries later messages; a supplied credential must
        // prove full control even though tool reads may later use only an ID
        if (auth && !auth.extra?.full) {
          throw new Refusal(401, 'full_key_required');
        }
        const server = this._makeServer();
        const transport = new SSEServerTransport('/messages', res);
        const session = { server, transport, owner };
        this.legacySessions.set(transport.sessionId, session);
        transport.onclose = () => {
          this.legacySessions.delete(transport.sessionId);
        };
        await server.connect(transport);
        return;
      }
      const session = this.legacySessions.get(url.searchParams.get('sessionId') || '');
      if (!session) throw new Refusal(404, 'unknown_session');
      if (session.owner && owner !== session.owner) {
        throw new Refusal(auth ? 403 : 401, 'session_identity_mismatch');
      }
      const body = parsed || await this._read(req);
      if (Array.isArray(body)) throw new Refusal(400, 'batch_not_supported');
      if (body.method === 'tools/call') {
        this.authorize(body.params?.name || '', auth);
      }
      const publicControls = [ 'initialize', 'notifications/initialized',
        'tools/list', 'tools/call' ];
      if (!publicControls.includes(body.method || '') && !auth?.extra?.full) {
        throw new Refusal(401, 'full_key_required');
      }
      //bind once, then keep the person's/client's/approval's identity stable;
      // closing the only GET channel here would discard the client's replies
      if (!session.owner && owner) session.owner = owner;
      await session.transport.handlePostMessage(req, res, body);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const refusal = error instanceof Refusal
        ? error : new Refusal(500, (error as Error).message);
      const headers: Record<string, string> = {
        'content-type': 'application/json', 'cache-control': 'no-store'
      };
      if (refusal.status === 401 || refusal.scope) {
        headers['www-authenticate'] = `Bearer resource_metadata="${
          this.base}/.well-known/oauth-protected-resource/sse"`;
        if (refusal.scope) {
          headers['www-authenticate'] +=
            `, error="insufficient_scope", scope="${refusal.scope}"`;
        }
      }
      res.writeHead(refusal.status, headers).end(JSON.stringify({ error: refusal.message }));
    }
  }
}
