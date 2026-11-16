/**
 * Sprites — the atlas grid: column spans, per-track uniformity, and the
 * up-to-date comparison (issue #3016).
 *
 * The grid expresses **variable-length column spans** per track, with uniformity a
 * *within-track* rule (all facings of one track share a row width), so a short action
 * track can sit beside a long walk. It owns what the write side (atlas.js) and the
 * describe side (atlasLayout.js) must never disagree about:
 *
 * - **`buildAtlasGrid`**: `idle` is column 0, then each track's columns in registry
 *   order, yielding the flat `columns` list and the `{ start, count, rows }` `tracks`
 *   descriptor of the published `layout.json` sidecar (#2982).
 * - **`resolveTrackUniformity`**: one track's frame count / fps from its per-direction
 *   rows, asserting the facings agree. It never compares tracks and range-checks
 *   against the *named track's* registry row (#3015), not global walk constants.
 * - **`deriveTracks` / `compiledGridUpToDate`**: read a persisted grid back, including
 *   legacy shapes (no `tracks` field, a pre-#2986 `scanner` column, no `walkFrameCount`).
 *
 * **Sharp-free leaf**, like `animationTracks.js` and `walkBounds.js`: atlas.js imports
 * sharp and atlasLayout.js must not, so the one column-span definition lives below both.
 * Nothing here touches fs, state, or the image graph.
 *
 * **Rows are per-track (#3017).** A directional track takes one row per facing; a
 * NON-directional one (tree in wind, lamp) takes row 0 and leaves the rest of its span
 * transparent, hence `rows` on every span and `trackDirections`. Still ONE rectangular
 * atlas per record (transparent cells cost little; a second atlas doubles the publish
 * surface). Only the GRID and COMPILE layer generalized: authoring (`walk.js`'s
 * `allApproved`, `reference.js`'s eight anchors) stays eight-shaped until #3045. A
 * persisted span with NO `rows` reads as full-height so pre-#3017 atlases stay idempotent.
 *
 * **Only `walk` is COMPILED IN**; every other row (incl. seeded `scanner`/`ambient`)
 * comes from the user-defined store (#3152), so the default `tracks` table is
 * `getEffectiveAnimationTracks()`. The registry table is the injection seam (like
 * `assertAnimationTrackRows(tracks)`), so tests use a synthetic table that passes through
 * the real lookup, ordering and unknown-id boundary.
 */

import { WALK_TRACK, getAnimationTrack, trackRowCount } from './animationTracks.js';
// Supplies the default `tracks` table (#3152); defaults evaluate per CALL, so the store
// is read on first use, not at module load.
import { getEffectiveAnimationTracks } from './animationTrackStore.js';
// These two names describe columns found in imported/legacy compiled grids;
// neither declares an animation track in the registry.
import { ATLAS_IDLE_COLUMN, ATLAS_SCANNER_COLUMN, walkPhaseLabels } from './walkBounds.js';
import { SPRITE_DIRECTIONS } from './prompts.js';
import { canonicalStringify } from '../../lib/objects.js';

/**
 * Height of every atlas this compiler emits: one row per canonical facing. Not a
 * threaded parameter: only a PERSISTED geometry (`geometry.rows`) can differ, so only
 * its readers (`deriveTracks`, `compiledGridUpToDate`) take a row count; a knob on the
 * producers would be a second, disagreeing source for one number.
 */
export const ATLAS_DEFAULT_ROWS = SPRITE_DIRECTIONS.length;

/**
 * The facings one track occupies: all of them for a directional track, just the first
 * (row 0) for a non-directional one. Stops `validateForCompile` and the uniformity check
 * assuming eight facings per track (#3017); authoring stays eight-shaped until #3045.
 */
export function trackDirections(trackId, directions = SPRITE_DIRECTIONS, tracks = getEffectiveAnimationTracks()) {
  if (!Array.isArray(directions) || !directions.length) {
    throw new Error(`Atlas track '${trackId}' needs a non-empty direction list`);
  }
  const rows = trackRowCount(trackId, directions.length, tracks);
  return rows === directions.length ? [...directions] : directions.slice(0, rows);
}

/**
 * Column labels for one track's span. The walk track keeps its historical labels (named
 * gait phases at 8 frames, `frame-NN` otherwise) so existing atlases round-trip
 * byte-identically. Every OTHER track namespaces with its id (`scanner-00`): positional
 * labels are per-track, so two four-frame tracks would emit duplicate names in the flat
 * `columns` list that consumers resolve BY NAME
 * (docs/features/sprite-export-contract.md).
 */
export function trackColumnLabels(trackId, frameCount) {
  // Structural bound only (at least one column); authoring limits live in the registry
  // and resolveTrackUniformity.
  if (!Number.isInteger(frameCount) || frameCount < 1) {
    throw new Error(`Atlas track '${trackId}' needs a positive integer frame count, got ${frameCount}`);
  }
  if (trackId === WALK_TRACK) return walkPhaseLabels(frameCount);
  return Array.from({ length: frameCount }, (_, i) => `${trackId}-${String(i).padStart(2, '0')}`);
}

/**
 * Build the atlas grid from track specs (`{ id, frameCount }`) as `{ columns, tracks }`,
 * `tracks` mapping each id to its contiguous `{ start, count, rows }` span, consistent
 * by construction so PNG width and sidecar spans can't drift. `rows` is the facings the
 * track occupies (#3017).
 *
 * `idle` is always column 0, described as its own track. Specs are sorted into registry
 * order rather than trusted in call order, and an unknown id is refused through
 * `getAnimationTrack`'s boundary. The registry TABLE is the injection seam (the
 * `assertAnimationTrackRows(tracks)` idiom) so tests need no boundary-bypassing lookup.
 */
export function buildAtlasGrid(specs, tracks = getEffectiveAnimationTracks()) {
  if (!Array.isArray(specs) || !specs.length) {
    throw new Error('Atlas grid needs at least one animation track');
  }
  const order = Object.keys(tracks);
  const seen = new Set();
  for (const spec of specs) {
    const id = spec?.id;
    if (typeof id !== 'string' || !id) throw new Error('Atlas grid track spec needs an id');
    if (id === ATLAS_IDLE_COLUMN) {
      throw new Error(`Atlas grid cannot register a track named '${ATLAS_IDLE_COLUMN}' — the idle anchor owns that column`);
    }
    if (seen.has(id)) throw new Error(`Atlas grid lists track '${id}' twice`);
    seen.add(id);
    getAnimationTrack(id, tracks);
  }

  const ordered = [...specs].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const trackRows = ordered.map((spec) => trackRowCount(spec.id, ATLAS_DEFAULT_ROWS, tracks));

  // idle spans as many rows as the tallest track present, not unconditionally full height:
  // a record with only a non-directional track has one facing of pose, and promising eight
  // would claim rows nothing writes. Inserted FIRST so key order matches column order.
  const columns = [ATLAS_IDLE_COLUMN];
  const spans = { [ATLAS_IDLE_COLUMN]: { start: 0, count: 1, rows: Math.max(...trackRows) } };
  ordered.forEach((spec, i) => {
    // Labels and row height are DERIVED (registry `directional` flag), never supplied, so
    // the builder can't be handed a mismatch to reconcile.
    const labels = trackColumnLabels(spec.id, spec.frameCount);
    spans[spec.id] = { start: columns.length, count: labels.length, rows: trackRows[i] };
    columns.push(...labels);
  });
  return { columns, tracks: spans };
}

/**
 * The walk-phase columns of a compiled grid: everything but the idle anchor and a legacy
 * scanner placeholder. Derived from ACTUAL column names so positional (`frame-00…`) grids
 * group like the named 8-frame phases. Pre-#2986 grids still carry a scanner column; it
 * stays filtered or their walk-frame count would be one too high.
 */
const walkColumnsOf = (columns) =>
  columns.filter((c) => c !== ATLAS_IDLE_COLUMN && c !== ATLAS_SCANNER_COLUMN);

/**
 * Walk frame count for a compiled atlas: `walkFrameCount` (absent before #2970), else the
 * track descriptor, else counting walk columns. The descriptor wins over counting because
 * with several tracks (#3018) the column count over-reports (`walk:{1,12}` + `scanner:{13,4}`
 * would read 16) and a character with only another track would publish a fabricated walk
 * length.
 */
export function resolveWalkFrameCount(geometry) {
  if (Number.isInteger(geometry?.walkFrameCount)) return geometry.walkFrameCount;
  // A PRESENT descriptor is authoritative: if it names no walk track the answer is "none".
  // Only an ABSENT one falls through to counting columns.
  if (geometry?.tracks && typeof geometry.tracks === 'object' && !Array.isArray(geometry.tracks)) {
    const span = geometry.tracks[WALK_TRACK];
    return Number.isInteger(span?.count) ? span.count : null;
  }
  if (!Array.isArray(geometry?.columns)) return null;
  return walkColumnsOf(geometry.columns).length;
}

/**
 * Validate a persisted `tracks` descriptor against the column list it claims to
 * describe. Returns `{ tracks }` or `{ error }`, never throws, so the idempotency
 * predicate can treat an undescribable grid as "not provably up to date" while
 * `deriveTracks` makes it a loud failure.
 *
 * A present descriptor must tile the columns exactly (contiguous, non-overlapping,
 * covering all), else a consumer is pointed at the wrong pixels (#2982). `rows` is
 * normalized: absent means full-height (pre-#3017), present is range-checked against the
 * grid's real height.
 */
function validateCompiledTracks(compiled, columns, directionCount) {
  const entries = Object.entries(compiled);
  if (!entries.length) {
    return { error: `Atlas track descriptor is empty but the grid has ${columns.length} columns` };
  }
  for (const [id, span] of entries) {
    if (!Number.isInteger(span?.start) || !Number.isInteger(span?.count)) {
      return { error: `Atlas track "${id}" needs integer start/count` };
    }
    if (span.count < 1) return { error: `Atlas track "${id}" spans ${span.count} columns` };
    if (span.start < 0 || span.start + span.count > columns.length) {
      return { error: `Atlas track "${id}" spans columns ${span.start}–${span.start + span.count - 1}, outside the ${columns.length}-column grid` };
    }
    // Absent is legal (legacy = full height); present must be a real row count.
    if (span.rows !== undefined && span.rows !== null
      && (!Number.isInteger(span.rows) || span.rows < 1 || span.rows > directionCount)) {
      return { error: `Atlas track "${id}" claims ${span.rows} rows, outside the ${directionCount}-row grid` };
    }
  }
  const sorted = [...entries].sort((a, b) => a[1].start - b[1].start);
  let cursor = 0;
  const tracks = {};
  for (const [id, span] of sorted) {
    if (span.start !== cursor) {
      return { error: `Atlas track "${id}" starts at column ${span.start} but the previous track ends at ${cursor} — the grid is not tiled by its tracks` };
    }
    cursor += span.count;
    tracks[id] = {
      start: span.start,
      count: span.count,
      rows: Number.isInteger(span.rows) ? span.rows : directionCount,
    };
  }
  if (cursor !== columns.length) {
    return { error: `Atlas tracks describe ${cursor} of ${columns.length} columns` };
  }
  return { tracks };
}

/**
 * Group a compiled grid into named tracks of contiguous column spans:
 * `{ idle: { start: 0, count: 1, rows: 8 }, walk: { start: 1, count: 8, rows: 8 } }`.
 *
 * `compiledTracks` (the persisted manifest descriptor) is authoritative when **present**.
 * When **absent** (`undefined`/`null`, pre-#3016) fall back to the historical derivation:
 * the `walkFrameCount` columns after idle are walk and every other column is its own
 * named track. Absent and present-but-empty differ: `{}` fails to describe the grid and
 * is rejected, not re-derived.
 */
export function deriveTracks(columns, walkFrameCount, compiledTracks = null, directionCount = ATLAS_DEFAULT_ROWS) {
  const described = describeTracks(columns, walkFrameCount, compiledTracks, directionCount);
  if (described.error) throw new Error(described.error);
  return described.tracks;
}

/** Non-throwing `deriveTracks` — `{ tracks }` or `{ error }`. */
function describeTracks(columns, walkFrameCount, compiledTracks = null, directionCount = ATLAS_DEFAULT_ROWS) {
  if (!Array.isArray(columns) || !columns.length) {
    return { error: 'Compiled atlas geometry has no column list' };
  }
  if (!Number.isInteger(directionCount) || directionCount < 1) {
    return { error: `Compiled atlas geometry has no usable row count (got ${directionCount})` };
  }
  if (compiledTracks !== null && compiledTracks !== undefined) {
    if (typeof compiledTracks !== 'object' || Array.isArray(compiledTracks)) {
      return { error: 'Atlas track descriptor must be an object of column spans' };
    }
    return validateCompiledTracks(compiledTracks, columns, directionCount);
  }

  const walkStart = columns[0] === ATLAS_IDLE_COLUMN ? 1 : 0;
  const walkEnd = walkStart + (Number.isInteger(walkFrameCount) ? walkFrameCount : 0);
  const tracks = {};
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index];
    const name = index >= walkStart && index < walkEnd ? WALK_TRACK : column;
    const existing = tracks[name];
    if (!existing) {
      // Legacy grids predate non-directional tracks, so every derived span is full height.
      tracks[name] = { start: index, count: 1, rows: directionCount };
      continue;
    }
    if (existing.start + existing.count !== index) {
      // A track split across non-adjacent columns can't be described as a
      // span — refuse rather than emit a layout that lies about the grid.
      return { error: `Atlas column "${column}" repeats non-contiguously — the grid cannot be described as tracks` };
    }
    existing.count += 1;
  }
  return { tracks };
}

/**
 * True when a persisted pointer geometry describes exactly the grid this compile would
 * emit (the pre-pixel idempotency test). Beyond cell metrics (#2986) and the column list,
 * the **track set** joins the comparison: re-partitioning the same columns into different
 * tracks is a different grid and must recompile.
 *
 * The persisted side is read through `describeTracks`, not compared raw, so a pointer
 * predating `tracks` (#3016) stays idempotent; an undescribable grid is "not provably up
 * to date" and recompiles.
 */
export function compiledGridUpToDate(current, expected) {
  if (!current || !expected) return false;
  if (current.cellSize !== expected.cellSize) return false;
  if (JSON.stringify(current.pivot) !== JSON.stringify(expected.pivot)) return false;
  if (current.targetMaxHeight !== expected.targetMaxHeight) return false;
  if (current.targetMaxWidth !== expected.targetMaxWidth) return false;
  if (JSON.stringify(current.columns) !== JSON.stringify(expected.columns)) return false;
  // Described, not compared raw, so pointers predating `rows` (#3017) or `tracks` (#3016)
  // stay idempotent. Height comes from the POINTER's own `geometry.rows`, which
  // atlasLayout.js also reads, so the two consumers can't disagree.
  const described = describeTracks(
    current.columns,
    resolveWalkFrameCount(current),
    current.tracks ?? null,
    Number.isInteger(current.rows) ? current.rows : ATLAS_DEFAULT_ROWS,
  );
  if (described.error) return false;
  // canonicalStringify, NOT JSON.stringify: the two sides come from producers with
  // different key-insertion orders, and an order-sensitive compare would report "not up to
  // date" forever and rerun the pixel pipeline on every compile.
  return canonicalStringify(described.tracks) === canonicalStringify(expected.tracks);
}

/**
 * Resolve one track's frame count and playback fps from its per-direction rows,
 * asserting every facing agrees.
 *
 * **Uniformity is within-track**: all rows of a track share its column span, but
 * different tracks may differ in length and speed (#3016). The range check reads the named
 * track's own registry row (#3015), not global walk constants.
 *
 * **Row count is per-track too (#3017)**: a directional track needs every facing, a
 * non-directional one exactly one, and a mismatch is refused here instead of yielding a
 * half-empty atlas. `expectedRows` is passed in rather than re-derived from a grid height.
 *
 * `rows` are `{ direction, frameCount, declaredFrameCount, fps }`. The registry `tracks`
 * table is the injection seam (as in `buildAtlasGrid`); `error` is injectable so this leaf
 * avoids the error-handler import (callers pass the 422-shaped `compileError`).
 * `defaultFps` keeps manifests predating the fps field resolving to their old value.
 * Returns `{ id, frameCount, fps }`, not column labels, which `buildAtlasGrid` derives.
 */
export function resolveTrackUniformity(trackId, rows, {
  tracks = getEffectiveAnimationTracks(),
  trackRow = getAnimationTrack(trackId, tracks),
  error = (message) => new Error(message),
  defaultFps = trackRow.defaultFps,
  expectedRows = trackRowCount(trackId, ATLAS_DEFAULT_ROWS, tracks),
} = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    throw error(`Track ${trackId} has no directions to compile`);
  }
  if (rows.length !== expectedRows) {
    throw error(
      `Track ${trackId} occupies ${expectedRows} atlas ${expectedRows === 1 ? 'row' : 'rows'} `
      + `but ${rows.length} ${rows.length === 1 ? 'was' : 'were'} supplied`,
    );
  }
  let frameCount = null;
  let fps = null;
  for (const row of rows) {
    const { direction } = row;
    if (frameCount === null) {
      frameCount = row.frameCount;
      if (!Number.isInteger(frameCount)
        || frameCount < trackRow.minFrameCount || frameCount > trackRow.maxFrameCount) {
        throw error(`Direction ${direction} has ${row.frameCount} frames — outside the supported ${trackRow.minFrameCount}–${trackRow.maxFrameCount} range`);
      }
    } else if (row.frameCount !== frameCount) {
      throw error(`Direction ${direction} has ${row.frameCount} frames but the set uses ${frameCount} — reprocess all directions to the same frame count before compiling`);
    }
    if (Number.isInteger(row.declaredFrameCount) && row.declaredFrameCount !== row.frameCount) {
      throw error(`Direction ${direction} manifest declares ${row.declaredFrameCount} frames but carries ${row.frameCount}`);
    }
    // Playback fps must also agree across directions (one speed per track), range-checked;
    // no frameRate falls back to the legacy default.
    const rowFps = Number.isFinite(row.fps) ? row.fps : defaultFps;
    if (rowFps < trackRow.minFps || rowFps > trackRow.maxFps) {
      throw error(`Direction ${direction} playback fps ${rowFps} is outside the supported ${trackRow.minFps}–${trackRow.maxFps} range`);
    }
    if (fps === null) {
      fps = rowFps;
    } else if (rowFps !== fps) {
      throw error(`Direction ${direction} plays at ${rowFps} fps but the set uses ${fps} — reprocess all directions to the same speed before compiling`);
    }
  }
  return { id: trackId, frameCount, fps };
}
