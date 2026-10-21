//Shared lightweight test doubles for the fixed OAuth event handlers
//(action()-wrapped `{req, res, ctx}` functions). Not a *.test.ts file -
//mocha's unquoted `tests/**/*.test.ts` glob never picks this up.
import type { StatusResponse } from '@stackpress/lib/types';

export function makeReq(input: unknown) {
  return { data: () => input } as any;
}

export function makeRes() {
  const res: any = {
    code: undefined,
    body: undefined,
    results(body: unknown, code = 200) {
      res.body = body;
      res.code = code;
      return res;
    },
    setError(response: Partial<StatusResponse>) {
      res.body = response;
      res.code = response.code;
      return res;
    }
  };
  return res;
}

export type FakeResolvers = Record<
  string,
  (data: unknown) => Promise<Partial<StatusResponse>> | Partial<StatusResponse>
>;

export function makeCtx(options: {
  oauth?: unknown,
  database?: unknown,
  resolvers?: FakeResolvers,
  configPaths?: Record<string, unknown>
}) {
  const plugins: Record<string, unknown> = {};
  if (typeof options.oauth !== 'undefined') plugins.oauth = options.oauth;
  if (typeof options.database !== 'undefined') plugins.database = options.database;
  const ctx = {
    plugin(name: string) {
      return plugins[name];
    },
    resolve: async (event: string, data?: unknown) => {
      const resolver = options.resolvers?.[event];
      if (!resolver) {
        return { code: 404, error: 'no listener registered' };
      }
      return await resolver(data);
    },
    config: {
      path: (key: string, def?: unknown) => {
        if (options.configPaths && key in options.configPaths) {
          return options.configPaths[key];
        }
        return def;
      }
    }
  };
  return ctx as any;
}

export function makeOAuthPlugin(
  config: unknown,
  apiOperations: Map<string, { descriptor: unknown, fingerprint: string }> = new Map()
) {
  return {
    config,
    finalized: true,
    apiOperations,
    registerApiOperation() {},
    registerMcpResource() {},
    finalize: async () => {},
    assertFinalized() {}
  };
}
