// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { createSwSandbox, dispatchNavigation, dispatchFetch } from './swSandbox.js';

describe('sw.js navigationHandler — offline fallback branches', () => {
  const NAV_URL = 'https://portos.example/local-llm/playground?backend=ollama&model=x';

  it('serves the cached offline shell when the network fetch fails and a shell is cached', async () => {
    const { listeners, openCache } = createSwSandbox();
    const shellCache = openCache('portos-shell-v1');
    await shellCache.put('/index.html', new Response('<html>shell</html>', { status: 200 }));

    const response = await dispatchNavigation(listeners, NAV_URL);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('<html>shell</html>');
  });

  it('serves an exact cached response for the navigation URL when no shell is cached', async () => {
    const { listeners, openCache } = createSwSandbox();
    const exactCache = openCache('some-other-cache');
    await exactCache.put(NAV_URL, new Response('<html>exact match</html>', { status: 200 }));

    const response = await dispatchNavigation(listeners, NAV_URL);

    await expect(response.text()).resolves.toBe('<html>exact match</html>');
  });

  it('returns a renderable fallback page (not Response.error()) when nothing is cached', async () => {
    const { listeners } = createSwSandbox();

    const response = await dispatchNavigation(listeners, NAV_URL);

    // Response.error() produces an opaque, unreadable network-error response
    // (type 'error', status 0) — the bug this issue is about. The fix must
    // return something the browser can actually render.
    expect(response.type).not.toBe('error');
    expect(response.status).toBeGreaterThan(0);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    const body = await response.text();
    expect(body).toMatch(/connection failed/i);
    expect(body).toMatch(/retry|reload/i);
  });
});

describe('sw.js asset/static strategies — Cache Storage is optional', () => {
  const ok = () => Promise.resolve(new Response('net', { status: 200 }));
  const failing = (method) => (real) => ({
    ...real,
    open: async (name) => {
      if (method === 'open') throw new Error('SecurityError');
      const c = await real.open(name);
      return { ...c, [method]: async () => { throw new Error('boom'); } };
    },
  });
  const cases = [['/assets/a.js'], ['/favicon.svg']];

  for (const [path] of cases) {
    for (const method of ['put', 'match', 'open']) {
      it(`${path} returns the network response when cache.${method} fails`, async () => {
        const { listeners } = createSwSandbox({ fetch: ok, cachesOverride: failing(method) });
        const event = dispatchFetch(listeners, `https://portos.example${path}`);
        const res = await event._responded;
        await expect(res.text()).resolves.toBe('net');
        await Promise.all(event._waits);
      });
    }
  }

  it('serves a repeat asset request from the cache', async () => {
    let calls = 0;
    const { listeners } = createSwSandbox({ fetch: () => { calls += 1; return ok(); } });
    const first = dispatchFetch(listeners, 'https://portos.example/assets/a.js');
    await first._responded;
    await Promise.all(first._waits);
    const second = dispatchFetch(listeners, 'https://portos.example/assets/a.js');
    await expect((await second._responded).text()).resolves.toBe('net');
    expect(calls).toBe(1);
  });

  it('trims the asset cache on an over-cap write', async () => {
    const { listeners, openCache } = createSwSandbox({ fetch: ok });
    const store = openCache('portos-assets-v1');
    for (let i = 0; i < 125; i += 1) await store.put(`https://portos.example/assets/old${i}.js`, new Response('x'));
    const event = dispatchFetch(listeners, 'https://portos.example/assets/new.js');
    await event._responded;
    await Promise.all(event._waits);
    expect((await store.keys()).length).toBeLessThanOrEqual(120);
  });

  it('still rejects when the network fails for an uncached asset', async () => {
    const { listeners } = createSwSandbox();
    const event = dispatchFetch(listeners, 'https://portos.example/assets/miss.js');
    await expect(event._responded).rejects.toThrow();
  });
});
