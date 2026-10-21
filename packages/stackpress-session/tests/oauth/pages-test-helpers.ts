//Lightweight test doubles for the HTTP-layer page handlers (src/oauth/pages/*),
//closer to the real @stackpress/ingest Request/Response surface than
//events-helpers.ts's thin action-level fakes. Not a *.test.ts file -
//mocha's unquoted glob never picks this up.

export function makePageReq(options: {
  method?: string,
  pathname?: string,
  headers?: Record<string, string>,
  post?: Record<string, unknown>,
  body?: unknown,
  remoteAddress?: string
}) {
  const headers = new Map<string, string>(
    Object.entries(options.headers || {}).map(([k, v]) => [ k.toLowerCase(), v ])
  );
  return {
    method: options.method || 'GET',
    url: { pathname: options.pathname || '/' },
    headers: { get: (name: string) => headers.get(name.toLowerCase()) },
    post: (name: string) => (options.post || {})[name],
    body: typeof options.body === 'undefined' ? null : options.body,
    resource: { socket: { remoteAddress: options.remoteAddress || '203.0.113.1' } }
  } as any;
}

export function makePageRes() {
  const headers = new Map<string, string>();
  const res: any = {
    code: 0,
    status: '',
    body: undefined,
    headers: {
      set: (name: string, value: string) => headers.set(name, value),
      get: (name: string) => headers.get(name)
    },
    json(body: unknown, code = 200) {
      res.body = body;
      res.code = code;
      return res;
    },
    statusCode(code: number) {
      res.code = code;
      return res;
    }
  };
  return res;
}

export function makePageCtx(options: {
  oauth?: unknown,
  database?: unknown,
  resolvers?: Record<string, (data: unknown) => Promise<unknown> | unknown>
}) {
  const plugins: Record<string, unknown> = {};
  if (typeof options.oauth !== 'undefined') plugins.oauth = options.oauth;
  if (typeof options.database !== 'undefined') plugins.database = options.database;
  return {
    plugin(name: string) {
      return plugins[name];
    },
    resolve: async (event: string, data?: unknown) => {
      const resolver = options.resolvers?.[event];
      if (!resolver) {
        return { code: 404, error: 'no listener registered' };
      }
      return await resolver(data);
    }
  } as any;
}
