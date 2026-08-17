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
