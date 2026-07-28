import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// sw.js is a plain classic service-worker script (no ES imports/exports — it's
// registered without { type: 'module' }), served as-is from client/public/.
// To exercise navigationHandler's fallback branches without extracting it out
// of the worker, evaluate the real file in an isolated vm sandbox that
// implements just enough of the SW globals (self, caches, fetch, Response) to
// drive its 'fetch' event listener, then read back the Response it produces.

const SW_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/sw.js');
const SW_SOURCE = readFileSync(SW_PATH, 'utf-8');

function createSandbox() {
  const listeners = {};
  // name -> Map(url -> Response)
  const cacheStores = new Map();

  function openCache(name) {
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());
    const store = cacheStores.get(name);
    return {
      match: async (req) => store.get(typeof req === 'string' ? req : req.url),
      put: async (req, res) => store.set(typeof req === 'string' ? req : req.url, res),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (req) => store.delete(typeof req === 'string' ? req : req.url),
    };
  }

  const cachesApi = {
    open: async (name) => openCache(name),
    // Global lookup across every opened cache, mirroring the real Cache Storage API.
    match: async (req) => {
      const key = typeof req === 'string' ? req : req.url;
      for (const store of cacheStores.values()) {
        if (store.has(key)) return store.get(key);
      }
      return undefined;
    },
    keys: async () => [...cacheStores.keys()],
    delete: async (name) => cacheStores.delete(name),
  };

  const sandbox = {
    caches: cachesApi,
    console,
    Response,
    Request,
    URL,
    fetch: async () => {
      throw new Error('network unavailable');
    },
  };
  sandbox.self = {
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    skipWaiting: () => {},
    location: { origin: 'https://portos.example' },
    registration: {}, // no navigationPreload in this sandbox
    clients: { claim: async () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'sw.js' });

  return { listeners, cacheStores, cachesApi, openCache };
}

function makeNavigationEvent(url) {
  const event = {
    request: { method: 'GET', url, mode: 'navigate' },
    preloadResponse: Promise.resolve(undefined),
    respondWith: (promise) => {
      event._responded = promise;
    },
    waitUntil: () => {},
  };
  return event;
}

async function dispatchNavigation(listeners, url) {
  const event = makeNavigationEvent(url);
  listeners.fetch(event);
  return event._responded;
}

describe('sw.js navigationHandler — offline fallback branches', () => {
  const NAV_URL = 'https://portos.example/local-llm/playground?backend=ollama&model=x';

  it('serves the cached offline shell when the network fetch fails and a shell is cached', async () => {
    const { listeners, openCache } = createSandbox();
    const shellCache = openCache('portos-shell-v1');
    await shellCache.put('/index.html', new Response('<html>shell</html>', { status: 200 }));

    const response = await dispatchNavigation(listeners, NAV_URL);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('<html>shell</html>');
  });

  it('serves an exact cached response for the navigation URL when no shell is cached', async () => {
    const { listeners, openCache } = createSandbox();
    const exactCache = openCache('some-other-cache');
    await exactCache.put(NAV_URL, new Response('<html>exact match</html>', { status: 200 }));

    const response = await dispatchNavigation(listeners, NAV_URL);

    await expect(response.text()).resolves.toBe('<html>exact match</html>');
  });

  it('returns a renderable fallback page (not Response.error()) when nothing is cached', async () => {
    const { listeners } = createSandbox();

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
