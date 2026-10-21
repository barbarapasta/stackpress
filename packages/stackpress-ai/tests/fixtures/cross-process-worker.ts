//00009's cross-process notification worker. Run with `tsx` as a *real,
//separate OS process* (never imported in-process) by
//`mcp-oauth-cross-process.test.ts`. Not a *.test.ts file - the package's
//unquoted `tests/**/*.test.ts` glob never picks this up.
//
// Usage: tsx cross-process-worker.ts <mode> <postgres|mysql> <jsonPayload>
//
// Modes:
//  - watch:        poll `oauth-grants-list` via the real
//                   `watchGrantForChanges()` production function (the
//                   exact one `scripts/http.ts`/`scripts/sse.ts` wire to
//                   `session.server.sendToolListChanged()`) until the
//                   bound grant changes or a bounded timeout elapses.
//                   Prints CHANGED or TIMEOUT.
//  - revoke:        calls the real `oauth-revoke` event handler to
//                   cancel the grant. Prints DONE.
//  - verify-stale:  calls the real `oauth-token-verify` event handler
//                   with a previously-issued access key. Prints ALLOWED
//                   or REFUSED.
//
// Each mode opens its *own* database connection via
// `connectRealDbEngine()` - this process shares no in-memory state with
// whichever process ran the other half of the scenario; only the real
// database server they both talk to does.
import {
  buildRealDbCtx, connectRealDbEngine, RESOURCE, type RealDbEngineKind
} from './real-db-ctx.js';
import { watchGrantForChanges } from '../../src/oauth.js';

async function main() {
  const [ , , mode, kindArg, payloadArg ] = process.argv;
  const kind = kindArg as RealDbEngineKind;
  const payload = payloadArg ? JSON.parse(payloadArg) : {};

  const { engine, close } = await connectRealDbEngine(kind);
  try {
    const { ctx } = buildRealDbCtx(engine);

    if (mode === 'watch') {
      const { profileId, grantId, intervalMs, timeoutMs } = payload as {
        profileId: string, grantId: string, intervalMs: number, timeoutMs: number
      };
      const changed = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => { handle.stop(); resolve(false); }, timeoutMs);
        const handle = watchGrantForChanges(ctx, profileId, grantId, () => {
          clearTimeout(timeout);
          handle.stop();
          resolve(true);
        }, intervalMs);
      });
      process.stdout.write(changed ? 'CHANGED\n' : 'TIMEOUT\n');
      process.exitCode = changed ? 0 : 1;
      return;
    }

    if (mode === 'revoke') {
      const { accessToken, clientId } = payload as { accessToken: string, clientId: string };
      const response = await ctx.resolve('oauth-revoke', {
        token: accessToken, client_id: clientId
      });
      process.stdout.write(response?.code === 200 ? 'DONE\n' : `ERROR ${response?.code}\n`);
      process.exitCode = response?.code === 200 ? 0 : 1;
      return;
    }

    if (mode === 'verify-stale') {
      const { accessToken } = payload as { accessToken: string };
      const response = await ctx.resolve('oauth-token-verify', {
        token: accessToken, resource: RESOURCE
      });
      process.stdout.write(response?.code === 200 ? 'ALLOWED\n' : 'REFUSED\n');
      process.exitCode = 0;
      return;
    }

    process.stderr.write(`Unknown mode: ${mode}\n`);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((e) => {
  process.stderr.write(`Worker crashed: ${(e as Error)?.stack || e}\n`);
  process.exitCode = 1;
});
