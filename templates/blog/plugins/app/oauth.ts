//modules
import type { HttpServer } from '@stackpress/ingest';
import { action } from '@stackpress/ingest/http';
import type {
  OAuthApprovalPolicyInput,
  OAuthApprovalPolicyResult,
  OAuthAccessPolicyInput,
  OAuthAccessPolicyResult
} from 'stackpress/session/types';
import type { Config } from '../../config/common.js';

//The two app-owned policy listeners `session.oauth.policy` names
//(configuration.md). Stackpress never hardcodes a role mapping; this is
//the app's own authorization decision, kept here instead of maintainer
//code so it can be edited freely.
//
//Demonstrates "ordinary" vs. "stronger-check" accounts (task 00010 step
//3) through role-based scope narrowing: an ADMIN/MANAGER profile (the
//seeded "developer" account) may approve every requested scope/
//operation, while an ordinary USER profile may only approve read access
//- `articles.write`/`comments.write` are silently dropped from what gets
//offered, not merely hidden, so the approval screen only ever shows what
//this profile may actually grant.
export function approval(
  input: OAuthApprovalPolicyInput
): OAuthApprovalPolicyResult {
  const roles = input.profile.roles;
  const stronger = roles.includes('ADMIN') || roles.includes('MANAGER');
  const scopes = stronger
    ? input.scopes
    : input.scopes.filter((scope: string) => scope === 'articles.read');
  const operations = stronger
    ? input.operations
    : input.operations.filter(
      (operation: string) => operation === 'articles.detail'
    );
  //task 00012: a MANAGER/ADMIN profile's wider grant requires a fresh
  //identity check (J05/J06) tied to this pending approval; an ordinary
  //USER's narrower read-only grant does not.
  return { allowed: true, scopes, operations, requireFactor: stronger };
}

//Re-checked on every exchange/verify/refresh (configuration.md:
//"membership and scopes remain independent checks"). The blog keeps this
//simple and always confirms the already-approved scopes; an app that
//wants to revoke privileges after approval (for example when a role
//changes) would narrow `scopes` here instead of in `approval` above.
export function access(
  _input: OAuthAccessPolicyInput
): OAuthAccessPolicyResult {
  return { allowed: true };
}

export default function plugin(server: HttpServer<Config>) {
  server.on('listen', async _ => {
    server.on('blog-oauth-approval', action(async ({ req, res }) => {
      res.results(approval(req.data() as unknown as OAuthApprovalPolicyInput) as any);
    }));
    server.on('blog-oauth-access', action(async ({ req, res }) => {
      res.results(access(req.data() as unknown as OAuthAccessPolicyInput) as any);
    }));
  });
};
