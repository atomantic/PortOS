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
  vi.useRealTimers();
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

  it.each([
    'The superclass is not a constructor.',
    "undefined is not an object (evaluating 'A.useState')",
    "undefined is not an object (evaluating '$.jsx')",
  ])('treats %s as stale only in module-load or render recovery', (msg) => {
    const error = new Error(msg);
    expect(isStaleChunkError(error)).toBe(false);
    expect(isStaleChunkError(error, { duringImport: true })).toBe(true);
    expect(isStaleChunkError(error, { duringRender: true })).toBe(true);
  });

  it('does not treat unrelated Safari undefined-object errors as stale module errors', () => {
    const error = new Error("undefined is not an object (evaluating 'A.someValue')");
    expect(isStaleChunkError(error, { duringImport: true })).toBe(false);
    expect(isStaleChunkError(error, { duringRender: true })).toBe(false);
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
    // Cache-busting query param: the SW's offline fallback is
    // caches.match(request), which `no-store` does not bypass — a unique URL
    // guarantees a miss so a historical cached shell can't spoof the probe.
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^\/\?portos-build-probe=\d+$/),
      { cache: 'no-store' }
    );
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
  it('purges caches and reloads only after confirming a newer server build', async () => {
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

    await expect(reloadOnceForStaleChunk()).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(['portos-shell-v1']);
  });

  it('keeps the current page when the server build cannot be checked', async () => {
    stubSessionStorage();
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const reload = stubReload();
    const cacheDelete = vi.fn();
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['portos-shell-v1']),
      delete: cacheDelete,
    });

    await expect(reloadOnceForStaleChunk()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    // An offline or unverified probe is not evidence that a reload can recover.
    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('does not reload on the same build, and remains eligible when a newer build appears', async () => {
    stubSessionStorage();
    // A same-build response means this may be a transient failure or a real
    // application bug; keep the page in place and leave the guard unset.
    const fetch = stubFetch(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(shellHtml('build-abc')) })
    );
    const reload = stubReload();
    const cacheDelete = vi.fn();
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['portos-shell-v1']),
      delete: cacheDelete,
    });

    await expect(reloadOnceForStaleChunk()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(cacheDelete).not.toHaveBeenCalled();

    fetch.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(shellHtml('build-new')) })
    );
    await expect(reloadOnceForStaleChunk()).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith('portos-shell-v1');
  });

  it('clears cached assets on an explicit retry when the server is reachable on the same build', async () => {
    stubSessionStorage();
    stubFetch(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(shellHtml('build-abc')) })
    );
    const reload = stubReload();
    const deleted = [];
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['portos-shell-v1', 'other-app-cache']),
      delete: vi.fn((name) => {
        deleted.push(name);
        return Promise.resolve(true);
      }),
    });

    await expect(reloadOnceForStaleChunk({ forceCachePurge: true })).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(deleted).toEqual(['portos-shell-v1']);
    // The explicit retry is still one-shot for this page build.
    await expect(reloadOnceForStaleChunk({ forceCachePurge: true })).resolves.toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not clear cached assets on an explicit retry when the browser is offline', async () => {
    stubSessionStorage();
    stubFetch(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(shellHtml('build-abc')) })
    );
    vi.stubGlobal('navigator', { onLine: false });
    const reload = stubReload();
    const cacheDelete = vi.fn();
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['portos-shell-v1']),
      delete: cacheDelete,
    });

    await expect(reloadOnceForStaleChunk({ forceCachePurge: true })).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(cacheDelete).not.toHaveBeenCalled();
  });

  it('does not reload twice for the same build id', async () => {
    stubSessionStorage();
    stubFetch();
    const reload = stubReload();
    vi.stubGlobal('caches', undefined);

    await expect(reloadOnceForStaleChunk()).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // Second stale error in the SAME build → guard blocks it.
    await expect(reloadOnceForStaleChunk()).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload at all when sessionStorage is unavailable (no reload loop)', async () => {
    // Safari private mode / blocked storage: the accessor itself throws. The
    // stored flag IS the anti-loop guard, so a storage that cannot persist it
    // must not read back as "no reload attempted yet" — that would reload on
    // every stale-chunk error, forever (#5689).
    const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom });
    stubFetch();
    const reload = stubReload();
    vi.stubGlobal('caches', undefined);

    await expect(reloadOnceForStaleChunk()).resolves.toBe(false);
    await expect(reloadOnceForStaleChunk()).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again after a new build ships (guard is build-scoped)', async () => {
    stubSessionStorage();
    stubFetch();
    const reload = stubReload();
    vi.stubGlobal('caches', undefined);

    await expect(reloadOnceForStaleChunk()).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    setBuildId('build-def');
    await expect(reloadOnceForStaleChunk()).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when the build probe times out', async () => {
    vi.useFakeTimers();
    stubSessionStorage();
    // A timed out probe cannot confirm that reloading will recover.
    stubFetch(() => new Promise(() => {}));
    const reload = stubReload();
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    });

    const attempt = reloadOnceForStaleChunk();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(attempt).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
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

    const attempt = reloadOnceForStaleChunk();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(attempt).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not probe or reload without the current page build id', async () => {
    stubSessionStorage();
    const fetch = stubFetch();
    const reload = stubReload();
    setBuildId(null);

    await expect(reloadOnceForStaleChunk()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
