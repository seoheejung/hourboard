import { createServer } from 'node:http';

export async function startSharedCache(origin, ttlMs = 1000) {
  let cached = null;
  let inFlight = null;
  const stats = { clientRequestCount: 0, originRequestCount: 0, cacheHitCount: 0, cacheMissCount: 0, coalescedCount: 0 };

  async function load() {
    stats.originRequestCount++;
    stats.cacheMissCount++;
    const response = await fetch(`${origin}/api/open-state`);
    const body = await response.text();
    if (!response.ok) throw new Error(`Origin open-state returned ${response.status}`);
    const state = JSON.parse(body);
    if (!Number.isFinite(Date.parse(state.roundEndsAt))) throw new Error('Invalid origin open-state');
    cached = { body, expiresAt: Math.min(Date.now() + ttlMs, Date.parse(state.roundEndsAt)) };
    return body;
  }

  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/api/open-state') {
      response.writeHead(404).end();
      return;
    }
    stats.clientRequestCount++;
    try {
      let body;
      if (cached && Date.now() < cached.expiresAt) {
        stats.cacheHitCount++;
        body = cached.body;
      } else {
        if (inFlight) {
          stats.cacheHitCount++;
          stats.coalescedCount++;
        } else {
          inFlight = load().finally(() => { inFlight = null; });
        }
        body = await inFlight;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=0, s-maxage=1' }).end(body);
    } catch {
      response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'ORIGIN_UNAVAILABLE' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    stats,
    clear: () => { cached = null; },
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
