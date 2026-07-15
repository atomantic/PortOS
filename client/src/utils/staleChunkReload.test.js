import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isStaleChunkError,
  fetchServerBuildId,
  reloadOnceForStaleChunk,
  purgeOfflineCaches,
} from './staleChunkReload';

// jsdom lacks Cache Storage and a settable location.reload; stub both.
const stubSessionStorage = () => {
  const store = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  });
  return store;
};

const stubReload = () => {
  const reload = vi.fn();
  // location is non-configurable in jsdom; replace the whole object.
  vi.stubGlobal('location', { reload });
  return reload;
};

const setBuildId = (id) => {
  document.head.innerHTML = id
    ? `<meta name="portos-build-id" content="${id}">`
    : '';
};

// Build-id probe: GET / returns the server's stamped shell. Default to serving
// a DIFFERENT build than the page's `build-abc`, i.e. "a new build exists".
const shellHtml = (id) =>
  `<html><head><meta name="portos-build-id" content="${id}"></head><body></body></html>`;

const stubFetch = (impl) => {
  const fetch = vi.fn(
    impl ?? (() => Promise.resolve({ ok: true, text: () => Promise.resolve(shellHtml('build-new')) }))
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

beforeEach(() => {
  setBuildId('build-abc');
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('isStaleChunkError', () => {
  it.each([
    'Importing a module script failed',
    'Failed to fetch dynamically imported module',
    'error loading dynamically imported module',
    'Expected a JavaScript module but got MIME type text/html',
  ])('matches %s', (msg) => {
    expect(isStaleChunkError(new Error(msg))).toBe(true);
  });

  it('is case-insensitive and accepts non-Error values', () => {
    expect(isStaleChunkError('IMPORTING A MODULE SCRIPT FAILED')).toBe(true);
  });

  it('ignores unrelated errors', () => {
    expect(isStaleChunkError(new Error('network down'))).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});

describe('purgeOfflineCaches', () => {
  it('deletes only portos-* caches and swallows failures', async () => {
    const deleted = [];
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([
        'portos-shell-v1',
        'portos-assets-v1',
        'some-other-cache',
      ]),
      delete: vi.fn((name) => {
        deleted.push(name);
        return Promise.resolve(true);
      }),
    });
    await purgeOfflineCaches();
    expect(deleted).toEqual(['portos-shell-v1', 'portos-assets-v1']);
  });

  it('no-ops when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(purgeOfflineCaches()).resolves.toBeUndefined();
  });

  it('does not throw when caches.keys rejects', async () => {
    vi.stubGlobal('caches', {
      keys: vi.fn().mockRejectedValue(new Error('storage disabled')),
      delete: vi.fn(),
    });
    await expect(purgeOfflineCaches()).resolves.toBeUndefined();
  });
});

describe('fetchServerBuildId', () => {
  it('reads the build id stamped into the served shell', async () => {
    const fetch = stubFetch();
    await expect(fetchServerBuildId()).resolves.toBe('build-new');
    expect(fetch).toHaveBeenCalledWith('/', { cache: 'no-store' });
  });

  it('is null when the probe rejects (offline)', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(fetchServerBuildId()).resolves.toBeNull();
  });

  it('is null on a non-ok response', async () => {
    stubFetch(() => Promise.resolve({ ok: false }));
    await expect(fetchServerBuildId()).resolves.toBeNull();
  });

  it('is null when the shell has no build-id meta tag', async () => {
    stubFetch(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('<html><head></head></html>') })
    );
    await expect(fetchServerBuildId()).resolves.toBeNull();
  });

  it('short-circuits null when navigator reports offline', async () => {
    const fetch = stubFetch();
    vi.stubGlobal('navigator', { onLine: false });
    await expect(fetchServerBuildId()).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('reloadOnceForStaleChunk', () => {
  it('purges caches then reloads once for a given build', async () => {
    stubSessionStorage();
    stubFetch();
    const reload = stubReload();
    const deleted = [];
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['portos-shell-v1']),
      delete: vi.fn((name) => {
        deleted.push(name);
        return Promise.resolve(true);
      }),
    });

    expect(reloadOnceForStaleChunk()).toBe(true);
    // Reload is deferred until the purge settles.
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(deleted).toEqual(['portos-shell-v1']);
  });

  it('skips the purge but still reloads when the server is unreachable', async () => {
    stubSessionStorage();
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const reload = stubReload();
    const cacheDelete = vi.fn();
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['portos-shell-v1']),
      delete: cacheDelete,
    });

    expect(reloadOnceForStaleChunk()).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Offline: the (possibly current-build) offline shell must survive so the
    // reload can boot it — purging would strand the user on a network error page.
    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('skips the purge when the server still serves the SAME build (transient failure)', async () => {
    stubSessionStorage();
    // Server reachable, but serving the build the page already runs — the
    // import error was a network blip, not a stale deployment.
    stubFetch(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(shellHtml('build-abc')) })
    );
    const reload = stubReload();
    const cacheDelete = vi.fn();
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['portos-shell-v1']),
      delete: cacheDelete,
    });

    expect(reloadOnceForStaleChunk()).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('does not reload twice for the same build id', async () => {
    stubSessionStorage();
    stubFetch();
    const reload = stubReload();
    vi.stubGlobal('caches', undefined);

    expect(reloadOnceForStaleChunk()).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Second stale error in the SAME build → guard blocks it.
    expect(reloadOnceForStaleChunk()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again after a new build ships (guard is build-scoped)', async () => {
    stubSessionStorage();
    stubFetch();
    const reload = stubReload();
    vi.stubGlobal('caches', undefined);

    expect(reloadOnceForStaleChunk()).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    setBuildId('build-def');
    expect(reloadOnceForStaleChunk()).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it('still reloads when the reachability probe hangs (timeout backstop)', async () => {
    vi.useFakeTimers();
    stubSessionStorage();
    // Probe never resolves → the whole purge chain would hang without the timeout.
    stubFetch(() => new Promise(() => {}));
    const reload = stubReload();
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    });

    expect(reloadOnceForStaleChunk()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('still reloads when the cache purge hangs (timeout backstop)', async () => {
    vi.useFakeTimers();
    stubSessionStorage();
    stubFetch();
    const reload = stubReload();
    // keys() never resolves → purge would hang without the timeout.
    vi.stubGlobal('caches', {
      keys: vi.fn(() => new Promise(() => {})),
      delete: vi.fn(),
    });

    expect(reloadOnceForStaleChunk()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
