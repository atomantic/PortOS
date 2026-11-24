// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { createSwSandbox, dispatchNavigation } from './swSandbox.js';

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

describe('sw.js asset cache cap', () => {
  const ORIGIN = 'https://portos.example';
  const assetUrl = (i) => `${ORIGIN}/assets/chunk-${i}.js`;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function requestAssets(listeners, urls) {
    for (const url of urls) {
      const event = { request: { method: 'GET', url, mode: 'cors' }, respondWith: (p) => { event._responded = p; }, waitUntil: () => {} };
      listeners.fetch(event);
      await event._responded;
    }
    // cacheFirst fires trimCache without awaiting it.
    await settle();
    await settle();
  }

  const okFetch = async () => new Response('x', { status: 200 });

  it('keeps every asset of a full ~831-file build cached', async () => {
    const { listeners, openCache } = createSwSandbox({ fetch: okFetch });
    await requestAssets(listeners, Array.from({ length: 831 }, (_, i) => assetUrl(i)));
    expect((await openCache('portos-assets-v1').keys()).length).toBe(831);
  });

  it('trims oldest first past the cap without evicting the shell boot assets', async () => {
    const { listeners, openCache } = createSwSandbox({ fetch: okFetch });
    const assets = openCache('portos-assets-v1');
    await openCache('portos-shell-v1').put('/index.html', new Response('<script src="/assets/chunk-0.js"></script>'));
    await requestAssets(listeners, Array.from({ length: 1501 }, (_, i) => assetUrl(i)));
    const urls = (await assets.keys()).map((k) => k.url);
    expect(urls.length).toBe(1500);
    expect(urls).toContain(assetUrl(0));
    expect(urls).not.toContain(assetUrl(1));
    expect(urls).toContain(assetUrl(1500));
  });
});
