/**
 * Sprites — the published atlas layout sidecar and the runtime-contract check
 * (issue #2982).
 *
 * The atlas PNG is the entire export: the compile manifest never leaves
 * `data/`, so a consuming app has had to hardcode the grid (idle at column 0,
 * walk phases from column 1, the frame count baked in as a constant). That
 * held by construction while every walk was 8 frames; since the count became
 * authorable (#2970) a 12-frame publish silently shifts every column the app
 * reads — no crash, no log, just the wrong pixels.
 *
 * Two pieces close that gap:
 *
 * - `buildAtlasLayout` produces the `<atlas-stem>.layout.json` sidecar written
 *   beside the published PNG, so the app can resolve columns BY NAME and
 *   verify the atlas it loaded is the one the layout describes
 *   (`sourceAtlasSha256`). Alongside the flat `columns` list it carries a
 *   per-track column span (`tracks`), so a future multi-frame scanner action or
 *   an ambient loop is an additive track rather than a v2 rewrite.
 * - `runtimeContractMismatch` compares compiled geometry against the optional
 *   `publishBinding.runtimeContract` the app declared, so a publish the app
 *   cannot consume is refused with both numbers named instead of shipping.
 *
 * Playback speed is deliberately NOT part of the contract. Distance-driven
 * consumers (the reference case advances the walk per unit of movement) have
 * no animation-fps concept at all, so PortOS's authoring fps is preview-only:
 * it rides along as `previewFps`, explicitly labeled as authoring metadata the
 * consumer must ignore.
 *
 * Pure and dependency-free (no image graph, no state): publish.js builds the
 * payload before taking any write lock, and the shape is unit-testable on its
 * own.
 */

import { basename } from 'path';
import { ATLAS_IDLE_COLUMN, ATLAS_SCANNER_COLUMN } from './walkBounds.js';

// Bump only on a breaking shape change. Adding a field (or a new track) is
// additive — consumers read `tracks`/`columns` by name, not by position.
export const ATLAS_LAYOUT_SCHEMA_VERSION = 1;
export const ATLAS_LAYOUT_KIND = 'portos-sprite-atlas-layout';

// Stated inside the file the app reads, so the "do not animate from this"
// rule travels with the value instead of living only in our docs.
export const PREVIEW_FPS_NOTE = 'Authoring metadata only — the speed PortOS previews this walk at. '
  + 'The consuming app determines real playback (e.g. from movement distance); do not use this as a runtime frame rate.';

const WALK_TRACK = 'walk';

/**
 * Sidecar path for a published atlas: `…/hero-atlas.png` →
 * `…/hero-atlas.layout.json`. The binding schema already forces a `.png`
 * destination; anything else keeps its full name plus the suffix rather than
 * silently truncating an unexpected extension.
 */
export function layoutSidecarPath(atlasDestPath) {
  const stem = atlasDestPath.replace(/\.png$/i, '');
  return `${stem}.layout.json`;
}

/**
 * The walk-phase columns of a compiled grid: everything that is neither the
 * idle anchor nor the scanner placeholder. Derived from the ACTUAL column
 * names rather than from `walkPhaseLabels(count)`, so a grid whose columns are
 * positional (`frame-00…`) groups into one walk span just like the named
 * 8-frame gait phases — and so a scanner-less grid (#2986) still resolves.
 */
const walkColumnsOf = (columns) =>
  columns.filter((c) => c !== ATLAS_IDLE_COLUMN && c !== ATLAS_SCANNER_COLUMN);

/**
 * Walk frame count for a compiled atlas. Pointers written before #2970 have no
 * `walkFrameCount`, so fall back to counting the walk columns themselves.
 */
export function resolveWalkFrameCount(geometry) {
  if (Number.isInteger(geometry?.walkFrameCount)) return geometry.walkFrameCount;
  if (!Array.isArray(geometry?.columns)) return null;
  return walkColumnsOf(geometry.columns).length;
}

/**
 * Group the flat column list into named tracks of contiguous column spans:
 * `{ idle: { start: 0, count: 1 }, walk: { start: 1, count: 8 }, … }`. The walk
 * track is the `walkFrameCount` columns following the idle anchor — positional,
 * per the grid contract, so it doesn't care whether those columns carry named
 * gait phases or positional `frame-NN` labels. Every other column becomes a
 * track of its own named for the column, so a future four-frame scanner action
 * lands as `scanner: { start, count: 4 }` with no shape change on either side
 * of the boundary.
 */
export function deriveTracks(columns, walkFrameCount) {
  const walkStart = columns[0] === ATLAS_IDLE_COLUMN ? 1 : 0;
  const walkEnd = walkStart + (Number.isInteger(walkFrameCount) ? walkFrameCount : 0);
  const tracks = {};
  columns.forEach((column, index) => {
    const name = index >= walkStart && index < walkEnd ? WALK_TRACK : column;
    const existing = tracks[name];
    if (!existing) {
      tracks[name] = { start: index, count: 1 };
      return;
    }
    if (existing.start + existing.count !== index) {
      // A track split across non-adjacent columns can't be described as a
      // span — refuse rather than emit a layout that lies about the grid.
      throw new Error(`Atlas column "${column}" repeats non-contiguously — the grid cannot be described as tracks`);
    }
    existing.count += 1;
  });
  return tracks;
}

/**
 * Build the layout sidecar payload for a compiled atlas.
 *
 * Deliberately carries NO publish timestamp: the payload is a pure function of
 * the atlas bytes and their geometry, so an unchanged republish produces
 * byte-identical content and the sidecar write stays idempotent (the publish
 * path compares hashes to decide whether anything actually changed).
 */
export function buildAtlasLayout({
  characterId, geometry, atlasSha256, version, atlasDestPath,
}) {
  const columns = geometry?.columns;
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error('Compiled atlas geometry has no column list');
  }
  const walkFrameCount = resolveWalkFrameCount(geometry);
  return {
    schemaVersion: ATLAS_LAYOUT_SCHEMA_VERSION,
    kind: ATLAS_LAYOUT_KIND,
    characterId,
    // Basename only: the sidecar sits beside the atlas, so a repo-relative
    // path would just be a second copy of where the reader already is.
    atlasFile: basename(atlasDestPath),
    atlasVersion: version ?? null,
    sourceAtlasSha256: atlasSha256,
    cellSize: geometry.cellSize ?? null,
    rows: geometry.rows ?? (Array.isArray(geometry.directionOrder) ? geometry.directionOrder.length : null),
    rowOrder: Array.isArray(geometry.directionOrder) ? [...geometry.directionOrder] : null,
    columns: [...columns],
    columnCount: columns.length,
    tracks: deriveTracks(columns, walkFrameCount),
    walkFrameCount,
    previewFps: Number.isFinite(geometry.walkFps) ? geometry.walkFps : null,
    previewFpsNote: PREVIEW_FPS_NOTE,
  };
}

/**
 * Compare compiled atlas geometry against an app's declared runtime contract.
 * Returns `null` when they agree (or when no contract was declared — an absent
 * contract publishes unchecked, exactly as before this existed), otherwise a
 * message naming BOTH the actual and expected numbers and the two ways to
 * resolve the disagreement.
 *
 * Callers pass describable geometry (a column list); publish.js asserts that
 * once, up front, for both this and `buildAtlasLayout`.
 */
export function runtimeContractMismatch(geometry, contract, appLabel = 'the bound app') {
  if (!contract) return null;

  const actualColumns = geometry.columns.length;
  const actualFrames = resolveWalkFrameCount(geometry);
  const { walkFrameCount: expectedFrames, columnCount: expectedColumns, cellSize: expectedCellSize } = contract;
  const actualDesc = `Atlas has ${actualColumns} columns (${actualFrames} walk frames)`;
  const expectedDesc = Number.isInteger(expectedColumns)
    ? `${expectedColumns} (${expectedFrames} walk frames)`
    : `${expectedFrames} walk frames`;
  const countMismatch = (resolution) => `${actualDesc} but ${appLabel} expects ${expectedDesc}. ${resolution}`;

  if (Number.isInteger(expectedFrames) && expectedFrames !== actualFrames) {
    return countMismatch(
      `Update the game's walk-frame constant and its cycle distance, or reprocess this walk set to ${expectedFrames} frames before publishing.`,
    );
  }
  if (Number.isInteger(expectedColumns) && expectedColumns !== actualColumns) {
    return countMismatch(
      `The grid shape changed — update the app's expected column layout, or re-bind its runtime contract to ${actualColumns} columns before publishing.`,
    );
  }
  if (Number.isInteger(expectedCellSize) && expectedCellSize !== geometry.cellSize) {
    return `Atlas cells are ${geometry.cellSize}px but ${appLabel} expects ${expectedCellSize}px. `
      + `Recompile this atlas at ${expectedCellSize}px cells, or update the app's cell-size constant before publishing.`;
  }
  return null;
}
