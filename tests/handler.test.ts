import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../shared/rate-limit';
import { BROWSER_USER_AGENT, yahooChartUrl } from '../shared/yahoo';
import { handleChartRequest, type Env, type HandlerDeps, type ResponseCache } from '../workers/api/src/handler';

const NOW = new Date('2026-10-19T09:54:00Z');
const ENV: Env = { ALLOWED_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173' };

function memoryCache(): ResponseCache & { keys(): string[] } {
  const saved = new Map<string, { status: number; headers: [string, string][]; body: string }>();
  return {
    keys: () => [...saved.keys()],
    async match(request) {
      const hit = saved.get(request.url);
      if (!hit) return undefined;
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    },
    async put(request, response) {
      saved.set(request.url, {
        status: response.status,
        headers: [...response.headers.entries()],
        body: await response.text(),
      });
    },
  };
}

function harness(options?: {
  status?: number;
  body?: string;
  contentType?: string;
  limit?: (key: string) => boolean;
  cache?: ResponseCache;
}) {
  const calls: Array<{ url: string; userAgent: string | null }> = [];
  const body = options?.body ?? '{"chart": {"result": [1]}}';
  const pending: Promise<unknown>[] = [];
  const deps: HandlerDeps = {
    now: () => NOW,
    cache: options?.cache ?? memoryCache(),
    limit: options?.limit ?? (() => true),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({ url: request.url, userAgent: request.headers.get('User-Agent') });
      return new Response(body, {
        status: options?.status ?? 200,
        headers: { 'Content-Type': options?.contentType ?? 'application/json;charset=utf-8' },
      });
    },
  };
  return {
    calls,
    deps,
    async run(path: string, headers?: Record<string, string>) {
      const response = await handleChartRequest(new Request(`https://api.test${path}`, { headers }), ENV, {
        waitUntil(promise) {
          pending.push(promise);
        },
      }, deps);
      await Promise.all(pending);
      return response;
    },
  };
}

describe('chart relay', () => {
  it('streams Yahoo JSON for 0700.HK and NVDA without parsing it', async () => {
    const hk = harness({ body: '{"chart": {"symbol":"0700.HK"}, "raw": true}' });
    const hkResponse = await hk.run('/v1/chart/0700.HK?d=2026-10-19');
    expect(hkResponse.status).toBe(200);
    expect(await hkResponse.text()).toBe('{"chart": {"symbol":"0700.HK"}, "raw": true}');
    expect(hk.calls[0]).toEqual({
      url: yahooChartUrl('0700.HK'),
      userAgent: BROWSER_USER_AGENT,
    });
    expect(hkResponse.headers.get('Cache-Control')).toBe('public, max-age=81360');

    const us = harness({ body: '{not-json' });
    const usResponse = await us.run('/v1/chart/NVDA.US?d=2026-10-16');
    expect(await usResponse.text()).toBe('{not-json');
    expect(us.calls[0]?.url).toBe(yahooChartUrl('NVDA'));
    expect(yahooChartUrl('NVDA')).toContain('events=div%7Csplit');
  });

  it('maps 700.HK and BRK.B.US onto Yahoo symbols', async () => {
    const hk = harness();
    await hk.run('/v1/chart/700.HK?d=2026-10-19');
    expect(hk.calls[0]?.url).toBe(yahooChartUrl('0700.HK'));

    const brk = harness();
    await brk.run('/v1/chart/BRK.B.US?d=2026-10-16');
    expect(brk.calls[0]?.url).toBe(yahooChartUrl('BRK-B'));
  });

  it('rejects a symbol or session the relay must not fetch', async () => {
    const api = harness();
    expect((await api.run('/v1/chart/NVDA?d=2026-10-16')).status).toBe(400);
    expect((await api.run('/v1/chart/NVDA.US')).status).toBe(400);
    expect((await api.run('/v1/chart/NVDA.US?d=2026-10-14')).status).toBe(400);
    expect((await api.run('/v1/chart/NVDA.US?d=2026-10-16&range=1d')).status).toBe(400);
    expect(api.calls).toHaveLength(0);
  });

  it('turns Yahoo 404 into a cached 404 and Yahoo 429/500 into an uncached 503', async () => {
    const missing = harness({ status: 404, body: '{"chart":{"error":"missing"}}' });
    const missingResponse = await missing.run('/v1/chart/0700.HK?d=2026-10-19');
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(await missingResponse.text()).toContain('missing');

    const limited = harness({ status: 429, body: 'slow down' });
    const limitedResponse = await limited.run('/v1/chart/NVDA.US?d=2026-10-16');
    expect(limitedResponse.status).toBe(503);
    expect(limitedResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(await limitedResponse.json()).toEqual({ error: 'upstream' });

    const broken = harness({ status: 502, body: 'bad gateway' });
    expect((await broken.run('/v1/chart/NVDA.US?d=2026-10-16')).status).toBe(503);
  });

  it('does not cache or pass through a non-JSON success', async () => {
    const html = harness({ body: '<html>consent</html>', contentType: 'text/html' });
    const response = await html.run('/v1/chart/NVDA.US?d=2026-10-16');
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('serves a cache hit without calling Yahoo or the rate limiter', async () => {
    const cache = memoryCache();
    const first = harness({ cache, body: '{"ok":1}' });
    await first.run('/v1/chart/0700.HK?d=2026-10-19');
    let limited = false;
    const second = harness({
      cache,
      body: '{"ok":2}',
      limit: () => {
        limited = true;
        return false;
      },
    });
    const hit = await second.run('/v1/chart/0700.HK?d=2026-10-19');
    expect(await hit.text()).toBe('{"ok":1}');
    expect(second.calls).toHaveLength(0);
    expect(limited).toBe(false);
    expect(cache.keys()).toEqual(['https://stock-animation.cache/v2/chart/0700.HK?d=2026-10-19']);
  });

  it('stops before Yahoo when the miss limit is exhausted', async () => {
    const api = harness({ limit: (key) => key !== 'global' });
    const response = await api.run('/v1/chart/NVDA.US?d=2026-10-16');
    expect(response.status).toBe(429);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(api.calls).toHaveLength(0);
  });

  it('blocks a browser origin that is not the app', async () => {
    const api = harness();
    const response = await api.run('/v1/chart/NVDA.US?d=2026-10-16', { Origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(api.calls).toHaveLength(0);
    const ok = await api.run('/v1/chart/NVDA.US?d=2026-10-16', { Origin: 'http://localhost:5173' });
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(ok.headers.get('Vary')).toBe('Origin');
  });

  it('allows the page origin even when that host is not on the allow list', async () => {
    const api = harness();
    const response = await api.run('/v1/chart/NVDA.US?d=2026-10-16', { Origin: 'https://api.test' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://api.test');
    expect(api.calls).toHaveLength(1);
  });
});

describe('in-memory rate limiter', () => {
  it('allows 60 and blocks the 61st in the same window', () => {
    const limiter = createRateLimiter(60, 60_000);
    for (let i = 0; i < 60; i += 1) expect(limiter.allow('global', 1_000)).toBe(true);
    expect(limiter.allow('global', 1_000)).toBe(false);
    expect(limiter.allow('global', 61_000)).toBe(true);
    expect(limiter.allow('ip:other', 1_000)).toBe(true);
  });
});
