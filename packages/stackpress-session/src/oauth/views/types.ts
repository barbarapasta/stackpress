//Explicit safe snapshots rendered by the OAuth browser pages (task 00007).
//
//events.md: "Views receive an explicit safe snapshot, including only
//CSRF/form continuation fields needed by the browser. Do not serialize
//me.token, incoming authorization headers, factor values, pending
//PKCE/state internals or full request wrappers." Every field below is
//either public configuration, already-checked client display text
//(rendered as escaped React text, never as markup or a link target),
//or the CSRF field the form must post back. Nothing here is ever built
//by spreading a request, session, pending row or grant row.

export type OAuthBrowserCsrf = {
  name: string,
  token: string
};

export type OAuthBrowserLinks = {
  //this app's own approval page (same-app, never a client address)
  authorize: string,
  factor: string,
  connections: string,
  //existing account settings and 2FA set-up pages (J06 / J13 / J07)
  account: string,
  factorSetup: string
};

export type OAuthScopeView = {
  id: string,
  name: string,
  description: string,
  checked: boolean
};

export type OAuthOperationView = {
  id: string,
  method: string,
  route: string,
  checked: boolean
};

export type OAuthClientView = {
  //public client identifier (a client-document URL or registered ID)
  id: string,
  //client-supplied display name; untrusted text, shown escaped only
  name?: string,
  kind: 'document' | 'registered',
  //host of a client-document URL; registered clients have no checked
  //website, so this is omitted rather than trusting client_uri
  host?: string,
  //exact checked return address and its host
  redirect: string,
  redirectHost: string,
  //true when the return address is on this computer (loopback)
  local: boolean
};

export type OAuthResourceView = {
  id: string,
  name: string,
  description: string
};

//every distinct page state J03-J07 require; the view maps each one to
//translated copy and the actions allowed in that state.
export type OAuthAuthorizeState =
  | 'approve'
  | 'factor_unavailable'
  | 'policy_denied'
  | 'completed'
  | 'denied'
  | 'lost'
  | 'expired'
  | 'wrong_account'
  | 'inactive'
  | 'invalid_request'
  | 'unavailable'
  | 'rate_limited'
  | 'error';

//short machine keys for an extra notice shown above the form; the view
//translates them, so no server-built prose reaches the page.
export type OAuthAuthorizeNotice =
  | 'selection_changed'
  | 'selection_denied'
  | 'form_expired'
  | 'retry'
  | 'factor_verified'
  | 'factor_changed';

export type OAuthAuthorizeSnapshot = {
  state: OAuthAuthorizeState,
  notice?: OAuthAuthorizeNotice,
  retryAfter?: number,
  account?: { name: string },
  client?: OAuthClientView,
  resource?: OAuthResourceView,
  scopes: OAuthScopeView[],
  operations: OAuthOperationView[],
  factor: {
    //the app's approval policy requires a fresh check for this request
    required: boolean,
    //a receipt for the currently preselected access is already saved
    verified: boolean
  },
  csrf?: OAuthBrowserCsrf,
  links: OAuthBrowserLinks
};

export type OAuthFactorState =
  | 'verify'
  | 'unavailable'
  | 'lost'
  | 'expired'
  | 'completed'
  | 'wrong_account'
  | 'inactive'
  | 'unavailable_service'
  | 'error';

export type OAuthFactorError =
  | 'invalid_code'
  | 'code_reused'
  | 'rate_limited'
  | 'form_expired';

export type OAuthFactorSnapshot = {
  state: OAuthFactorState,
  error?: OAuthFactorError,
  retryAfter?: number,
  account?: { name: string },
  client?: OAuthClientView,
  resource?: OAuthResourceView,
  scopes: OAuthScopeView[],
  operations: OAuthOperationView[],
  csrf?: OAuthBrowserCsrf,
  links: OAuthBrowserLinks
};

export type OAuthConnectionView = {
  grantId: string,
  client: { id: string, name?: string, host?: string },
  resource: OAuthResourceView,
  scopes: { id: string, name: string }[],
  operations: string[],
  //ISO strings; dates are formatted by the view
  issued: string,
  deadline: string
};

export type OAuthConnectionsState =
  | 'list'
  | 'inactive'
  | 'unavailable'
  | 'error';

export type OAuthConnectionsResult =
  | 'disconnected'
  | 'not_found'
  | 'failed'
  | 'form_expired';

export type OAuthConnectionsSnapshot = {
  state: OAuthConnectionsState,
  result?: OAuthConnectionsResult,
  //display name of the connection just disconnected, when known
  resultName?: string,
  account?: { name: string },
  connections: OAuthConnectionView[],
  csrf?: OAuthBrowserCsrf,
  links: OAuthBrowserLinks
};

//the `data` prop handed to the view engine: public brand/language/view
//configuration plus exactly one snapshot, URI-encoded (see snapshot.ts).
//The type parameter documents which snapshot the string decodes to.
export type OAuthBrowserPageData<S> = {
  brand: Record<string, string>,
  language: Record<string, unknown>,
  view: Record<string, unknown>,
  oauth: string | S
};
