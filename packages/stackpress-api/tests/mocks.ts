//modules
import Request from '@stackpress/ingest/Request';
import Response from '@stackpress/ingest/Response';
import type { Method } from '@stackpress/lib/types';

/**
 * Builds a real ingest Request instance for tests. Using the real class
 * (instead of a hand rolled stub) means `req.data()`, `req.data.set(...)`,
 * `req.headers.get(...)` and `req.url` behave exactly like production.
 */
export function createRequest(options: {
  method?: Method,
  url?: string,
  headers?: Record<string, string>,
  data?: Record<string, any>
} = {}) {
  const {
    method = 'GET',
    url = 'http://localhost/',
    headers = {},
    data = {}
  } = options;
  return new Request({
    resource: {},
    method,
    url,
    headers,
    data
  });
}

/**
 * Builds a real ingest Response instance for tests.
 */
export function createResponse() {
  return new Response({});
}

/**
 * Minimal Server ("ctx") test double. Only implements the surface each
 * test actually exercises: config lookups, plugin lookups, resolve() for
 * cross-plugin calls, route registration and event emission tracking.
 */
export function createCtxStub(options: {
  config?: Record<string, any>,
  plugins?: Record<string, any>,
  resolves?: Record<string, any>
} = {}) {
  const { config = {}, plugins = {}, resolves = {} } = options;
  const routes: Array<{ method: string, path: string, action: Function, priority?: number }> = [];
  const emitted: Array<{ event: string, req: unknown, res: unknown }> = [];
  const listeners: Record<string, Array<{ callback: Function, priority?: number }>> = {};
  const imports: Array<{ path: string, loader: Function }> = [];
  const views: Array<{ path: string, component: string, priority?: number }> = [];

  const ctx = {
    routes,
    emitted,
    listeners,
    imports,
    views,
    config: Object.assign(
      (key: string) => {
        const parts = key.split('.');
        let value: any = config;
        for (const part of parts) {
          if (value == null) return undefined;
          value = value[part];
        }
        return value;
      },
      {
        get<T = unknown>(key: string): T {
          return config[key] as T;
        },
        path<T>(key: string, fallback?: T): T {
          return (key in config ? config[key] : fallback) as T;
        }
      }
    ),
    plugin<T = unknown>(name: string): T {
      return plugins[name] as T;
    },
    route(method: string, path: string, action: Function, priority?: number) {
      routes.push({ method, path, action, priority });
      return ctx;
    },
    on(event: string, callback: Function, priority?: number) {
      (listeners[event] = listeners[event] || []).push({ callback, priority });
      return ctx;
    },
    import: {
      all(path: string, loader: Function) {
        imports.push({ path, loader });
        return ctx;
      }
    },
    view: {
      all(path: string, component: string, priority?: number) {
        views.push({ path, component, priority });
        return ctx;
      }
    },
    async resolve<T = unknown>(event: string, data?: unknown, res?: unknown) {
      const result = resolves[event];
      if (typeof result === 'function') {
        return result(data, res) as { results?: T, code?: number };
      }
      return (result || { code: 404, results: undefined }) as {
        results?: T,
        code?: number
      };
    },
    async emit(event: string, req: unknown, res: unknown) {
      emitted.push({ event, req, res });
    }
  };

  return ctx;
}
