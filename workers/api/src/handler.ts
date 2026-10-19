import { createRateLimiter } from '../../../shared/rate-limit';
import { cacheMaxAgeSeconds, isAcceptableSessionDate } from '../../../shared/session';
import { mapRelaySymbol } from '../../../shared/symbols';
import { BROWSER_USER_AGENT, yahooChartUrl } from '../../../shared/yahoo';

const DAY_SECONDS = 86_400;
const memoryLimiter = createRateLimiter(60);

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ALLOWED_ORIGIN?: string;
  RATE_LIMITER?: RateLimiterBinding;
}

export interface ResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface HandlerDeps {
  fetch: typeof fetch;
  cache: ResponseCache;
  now: () => Date;
  /** Test seam. When set, the binding and the in-memory limiter are not used. */
  limit?: (key: string) => boolean | Promise<boolean>;
}

/**
 * Thin Yahoo pass-through. The body is streamed and never parsed.
 * Workers Cache (see wrangler.toml) stores responses from Cache-Control.
 * The injected cache covers local dev, where that front door is not running.
 */
export async function handleChartRequest(
  request: Request,
  env: Env,
  ctx: WaitUntil,
  deps: HandlerDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);

  if (origin && !allowed.includes(origin)) {
    return json({ error: 'origin_not_allowed' }, 403, 'no-store', null);
  }
  if (request.method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }), origin, allowed, 'no-store');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'method_not_allowed' }, 405, 'no-store', originHeader(origin, allowed));
  }

  const match = url.pathname.match(/^\/v1\/chart\/([^/]+)$/);
  if (!match?.[1]) return json({ error: 'not_found' }, 404, 'no-store', originHeader(origin, allowed));

  let rawSymbol: string;
  try {
    rawSymbol = decodeURIComponent(match[1]);
  } catch {
    return json({ error: 'invalid_symbol' }, 400, 'no-store', originHeader(origin, allowed));
  }
  const mapped = mapRelaySymbol(rawSymbol);
  if (!mapped) return json({ error: 'invalid_symbol' }, 400, 'no-store', originHeader(origin, allowed));

  const unexpected = [...url.searchParams.keys()].filter((key) => key !== 'd');
  if (unexpected.length > 0 || !url.searchParams.has('d')) {
    return json({ error: 'invalid_session' }, 400, 'no-store', originHeader(origin, allowed));
  }
  const sessionDate = url.searchParams.get('d') ?? '';
  if (!isAcceptableSessionDate(mapped.market, sessionDate, deps.now())) {
    return json({ error: 'invalid_session' }, 400, 'no-store', originHeader(origin, allowed));
  }

  const cacheKey = new Request(`https://stock-animation.cache/v1/chart/${mapped.yahoo}?d=${sessionDate}`);
  const cached = await deps.cache.match(cacheKey);
  if (cached) return cors(cached, origin, allowed, null);

  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (!(await allow(deps, env, `ip:${ip}`)) || !(await allow(deps, env, 'global'))) {
    return json({ error: 'rate_limited' }, 429, 'no-store', originHeader(origin, allowed));
  }

  const upstream = await deps.fetch(yahooChartUrl(mapped.yahoo), {
    headers: {
      Accept: 'application/json',
      'User-Agent': BROWSER_USER_AGENT,
    },
  });

  if (upstream.status === 404) {
    const response = passthrough(upstream, 404, `public, max-age=${DAY_SECONDS}`);
    store(ctx, deps.cache, cacheKey, response);
    return cors(response, origin, allowed, null);
  }
  if (upstream.status === 429 || upstream.status >= 500) {
    return json({ error: 'upstream' }, 503, 'no-store', originHeader(origin, allowed));
  }
  if (!upstream.ok) {
    return json({ error: 'upstream' }, 503, 'no-store', originHeader(origin, allowed));
  }
  const contentType = upstream.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    return json({ error: 'upstream' }, 503, 'no-store', originHeader(origin, allowed));
  }

  const maxAge = cacheMaxAgeSeconds(mapped.market, deps.now());
  const response = passthrough(upstream, 200, `public, max-age=${maxAge}`);
  store(ctx, deps.cache, cacheKey, response);
  return cors(response, origin, allowed, null);
}

function passthrough(upstream: Response, status: number, cacheControl: string): Response {
  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8');
  headers.set('Cache-Control', cacheControl);
  return new Response(upstream.body, { status, headers });
}

function store(ctx: WaitUntil, cache: ResponseCache, key: Request, response: Response): void {
  const copy = response.clone();
  ctx.waitUntil(
    cache.put(key, copy).catch(() => {
      /* a cache write must not fail the response */
    }),
  );
}

async function allow(deps: HandlerDeps, env: Env, key: string): Promise<boolean> {
  if (deps.limit) return deps.limit(key);
  if (env.RATE_LIMITER) {
    const result = await env.RATE_LIMITER.limit({ key });
    return result.success;
  }
  return memoryLimiter.allow(key, deps.now().getTime());
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function originHeader(requestOrigin: string | null, allowed: string[]): string | null {
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0] ?? null;
}

function cors(response: Response, requestOrigin: string | null, allowed: string[], cacheControl: string | null): Response {
  const headers = new Headers(response.headers);
  const allow = originHeader(requestOrigin, allowed);
  if (allow) headers.set('Access-Control-Allow-Origin', allow);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  if (cacheControl) headers.set('Cache-Control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}

function json(body: unknown, status: number, cacheControl: string, allowOrigin: string | null): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
    Vary: 'Origin',
  });
  if (allowOrigin) headers.set('Access-Control-Allow-Origin', allowOrigin);
  return new Response(JSON.stringify(body), { status, headers });
}
