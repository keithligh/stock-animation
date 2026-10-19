import { handleChartRequest, type Env } from './handler';

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleChartRequest(request, env, ctx, {
      fetch: globalThis.fetch.bind(globalThis),
      cache: caches.default,
      now: () => new Date(),
    });
  },
};
