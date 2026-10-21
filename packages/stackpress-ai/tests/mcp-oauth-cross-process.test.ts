//node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
//modules
import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';

import { createAllOAuthTables } from '../../stackpress-session/src/oauth/storage/tables.js';
import {
  buildRealDbCtx, connectRealDbEngine, RESOURCE, CLIENT_ID,
  type RealDbEngineKind
} from './fixtures/real-db-ctx.js';
import { computeS256Challenge } from '../../stackpress-session/src/oauth/pkce.js';
import { hashWithDomain, newPendingBinding } from '../../stackpress-session/src/oauth/storage/ids.js';

//storage.md's "each process watch/poll revisions" clause (sprint.md
//allocates "list notifications across processes" to this task, not
//00011) needs two *real OS processes* sharing one *real* PostgreSQL/
//MySQL server - PGlite (every other test in this package) is
//single-process by construction and cannot exercise this at all. This
//suite starts one disposable, tmpfs-backed container per engine (see
//task notes for the exact `docker run`/cleanup commands run alongside
//this pass) and spawns separate `tsx` child processes for the writer
//(`revoke`) and the watcher (`watch`), plus a third for the stale-access
//recheck (`verify-stale`) - none of the three ever import each other or
//share anything but the real database rows.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.join(__dirname, 'fixtures', 'cross-process-worker.ts');
const TSX_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');

const CODE_VERIFIER = 'cross-process-verifier-with-enough-entropy-0123456789';
const CODE_CHALLENGE = computeS256Challenge(CODE_VERIFIER);

function runWorker(
  mode: 'watch' | 'revoke' | 'verify-stale',
  kind: RealDbEngineKind,
  payload: Record<string, unknown>
): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      TSX_BIN,
      [ WORKER_SCRIPT, mode, kind, JSON.stringify(payload) ],
      { timeout: 20_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof (error as any).code === 'number' ? (error as any).code : 0,
          stdout, stderr
        });
      }
    );
  });
}

function runCrossProcessSuite(name: string, kind: RealDbEngineKind) {
  describe(`MCP OAuth cross-process list notifications (${name})`, function () {
    this.timeout(40_000);
    let close: () => Promise<void>;
    let skipped = false;

    before(async function () {
      let connected: Awaited<ReturnType<typeof connectRealDbEngine>>;
      try {
        connected = await connectRealDbEngine(kind);
      } catch (e) {
        skipped = true;
        this.skip();
        return;
      }
      close = connected.close;
      for (const create of createAllOAuthTables()) {
        create.engine = connected.engine;
        await create;
      }
    });

    after(async () => {
      if (!skipped && close) {
        await close();
      }
    });

    async function createGrantAndToken(scopes: string[] = [ 'articles:read' ]) {
      //table setup happened in `before()` on the test process's own
      //connection; grant creation here uses one more fresh connection of
      //its own, matching the rest of this suite's one-connection-per-
      //actor rule rather than reusing `before()`'s.
      const { engine, close: closeSetup } = await connectRealDbEngine(kind);
      try {
        const { store } = buildRealDbCtx(engine);
        const pending = await store.createPending({
          id: `pending_${Math.random().toString(36).slice(2)}`,
          bindingHash: hashWithDomain('pending-binding', newPendingBinding()),
          clientId: CLIENT_ID,
          redirectUri: 'https://client.example/callback',
          codeChallenge: CODE_CHALLENGE,
          resource: RESOURCE,
          scopes,
          operations: [],
          expires: new Date(Date.now() + 600_000)
        });
        const { grant, code } = await store.approvePending({
          pendingId: pending.id,
          profileId: 'profile-1',
          approvedScopes: scopes,
          approvedOperations: [],
          operationFingerprints: [],
          accessSeconds: 900,
          renewalSeconds: 604_800,
          codeSeconds: 60
        });
        const issued = await store.exchangeCode({
          code,
          clientId: CLIENT_ID,
          redirectUri: 'https://client.example/callback',
          resource: RESOURCE,
          codeVerifier: CODE_VERIFIER,
          renewalSeconds: 604_800
        });
        return {
          grantId: grant.id,
          profileId: 'profile-1',
          accessToken: `${issued.accessId}:${issued.accessSecret}`
        };
      } finally {
        await closeSetup();
      }
    }

    it('process B observes process A revoking the grant, and a third process sees the now-stale key refused', async function () {
      const { grantId, profileId, accessToken } = await createGrantAndToken();

      //process B: start watching *before* process A writes anything, so
      //the watcher's first poll establishes the "still active" baseline
      //and only the second poll (after the revoke lands) can observe a
      //change - exactly `watchGrantForChanges()`'s own documented shape.
      const watchPromise = runWorker('watch', kind, {
        profileId, grantId, intervalMs: 250, timeoutMs: 10_000
      });

      //give process B's first poll a moment to run and record the
      //baseline snapshot before process A mutates the row.
      await new Promise((resolve) => setTimeout(resolve, 500));

      //process A: an entirely separate OS process, with its own
      //database connection, cancels the grant through the real
      //`oauth-revoke` event handler - the same one a live MCP session's
      //own request would call.
      const revokeResult = await runWorker('revoke', kind, {
        accessToken, clientId: CLIENT_ID
      });
      expect(revokeResult.stdout.trim(), revokeResult.stderr).to.equal('DONE');
      expect(revokeResult.code).to.equal(0);

      //process B must detect the change made by process A purely
      //through the real database, and in production that detection is
      //what drives `session.server.sendToolListChanged()`
      //(`scripts/http.ts`/`scripts/sse.ts` wire this exact callback).
      const watchResult = await watchPromise;
      expect(watchResult.stdout.trim(), watchResult.stderr).to.equal('CHANGED');
      expect(watchResult.code).to.equal(0);

      //a third, independent process must also see the now-cancelled
      //grant as refused - proving there is no per-process positive
      //cache anywhere in this path, only the live store.
      const staleResult = await runWorker('verify-stale', kind, { accessToken });
      expect(staleResult.stdout.trim(), staleResult.stderr).to.equal('REFUSED');
    });

    it('process B times out with no false CHANGED when nothing else touches the grant', async function () {
      const { grantId, profileId } = await createGrantAndToken();
      const watchResult = await runWorker('watch', kind, {
        profileId, grantId, intervalMs: 250, timeoutMs: 2_000
      });
      expect(watchResult.stdout.trim(), watchResult.stderr).to.equal('TIMEOUT');
      expect(watchResult.code).to.equal(1);
    });
  });
}

runCrossProcessSuite('PostgreSQL', 'postgres');
runCrossProcessSuite('MySQL', 'mysql');
