import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  describeFrameStats,
  isDegenerateFrame,
  FRAME_REASON,
  MIN_JUDGEABLE_PIXELS,
} from './imageFrameStats.js';

const SIDE = 64; // 4096 px — comfortably over MIN_JUDGEABLE_PIXELS

// Every fixture is synthesized here: no binary fixture is committed and no
// image from the running instance is ever read.
const solid = (background, channels = 3) => sharp({
  create: { width: SIDE, height: SIDE, channels, background },
}).png().toBuffer();

// Raw RGB gradient so we control the exact pixel values.
const fromPixels = (fill, { channels = 3, width = SIDE, height = SIDE } = {}) => {
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const px = fill(x, y);
      for (let c = 0; c < channels; c++) raw[i + c] = px[c];
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
};

describe('describeFrameStats', () => {
  it('rejects a solid black frame as a flat fill', async () => {
    const stats = await describeFrameStats(await solid({ r: 0, g: 0, b: 0 }));
    expect(stats.ok).toBe(false);
    expect(stats.reason).toBe(FRAME_REASON.SOLID_FILL);
    expect(isDegenerateFrame(stats)).toBe(true);
  });

  it('rejects a solid white frame as a flat fill', async () => {
    const stats = await describeFrameStats(await solid({ r: 255, g: 255, b: 255 }));
    expect(stats.ok).toBe(false);
    expect(stats.reason).toBe(FRAME_REASON.SOLID_FILL);
  });

  it('rejects a solid mid-grey frame as a flat fill', async () => {
    const stats = await describeFrameStats(await solid({ r: 118, g: 118, b: 118 }));
    expect(stats.ok).toBe(false);
    expect(stats.reason).toBe(FRAME_REASON.SOLID_FILL);
  });

  it('rejects a fully transparent sheet even when its colour channels vary', async () => {
    // Noisy RGB under a zero alpha — the colour tests alone would pass it.
    const buf = await fromPixels((x, y) => [(x * 7) % 256, (y * 11) % 256, (x + y) % 256, 0], { channels: 4 });
    const stats = await describeFrameStats(buf);
    expect(stats.ok).toBe(false);
    expect(stats.reason).toBe(FRAME_REASON.FULLY_TRANSPARENT);
  });

  it('ACCEPTS a very dark but real low-key gradient (not a quality judge)', async () => {
    // Deepest pixel 0, brightest 12/255 — the sort of near-black night render
    // a naive brightness heuristic would throw away.
    const buf = await fromPixels((x, y) => {
      const v = Math.round(((x + y) / (2 * (SIDE - 1))) * 12);
      return [v, v, v + (x % 2)];
    });
    const stats = await describeFrameStats(buf);
    expect(stats.ok).toBe(true);
    expect(stats.reason).toBeNull();
    expect(isDegenerateFrame(stats)).toBe(false);
  });

  it('ACCEPTS a minimalist frame that is mostly one colour with a real subject', async () => {
    const buf = await fromPixels((x, y) => {
      const inSubject = x > 20 && x < 44 && y > 20 && y < 44;
      return inSubject ? [220, 180, 90] : [8, 8, 10];
    });
    const stats = await describeFrameStats(buf);
    expect(stats.ok).toBe(true);
  });

  it('ACCEPTS a normal photo-like frame', async () => {
    const buf = await fromPixels((x, y) => [
      (x * 3 + y) % 256,
      (y * 5 + x * 2) % 256,
      (x * x + y * y) % 256,
    ]);
    const stats = await describeFrameStats(buf);
    expect(stats.ok).toBe(true);
    expect(stats.perChannel).toHaveLength(3);
  });

  it('ACCEPTS an opaque frame whose alpha channel is flat by definition', async () => {
    const buf = await fromPixels((x, y) => [(x * 4) % 256, (y * 4) % 256, 128, 255], { channels: 4 });
    const stats = await describeFrameStats(buf);
    expect(stats.ok).toBe(true);
  });

  it('rejects a near-empty frame whose single stray pixel leaves entropy at the floor', async () => {
    const buf = await fromPixels((x, y) => (x === 0 && y === 0 ? [255, 255, 255] : [0, 0, 0]));
    const stats = await describeFrameStats(buf);
    expect(stats.ok).toBe(false);
    // Either tell is correct here; what matters is that it is not accepted.
    expect([FRAME_REASON.SOLID_FILL, FRAME_REASON.NEAR_EMPTY]).toContain(stats.reason);
  });
});

describe('describeFrameStats sentinels', () => {
  it('returns ok:null (not degenerate) for an undecodable buffer', async () => {
    const stats = await describeFrameStats(Buffer.from('not an image at all'));
    expect(stats.ok).toBeNull();
    expect(stats.reason).toBe(FRAME_REASON.STATS_UNAVAILABLE);
    expect(stats.perChannel).toBeNull();
    // The crux: "could not compute" must NOT read as "degenerate".
    expect(isDegenerateFrame(stats)).toBe(false);
  });

  it('returns ok:null for an empty buffer rather than calling it empty content', async () => {
    const stats = await describeFrameStats(Buffer.alloc(0));
    expect(stats.ok).toBeNull();
    expect(isDegenerateFrame(stats)).toBe(false);
  });

  it('returns ok:null for a frame too small for its statistics to mean anything', async () => {
    const tiny = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).png().toBuffer();
    const stats = await describeFrameStats(tiny);
    expect(stats.ok).toBeNull();
    expect(stats.reason).toBe(FRAME_REASON.TOO_SMALL);
    expect(isDegenerateFrame(stats)).toBe(false);
  });

  it('judges a frame exactly at the minimum size', async () => {
    const side = Math.sqrt(MIN_JUDGEABLE_PIXELS);
    const buf = await sharp({ create: { width: side, height: side, channels: 3, background: '#000' } })
      .png().toBuffer();
    const stats = await describeFrameStats(buf);
    expect(stats.ok).toBe(false);
    expect(stats.reason).toBe(FRAME_REASON.SOLID_FILL);
  });

  it('isDegenerateFrame is false for a missing/garbled verdict', () => {
    expect(isDegenerateFrame(null)).toBe(false);
    expect(isDegenerateFrame(undefined)).toBe(false);
    expect(isDegenerateFrame({})).toBe(false);
  });
});
