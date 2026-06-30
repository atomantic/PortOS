import { describe, it, expect, beforeEach, vi } from 'vitest';

// Simulate a platform/filesystem where fs.watch is unavailable, with index.html
// fully in-memory so this file never touches the real client/dist/index.html
// (and so can't race the sibling buildId.test.js, which vitest may run in a
// parallel worker). The buildId module must fall back to a throttled stat so a
// rebuild is still detected instead of serving stale chunk URLs until restart
// (codex review #1828).
const state = { mtimeMs: 1000, html: '<html><head></head><body>A</body></html>', indexExists: true };

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    watch: vi.fn(() => { throw new Error('fs.watch unsupported'); }),
    existsSync: vi.fn((p) => (String(p).endsWith('index.html') ? state.indexExists : true)),
    statSync: vi.fn(() => ({ mtimeMs: state.mtimeMs })),
    readFileSync: vi.fn(() => state.html),
  };
});

beforeEach(() => {
  vi.resetModules();
  state.mtimeMs = 1000;
  state.html = '<html><head></head><body>A</body></html>';
  state.indexExists = true;
});

describe('buildId — degraded mode (fs.watch unavailable)', () => {
  it('falls back to a stat so a rebuild is still detected without the watcher', async () => {
    const mod = await import('./buildId.js');
    const idA = mod.getBuildId(); // primes (the `!cached` path — no stat fallback yet)
    expect(idA).not.toBe('dev');

    // Rebuild: new content + mtime. With no watcher, the next read's throttled
    // stat fallback (lastStatAt is still 0 after the prime) fires and recomputes.
    // NOTE: don't read again before mutating — in degraded mode the fallback is
    // throttled to one stat per STAT_FALLBACK_MS, so an intervening read would
    // consume the window and suppress this rebuild detection (bounded staleness
    // is the intended degraded-mode tradeoff).
    state.html = '<html><head></head><body>B</body></html>';
    state.mtimeMs = 2000;

    const idB = mod.getBuildId();
    expect(idB).not.toBe(idA);
    expect(mod.getStampedIndexHtml()).toContain('body>B');
  });

  it('drops to id=dev when index.html disappears while the watcher is unavailable', async () => {
    const mod = await import('./buildId.js');
    expect(mod.getBuildId()).not.toBe('dev'); // primes from in-memory A

    state.indexExists = false;
    expect(mod.getBuildId()).toBe('dev');
    expect(mod.getStampedIndexHtml()).toBe(null);
  });
});
