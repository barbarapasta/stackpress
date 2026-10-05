//modules
import type { HttpServer } from '@stackpress/ingest';
import type Request from '@stackpress/ingest/Request';
import type { SessionPlugin, SessionRoute } from 'stackpress/session/types';
import { caller } from 'stackpress-ai';
//app
import type { Config } from '../../config/common.js';

//--------------------------------------------------------------------//
// Types

export type Verdict = {
  allowed: true
} | {
  allowed: false,
  code: number,
  status: string,
  error: string
};

//--------------------------------------------------------------------//
// Functions

/**
 * The route the admin UI uses for an action on a record. A person may do the
 * action through the agent only if they could do it through that route.
 */
export function adminRoute<C extends HttpServer<Config>>(
  ctx: C,
  model: string,
  action: string,
  id: string
): SessionRoute {
  const base = ctx.config.path<string>('admin.base', '/admin');
  //a form is submitted with a POST. The id cannot add path segments
  return {
    method: 'POST',
    route: `${base}/${model}/${action}/${encodeURIComponent(id)}`
  };
}

/**
 * Decide whether the caller of a tool event may use a route, by the same
 * access rules the session applies to a request for it. Generated model
 * events check nothing, so an event that changes records asks this first.
 *
 * Who is asking comes only from the caller record the system wrote after a
 * sign-in or key was verified, never from the input:
 *  - a `person` carries their own session, so the session decides.
 *  - a `user` key names a verified profile. Its roles are read from that
 *    profile and run through the same rules, so a scope cannot grant more
 *    than the person's roles do.
 *  - an `app` key, a public caller, or no caller is refused.
 */
export async function authorize<C extends HttpServer<Config>>(
  ctx: C,
  req: Request,
  permit: SessionRoute
): Promise<Verdict> {
  const who = caller(req);
  const session = ctx.plugin<SessionPlugin>('session');
  if (!who || !session) {
    return deny(401, 'Unauthorized', 'Sign in to do this.');
  }
  if (who.kind === 'person') {
    //the session was carried into this request by the system
    const allowed = await session.load(req).can(permit);
    return allowed ? { allowed } : deny();
  }
  if (who.kind === 'user' && who.profileId) {
    const roles = await rolesOf(ctx, who.profileId);
    if (!roles) return deny();
    const token = await session.create({
      id: who.profileId,
      name: '',
      roles
    });
    const allowed = await session.load(token).can(permit);
    return allowed ? { allowed } : deny();
  }
  return deny();
}

//--------------------------------------------------------------------//
// Helpers

/**
 * A refusal, which is a 403 unless the caller is not known at all.
 */
function deny(
  code = 403,
  status = 'Forbidden',
  error = 'You are not allowed to do this.'
): Verdict {
  return { allowed: false, code, status, error };
}

/**
 * The roles of a profile that exists and is active, read fresh each call,
 * or null.
 */
async function rolesOf<C extends HttpServer<Config>>(ctx: C, id: string) {
  const response = await ctx.resolve<{ roles?: unknown, active?: boolean }>(
    'profile-get',
    ctx.request({ data: { key: 'id', value: id } })
  );
  const profile = response.code === 200 ? response.results : null;
  if (!profile || profile.active === false || !Array.isArray(profile.roles)) {
    return null;
  }
  return profile.roles.map(String);
}
