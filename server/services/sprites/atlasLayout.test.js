/**
 * Atlas layout sidecar + runtime-contract comparison (#2982). Pure module —
 * no fs, no compiler; publish.test.js owns the write/serialization side.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAtlasLayout, layoutSidecarPath, runtimeContractMismatch, ATLAS_LAYOUT_SCHEMA_VERSION,
} from './atlasLayout.js';
import { walkPhaseLabels } from './walkBounds.js';
// The span math moved to atlasGrid.js (#3016) and is unit-tested there. This
// file asserts it only THROUGH `buildAtlasLayout`, i.e. as the sidecar a
// consumer actually reads.
import { buildAtlasGrid } from './atlasGrid.js';
import { ANIMATION_TRACKS } from './animationTracks.js';
import { trackSpan as span } from './spriteTestFixtures.js';

const DIRECTIONS = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'];

// The grid the compiler emits today: idle + N walk phases (#2986 dropped the
// trailing scanner placeholder).
const geometryFor = (walkFrameCount, overrides = {}) => ({
  columns: ['idle', ...walkPhaseLabels(walkFrameCount)],
  directionOrder: DIRECTIONS,
  rows: DIRECTIONS.length,
  cellSize: 96,
  walkFrameCount,
  walkFps: 10,
  ...overrides,
});
// A pre-#2986 / imported grid, which still carries the scanner column. The
// sidecar is the READ side of the contract, so it must keep describing these.
const legacyGeometryFor = (walkFrameCount, overrides = {}) =>
  geometryFor(walkFrameCount, {
    columns: ['idle', ...walkPhaseLabels(walkFrameCount), 'scanner'],
    ...overrides,
  });

describe('layoutSidecarPath', () => {
  it('swaps the .png extension for .layout.json', () => {
    expect(layoutSidecarPath('assets/sprites/hero/hero-atlas.png'))
      .toBe('assets/sprites/hero/hero-atlas.layout.json');
    expect(layoutSidecarPath('assets/HERO.PNG')).toBe('assets/HERO.layout.json');
  });
});

describe('buildAtlasLayout', () => {
  it('describes the compiled grid, marking previewFps as authoring-only', () => {
    const layout = buildAtlasLayout({
      characterId: 'example-character',
      geometry: geometryFor(8),
      atlasSha256: 'abc123',
      version: 4,
      atlasDestPath: 'assets/sprites/hero/hero-atlas.png',
    });
    expect(layout).toMatchObject({
      schemaVersion: ATLAS_LAYOUT_SCHEMA_VERSION,
      kind: 'portos-sprite-atlas-layout',
      characterId: 'example-character',
      atlasFile: 'hero-atlas.png',
      atlasVersion: 4,
      sourceAtlasSha256: 'abc123',
      cellSize: 96,
      rows: 8,
      rowOrder: DIRECTIONS,
      columnCount: 9,
      walkFrameCount: 8,
      previewFps: 10,
    });
    expect(layout.columns).toEqual(['idle', ...walkPhaseLabels(8)]);
    // The compiled grid has exactly two tracks — the scanner span is gone with
    // the column it described (#2986).
    expect(layout.tracks).toEqual({ idle: span(0, 1), walk: span(1, 8) });
    expect(layout.previewFpsNote).toMatch(/do not use this as a runtime frame rate/);
    // No timestamp: identical geometry must produce byte-identical content so
    // an unchanged republish stays a no-op.
    expect(JSON.stringify(layout)).not.toMatch(/publishedAt/);
  });

  it('still describes a pre-#2986 grid that carries a scanner column', () => {
    const layout = buildAtlasLayout({
      characterId: 'example-character',
      geometry: legacyGeometryFor(8),
      atlasSha256: 'abc123',
      version: 2,
      atlasDestPath: 'assets/sprites/hero/hero-atlas.png',
    });
    expect(layout.columnCount).toBe(10);
    expect(layout.walkFrameCount).toBe(8);
    expect(layout.tracks.scanner).toEqual(span(9, 1));
  });

  it('describes a two-track grid whose tracks differ in length (#3016)', () => {
    // Built through the compiler's own span builder, against a SYNTHETIC
    // registration order — only `walk` is registered today, so shipping a real
    // second track is #3018's job (see atlasGrid.test.js for why the synthetic
    // fixture is the point rather than a shortcut).
    const grid = buildAtlasGrid(
      [{ id: 'walk', frameCount: 12 }, { id: 'scanner', frameCount: 4 }],
      { ...ANIMATION_TRACKS, scanner: { ...ANIMATION_TRACKS.walk, id: 'scanner' } },
    );
    const layout = buildAtlasLayout({
      characterId: 'example-character',
      geometry: geometryFor(12, { columns: grid.columns, tracks: grid.tracks }),
      atlasSha256: 'abc123',
      version: 7,
      atlasDestPath: 'assets/sprites/hero/hero-atlas.png',
    });
    expect(layout.tracks).toEqual({
      idle: span(0, 1),
      walk: span(1, 12),
      scanner: span(13, 4),
    });
    // columns, tracks and the atlas width stay mutually consistent: the spans
    // tile the column list exactly, so a consumer sampling by span lands on the
    // pixels the PNG's width accounts for.
    expect(layout.columnCount).toBe(17);
    expect(layout.columns).toHaveLength(layout.columnCount);
    expect(Object.values(layout.tracks).reduce((n, s) => n + s.count, 0)).toBe(layout.columnCount);
    // The walk span is still recoverable by name for a consumer that only knows
    // about walk — a second track is additive, not a re-read.
    expect(layout.walkFrameCount).toBe(12);
  });

  it('refuses a persisted descriptor that contradicts its own column list', () => {
    // A sidecar whose spans disagree with its columns would silently point a
    // consumer at the wrong pixels — the exact failure #2982 exists to prevent.
    expect(() => buildAtlasLayout({
      characterId: 'example-character',
      geometry: geometryFor(8, { tracks: { idle: { start: 0, count: 1 }, walk: { start: 1, count: 3 } } }),
      atlasSha256: 'abc123',
      atlasDestPath: 'assets/sprites/hero/hero-atlas.png',
    })).toThrow(/describe 4 of 9 columns/);
  });

  it('refuses geometry with no column list', () => {
    expect(() => buildAtlasLayout({ characterId: 'x', geometry: {}, atlasDestPath: 'a.png' }))
      .toThrow(/no column list/);
  });
});

describe('runtimeContractMismatch', () => {
  const contract = { walkFrameCount: 8, cellSize: 96, columnCount: 9 };

  it('passes an absent contract and a matching one', () => {
    expect(runtimeContractMismatch(geometryFor(12), null)).toBeNull();
    expect(runtimeContractMismatch(geometryFor(12), undefined)).toBeNull();
    expect(runtimeContractMismatch(geometryFor(8), contract)).toBeNull();
  });

  it('names both counts and both resolutions on a frame-count mismatch', () => {
    const message = runtimeContractMismatch(geometryFor(12), contract, 'Example App');
    expect(message).toContain('Atlas has 13 columns (12 walk frames)');
    expect(message).toContain('Example App expects 9 (8 walk frames)');
    expect(message).toMatch(/walk-frame constant/);
    expect(message).toMatch(/reprocess this walk set to 8 frames/);
  });

  it('flags a column-count-only mismatch as a grid-shape change', () => {
    // A pre-#2986 atlas (still carrying the scanner column) against a contract
    // re-bound to the current 9-column grid: same walk frames, wrong shape.
    const message = runtimeContractMismatch(legacyGeometryFor(8), contract, 'Example App');
    expect(message).toContain('Atlas has 10 columns (8 walk frames)');
    expect(message).toMatch(/grid shape changed/);
  });

  it('flags a cell-size mismatch', () => {
    expect(runtimeContractMismatch(geometryFor(8, { cellSize: 64 }), contract, 'Example App')).toBe(
      'Atlas cells are 64px but Example App expects 96px. '
      + "Recompile this atlas at 96px cells, or update the app's cell-size constant before publishing.",
    );
  });

  it('describes and validates an ambient-only grid without inventing walk frames', () => {
    const geometry = {
      columns: ['idle', 'ambient-00', 'ambient-01', 'ambient-02'],
      tracks: { idle: span(0, 1, 1), ambient: span(1, 3, 1) },
      directionOrder: DIRECTIONS,
      rows: DIRECTIONS.length,
      cellSize: 96,
      walkFrameCount: null,
      ambientFrameCount: 3,
    };
    const layout = buildAtlasLayout({
      characterId: 'example-place', geometry, atlasSha256: 'abc123', atlasDestPath: 'assets/tree.png',
    });
    expect(layout.walkFrameCount).toBeNull();
    expect(layout.ambientFrameCount).toBe(3);
    expect(layout.tracks.ambient).toEqual(span(1, 3, 1));
    expect(runtimeContractMismatch(geometry, { ambientFrameCount: 3 })).toBeNull();
    expect(runtimeContractMismatch(geometry, { ambientFrameCount: 4 })).toMatch(/3 ambient frames.*expects 4/);
  });
});
