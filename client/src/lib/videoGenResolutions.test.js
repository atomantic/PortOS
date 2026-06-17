import { describe, it, expect } from 'vitest';
import { VIDEO_RESOLUTIONS, snapAspectToImage } from './videoGenResolutions.js';

describe('snapAspectToImage', () => {
  it('snaps a 16:9 landscape source to the 16:9 preset', () => {
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, 1920, 1080)).toEqual({ w: 1024, h: 576 });
  });

  it('snaps a 9:16 vertical source to the 9:16 preset', () => {
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, 1080, 1920)).toEqual({ w: 576, h: 1024 });
  });

  it('snaps a square source to a 1:1 preset', () => {
    const r = snapAspectToImage(VIDEO_RESOLUTIONS, 1000, 1000);
    expect(r.w).toBe(r.h); // 512×512 or 768×768 — both are exact 1:1 matches
  });

  it('snaps a tall portrait source to the portrait preset over a square one', () => {
    // 2:3 photo (e.g. 800×1200) is closer to 512×768 than to 512×512.
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, 800, 1200)).toEqual({ w: 512, h: 768 });
  });

  it('penalises too-wide and too-tall symmetrically (log-space metric)', () => {
    // A 2:1 source and a 1:2 source should not both collapse to the same preset:
    // the wide one lands on a landscape preset, the tall one on a portrait preset.
    const wide = snapAspectToImage(VIDEO_RESOLUTIONS, 2000, 1000);
    const tall = snapAspectToImage(VIDEO_RESOLUTIONS, 1000, 2000);
    expect(wide.w).toBeGreaterThan(wide.h);
    expect(tall.h).toBeGreaterThan(tall.w);
  });

  it('returns null for non-positive or non-finite dimensions', () => {
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, 0, 1080)).toBeNull();
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, 1920, 0)).toBeNull();
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, -10, 10)).toBeNull();
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, NaN, 100)).toBeNull();
    expect(snapAspectToImage(VIDEO_RESOLUTIONS, undefined, undefined)).toBeNull();
  });

  it('returns null for an empty or invalid preset list', () => {
    expect(snapAspectToImage([], 1920, 1080)).toBeNull();
    expect(snapAspectToImage(null, 1920, 1080)).toBeNull();
  });

  it('ignores malformed presets without crashing', () => {
    const presets = [{ w: 0, h: 0 }, { label: 'bad' }, { w: 1024, h: 576 }];
    expect(snapAspectToImage(presets, 1920, 1080)).toEqual({ w: 1024, h: 576 });
  });
});
