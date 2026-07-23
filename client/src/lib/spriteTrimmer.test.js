import { describe, it, expect } from 'vitest';
import {
  WALK_PHASES, stripFrameGeometry, phaseLabelFor, allColumns, invertColumns,
  sanitizeTrimSlug, buildTrimmerSources,
} from './spriteTrimmer.js';

describe('stripFrameGeometry', () => {
  it('reads frame count / fps / cell size from a rich preview', () => {
    expect(stripFrameGeometry({ frameCount: 12, fps: 24, cellWidth: 384, cellHeight: 320 }))
      .toEqual({ frameCount: 12, fps: 24, cellWidth: 384, cellHeight: 320 });
  });

  it('falls back to the native 8-phase packing and 12fps when fields are absent', () => {
    expect(stripFrameGeometry({})).toEqual({ frameCount: 8, fps: 12, cellWidth: 0, cellHeight: 0 });
    expect(stripFrameGeometry(null)).toEqual({ frameCount: 8, fps: 12, cellWidth: 0, cellHeight: 0 });
  });

  it('treats a non-numeric or <2 frame count as the native default (NaN > 1 is false)', () => {
    expect(stripFrameGeometry({ frameCount: 'x' }).frameCount).toBe(8);
    expect(stripFrameGeometry({ frameCount: 1 }).frameCount).toBe(8);
  });
});

describe('phaseLabelFor', () => {
  it('names walk phases for the native 8-cell packing', () => {
    expect(phaseLabelFor(0, 8)).toBe('left-contact');
    expect(phaseLabelFor(7, 8)).toBe(WALK_PHASES[7]);
  });

  it('uses a bare frame index for a non-8 strip so labels never mix', () => {
    expect(phaseLabelFor(0, 12)).toBe('frame 0');
    expect(phaseLabelFor(11, 12)).toBe('frame 11');
  });
});

describe('allColumns / invertColumns', () => {
  it('lists every column', () => {
    expect(allColumns(4)).toEqual([0, 1, 2, 3]);
    expect(allColumns(0)).toEqual([]);
  });

  it('inverts an enabled selection', () => {
    expect(invertColumns(6, [0, 2, 4])).toEqual([1, 3, 5]);
    expect(invertColumns(3, [])).toEqual([0, 1, 2]);
    expect(invertColumns(3, [0, 1, 2])).toEqual([]);
  });
});

describe('sanitizeTrimSlug', () => {
  it('lowercases and collapses non-alphanumerics to single dashes', () => {
    expect(sanitizeTrimSlug('East Loop v2')).toBe('east-loop-v2');
    expect(sanitizeTrimSlug('  --Hero__Walk!!  ')).toBe('hero-walk');
  });

  it('returns empty for input with no usable characters', () => {
    expect(sanitizeTrimSlug('!!!')).toBe('');
    expect(sanitizeTrimSlug('')).toBe('');
    expect(sanitizeTrimSlug(null)).toBe('');
  });
});

describe('buildTrimmerSources', () => {
  const walk = {
    runs: [
      {
        id: 'walk-east-1', direction: 'east', status: 'candidate',
        stripPreview: { stripPath: 'grok/walk-east-1/generated/strip.png', frameCount: 8, fps: 12 },
      },
      {
        id: 'import-north', direction: 'north', status: 'approved',
        stripPreview: { stripPath: 'runs/import-north/generated/strip.png', frameCount: 12, fps: 10 },
      },
      { id: 'no-strip', direction: 'west', status: 'queued', stripPreview: null },
    ],
  };
  const assets = [
    { path: 'walk/trims/east-loop-v001-strip.png', width: 1536, height: 384 },
    { path: 'walk/trims/east-loop-v001.gif', width: 0, height: 0 },
    { path: 'grok/walk-east-1/generated/strip.png', width: 3072, height: 384 },
  ];

  it('lists packaged runs first, saved trims after, and skips stripless runs', () => {
    const out = buildTrimmerSources(walk, assets);
    expect(out.map((s) => s.id)).toEqual([
      'run:walk-east-1', 'run:import-north', 'trim:walk/trims/east-loop-v001-strip.png',
    ]);
  });

  it('marks only grok/ runs trimmable; imported runs and saved trims are preview-only', () => {
    const out = buildTrimmerSources(walk, assets);
    expect(out.find((s) => s.id === 'run:walk-east-1').trimmable).toBe(true);
    expect(out.find((s) => s.id === 'run:import-north').trimmable).toBe(false);
    expect(out.find((s) => s.kind === 'trim').trimmable).toBe(false);
  });

  it('derives a saved trim frame count from strip width / height', () => {
    const trim = buildTrimmerSources(walk, assets).find((s) => s.kind === 'trim');
    expect(trim.frameCount).toBe(4); // 1536 / 384
    expect(trim.runId).toBeNull();
    expect(trim.label).toBe('saved trim · east-loop-v001');
  });

  it('tolerates missing walk / assets', () => {
    expect(buildTrimmerSources(null)).toEqual([]);
    expect(buildTrimmerSources({ runs: [] }, null)).toEqual([]);
  });
});
