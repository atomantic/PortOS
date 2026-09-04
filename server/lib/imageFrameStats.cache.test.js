/**
 * Content-addressed memo for `describeFrameStats` (issue #6004).
 *
 * A separate file from `imageFrameStats.test.js` — which pins the CLASSIFIER
 * and builds every fixture with the real sharp — because counting decodes needs
 * sharp wrapped for the whole module graph, and the classifier suite must keep
 * measuring through the unwrapped one.
 *
 * The decode count is the point: `sharp().stats()` costs ~4ms regardless of
 * pixel count (libvips pipeline setup, not pixels), and the sprite compiler
 * re-probes the same frame bytes dozens of times per run. A regression here is
 * invisible in behavior and only shows up as CI wall time, so it is asserted
 * directly rather than left to a timing threshold.
 */
import { describe, it, expect, beforeEach, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const probe = vi.hoisted(() => ({ calls: 0 }));

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal();
  const real = actual.default;
  const counted = Object.assign((...args) => {
    probe.calls += 1;
    return real(...args);
  }, real);
  return { ...actual, default: counted };
});

const sharp = (await import('sharp')).default;
const {
  describeFrameStats, __resetFrameStatsCache, FRAME_REASON,
} = await import('./imageFrameStats.js');

const SIDE = 64;

// Synthesized here; no binary fixture is committed and no image from the
// running instance is ever read.
const flatPng = (level) => sharp({
  create: { width: SIDE, height: SIDE, channels: 3, background: { r: level, g: level, b: level } },
}).png().toBuffer();

const gradientPng = (offset = 0) => {
  const raw = Buffer.alloc(SIDE * SIDE * 3);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const i = (y * SIDE + x) * 3;
      raw[i] = (x * 4 + offset) % 256;
      raw[i + 1] = (y * 4 + offset) % 256;
      raw[i + 2] = ((x + y) * 2 + offset) % 256;
    }
  }
  return sharp(raw, { raw: { width: SIDE, height: SIDE, channels: 3 } }).png().toBuffer();
};

beforeEach(() => {
  __resetFrameStatsCache();
  probe.calls = 0;
});

describe('describeFrameStats memo', () => {
  it('decodes a buffer once and answers repeat probes from the memo', async () => {
    const bytes = await gradientPng();
    probe.calls = 0;

    const first = await describeFrameStats(bytes);
    const decodesForFirst = probe.calls;
    const second = await describeFrameStats(bytes);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(decodesForFirst).toBeGreaterThan(0);
    expect(probe.calls).toBe(decodesForFirst);
  });

  it('keys on content, not buffer identity — equal bytes hit, different bytes miss', async () => {
    const bytes = await gradientPng();
    const twin = Buffer.from(bytes);
    const flat = await flatPng(90);
    probe.calls = 0;

    const original = await describeFrameStats(bytes);
    const afterCopy = probe.calls;
    const fromTwin = await describeFrameStats(twin);
    const afterTwin = probe.calls;
    const fromFlat = await describeFrameStats(flat);

    expect(fromTwin).toEqual(original);
    expect(afterTwin).toBe(afterCopy);
    // A distinct image must not be answered by the memo: its verdict differs,
    // which a key on length (or on identity) would get wrong.
    expect(fromFlat.ok).toBe(false);
    expect(fromFlat.reason).toBe(FRAME_REASON.SOLID_FILL);
    expect(probe.calls).toBeGreaterThan(afterTwin);
  });

  it('never memoizes a PATH, whose file can change under the same key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'frame-stats-memo-'));
    const framePath = join(dir, 'frame.png');
    writeFileSync(framePath, await flatPng(120));
    // libvips keeps its own operation cache keyed on the file, which would
    // answer the second read with the first image and hide whichever layer is
    // actually re-measuring. Off for this test so the assertion is about OUR
    // memo — and note libvips' cache is per-process and short-lived, unlike an
    // hour-long path-keyed memo, which is why one is tolerable and the other
    // would be a correctness bug. Restored from a teardown, not inline: a
    // failing assertion would otherwise leave libvips uncached for every later
    // test in this worker and leak the tmpdir.
    sharp.cache(false);
    onTestFinished(() => {
      sharp.cache(true);
      rmSync(dir, { recursive: true, force: true });
    });

    const degenerate = await describeFrameStats(framePath);
    writeFileSync(framePath, await gradientPng());
    const rewritten = await describeFrameStats(framePath);

    expect(degenerate.ok).toBe(false);
    expect(rewritten.ok).toBe(true);
  });

  it('re-probes an unmeasurable buffer instead of pinning `ok: null` on it', async () => {
    // `stats-unavailable` catches EVERY probe failure, including a transient
    // libvips one on bytes that are perfectly valid. Memoizing it would disable
    // the content gate for that frame until the TTL expired, so it is the one
    // verdict that must stay unmemoized — asserted by decode count, since the
    // returned verdict looks identical either way.
    const undecodable = Buffer.from('this is not an image');
    probe.calls = 0;

    const first = await describeFrameStats(undecodable);
    const decodesForFirst = probe.calls;
    const second = await describeFrameStats(undecodable);

    expect(first.ok).toBeNull();
    expect(first.reason).toBe(FRAME_REASON.STATS_UNAVAILABLE);
    expect(second).toEqual(first);
    expect(probe.calls).toBeGreaterThan(decodesForFirst);
  });

  it('hands out a copy, so a caller mutating a verdict cannot poison the memo', async () => {
    const bytes = await gradientPng(7);

    const first = await describeFrameStats(bytes);
    first.ok = false;
    first.reason = 'tampered';
    first.perChannel[0].stdev = -1;
    const second = await describeFrameStats(bytes);

    expect(second.ok).toBe(true);
    expect(second.reason).toBeNull();
    expect(second.perChannel[0].stdev).toBeGreaterThan(0);
  });
});
