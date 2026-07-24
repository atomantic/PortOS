/**
 * Atlas layout sidecar + runtime-contract comparison (#2982). Pure module —
 * no fs, no compiler; publish.test.js owns the write/serialization side.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAtlasLayout, deriveTracks, layoutSidecarPath, resolveWalkFrameCount,
  runtimeContractMismatch, ATLAS_LAYOUT_SCHEMA_VERSION,
} from './atlasLayout.js';
import { walkPhaseLabels } from './walkBounds.js';

const DIRECTIONS = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'];
const geometryFor = (walkFrameCount, overrides = {}) => ({
  columns: ['idle', ...walkPhaseLabels(walkFrameCount), 'scanner'],
  directionOrder: DIRECTIONS,
  rows: DIRECTIONS.length,
  cellSize: 96,
  walkFrameCount,
  walkFps: 10,
  ...overrides,
});

describe('layoutSidecarPath', () => {
  it('swaps the .png extension for .layout.json', () => {
    expect(layoutSidecarPath('assets/sprites/hero/hero-atlas.png'))
      .toBe('assets/sprites/hero/hero-atlas.layout.json');
    expect(layoutSidecarPath('assets/HERO.PNG')).toBe('assets/HERO.layout.json');
  });
});

describe('resolveWalkFrameCount', () => {
  it('prefers the declared count and falls back to counting non-anchor columns', () => {
    expect(resolveWalkFrameCount(geometryFor(12))).toBe(12);
    // Pre-#2970 pointers carry no walkFrameCount.
    expect(resolveWalkFrameCount({ columns: ['idle', 'a', 'b', 'c', 'scanner'] })).toBe(3);
    // A scanner-less grid (#2986) still resolves.
    expect(resolveWalkFrameCount({ columns: ['idle', 'a', 'b'] })).toBe(2);
    expect(resolveWalkFrameCount({})).toBeNull();
  });
});

describe('deriveTracks', () => {
  it('collapses walk-phase columns into one span and gives every other column its own', () => {
    const columns = ['idle', ...walkPhaseLabels(6), 'scanner'];
    expect(deriveTracks(columns, walkPhaseLabels(6))).toEqual({
      idle: { start: 0, count: 1 },
      walk: { start: 1, count: 6 },
      scanner: { start: 7, count: 1 },
    });
  });

  it('describes a future multi-frame track as a span', () => {
    const columns = ['idle', 'w0', 'w1', 'scan-a', 'scan-a', 'scan-a'];
    expect(deriveTracks(columns, ['w0', 'w1'])).toEqual({
      idle: { start: 0, count: 1 },
      walk: { start: 1, count: 2 },
      'scan-a': { start: 3, count: 3 },
    });
  });

  it('refuses a grid whose track columns are not contiguous', () => {
    expect(() => deriveTracks(['idle', 'scanner', 'idle'], [])).toThrow(/non-contiguously/);
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
      walkLabels: walkPhaseLabels(8),
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
      columnCount: 10,
      walkFrameCount: 8,
      previewFps: 10,
    });
    expect(layout.tracks.walk).toEqual({ start: 1, count: 8 });
    expect(layout.previewFpsNote).toMatch(/do not use this as a runtime frame rate/);
    // No timestamp: identical geometry must produce byte-identical content so
    // an unchanged republish stays a no-op.
    expect(JSON.stringify(layout)).not.toMatch(/publishedAt/);
  });

  it('refuses geometry with no column list', () => {
    expect(() => buildAtlasLayout({ characterId: 'x', geometry: {}, atlasDestPath: 'a.png' }))
      .toThrow(/no column list/);
  });
});

describe('runtimeContractMismatch', () => {
  const contract = { walkFrameCount: 8, cellSize: 96, columnCount: 10 };

  it('passes an absent contract and a matching one', () => {
    expect(runtimeContractMismatch(geometryFor(12), null)).toBeNull();
    expect(runtimeContractMismatch(geometryFor(12), undefined)).toBeNull();
    expect(runtimeContractMismatch(geometryFor(8), contract)).toBeNull();
  });

  it('names both counts and both resolutions on a frame-count mismatch', () => {
    const result = runtimeContractMismatch(geometryFor(12), contract, 'Example App');
    expect(result.code).toBe('PUBLISH_CONTRACT_MISMATCH');
    expect(result.message).toContain('Atlas has 14 columns (12 walk frames)');
    expect(result.message).toContain('Example App expects 10 (8 walk frames)');
    expect(result.message).toMatch(/walk-frame constant/);
    expect(result.message).toMatch(/reprocess this walk set to 8 frames/);
  });

  it('flags a column-count-only mismatch as a grid-shape change', () => {
    // The scanner column removed (#2986) against a contract that still expects it.
    const geometry = { columns: ['idle', ...walkPhaseLabels(8)], cellSize: 96, walkFrameCount: 8 };
    const result = runtimeContractMismatch(geometry, contract, 'Example App');
    expect(result.message).toContain('Atlas has 9 columns (8 walk frames)');
    expect(result.message).toMatch(/grid shape changed/);
  });

  it('flags a cell-size mismatch', () => {
    const result = runtimeContractMismatch(geometryFor(8, { cellSize: 64 }), contract, 'Example App');
    expect(result.message).toBe(
      'Atlas cells are 64px but Example App expects 96px. '
      + "Recompile this atlas at 96px cells, or update the app's cell-size constant before publishing.",
    );
  });

  it('refuses to vouch for geometry it cannot read', () => {
    expect(runtimeContractMismatch({}, contract).code).toBe('ATLAS_GEOMETRY_UNKNOWN');
  });
});
