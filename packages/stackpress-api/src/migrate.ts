//modules
import { action } from '@stackpress/ingest/Server';
//stackpress-api
import type { Application, Session } from './types.js';
import { badRequest } from './helpers.js';

export type LegacyMigrationKind = 'app' | 'session';

export type LegacyMigrationInput = {
  kind: LegacyMigrationKind,
  resource: string,
  //explicit selection only - storage.md: "operators bind selected keys",
  //never an implicit migrate-everything default
  ids: string[],
  dryRun?: boolean,
  expiresInSeconds?: number
};

export type LegacyMigrationRecordStatus =
  | 'bound'
  | 'would_bind'
  | 'invalid'
  | 'namespace_conflict'
  | 'incarnation_mismatch';

export type LegacyMigrationRecordResult = {
  id: string,
  status: LegacyMigrationRecordStatus
};

export type LegacyMigrationResult = {
  dryRun: boolean,
  total: number,
  bound: number,
  invalid: number,
  records: LegacyMigrationRecordResult[]
};

/**
 * `oauth-legacy-migrate` (storage.md "Upgrade Existing MCP Keys
 * Explicitly"): "API owns an operator-only migration adapter: validate
 * the selected real legacy records and submit kind, hashed ID and exact
 * resource to session. It must support a dry-run and report selected
 * counts/invalid records without secrets." Not one of events.md's nine
 * fixed protocol events and carries no HTTP route - an operator invokes
 * it in-process (for example via `yarn emit oauth-legacy-migrate`), per
 * "no public migration route" and "no automatic first-use binding".
 * Repeatable: re-running with the same still-valid records is a no-op
 * success (session's `oauth-legacy-bind` is itself idempotent).
 */
export default action(async function OAuthLegacyMigrate({ req, res, ctx }) {
  const input = req.data() as LegacyMigrationInput;
  if (
    (input.kind !== 'app' && input.kind !== 'session') ||
    typeof input.resource !== 'string' || !input.resource.length ||
    !Array.isArray(input.ids) || input.ids.length === 0 ||
    !input.ids.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    return badRequest(res, 'Malformed legacy migration request');
  }
  const dryRun = input.dryRun === true;
  const event = input.kind === 'app' ? 'application-detail' : 'session-detail';
  const records: LegacyMigrationRecordResult[] = [];

  for (const id of input.ids) {
    const response = await ctx.resolve(event, { id });
    const record = response?.results as (Application | Session) | undefined;
    //validate the selected real legacy record: must exist, be active,
    //and not be expired. No secret is ever read out of `record` below.
    if (!record || !record.active || (record.expires && record.expires.getTime() <= Date.now())) {
      records.push({ id, status: 'invalid' });
      continue;
    }
    const incarnation = record.created instanceof Date ?
      record.created.toISOString() : String(record.created);
    if (dryRun) {
      records.push({ id, status: 'would_bind' });
      continue;
    }
    const bindResponse = await ctx.resolve<{ bound: boolean, reason?: string }>(
      'oauth-legacy-bind',
      {
        kind: input.kind,
        legacyId: id,
        incarnation,
        resource: input.resource,
        expires: input.expiresInSeconds ?
          new Date(Date.now() + input.expiresInSeconds * 1000) : null
      }
    );
    const outcome = bindResponse?.results;
    if (!outcome || outcome.bound !== true) {
      const reason = outcome?.reason;
      records.push({
        id,
        status: reason === 'namespace_conflict' || reason === 'incarnation_mismatch' ?
          reason : 'invalid'
      });
      continue;
    }
    records.push({ id, status: 'bound' });
  }

  const bound = records.filter((r) => r.status === 'bound' || r.status === 'would_bind').length;
  const result: LegacyMigrationResult = {
    dryRun,
    total: records.length,
    bound,
    invalid: records.length - bound,
    records
  };
  res.results(result);
});
