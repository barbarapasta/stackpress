//modules
import type Server from '@stackpress/ingest/Server';
import type Request from '@stackpress/ingest/Request';
import type Response from '@stackpress/ingest/Response';
import type { Method } from '@stackpress/lib/types';
//stackpress-session
import type {
  OAuthApiOperationDescriptor,
  OAuthPlugin,
  OAuthIdentity,
  OAuthCredential
} from 'stackpress-session/types';
//stackpress-api
import type {
  ApiConfig,
  ApiEndpoint,
  Application,
  Session
} from './types.js';
import { authorize, unauthorized, badRequest, validData } from './helpers.js';
import legacyMigrate from './migrate.js';

//storage.md: "New access IDs use oauth_ followed by..." - the namespace
//prefix is a stable protocol fact (also documented in storage.md), used
//here only to route a request to the new verifier before any legacy
//lookup is attempted; the hashing/verification itself always stays in
//session's private store, never reimplemented here.
const OAUTH_NAMESPACE_PREFIX = 'oauth_';

//events.md: "reject reserved caller fields profileId, applicationId,
//sessionId and oauth, including values in configured fixed data."
const RESERVED_OAUTH_FIELDS = [ 'profileId', 'applicationId', 'sessionId', 'oauth' ];

function isOAuthNamespace(id: string): boolean {
  return id.startsWith(OAUTH_NAMESPACE_PREFIX);
}

/**
 * This interface is intended for the Stackpress library.
 */
export default function plugin(ctx: Server) {
  //if no api config exists, disable the plugin
  if (!ctx.config.get('api')) return;
  //on listen, add webhooks
  ctx.on('listen', ({ ctx }) => {
    //storage.md: API's operator-only legacy-key migration adapter. Not
    //an HTTP route ("no public migration route"); an operator invokes
    //it in-process (for example `yarn emit oauth-legacy-migrate`).
    ctx.on('oauth-legacy-migrate', legacyMigrate);
    const { webhooks = [] } = ctx.config<ApiConfig>('api') || {};
    for (const webhook of webhooks) {
      ctx.on(webhook.event, async ({ req, res }) => {
        //if there was an error, return
        if (res.code !== 200) return;
        //get the data from the webhook
        const data = webhook.data || {};
        //get the params from the request
        const params = req.data();
        //get the results from the response
        const results = res.toStatusResponse().results as Record<string, any>;
        //if the data is not valid, return
        if (!validData(webhook.validity, results)) return;
        //send the webhook
        await fetch(webhook.uri, {
          method: webhook.method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data, params, results }),
        });
      }, -200);
    }
  })
  //on route, add user routes
  ctx.on('route', ({ ctx }) => {
    const { endpoints = [] } = ctx.config<ApiConfig>('api') || {};
    //if no endpoints, return
    if (!Array.isArray(endpoints) || endpoints.length === 0) return;
    ctx.import.all('/auth/oauth/token', () => import('./pages/token.js'));
    ctx.import.all('/auth/oauth', () => import('./pages/oauth.js'));
    ctx.view.all('/auth/oauth', 'stackpress-api/esm/views/oauth', -100);
    const oauthIds = new Set<string>();
    for (const endpoint of endpoints) {
      //cors check
      cors(endpoint, ctx);
      registerOAuthOperation(endpoint, ctx, oauthIds);
      if (endpoint.type === 'session') {
        session(endpoint, ctx);
      } else if (endpoint.type === 'app') {
        app(endpoint, ctx);
      } else if (endpoint.type === 'public') {
        open(endpoint, ctx);
      }
    }
  });
};

/**
 * Validates an endpoint's OAuth opt-in and saves the trusted operation
 * descriptor with session's OAuth service so finalize() can check for
 * ID/route collisions. Membership must be explicit: app-only and
 * public API routes cannot enable user OAuth, and `oauth: true` is
 * invalid because it does not name one operation ID.
 */
export function registerOAuthOperation(
  endpoint: ApiEndpoint,
  ctx: Server,
  oauthIds: Set<string>
) {
  if (!endpoint.oauth) return;
  if (endpoint.oauth === true || typeof endpoint.oauth !== 'object') {
    throw new Error(
      `Endpoint ${endpoint.method} ${endpoint.route}: oauth must explicitly ` +
      `name one operation ID, not a boolean`
    );
  }
  if (endpoint.type !== 'session') {
    throw new Error(
      `Endpoint ${endpoint.method} ${endpoint.route}: only type: 'session' ` +
      `routes can enable user OAuth`
    );
  }
  if (endpoint.method === 'ALL') {
    throw new Error(
      `Endpoint ${endpoint.method} ${endpoint.route}: OAuth-enabled routes ` +
      `must declare a concrete method, not ALL`
    );
  }
  const { operation, resources } = endpoint.oauth;
  if (typeof operation !== 'string' || !operation) {
    throw new Error(
      `Endpoint ${endpoint.method} ${endpoint.route}: oauth.operation is ` +
      `required`
    );
  }
  if (oauthIds.has(operation)) {
    throw new Error(`Duplicate OAuth API operation ID: ${operation}`);
  }
  oauthIds.add(operation);
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error(
      `Endpoint ${endpoint.method} ${endpoint.route}: oauth.resources must ` +
      `declare at least one resource`
    );
  }
  const fixedData = endpoint.data || {};
  const reservedField = RESERVED_OAUTH_FIELDS.find((field) => field in fixedData);
  if (reservedField) {
    throw new Error(
      `Endpoint ${endpoint.method} ${endpoint.route}: fixed data may not ` +
      `set reserved field "${reservedField}"`
    );
  }
  const oauth = ctx.plugin<OAuthPlugin>('oauth');
  if (!oauth) {
    throw new Error(
      `Endpoint ${endpoint.method} ${endpoint.route}: oauth requires ` +
      `session.oauth to be configured`
    );
  }
  const descriptor: OAuthApiOperationDescriptor = {
    id: operation,
    surface: 'api',
    method: endpoint.method,
    route: endpoint.route,
    event: endpoint.event,
    resources,
    scopes: endpoint.scopes || [],
    data: endpoint.data || {}
  };
  oauth.registerApiOperation(descriptor);
}

export function cors(endpoint: ApiEndpoint, ctx: Server) {
  let origin = endpoint.cors === true ? '*' : endpoint.cors;
  //make sure cors can only be an array of strings
  if (typeof origin === 'string') {
    origin = [ origin ];
  }
  //skip if origin is false or undefined
  if (!Array.isArray(origin)) return;
  //create a cors route action 
  const cors = function CrossOrigin(
    { req, res }: { req: Request, res: Response }
  ) {
    //origin check
    if (origin.includes('*')) {
      res.headers.set('Access-Control-Allow-Origin', '*');
    } else if (origin.includes(req.url.origin)) {
      res.headers.set('Access-Control-Allow-Origin', req.url.origin);
    } else {
      return;
    }
    //only allow the methods specified in the endpoint
    const method = endpoint.method !== 'ALL' ? endpoint.method : '*';
    res.headers.set('Access-Control-Request-Method', method);
    res.headers.set('Access-Control-Allow-Methods', 'OPTIONS, GET');
    res.headers.set('Access-Control-Allow-Headers', '*');
  };
  //create a preflight route action
  const preflight = function PreFlight(
    { req, res }: { req: Request, res: Response }
  ) {
    cors({ req, res });
    res.code = 200;
  };

  ctx.route('OPTIONS', endpoint.route, preflight, 1000);
  ctx.route(endpoint.method, endpoint.route, cors, 1000);
}

export function session(endpoint: ApiEndpoint, ctx: Server) {
  ctx.route(
    endpoint.method,
    endpoint.route,
    async function SessionAPI({ req, res, ctx }) {
      //authorization check
      const authorization = authorize(req, res);
      if (!authorization) {
        return;
      }
      const { id, secret, token } = authorization;
      //storage.md: "The oauth_ namespace selects the OAuth verifier.
      //Malformed/unknown/expired/new keys never fall through to legacy
      //lookup." Classify once, here, before any legacy lookup is even
      //attempted, and never fall back to the weaker legacy rules below
      //on a failed new-key check.
      if (isOAuthNamespace(id)) {
        return oauthSession(endpoint, req, res, ctx, token);
      }
      const response = await ctx.resolve('session-detail', { id });
      if (!response || !response.results) {
        return unauthorized(res);
      }
      const session = response.results as Session;
      if (req.method.toUpperCase() !== 'GET'
        && secret !== session.secret
      ) {
        return unauthorized(res);
      }
      //if all of the application scopes are not any of endpoint scopes
      //then return unauthorized
      const permits = endpoint.scopes || [];
      if (!session.scopes.some(scope => permits.includes(scope))) {
        return unauthorized(res);
      }
      //we are good to call
      req.data.set(endpoint.data || {});
      req.data.set('profileId', session.profileId);
      await ctx.emit(endpoint.event, req, res);
    },
    endpoint.priority || 0
  );
};

/**
 * configuration.md's API OAuth opt-in: checks the new `oauth_` access
 * key through the session-owned `oauth-token-verify` fixed event instead
 * of the legacy `session-detail` lookup. Only reachable from `session()`
 * once an `oauth_`-namespaced ID has already been classified; never
 * falls back to the legacy path on any failure here.
 */
export async function oauthSession(
  endpoint: ApiEndpoint,
  req: Request,
  res: Response,
  ctx: Server,
  token: string
) {
  //configuration.md: "New OAuth keys refused when the route setting is
  //absent or disabled" - an oauth_ credential on a route that never
  //opted in is refused outright, not silently tried against legacy.
  if (!endpoint.oauth || typeof endpoint.oauth !== 'object') {
    return unauthorized(res);
  }
  //events.md: reject reserved caller-submitted fields before anything
  //trusted is injected over them.
  const submitted = req.data();
  if (RESERVED_OAUTH_FIELDS.some((field) => field in submitted)) {
    return badRequest(res, 'Reserved field is not allowed in request data');
  }
  const method = req.method.toUpperCase() as Method;
  //configuration.md: "GET alone permits read IDs; HEAD and other methods
  //require a full key." `authorize()` already enforces that a secret is
  //present for every non-GET method (including HEAD), so this only
  //controls whether oauth-token-verify accepts an ID-only credential.
  const requiredCredential: OAuthCredential = method === 'GET' ? 'read' : 'full';
  const { operation, resources } = endpoint.oauth;
  //an operation may declare more than one acceptable resource; the
  //live grant is bound to exactly one, so the matching resource is
  //discovered by trying each configured candidate against the real
  //verifier - never by guessing or trusting a caller-supplied resource.
  //Every attempt runs the full oauth-token-verify check, so this never
  //weakens verification; it only determines which configured resource
  //the already-valid grant happens to be bound to.
  let identity: OAuthIdentity | undefined;
  for (const resource of resources) {
    const response = await ctx.resolve<OAuthIdentity>('oauth-token-verify', {
      token,
      resource,
      surface: 'api',
      method,
      requiredCredential,
      operation
    });
    if (response && response.code === 200 && response.results) {
      identity = response.results;
      break;
    }
  }
  if (!identity) {
    return unauthorized(res);
  }
  //storage.md "Protected API empty scope lists deny" / "one matching
  //permission is enough for a non-empty list"
  const permits = endpoint.scopes || [];
  if (permits.length === 0 || !identity.scopes.some((scope) => permits.includes(scope))) {
    return unauthorized(res);
  }
  //we are good to call; trusted values are injected last, never
  //overwritable by anything submitted (events.md)
  req.data.set(endpoint.data || {});
  req.data.set('profileId', identity.profileId);
  req.data.set('oauth', {
    clientId: identity.clientId,
    grantId: identity.grantId,
    resource: identity.resource,
    scopes: identity.scopes
  });
  await ctx.emit(endpoint.event, req, res);
};

export function app(endpoint: ApiEndpoint, ctx: Server) {
  ctx.route(
    endpoint.method, 
    endpoint.route, 
    async function AppAPI({ req, res, ctx }) {
      //authorization check
      const authorization = authorize(req, res);
      if (!authorization) {
        return;
      }
      const { id, secret } = authorization;
      //storage.md: "Existing app keys stay app identities and cannot
      //become user approvals." An oauth_-namespaced credential can never
      //match a legacy application ID; refuse it outright rather than
      //attempt (and predictably fail) the legacy lookup below.
      if (isOAuthNamespace(id)) {
        return unauthorized(res);
      }
      const response = await ctx.resolve('application-detail', { id });
      if (!response || !response.results) {
        return unauthorized(res);
      }
      const application = response.results as Application;
      if (req.method.toUpperCase() !== 'GET' 
        && secret !== application.secret
      ) {
        return unauthorized(res);
      }
      //if all of the application scopes are not any of endpoint scopes
      //then return unauthorized
      const permits = endpoint.scopes || [];
      if (!application.scopes.some(scope => permits.includes(scope))) {
        return unauthorized(res);
      }
      //we are good to call
      req.data.set(endpoint.data || {});
      await ctx.emit(endpoint.event, req, res);
    }, 
    endpoint.priority || 0
  );
};

export function open(endpoint: ApiEndpoint, ctx: Server) {
  ctx.route(
    endpoint.method, 
    endpoint.route, 
    async function PublicAPI({ req, res, ctx }) {
      req.data.set(endpoint.data || {});
      await ctx.emit(endpoint.event, req, res);
    }, 
    endpoint.priority || 0
  );
};
