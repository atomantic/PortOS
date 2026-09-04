// Web Storage (localStorage/sessionStorage) polyfill for the test environment.
//
// jsdom only exposes Storage when the document runs on a non-opaque origin — which
// varies by jsdom version, by `environmentOptions.url`, and by whether an earlier
// test stubbed `window` away (e.g. `vi.stubGlobal('window', undefined)` in
// loopbackHost.test.js, later restored by `vi.unstubAllGlobals()`). When Storage is
// absent, any test whose `beforeEach` calls `localStorage.clear()` dies with
// "Cannot read properties of undefined (reading 'clear')". Installing a guaranteed
// in-memory Storage removes that environmental dependency. See issue #1438.
//
// setup.js installs the shim unconditionally (`force`), because a *present* Storage
// is not automatically a usable one either: happy-dom backs `localStorage` with a
// Proxy that turns any property definition into a stored item, so `vi.spyOn(
// window.localStorage, 'setItem')` cannot be undone and `vi.restoreAllMocks()`
// leaks the throwing stub into every later test in the file (#6144). The shim is a
// plain object, so a spy on it restores like any other. Storage identity is not
// otherwise observable — nothing in the app reads `instanceof Storage`, and the
// 'storage' event listeners take a synthetic event from the test.

export const createMemoryStorage = () => {
  let store = new Map();
  return {
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key) {
      return store.has(String(key)) ? store.get(String(key)) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
    clear() {
      store = new Map();
    },
  };
};

// A present-but-broken Storage is as bad as a missing one — probe round-trip before
// trusting the environment's own implementation.
export const storageWorks = (candidate) => {
  if (!candidate) return false;
  const probe = '__portos_storage_probe__';
  // A throwing setItem (e.g. a Storage stubbed to simulate quota/private mode) means
  // "not usable as a baseline" — fall back to the in-memory shim.
  let ok;
  try {
    candidate.setItem(probe, '1');
    ok = candidate.getItem(probe) === '1';
    candidate.removeItem(probe);
  } catch {
    return false;
  }
  return ok;
};

// Ensure `globalThis[name]` (and `window[name]`, which the environment may alias) is
// a working Storage. Returns true when it installed a shim, false when the
// environment's own Storage already worked and was left alone. Idempotent.
// `force` skips the probe and installs the shim regardless — see the header.
export const ensureStorage = (name, root = globalThis, { force = false } = {}) => {
  if (!force && storageWorks(root[name])) return false;
  const shim = createMemoryStorage();
  Object.defineProperty(root, name, { value: shim, configurable: true, writable: true });
  // jsdom may expose `window` and `globalThis` as distinct objects; alias the shim
  // onto `window` too so bare `localStorage` and `window.localStorage` resolve to the
  // same instance. Only when installing onto the real global root — a caller passing
  // an explicit `root` (e.g. tests) must not mutate the global `window`.
  if (root === globalThis && typeof window !== 'undefined' && window !== globalThis) {
    Object.defineProperty(window, name, { value: shim, configurable: true, writable: true });
  }
  return true;
};

export const installTestStorage = () => {
  ensureStorage('localStorage', globalThis, { force: true });
  ensureStorage('sessionStorage', globalThis, { force: true });
};
