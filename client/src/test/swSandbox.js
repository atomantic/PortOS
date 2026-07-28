import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

// sw.js is a plain classic service-worker script (no ES imports/exports — it's
// registered without { type: 'module' }), served as-is from client/public/.
// To exercise it in a vitest suite without extracting logic out of the worker,
// evaluate the real file in an isolated vm sandbox implementing just enough of
// the SW globals (self, caches, fetch, Response) to drive its event listeners,
// then read back the Response(s) it produces. Reusable across any sw.js test —
// not just navigationHandler's fallback branches.

const SW_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/sw.js');
const SW_SOURCE = readFileSync(SW_PATH, 'utf-8');

/**
 * Evaluate sw.js in a fresh vm sandbox with an in-memory Cache Storage
 * implementation. Returns the captured event listeners and a cache-seeding
 * helper; the network `fetch` always rejects, so callers exercise the
 * offline/failure paths.
 */
export function createSwSandbox() {
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

  return { listeners, openCache };
}

export function makeNavigationEvent(url) {
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

export async function dispatchNavigation(listeners, url) {
  const event = makeNavigationEvent(url);
  listeners.fetch(event);
  return event._responded;
}
