import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, '..', '..', 'client', 'dist');
const INDEX_PATH = join(DIST_DIR, 'index.html');

// These tests touch the real client/dist/index.html that `buildId.js` reads,
// so they save the existing file, mutate it, and restore on teardown. They
// MUST run serially (vitest default in a single file) so they don't trample
// each other.
let preservedIndex = null;
let distCreated = false;

beforeEach(async () => {
  // Force a fresh module load each test — the module-level cache is the
  // whole subject of these tests.
  vi.resetModules();
  if (existsSync(INDEX_PATH)) {
    const { readFileSync } = await import('fs');
    preservedIndex = readFileSync(INDEX_PATH, 'utf8');
  } else if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
    distCreated = true;
  }
});

afterEach(() => {
  vi.useRealTimers();
  if (preservedIndex !== null) {
    writeFileSync(INDEX_PATH, preservedIndex);
    preservedIndex = null;
  } else if (distCreated) {
    rmSync(DIST_DIR, { recursive: true, force: true });
    distCreated = false;
  } else if (existsSync(INDEX_PATH)) {
    rmSync(INDEX_PATH);
  }
});

describe('buildId — cache invalidation', () => {
  it('recomputes when index.html mtime changes (the rebuild path)', async () => {
    writeFileSync(INDEX_PATH, '<html><head></head><body>A</body></html>');
    // Pin the mtime to a known past timestamp so the change is unambiguous.
    const t0 = new Date('2026-01-01T00:00:00Z');
    utimesSync(INDEX_PATH, t0, t0);

    const mod = await import('./buildId.js');
    const idA = mod.getBuildId(); // primes the cache synchronously
    const htmlA = mod.getStampedIndexHtml();
    expect(idA).not.toBe('dev');
    expect(htmlA).toContain(`<meta name="portos-build-id" content="${idA}">`);
    expect(htmlA).toContain('body>A');

    // Simulate a Vite rebuild: new content, new mtime. refreshBuildId() is the
    // explicit synchronous recompute hook (bypasses the throttle window the
    // hot-path getters honor) — deterministic, no timing.
    writeFileSync(INDEX_PATH, '<html><head></head><body>B</body></html>');
    const t1 = new Date('2026-02-01T00:00:00Z');
    utimesSync(INDEX_PATH, t1, t1);

    const snap = mod.refreshBuildId();
    expect(snap.id).not.toBe(idA);

    const idB = mod.getBuildId();
    const htmlB = mod.getStampedIndexHtml();
    expect(idB).not.toBe(idA);
    expect(htmlB).toContain(`<meta name="portos-build-id" content="${idB}">`);
    expect(htmlB).toContain('body>B');
  });

  it('serves the cached snapshot within the throttle window, then re-syncs after it (no per-request stat)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00Z'));

    writeFileSync(INDEX_PATH, '<html><head></head><body>old</body></html>');
    const t0 = new Date('2026-05-01T00:00:00Z');
    utimesSync(INDEX_PATH, t0, t0);

    const mod = await import('./buildId.js');
    const idOld = mod.getBuildId(); // primes; stamps the throttle clock
    expect(idOld).not.toBe('dev');

    // Rebuild on disk. Within the throttle window the getter must NOT re-stat —
    // it serves the cached (stale) snapshot.
    writeFileSync(INDEX_PATH, '<html><head></head><body>new</body></html>');
    const t1 = new Date('2026-05-01T00:10:00Z');
    utimesSync(INDEX_PATH, t1, t1);
    vi.advanceTimersByTime(500); // < CHECK_THROTTLE_MS (1000ms)
    expect(mod.getBuildId()).toBe(idOld);

    // Past the throttle window the next read re-stats, sees the new mtime, and
    // recomputes — so the served HTML re-syncs with the on-disk chunks.
    vi.advanceTimersByTime(600); // now > 1000ms since the prime
    const idNew = mod.getBuildId();
    expect(idNew).not.toBe(idOld);
    expect(mod.getStampedIndexHtml()).toContain('body>new');
  });

  it('returns the same id from cache when mtime is unchanged', async () => {
    writeFileSync(INDEX_PATH, '<html><head></head><body>same</body></html>');
    const t0 = new Date('2026-03-01T00:00:00Z');
    utimesSync(INDEX_PATH, t0, t0);

    const mod = await import('./buildId.js');
    const id1 = mod.getBuildId();
    const id2 = mod.getBuildId();
    const id3 = mod.getBuildId();
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it('falls back to id=dev with null html when index.html is missing', async () => {
    if (existsSync(INDEX_PATH)) rmSync(INDEX_PATH);

    const mod = await import('./buildId.js');
    expect(mod.getBuildId()).toBe('dev');
    expect(mod.getStampedIndexHtml()).toBe(null);
  });

  it('replaces an existing portos-build-id meta tag instead of double-stamping', async () => {
    writeFileSync(
      INDEX_PATH,
      '<html><head><meta name="portos-build-id" content="ABCDEF123456"></head><body>x</body></html>',
    );
    const t0 = new Date('2026-04-01T00:00:00Z');
    utimesSync(INDEX_PATH, t0, t0);

    const mod = await import('./buildId.js');
    const html = mod.getStampedIndexHtml();
    const matches = html.match(/portos-build-id/g) || [];
    expect(matches).toHaveLength(1);
    expect(html).not.toContain('content="ABCDEF123456"');
  });
});
