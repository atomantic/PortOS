import { describe, expect, it } from 'vitest';
import {
  HANDHELD_SEED_MAX, applyDocumentHandheld, documentHandheld, handheldSeedFor, handheldCssTransform, handheldFfmpegFilter, handheldOffset, handheldTerms, handheldZoom, isHandheldStill, normalizeHandheld,
} from './handheldCamera.js';

describe('normalizeHandheld', () => {
  it('clamps and rounds every control, and keeps the seed in range', () => {
    expect(normalizeHandheld({ shake: 2, steps: -1, seed: HANDHELD_SEED_MAX + 5 })).toEqual({ shake: 1, steps: 0, seed: HANDHELD_SEED_MAX });
    expect(normalizeHandheld({ shake: 0.333, steps: 'x', seed: 0 })).toEqual({ shake: 0.33, steps: 0.4, seed: 1 });
    expect(normalizeHandheld(null)).toBeNull();
    expect(isHandheldStill(normalizeHandheld({ shake: 0, steps: 0 }))).toBe(true);
  });
});

describe('handheldTerms', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = handheldTerms({ shake: 0.5, steps: 0.5, seed: 7 });
    expect(handheldTerms({ shake: 0.5, steps: 0.5, seed: 7 })).toEqual(a);
    expect(handheldTerms({ shake: 0.5, steps: 0.5, seed: 8 })).not.toEqual(a);
  });

  it('keeps the shake path when only the footsteps change', () => {
    const shakeOnly = handheldTerms({ shake: 0.6, steps: 0, seed: 3 });
    const walking = handheldTerms({ shake: 0.6, steps: 1, seed: 3 });
    expect(walking.slice(0, shakeOnly.length)).toEqual(shakeOnly);
    expect(walking.some((term) => term.kind === 'bob')).toBe(true);
    expect(handheldTerms({ shake: 0, steps: 0, seed: 3 })).toEqual([]);
  });
});

describe('handheldZoom', () => {
  it('grows with the motion and covers the worst-case offset and roll', () => {
    const gentle = handheldZoom(handheldTerms({ shake: 0.2, steps: 0, seed: 1 }));
    const wild = handheldZoom(handheldTerms({ shake: 1, steps: 1, seed: 1 }));
    expect(gentle).toBeGreaterThan(1);
    expect(wild).toBeGreaterThan(gentle);
    expect(wild).toBeLessThan(1.15);
    expect(handheldZoom([])).toBe(1);
  });

  it('never shows an edge: every sampled corner of the window stays inside the zoomed picture', () => {
    for (const seed of [1, 42, 999]) {
      for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
        const terms = handheldTerms({ shake: 1, steps: 1, seed });
        const zoom = handheldZoom(terms, aspect);
        const halfW = 0.5 * zoom;
        const halfH = (0.5 / aspect) * zoom;
        for (let t = 0; t < 12; t += 1 / 24) {
          const { x, y, r } = handheldOffset(terms, t);
          const theta = (r * Math.PI) / 180;
          for (const [cx, cy] of [[-0.5, -0.5 / aspect], [0.5, -0.5 / aspect], [-0.5, 0.5 / aspect], [0.5, 0.5 / aspect]]) {
            // The window corner in picture space: offset, then turned back by the roll.
            const px = cx + x;
            const py = cy + y / aspect;
            const sx = px * Math.cos(theta) + py * Math.sin(theta);
            const sy = -px * Math.sin(theta) + py * Math.cos(theta);
            expect(Math.abs(sx)).toBeLessThanOrEqual(halfW);
            expect(Math.abs(sy)).toBeLessThanOrEqual(halfH);
          }
        }
      }
    }
  });
});

describe('handheldFfmpegFilter', () => {
  it('scales up to even pixels, rolls and crops the original size back out', () => {
    const filter = handheldFfmpegFilter({ shake: 0.5, steps: 0.5, seed: 2 }, { width: 1280, height: 720 });
    const [scale, rotate, crop] = filter.split(/,(?=rotate=|crop=)/);
    const [, zw, zh] = scale.match(/^scale=(\d+):(\d+):flags=bicubic$/);
    expect(Number(zw) % 2).toBe(0);
    expect(Number(zh) % 2).toBe(0);
    expect(Number(zw)).toBeGreaterThan(1280);
    expect(rotate).toMatch(/^rotate=a='[^']+':c=black:bilinear=1$/);
    expect(crop).toMatch(/^crop=1280:720:x='\(iw-ow\)\/2\+1280\*\([^']+\)':y='\(ih-oh\)\/2\+720\*\([^']+\)'$/);
    // Inside single quotes, a comma would end the filter: the expressions use none.
    expect(rotate.includes(',')).toBe(false);
  });

  it('is null when nothing moves or the size is unknown', () => {
    expect(handheldFfmpegFilter({ shake: 0, steps: 0 }, { width: 1280, height: 720 })).toBeNull();
    expect(handheldFfmpegFilter({ shake: 0.5 }, { width: null, height: 720 })).toBeNull();
  });
});

describe('handheldCssTransform', () => {
  it('moves the picture opposite the window offset, rolls and zooms', () => {
    const terms = handheldTerms({ shake: 0.5, steps: 0.5, seed: 5 });
    const { x, y } = handheldOffset(terms, 1.25);
    const css = handheldCssTransform(terms, 1.25, 1.08);
    expect(css).toContain(`translate(${Number((-x * 100).toFixed(4))}%, ${Number((-y * 100).toFixed(4))}%)`);
    expect(css).toMatch(/rotate\(-?[\d.]+deg\) scale\(1\.08\)$/);
    expect(handheldCssTransform([], 1, 1)).toBeNull();
  });
});

describe('document handheld', () => {
  it('seeds each shot from its id, stably, and is off without shake or footsteps', () => {
    expect(handheldSeedFor('shot-a')).toBe(handheldSeedFor('shot-a'));
    expect(handheldSeedFor('shot-a')).not.toBe(handheldSeedFor('shot-b'));
    expect(documentHandheld({ handheld: 0, handheldSteps: 0 }, 'shot-a')).toBeNull();
    const motion = documentHandheld({ handheld: 0.5, handheldSteps: 0.5 }, 'shot-a');
    expect(motion.zoom).toBeGreaterThan(1);
    expect(motion.terms.every(([axis, , , , bob]) => ['x', 'y', 'r'].includes(axis) && (bob === 0 || bob === 1))).toBe(true);
  });

  // Uniquely catches the camera move and the shake together showing an edge of the picture.
  it('covers the frame when the shake rides on a camera move that already offsets and turns it', () => {
    const motion = documentHandheld({ handheld: 1, handheldSteps: 1 }, 'shot-a');
    const view = applyDocumentHandheld({ scale: 1.02, x: 0.01, y: -0.01, rotation: 0.02 }, motion, 1.5);
    const c = Math.abs(Math.cos(view.rotation)); const s = Math.abs(Math.sin(view.rotation));
    const need = Math.max((1 + 2 * Math.abs(view.x)) * c + (1 + 2 * Math.abs(view.y)) * s * (9 / 16), (1 + 2 * Math.abs(view.y)) * c + (1 + 2 * Math.abs(view.x)) * s * (16 / 9));
    expect(view.scale).toBeGreaterThanOrEqual(need - 1e-9);
    expect(applyDocumentHandheld({ scale: 1, x: 0, y: 0, rotation: 0 }, null, 1)).toEqual({ scale: 1, x: 0, y: 0, rotation: 0 });
  });
});
