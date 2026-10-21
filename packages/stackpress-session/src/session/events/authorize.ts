//stackpress
import { action } from '@stackpress/ingest/Server';
//session
import type { SessionPlugin } from '../types.js';
//oauth
import type { OAuthPlugin } from '../../oauth/types.js';

export default action(async function Authorize({ req, res, ctx }) {
  //configuration.md: "The global browser session.access authorizer must
  //recognize exact registered protocol/API/MCP route capabilities,
  //allowing those handlers to enforce their own identity checks. No
  //broad /auth/* bypass." Only an exact registered native (bearer-token)
  //capability skips the cookie check here; every other route - including
  ///authorize, /connections and /factor - keeps the ordinary browser
  //session requirement.
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (oauth && oauth.finalized &&
    oauth.isNativeRoute(req.method.toUpperCase(), req.url.pathname)
  ) {
    return;
  }
  const session = ctx.plugin<SessionPlugin>('session');
  await session.authorize(req, res);
});
