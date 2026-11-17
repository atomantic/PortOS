/**
 * Sprites — the published atlas layout sidecar and the runtime-contract check
 * (#2982).
 *
 * The atlas PNG is the entire export, so consuming apps would hardcode the grid
 * and a 12-frame publish (#2970) would silently shift every column they read.
 *
 * - `buildAtlasLayout` produces `<atlas-stem>.layout.json` beside the PNG so the
 *   app resolves columns BY NAME and verifies `sourceAtlasSha256`. A per-track
 *   column span (`tracks`) makes new tracks additive; each span states its
 *   `rows` (#3017), so a non-directional track is read from row 0 regardless of facing.
 * - `runtimeContractMismatch` compares compiled geometry against the app's
 *   `publishBinding.runtimeContract` so an unconsumable publish is refused with
 *   both numbers named.
 *
 * Playback speed is deliberately NOT part of the contract (distance-driven
 * consumers have no fps concept): the authoring fps rides along as `previewFps`,
 * labeled as metadata the consumer must ignore.
 *
 * Pure and free of the image graph (no sharp, fs or state): publish.js builds
 * the payload before taking any write lock. Span math lives in `atlasGrid.js`
 * (#3016) because the compiler that writes the grid imports sharp. A span is
 * named for its registry id (#3015) and persisted by the compiler; `deriveTracks`
 * prefers it, and only a legacy grid (pre-#3016 or imported) mints a name from a
 * column label, which keeps a pre-#2986 `scanner` placeholder describable.
 */

import { basename } from 'path';
import { deriveTracks, resolveWalkFrameCount, ATLAS_DEFAULT_ROWS } from './atlasGrid.js';
import { WALK_TRACK } from './animationTracks.js';
// #3152: the default table is the EFFECTIVE registry (compiled `walk` + user
// store). Load-bearing: the contract check iterates it for each track's
// `contractFrameCountField`, so a compiled-only default would silently skip
// scanner/ambient/user tracks and let a mismatched atlas publish. Sharp-free.
import { getEffectiveAnimationTracks } from './animationTrackStore.js';

// Bump only on a breaking shape change; added fields and tracks are additive.
export const ATLAS_LAYOUT_SCHEMA_VERSION = 1;
export const ATLAS_LAYOUT_KIND = 'portos-sprite-atlas-layout';

// Stated inside the file so the "do not animate from this" rule travels with it.
export const PREVIEW_FPS_NOTE = 'Authoring metadata only — the speed PortOS previews this walk at. '
  + 'The consuming app determines real playback (e.g. from movement distance); do not use this as a runtime frame rate.';

/**
 * Sidecar path for a published atlas: `…/hero-atlas.png` → `…/hero-atlas.layout.json`.
 * A non-`.png` name keeps its full name plus the suffix instead of truncating.
 */
export function layoutSidecarPath(atlasDestPath) {
  const stem = atlasDestPath.replace(/\.png$/i, '');
  return `${stem}.layout.json`;
}

/**
 * Build the layout sidecar payload for a compiled atlas. Deliberately carries NO
 * publish timestamp: the payload is a pure function of the atlas bytes and
 * geometry, so an unchanged republish is byte-identical (publish compares bytes).
 */
export function buildAtlasLayout({
  characterId, geometry, atlasSha256, version, atlasDestPath,
}, animationTracks = getEffectiveAnimationTracks()) {
  const columns = geometry?.columns;
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error('Compiled atlas geometry has no column list');
  }
  const walkFrameCount = resolveWalkFrameCount(geometry);
  // The grid's real height, not the canonical eight.
  const rows = geometry.rows ?? (Array.isArray(geometry.directionOrder) ? geometry.directionOrder.length : null);
  return {
    schemaVersion: ATLAS_LAYOUT_SCHEMA_VERSION,
    kind: ATLAS_LAYOUT_KIND,
    characterId,
    // Basename only: the sidecar sits beside the atlas.
    atlasFile: basename(atlasDestPath),
    atlasVersion: version ?? null,
    sourceAtlasSha256: atlasSha256,
    cellSize: geometry.cellSize ?? null,
    rows,
    rowOrder: Array.isArray(geometry.directionOrder) ? [...geometry.directionOrder] : null,
    columns: [...columns],
    columnCount: columns.length,
    // Prefer the compiler's persisted descriptor (#3016; the only thing that can
    // describe tracks of differing length), else legacy column-name derivation.
    // No usable row count falls back to the canonical eight, stated explicitly.
    tracks: deriveTracks(columns, walkFrameCount, geometry.tracks ?? null, rows ?? ATLAS_DEFAULT_ROWS),
    walkFrameCount,
    // Each track publishes the top-level field its runtime contract declares;
    // walkFrameCount and seeded scanner/ambient keep their historical names/order.
    ...Object.fromEntries(Object.values(animationTracks).flatMap((definition) => {
      const direct = geometry[definition.contractFrameCountField];
      // Atlases kept by the compiler's idempotent path may lack the convenience
      // field; the persisted span has the same count, avoiding a recompile.
      const value = Number.isInteger(direct) ? direct : geometry.tracks?.[definition.id]?.count;
      return Number.isInteger(value) ? [[definition.contractFrameCountField, value]] : [];
    })),
    previewFps: Number.isFinite(geometry.walkFps) ? geometry.walkFps : null,
    previewFpsNote: PREVIEW_FPS_NOTE,
  };
}

/**
 * Compare compiled atlas geometry against an app's declared runtime contract.
 * Returns `null` when they agree or no contract was declared (publishes
 * unchecked), otherwise a message naming BOTH numbers and how to resolve it.
 * Callers pass describable geometry; publish.js asserts that up front.
 */
export function runtimeContractMismatch(
  geometry,
  contract,
  appLabel = 'the bound app',
  tracks = getEffectiveAnimationTracks(),
) {
  if (!contract) return null;

  const actualColumns = geometry.columns.length;
  const { columnCount: expectedColumns, cellSize: expectedCellSize } = contract;

  for (const definition of Object.values(tracks)) {
    const expected = contract[definition.contractFrameCountField];
    if (!Number.isInteger(expected)) continue;
    const direct = geometry[definition.contractFrameCountField];
    const spanCount = geometry.tracks?.[definition.id]?.count;
    // Walk alone predates the per-track descriptor and keeps its imported-grid column fallback.
    const actual = definition.id === WALK_TRACK
      ? resolveWalkFrameCount(geometry)
      : (Number.isInteger(direct) ? direct : (Number.isInteger(spanCount) ? spanCount : null));
    if (expected === actual) continue;
    return `Atlas has ${actual ?? 'no'} ${definition.label.toLowerCase()} frame${actual === 1 ? '' : 's'} but ${appLabel} expects ${expected}. `
      + `Approve the ${definition.label.toLowerCase()} set at that frame count, or update the app runtime contract before publishing.`;
  }
  if (Number.isInteger(expectedColumns) && expectedColumns !== actualColumns) {
    return `Atlas has ${actualColumns} columns but ${appLabel} expects ${expectedColumns}. `
      + `The grid shape changed — update the app's expected column layout, or re-bind its runtime contract to ${actualColumns} columns before publishing.`;
  }
  if (Number.isInteger(expectedCellSize) && expectedCellSize !== geometry.cellSize) {
    return `Atlas cells are ${geometry.cellSize}px but ${appLabel} expects ${expectedCellSize}px. `
      + `Recompile this atlas at ${expectedCellSize}px cells, or update the app's cell-size constant before publishing.`;
  }
  return null;
}
