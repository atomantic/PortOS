import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { primeOpencodeCatalogCache } from './opencodeCatalogCache.js';

const CATALOG = JSON.stringify({
  opencode: { id: 'opencode', name: 'OpenCode Zen', models: { 'muse-spark-1.3-contributor-free': { id: 'muse-spark-1.3-contributor-free' } } },
});

const respondWith = (body, ok = true) => async () => ({ ok, text: async () => body });

let cacheHome;
let env;
let cachePath;

/** Seed a catalog on disk and age it past the staleness window. */
const seedStaleCatalog = async (body = CATALOG) => {
  await primeOpencodeCatalogCache({ env, fetchImpl: respondWith(body) });
  const longAgo = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(cachePath, longAgo, longAgo);
};

beforeEach(async () => {
  cacheHome = await mkdtemp(join(tmpdir(), 'opencode-catalog-'));
  env = { XDG_CACHE_HOME: cacheHome };
  cachePath = join(cacheHome, 'opencode', 'models.json');
});

describe('primeOpencodeCatalogCache', () => {
  // The path is the whole point: `opencode models` prints from this exact file,
  // so a catalog written anywhere else is a catalog the harness never reads.
  it('writes the fetched catalog where the harness will read it', async () => {
    const fetchImpl = vi.fn(respondWith(CATALOG));

    const result = await primeOpencodeCatalogCache({ env, fetchImpl });

    expect(result.primed).toBe(true);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://models.opencode.ai/api.json');
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(CATALOG);
  });

  // OpenCode's own staleness window. Without it, a double-click pulls several
  // megabytes twice for an answer that cannot have changed.
  it('leaves a cache younger than the max age alone', async () => {
    await primeOpencodeCatalogCache({ env, fetchImpl: respondWith(CATALOG) });
    const fetchImpl = vi.fn(respondWith(CATALOG));

    const result = await primeOpencodeCatalogCache({ env, fetchImpl });

    expect(result.primed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-fetches once the cache has aged past the max age', async () => {
    await seedStaleCatalog('{"old":{"models":{}}}');

    const result = await primeOpencodeCatalogCache({ env, fetchImpl: respondWith(CATALOG) });

    expect(result.primed).toBe(true);
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(CATALOG);
  });

  // The failure that matters: a stale-but-real catalog is a far better answer
  // than an empty picker, so nothing but a parsed catalog may replace it.
  it.each([
    ['an unreachable endpoint', async () => { throw new Error('Unable to connect'); }],
    ['a non-2xx response', respondWith('nope', false)],
    ['a gateway error page', respondWith('<html>502 Bad Gateway</html>')],
    ['a truncated body', respondWith('{"opencode":{"models":')],
    ['valid JSON that is not a catalog', respondWith('{}')],
  ])('keeps the existing catalog on %s', async (_label, fetchImpl) => {
    await seedStaleCatalog();

    const result = await primeOpencodeCatalogCache({ env, fetchImpl });

    expect(result.primed).toBe(false);
    await expect(readFile(cachePath, 'utf8')).resolves.toBe(CATALOG);
  });

  // Each of these means PortOS cannot be certain which file OpenCode reads (or
  // that it should read one at all) — writing anyway would leave a file OpenCode
  // ignores, or override an explicit opt-out.
  it.each([
    ['OPENCODE_MODELS_PATH pins another file', { OPENCODE_MODELS_PATH: '/somewhere/models.json' }],
    ['OPENCODE_DISABLE_MODELS_FETCH opts out', { OPENCODE_DISABLE_MODELS_FETCH: '1' }],
    ['OPENCODE_MODELS_URL names a mirror', { OPENCODE_MODELS_URL: 'https://mirror.example.com' }],
  ])('neither fetches nor writes when %s', async (_label, overrides) => {
    const fetchImpl = vi.fn(respondWith(CATALOG));

    const result = await primeOpencodeCatalogCache({ env: { ...env, ...overrides }, fetchImpl });

    expect(result.primed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow();
  });
});
