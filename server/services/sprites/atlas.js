/**
 * Sprites — runtime atlas compiler (issue #2898, phase 4).
 *
 * Compiles the immutable runtime sprite-sheet from a finalized eight-direction
 * walk set: an (idle + N walk phases)-column × 8-row grid (× S/SE/E/
 * NE/N/NW/W/SW) of fixed-size cells, each frame scaled once per direction and
 * translated so it anchors on the pivot x and its sole lands exactly on the
 * pivot ground line. Placement is anchored on the TORSO, not the silhouette
 * centre, and shared across a direction's cells — a walk frame carries the
 * packer's pivot through the scale, the idle anchor measures its own (#3021) —
 * so a swinging limb cannot slide the character and idle→walk does not pop.
 * N (the walk frame count) is read from the approved
 * run manifests — every direction must share it — so the atlas width tracks the
 * authored count (historically 8; variable per #sprite-walk-variable-frames).
 * Ports the source pipeline's
 * `runtime_publish.py` compile stage; all math preserves Python semantics
 * (banker's rounding via pyRound, exclusive-bbox bounds) so cell placement
 * matches the production atlases the importer brought over.
 *
 * Every input is revalidated before any pixel work: walk-set kind/status/
 * direction order, the selection + per-direction run-manifest sha256s, every
 * packaged frame's sha256, and the locked reference set's anchor sha256s. A
 * failed hash means the evidence chain is broken — compile refuses rather
 * than compiling from tampered bytes.
 *
 * Output is immutable-by-version under data/sprites/<id>/runtime/vN/
 * (a differing byte-write to an existing version path is refused), with a
 * mutable current.json pointer. Recompiling the same finalized set is
 * idempotent: identical bytes → the existing version is returned untouched.
 */

import { join } from 'path';
import { readdir, readFile } from 'fs/promises';
import sharp from 'sharp';
import {
  atomicWrite, ensureDir, pathExists, readJSONFile, tryReadFile,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  spriteDir, resolveSpriteAssetPath, RUNTIME_POINTER_REL, RUNTIME_PUBLICATIONS_REL,
  isSourcePipelinePath,
} from './paths.js';
import { requireAnimatable, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS } from './prompts.js';
import { keyChannelSplit } from './chromaKey.js';
import {
  WALK_PHASES, WALK_FPS,
  pyRound, pyRoundTo, median, premultipliedResize, decodeTransparentSpriteSource,
  despillKeyFrame,
  alphaBbox, robustBottomRow, rootX, rootBandForManifest, ROBUST_BASELINE_MIN_PIXELS, compositeOnto, sha256Buffer,
} from './walkPostprocess.js';
import { ATLAS_IDLE_COLUMN } from './walkBounds.js';
import {
  WALK_TRACK, SCANNER_TRACK, AMBIENT_TRACK,
  tracksForKind, primaryTrackForKind,
} from './animationTracks.js';
// #3152 — the DEFAULT registry table is the EFFECTIVE one (compiled `walk` + the
// user-defined store), not the compiled constant. Load-bearing now that #3158 made
// this compiler fully generic: it walks `tracksForKind` to find every track a
// record may carry, so with a compiled-only default a `place` record would resolve
// NO primary track (ambient is a stored row) and every ambient compile would fail
// with "has no animation track to compile". `animationTracks` stays an explicit
// parameter — still the injection seam the multi-track tests use.
import { getEffectiveAnimationTracks } from './animationTrackStore.js';
import {
  buildAtlasGrid, resolveTrackUniformity, compiledGridUpToDate, trackDirections,
} from './atlasGrid.js';
import {
  withWalkWriteTail, walkSetRelPath, importedWalkDirections, resolveChromaKey,
} from './walk.js';
import { trackSetRelPath } from './animationTrackWorkflow.js';
import { verifyPackagedFrames } from './walkFrames.js';
import { getRecord } from './records.js';

// Player atlas contract (source pipeline runtime_publish.py): 96px cells,
// pivot (48,88) — silhouette centered on x=48, feet on the y=88 ground line —
// content bounded to 86×74 so nothing touches a cell edge.
//
// The runtime grid is `idle` followed by one variable-length column span per
// animation track, in registry-registration order (#3016). Each track's length
// is read from its approved run manifests, not hardcoded, so the atlas width
// grows and shrinks with what was actually authored — and two tracks may
// legally differ in length, which is what makes a four-frame action beside a
// twelve-frame walk expressible. The span math lives in the sharp-free
// atlasGrid.js so the compiler that WRITES the grid and the sidecar that
// DESCRIBES it (atlasLayout.js) share one definition.
//
// ATLAS_COLUMNS remains the historical walk-only 8-frame layout, used as the
// default/fallback.
//
// A trailing `scanner` column used to follow the walk phases — a verbatim copy
// of the idle cell that no consumer ever sampled (#2986). It is no longer
// compiled: an action animation is its own named track, not a column bolted
// onto the walk cycle. Imported/legacy atlases and manifests that still carry
// the column keep loading and displaying unchanged — this is a write-side
// change only.
export const ATLAS_COLUMNS = buildAtlasGrid([{ id: WALK_TRACK, frameCount: WALK_PHASES.length }]).columns;

// A track whose historical run manifests predate the frameRate field falls back
// to the rate its frames were extracted at, not to the track's authoring
// default — so an older set compiles to exactly the atlas it always did. Keyed
// by track so a new track states its own answer (or omits it and takes its
// registry default) instead of adding a branch here.
const LEGACY_MANIFEST_FPS = { [WALK_TRACK]: WALK_FPS };
export const DEFAULT_ATLAS_GEOMETRY = {
  cellSize: 96,
  pivot: [48, 88],
  targetMaxHeight: 74,
  targetMaxWidth: 86,
};

// Silhouette-visibility alpha thresholds (exclusive bbox at alpha > N).
// Walk frames measure at 8; the idle anchor measures at 64 so chroma-key
// recovery noise can't inflate the character and shrink its scale.
const ALPHA_THRESHOLD = 8;
const SILHOUETTE_ALPHA_THRESHOLD = 64;
// Post-resize alpha snap (Python premultiplied_resize's ALPHA_NOISE_FLOOR).
const ALPHA_NOISE_FLOOR = 2;
// Compiled idle height must match the walk row's median height within two
// logical (96px-contract) pixels. Scale the rounding tolerance with source
// density so a 2×/3× compile applies the same visual standard.
const IDLE_HEIGHT_TOLERANCE = 2;

const RUNTIME_DIR = 'runtime';
const atlasStem = (recordId) => `${recordId}-animation-atlas`;

const compileError = (message, code = 'ATLAS_COMPILE_INVALID') =>
  new ServerError(message, { status: 422, code });

/**
 * The minimum opaque-pixel count a row needs to read as the sole rather than a
 * stray speck, at a given resize factor. A cell is typically upscaled from the
 * packer's frame, and the resize smears one source pixel across ~`scale` of
 * them — so a fixed count would let an upscaled speck masquerade as a sole.
 */
const cellMinRun = (scale) => Math.max(ROBUST_BASELINE_MIN_PIXELS, Math.ceil(ROBUST_BASELINE_MIN_PIXELS * scale));

/**
 * `robust` measures height to the SOLE rather than to the lowest lit pixel
 * (#3021). It matters here and not only at placement time: these dimensions set
 * the direction's scale, so a single speck below the feet made one frame read
 * taller, shrank the scale for the whole direction, and pushed the compiled idle
 * height off the walk median it is asserted against. Off for the idle anchor,
 * which is measured at the silhouette threshold on a raw reference.
 */
function occupiedDimensions(frame, threshold, label, robust = false) {
  const bounds = alphaBbox(frame, threshold);
  if (!bounds) throw compileError(`${label} has no visible pixels`);
  const bottom = robust ? robustBottomRow(frame, threshold) : bounds.bottom;
  return { width: bounds.right - bounds.left, height: bottom - bounds.top };
}

/**
 * Scale a source frame once and measure what placement needs from it: the bbox
 * the cell-edge guards test, and the sole the ground line is pinned to.
 * Placement itself is `placeCell` — the two are split because a direction's x is
 * SHARED, so every frame has to be measured before any of them can be placed.
 */
async function scaleForCell(source, scale, label) {
  const width = Math.max(1, pyRound(source.width * scale));
  const height = Math.max(1, pyRound(source.height * scale));
  const scaled = await premultipliedResize(source, width, height);
  // Python's premultiplied_resize snaps sub-noise alpha after re-straightening.
  for (let i = 3; i < scaled.data.length; i += 4) {
    if (scaled.data[i] <= ALPHA_NOISE_FLOOR) {
      scaled.data[i - 3] = 0; scaled.data[i - 2] = 0; scaled.data[i - 1] = 0; scaled.data[i] = 0;
    }
  }
  const bounds = alphaBbox(scaled, ALPHA_THRESHOLD);
  if (!bounds) throw compileError(`${label} has no visible pixels after scaling`);
  // The SOLE, not the lowest lit pixel — vertical placement keys on this.
  // Pinning the raw bbox bottom is what let a sub-sole speck set the ground line
  // and bob the body (#3021), and fixing it only in the packer would have been
  // undone right here: the packer would place the sole at its baseline, leaving
  // the speck lower, and this stage would pin the SPECK to the ground line,
  // landing the body exactly where it started.
  //
  // Measured on `scaled`, in the same space the ground-line assertion re-measures
  // — but with the pixel threshold scaled to match. These cells are upscaled
  // ~2.5x, and a lanczos upscale smears a single stray pixel into a blob several
  // pixels wide, wide enough to clear a fixed threshold and be mistaken for a
  // sole. Scaling the threshold keeps "a speck is a speck" true at any cell size.
  const baseline = robustBottomRow(scaled, ALPHA_THRESHOLD, cellMinRun(scale));
  return { scaled, bounds, baseline };
}

/**
 * Translate an already-scaled frame into a cell at the given x, with its sole on
 * the pivot ground line — translation-only placement, refusing any content that
 * touches a cell edge.
 */
function placeCell(scaled, bounds, baseline, pasteX, label, geometry, scale) {
  const { cellSize, pivot } = geometry;
  const pasteY = pivot[1] - (baseline - 1);
  if (pasteX + bounds.left <= 0 || pasteY + bounds.top <= 0) {
    throw compileError(`${label} touches the top or left runtime cell edge`);
  }
  if (pasteX + bounds.right >= cellSize || pasteY + bounds.bottom >= cellSize) {
    throw compileError(`${label} touches the right or bottom runtime cell edge`);
  }
  const cell = { data: Buffer.alloc(cellSize * cellSize * 4), width: cellSize, height: cellSize };
  compositeOnto(cell, scaled, pasteX, pasteY);
  // Port-faithful belt-and-braces: re-measure the composed cell and verify the
  // feet really sit on the ground line (runtime_publish.py does the same final
  // _bounds check rather than trusting the placement math). Measured by the same
  // robust rule that positioned it — asserting on the raw bbox would fail for
  // any frame carrying a speck below the sole, which is precisely the case this
  // is meant to tolerate.
  const final = alphaBbox(cell, ALPHA_THRESHOLD);
  if (!final || robustBottomRow(cell, ALPHA_THRESHOLD, cellMinRun(scale)) - 1 !== pivot[1]) {
    throw compileError(`${label} misses the runtime ground line y=${pivot[1]}`);
  }
  return {
    cell,
    meta: {
      scale: pyRoundTo(scale, 8),
      translation: [pasteX, pasteY],
      occupiedBounds: {
        left: final.left,
        top: final.top,
        width: final.right - final.left,
        height: final.bottom - final.top,
      },
    },
  };
}

/**
 * The shared x every cell of one direction is placed at, and the correction (if
 * any) needed to keep the whole row inside its cells.
 *
 * Anchoring on the packer's torso pivot rather than each cell's own silhouette
 * centre is what preserves registration through compile (#3021) — but it also
 * moves content off-centre by however far the torso sits from the silhouette
 * middle, which for a wide sprite can be enough to touch a cell edge and turn a
 * previously-successful compile into a hard 422. So the row is shifted back as a
 * WHOLE when that happens: relative registration between frames is preserved
 * exactly (the point of the fix), and only the row's absolute offset gives way.
 * Per-frame correction would reintroduce the very drift being removed.
 */
function sharedRowPasteX(anchoredX, boundsList, geometry) {
  const { cellSize } = geometry;
  const minLeft = Math.min(...boundsList.map((b) => anchoredX + b.left));
  const maxRight = Math.max(...boundsList.map((b) => anchoredX + b.right));
  if (minLeft <= 0) return anchoredX + (1 - minLeft);
  if (maxRight >= cellSize) return anchoredX - (maxRight - cellSize + 1);
  return anchoredX;
}

/**
 * Revalidate every registered track's evidence chain: finalized set →
 * selection → run manifests → packaged frame bytes, plus the locked reference
 * source. Returns everything the compiler consumes.
 */
export async function validateForCompile(recordId, animationTracks = getEffectiveAnimationTracks()) {
  return validateForCompileWithTracks(recordId, animationTracks);
}

async function validateForCompileWithTracks(recordId, animationTracks) {
  const record = await getRecord(recordId);
  const primary = primaryTrackForKind(record?.kind, animationTracks);
  const registryRows = tracksForKind(record?.kind, animationTracks);
  if (!primary || !registryRows.length) {
    throw compileError(`Sprite kind '${String(record?.kind)}' has no animation track to compile`);
  }

  // Every hashed input is read exactly once: verify the bytes in memory and
  // hand those same bytes to the compiler, so the pixels compiled are
  // provably the pixels verified (no re-read between check and use). Paths
  // come from server-owned manifests but still route through the record-dir
  // confinement gate (resolveSpriteAssetPath) per the paths.js contract.
  const readVerified = async (relPath, expectedSha, label) => {
    const bytes = await readFile(resolveSpriteAssetPath(recordId, relPath)).catch(() => null);
    if (!bytes || sha256Buffer(bytes) !== expectedSha) {
      throw compileError(`${label} no longer matches its recorded sha256`);
    }
    return bytes;
  };

  const dir = spriteDir(recordId);
  const loaded = {};
  for (const row of registryRows) {
    const setPath = row.id === WALK_TRACK ? walkSetRelPath(recordId) : trackSetRelPath(row.id, recordId);
    // eslint-disable-next-line no-await-in-loop -- registry order is the compiled span order
    const setBytes = await readFile(join(dir, setPath)).catch(() => null);
    if (!setBytes) {
      if (row.id !== primary.id) continue;
      if (row.id === WALK_TRACK) {
        throw compileError('No finalized walk set — approve all 8 directions first', 'WALK_SET_REQUIRED');
      }
      if (row.id === AMBIENT_TRACK) {
        throw compileError('No finalized ambient loop — approve its single row first', 'AMBIENT_SET_REQUIRED');
      }
      throw compileError(`No finalized ${row.label.toLowerCase()} set`, 'TRACK_SET_REQUIRED');
    }
    let set;
    try {
      set = JSON.parse(setBytes);
    } catch {
      throw compileError(`${row.label} set manifest is unreadable`);
    }
    const directions = trackDirections(row.id, SPRITE_DIRECTIONS, animationTracks);
    const trackMatches = row.id === WALK_TRACK ? (!set.track || set.track === row.id) : set.track === row.id;
    if (set.kind !== row.setKind || !trackMatches || set.status !== 'final' || set.characterId !== recordId
      || JSON.stringify(set.directionOrder) !== JSON.stringify(directions)) {
      throw compileError(`${row.label} set manifest is not a finalized ${row.directional ? 'directional' : 'single-row'} set`);
    }
    if (row.id === WALK_TRACK) {
      const stale = importedWalkDirections(set);
      if (stale.length || isSourcePipelinePath(set.selectionPath)) {
        const which = stale.length ? `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'}` : 'This walk set is';
        throw new ServerError(
          `${which} still packaged by the source pipeline, whose per-frame images were not imported — PortOS cannot compile from them. `
          + 'Reopen each such direction and reprocess it from its imported clip to re-derive the frames here, then compile. '
          + 'A direction with no imported clip cannot be re-derived at all — re-import the character to bring its clips across. '
          + 'The imported runtime atlases remain available in the asset library.',
          { status: 409, code: 'LEGACY_IMPORTED_WALK_SET' },
        );
      }
    }
    // eslint-disable-next-line no-await-in-loop -- validate each set before its run graph
    await readVerified(set.selectionPath, set.selectionSha256, `${row.label} selection file`);
    loaded[row.id] = {
      id: row.id,
      definition: row,
      set,
      setPath,
      setSha256: sha256Buffer(setBytes),
      directions,
    };
  }

  const referenceManifest = await loadManifest(recordId);
  const chromaKey = resolveChromaKey({ manifest: referenceManifest, record });
  if (!chromaKey) throw compileError('Reference manifest has no frozen chroma key');
  const anchors = {};
  let mainReference = null;
  if (primary.directional) {
    if (!referenceManifest || referenceManifest.status !== 'complete') {
      throw compileError('Reference set is not complete — all 8 anchors must be locked', 'REFERENCE_INCOMPLETE');
    }
    for (const direction of SPRITE_DIRECTIONS) {
      const anchor = (referenceManifest.anchors || []).find((item) => item.direction === direction);
      if (!anchor || anchor.status !== 'locked' || !anchor.path) {
        throw compileError(`Anchor for ${direction} is not locked`);
      }
      // eslint-disable-next-line no-await-in-loop -- read-once evidence verification
      const bytes = await readVerified(anchor.path, anchor.sha256, `Anchor for ${direction}`);
      anchors[direction] = { ...anchor, bytes };
    }
  } else {
    const main = referenceManifest?.mainReference;
    if (!main?.locked || !main.path || !main.sha256) {
      throw compileError('Main reference is not locked', 'REFERENCE_INCOMPLETE');
    }
    mainReference = {
      ...main,
      bytes: await readVerified(main.path, main.sha256, 'Locked main reference'),
    };
  }

  // Two passes per track: agree on shape using the small manifests first, then
  // read and hash every frame. A malformed row therefore fails before the
  // expensive pixel graph is loaded.
  for (const row of registryRows) {
    const track = loaded[row.id];
    if (!track) continue;
    const pendingRuns = {};
    const rows = [];
    for (const direction of track.directions) {
      const entry = track.set.directions?.[direction];
      if (!entry || entry.status !== 'approved') {
        throw compileError(`${row.label} direction ${direction} is not approved`);
      }
      // eslint-disable-next-line no-await-in-loop -- evidence chain is ordered per facing
      const manifestBytes = await readVerified(
        entry.runManifest,
        entry.runManifestSha256,
        `${row.label} run manifest for ${direction}`,
      );
      let manifest;
      try {
        manifest = JSON.parse(manifestBytes);
      } catch {
        manifest = null;
      }
      const manifestTrackMatches = row.id === WALK_TRACK
        ? (!manifest?.track || manifest.track === row.id)
        : manifest?.track === row.id;
      if (!manifest || !manifestTrackMatches || manifest.direction !== direction) {
        throw compileError(`${row.label} run manifest for ${direction} is unreadable or mislabeled`);
      }
      pendingRuns[direction] = { entry, manifest };
      rows.push({
        direction,
        frameCount: (manifest.frames || []).length,
        declaredFrameCount: manifest.frameCount,
        fps: manifest.frameRate,
      });
    }
    const uniform = resolveTrackUniformity(row.id, rows, {
      tracks: animationTracks,
      error: compileError,
      defaultFps: LEGACY_MANIFEST_FPS[row.id],
      expectedRows: track.directions.length,
    });
    const runs = {};
    for (const direction of track.directions) {
      const { entry, manifest } = pendingRuns[direction];
      // eslint-disable-next-line no-await-in-loop -- read-once frame verification
      const { frameBytes } = await verifyPackagedFrames(recordId, manifest, {
        bytes: true,
        track: row.id,
        tracks: animationTracks,
      });
      runs[direction] = {
        runId: entry.runId,
        manifestPath: entry.runManifest,
        manifest,
        frameBytes,
      };
    }
    loaded[row.id] = {
      ...track,
      rows,
      runs,
      frameCount: uniform.frameCount,
      fps: uniform.fps,
    };
  }

  const walk = loaded[WALK_TRACK];
  const scanner = loaded[SCANNER_TRACK];
  const ambient = loaded[AMBIENT_TRACK];
  return {
    primaryTrackId: primary.id,
    referenceManifest,
    chromaKey,
    anchors,
    mainReference,
    tracks: loaded,
    // Legacy views remain additive compatibility fields for existing runtime
    // pointers and consumers. The generic compiler itself reads `tracks`.
    walkSet: walk?.set || null,
    walkSetPath: walk?.setPath || null,
    walkSetSha256: walk?.setSha256 || null,
    scannerSet: scanner?.set || null,
    scannerSetPath: scanner?.setPath || null,
    scannerSetSha256: scanner?.setSha256 || null,
    ambientSet: ambient?.set || null,
    ambientSetPath: ambient?.setPath || null,
    ambientSetSha256: ambient?.setSha256 || null,
    walkFrameCount: walk?.frameCount ?? null,
    walkFps: walk?.fps ?? null,
    scannerFrameCount: scanner?.frameCount ?? null,
    ambientFrameCount: ambient?.frameCount ?? null,
  };
}

async function prepareTrackCells(track, direction, validated, geometry, split) {
  const run = track.runs[direction];
  const sources = [];
  for (const bytes of run.frameBytes) {
    // eslint-disable-next-line no-await-in-loop -- sharp transforms preserve frame order
    sources.push(await decodeTransparentSpriteSource(bytes, split, validated.chromaKey));
  }
  const dims = sources.map((source, index) => occupiedDimensions(
    source,
    ALPHA_THRESHOLD,
    `${direction}-${run.manifest.frames[index].phase}`,
    true,
  ));
  const scale = Math.min(
    geometry.targetMaxHeight / Math.max(...dims.map((dim) => dim.height)),
    geometry.targetMaxWidth / Math.max(...dims.map((dim) => dim.width)),
  );
  const pivotX = Number(run.manifest.alignment?.targetPivot?.[0]);
  const sourcePivotX = Number.isFinite(pivotX)
    ? pivotX
    : (Number(run.manifest.alignment?.cellSize) || sources[0].width) / 2;
  const scaled = [];
  for (let index = 0; index < sources.length; index++) {
    // eslint-disable-next-line no-await-in-loop -- frame order is the atlas order
    scaled.push(await scaleForCell(
      sources[index],
      scale,
      `${direction}-${run.manifest.frames[index].phase}`,
    ));
  }
  const pasteX = sharedRowPasteX(
    pyRound(geometry.pivot[0] - sourcePivotX * scale),
    scaled.map((item) => item.bounds),
    geometry,
  );
  const cells = scaled.map((item, index) => {
    const frame = run.manifest.frames[index];
    const normalized = placeCell(
      item.scaled,
      item.bounds,
      item.baseline,
      pasteX,
      `${direction}-${frame.phase}`,
      geometry,
      scale,
    );
    return {
      column: frame.phase,
      track: track.id,
      frameIndex: index,
      ...normalized,
      sourcePath: frame.path,
      sourceSha256: frame.sha256,
    };
  });
  return { track, run, dims, scale, cells };
}

async function compileTrackRow(direction, validated, geometry) {
  const split = keyChannelSplit(validated.chromaKey);
  const prepared = [];
  for (const track of Object.values(validated.tracks)) {
    if (!track.runs[direction]) continue;
    // eslint-disable-next-line no-await-in-loop -- preserve registry and cell order
    prepared.push(await prepareTrackCells(track, direction, validated, geometry, split));
  }
  const primary = prepared.find((item) => item.track.id === validated.primaryTrackId) || prepared[0];
  if (!primary) throw compileError(`No animation track occupies atlas row ${direction}`);

  const source = validated.anchors[direction] || validated.mainReference;
  const sourcePolicy = validated.anchors[direction]
    ? 'locked-directional-reference-anchor'
    : 'locked-main-reference';
  const idleLabel = `${direction}-idle`;
  const idleSource = await decodeTransparentSpriteSource(source.bytes, split, validated.chromaKey);
  const idleDims = occupiedDimensions(idleSource, SILHOUETTE_ALPHA_THRESHOLD, idleLabel);
  const desiredIdleHeight = median(primary.dims.map((dim) => dim.height)) * primary.scale;
  const idleScale = Math.min(desiredIdleHeight / idleDims.height, geometry.targetMaxWidth / idleDims.width);
  const idleScaled = await scaleForCell(idleSource, idleScale, idleLabel);
  const idlePasteX = validated.anchors[direction]
    ? pyRound(
      geometry.pivot[0]
      - rootX(
        idleScaled.scaled,
        alphaBbox(idleScaled.scaled, SILHOUETTE_ALPHA_THRESHOLD) || idleScaled.bounds,
        rootBandForManifest(primary.run.manifest),
      ),
    )
    : pyRound((geometry.cellSize - idleScaled.scaled.width) / 2);
  const idle = placeCell(
    idleScaled.scaled,
    idleScaled.bounds,
    idleScaled.baseline,
    sharedRowPasteX(idlePasteX, [idleScaled.bounds], geometry),
    idleLabel,
    geometry,
    idleScale,
  );
  const idleHeightTolerance = Math.max(
    IDLE_HEIGHT_TOLERANCE,
    IDLE_HEIGHT_TOLERANCE * (geometry.cellSize / DEFAULT_ATLAS_GEOMETRY.cellSize),
  );
  if (validated.anchors[direction]
    && Math.abs(idle.meta.occupiedBounds.height - desiredIdleHeight) > idleHeightTolerance) {
    throw compileError(
      `${direction} idle height ${idle.meta.occupiedBounds.height} misses the animation median ${pyRoundTo(desiredIdleHeight, 2)}`,
    );
  }
  const cells = [{
    column: ATLAS_IDLE_COLUMN,
    track: ATLAS_IDLE_COLUMN,
    frameIndex: 0,
    ...idle,
    sourcePath: source.path,
    sourceSha256: source.sha256,
    policy: sourcePolicy,
  }, ...prepared.flatMap((item) => item.cells)];
  const trackScales = Object.fromEntries(
    prepared.map((item) => [item.track.id, pyRoundTo(item.scale, 8)]),
  );
  return {
    direction,
    runId: primary.run.runId,
    runManifestPath: primary.run.manifestPath,
    walkDirectionScale: trackScales[WALK_TRACK],
    trackScales,
    idleScale: pyRoundTo(idleScale, 8),
    idlePolicy: sourcePolicy,
    cells,
  };
}

async function nextAtlasVersion(runtimeAbs, stem) {
  let entries = [];
  try {
    entries = await readdir(runtimeAbs, { withFileTypes: true });
  } catch {
    return 1;
  }
  const pattern = /^v(\d+)$/;
  let max = 0;
  for (const entry of entries) {
    const match = entry.isDirectory() && entry.name.match(pattern);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > max && await pathExists(join(runtimeAbs, entry.name, `${stem}-v${version}.png`))) {
      max = version;
    }
  }
  return max + 1;
}

/** Refuse to overwrite an immutable artifact with differing bytes. */
async function writeImmutable(absPath, buffer) {
  const existing = await tryReadFile(absPath, null);
  if (existing !== null) {
    if (!existing.equals(buffer)) {
      throw new ServerError(`Immutable runtime output differs: ${absPath}`, { status: 409, code: 'IMMUTABLE_CONFLICT' });
    }
    return;
  }
  await atomicWrite(absPath, buffer);
}

function mergeGeometry(override = {}) {
  const geometry = { ...DEFAULT_ATLAS_GEOMETRY, ...override };
  if (geometry.targetMaxWidth >= geometry.cellSize || geometry.targetMaxHeight >= geometry.cellSize) {
    throw new ServerError('Atlas geometry target bounds must fit inside the cell', { status: 400, code: 'INVALID_GEOMETRY' });
  }
  return geometry;
}

/**
 * Compile (idempotently) the runtime atlas for a finalized walk set. Returns
 * `{ created, version, atlasPath, atlasSha256, manifestPath, geometry }` —
 * `created: false` when the current pointer already covers identical bytes.
 * Runs inside the record's walk write tail; callers already inside the tail
 * use compileAtlasInTail.
 */
export function compileAtlas(recordId, options = {}) {
  return withWalkWriteTail(recordId, () => compileAtlasInTail(recordId, options));
}

const trackSetSha256s = (validated) => Object.fromEntries(
  Object.values(validated.tracks).map((track) => [track.id, track.setSha256]),
);

const persistedTrackSetSha256s = (persisted) => {
  if (persisted?.trackSetSha256s && typeof persisted.trackSetSha256s === 'object'
    && !Array.isArray(persisted.trackSetSha256s)) {
    return persisted.trackSetSha256s;
  }
  return {
    ...(persisted?.walkSetSha256 ? { [WALK_TRACK]: persisted.walkSetSha256 } : {}),
    ...(persisted?.scannerSetSha256 ? { [SCANNER_TRACK]: persisted.scannerSetSha256 } : {}),
    ...(persisted?.ambientSetSha256 ? { [AMBIENT_TRACK]: persisted.ambientSetSha256 } : {}),
  };
};

const trackSetsUpToDate = (persisted, validated) => {
  const current = persistedTrackSetSha256s(persisted);
  const expected = trackSetSha256s(validated);
  const ids = new Set([...Object.keys(current), ...Object.keys(expected)]);
  return [...ids].every((id) => current[id] === expected[id]);
};

const trackFrameCountFields = (validated, animationTracks) => Object.fromEntries(
  Object.values(animationTracks).flatMap((definition) => {
    const frameCount = validated.tracks[definition.id]?.frameCount;
    return Number.isInteger(frameCount) ? [[definition.contractFrameCountField, frameCount]] : [];
  }),
);

const trackFrameCountsUpToDate = (geometry, fields) => Object.entries(fields)
  .every(([field, frameCount]) => geometry?.[field] === frameCount);

export async function compileAtlasInTail(recordId, {
  geometry: geometryOverride,
  tracks: animationTracks = getEffectiveAnimationTracks(),
} = {}) {
  // The track-presence gate (#3017), not a literal kind check: a record may
  // compile an atlas when its kind carries at least one registered animation
  // track. Walk is character-only, so this refuses exactly what it always did —
  // but registering a non-directional ambient track that lists `place`/`object`
  // unlocks those records here with no edit to this line.
  await requireAnimatable(recordId);
  const geometry = mergeGeometry(geometryOverride);
  const validated = await validateForCompile(recordId, animationTracks);
  const frameCountFields = trackFrameCountFields(validated, animationTracks);
  const dir = spriteDir(recordId);

  // Columns/width follow the set's actual per-track frame counts, not the
  // historical 8 — and `tracks` names each track's `{ start, count }` span, so
  // the grid, the manifest geometry and the published sidecar can never
  // disagree about where a track's columns are.
  const trackSpecs = Object.values(validated.tracks).map((track) => ({
    id: track.id,
    frameCount: track.frameCount,
  }));
  const { columns, tracks } = buildAtlasGrid(trackSpecs, animationTracks);

  // Pre-pixel idempotency: the compile is deterministic, so unchanged track
  // sets + identical geometry mean identical bytes by construction —
  // skip the whole pixel pipeline. The evidence chain was still revalidated
  // above; the post-encode sha comparison below stays as the fallback for a
  // pointer whose geometry fields predate a shape change.
  // `compiledGridUpToDate` compares the GRID, not just the cell metrics: a
  // grid-shape change (#2986 dropping the trailing scanner column) leaves every
  // cell metric identical, and a track-SET change can leave even the column
  // count identical, so both the column list and the track spans are part of
  // the comparison (#3016). A pointer predating either field is described the
  // legacy way rather than treated as a mismatch, so upgrading an install
  // doesn't condemn every existing atlas to recompile its pixels forever.
  // Both idempotent early-returns require the pointed-at atlas file to still
  // exist — otherwise a deleted runtime/vN PNG would loop forever ("recompile"
  // → pointer returned untouched → still missing); falling through re-writes
  // the same version (nextAtlasVersion only counts versions whose PNG exists).
  const current = await readJSONFile(join(dir, RUNTIME_POINTER_REL), null, { strict: true });
  const currentAtlasOnDisk = current ? await pathExists(join(dir, current.atlasPath)) : false;
  if (
    current
    && currentAtlasOnDisk
    && trackSetsUpToDate(current, validated)
    && compiledGridUpToDate(current.geometry, { ...geometry, columns, tracks })
    && trackFrameCountsUpToDate(current.geometry, frameCountFields)
  ) {
    return { ...current, created: false };
  }

  // Each row emits its idle reference plus every registered track occupying
  // that facing. Cells carry their track and frame index into the compositor,
  // so variable-width and single-row spans land exactly where the grid says.
  const rowCount = Math.max(...Object.values(validated.tracks).map((track) => track.directions.length));
  const rows = await Promise.all(
    SPRITE_DIRECTIONS.slice(0, rowCount).map((direction) => compileTrackRow(direction, validated, geometry)),
  );

  // Resolve one cell's place in the grid from its track's span, once, and stamp
  // the answer on the cell so the manifest below reports where the pixels
  // actually went instead of re-deriving it. Deriving the index positionally
  // (its order within the row) was correct only while every track was
  // full-width and full-height; it would silently misplace a shorter or
  // single-row track rather than reporting the mismatch.
  const placeInGrid = (cell, r) => {
    const span = tracks[cell.track];
    if (!span) throw compileError(`Compiled cell references unknown atlas track '${cell.track}'`);
    // A non-directional track owns row 0 only; the rest of its span stays as
    // the zero-filled canvas left it — transparent, which PNG compresses to
    // near nothing. A cell compiled outside its track's rows would overwrite
    // pixels the sidecar promises are empty, so refuse rather than composite.
    if (r >= span.rows) {
      throw compileError(`Track '${cell.track}' occupies ${span.rows} atlas row(s) but a cell was compiled for ${SPRITE_DIRECTIONS[r]} (row ${r})`);
    }
    if (!Number.isInteger(cell.frameIndex) || cell.frameIndex < 0 || cell.frameIndex >= span.count) {
      throw compileError(`Track '${cell.track}' frame ${cell.frameIndex} is outside its ${span.count}-column span`);
    }
    const index = span.start + cell.frameIndex;
    if (columns[index] !== cell.column) {
      throw compileError(`Track '${cell.track}' frame ${cell.frameIndex} is column "${columns[index]}" in the grid but the cell is labeled "${cell.column}"`);
    }
    cell.columnIndex = index;
    return index;
  };

  const { cellSize } = geometry;
  const atlasWidth = cellSize * columns.length;
  const atlasHeight = cellSize * SPRITE_DIRECTIONS.length;
  const atlas = { data: Buffer.alloc(atlasWidth * atlasHeight * 4), width: atlasWidth, height: atlasHeight };
  for (let r = 0; r < rows.length; r++) {
    for (const cell of rows[r].cells) {
      compositeOnto(atlas, cell.cell, placeInGrid(cell, r) * cellSize, r * cellSize);
    }
  }
  const atlasBuffer = await sharp(atlas.data, { raw: { width: atlasWidth, height: atlasHeight, channels: 4 } })
    .png()
    .toBuffer();
  const atlasSha256 = sha256Buffer(atlasBuffer);

  if (current && currentAtlasOnDisk && trackSetsUpToDate(current, validated)
    && current.atlasSha256 === atlasSha256
    && trackFrameCountsUpToDate(current.geometry, frameCountFields)) {
    return { ...current, created: false };
  }

  const stem = atlasStem(recordId);
  const runtimeAbs = join(dir, RUNTIME_DIR);
  let version = await nextAtlasVersion(runtimeAbs, stem);
  // Never adopt a PNG-missing slot whose surviving manifest vouches for
  // DIFFERENT bytes — writing there would land a PNG its own manifest
  // contradicts and then 409 on the manifest write, poisoning the version
  // dir. Advance until the slot is empty or its manifest matches these bytes
  // (the re-materialize case).
  for (;;) {
    const survivor = await readJSONFile(join(runtimeAbs, `v${version}`, `${stem}-v${version}-manifest.json`), null, { strict: true });
    if (!survivor || (
      survivor.atlasSha256 === atlasSha256
      && trackFrameCountsUpToDate(survivor.geometry, frameCountFields)
    )) break;
    version += 1;
  }
  const versionRel = `${RUNTIME_DIR}/v${version}`;
  const atlasRel = `${versionRel}/${stem}-v${version}.png`;
  const manifestRel = `${versionRel}/${stem}-v${version}-manifest.json`;
  await ensureDir(join(dir, versionRel));
  await writeImmutable(join(dir, atlasRel), atlasBuffer);

  // Self-heal: when re-writing a version whose PNG was deleted, the version's
  // manifest usually survives — reuse it verbatim when it vouches for these
  // exact atlas bytes, since a freshly-built one would differ only in
  // createdAt and trip the immutable-write refusal.
  const manifestAbs = join(dir, manifestRel);
  const survivingManifest = await readJSONFile(manifestAbs, null, { strict: true });
  if (
    survivingManifest?.atlasSha256 === atlasSha256
    && trackFrameCountsUpToDate(survivingManifest.geometry, frameCountFields)
  ) {
    const survivingBuffer = await readFile(manifestAbs);
    const pointer = {
      schemaVersion: 1,
      kind: 'runtime-atlas-selection',
      characterId: recordId,
      version,
      atlasPath: atlasRel,
      atlasSha256,
      manifestPath: manifestRel,
      manifestSha256: sha256Buffer(survivingBuffer),
      ...(validated.walkSet ? { walkSetSha256: validated.walkSetSha256 } : {}),
      ...(survivingManifest.scannerSetSha256 ? { scannerSetSha256: survivingManifest.scannerSetSha256 } : {}),
      ...(survivingManifest.ambientSetSha256 ? { ambientSetSha256: survivingManifest.ambientSetSha256 } : {}),
      trackSetSha256s: persistedTrackSetSha256s(survivingManifest),
      geometry: survivingManifest.geometry,
      compiledAt: survivingManifest.createdAt,
    };
    await atomicWrite(join(dir, RUNTIME_POINTER_REL), pointer);
    console.log(`🧩 sprite atlas re-materialized for ${recordId} → v${version}`);
    return { ...pointer, created: true };
  }

  const manifest = {
    schemaVersion: 1,
    // The two named `kind`s are HISTORICAL spellings, kept so a recompile of a
    // record that was compiled before #3158 writes the same discriminator it always
    // did. They are matched on `primaryTrackId` rather than derived from it, which
    // means a user who deletes the seeded `ambient` row and authors their own
    // place-baseline track (#3152) gets the generic third spelling — correct for a
    // genuinely new track, and the same reason the two legacy names can't simply be
    // computed from the id: nothing else on disk records which name a record's
    // earlier atlases used.
    kind: validated.primaryTrackId === AMBIENT_TRACK
      ? 'reviewed-ambient-set-runtime-atlas'
      : validated.primaryTrackId === WALK_TRACK
        ? 'reviewed-walk-set-runtime-atlas'
        : 'reviewed-animation-set-runtime-atlas',
    characterId: recordId,
    version,
    createdAt: new Date().toISOString(),
    chromaKey: validated.chromaKey,
    compilerPath: 'server/services/sprites/atlas.js',
    ...(validated.walkSet ? {
      walkSetPath: validated.walkSetPath,
      walkSetSha256: validated.walkSetSha256,
    } : {}),
    ...(validated.scannerSet ? {
      scannerSetPath: validated.scannerSetPath,
      scannerSetSha256: validated.scannerSetSha256,
    } : {}),
    ...(validated.ambientSet ? {
      ambientSetPath: validated.ambientSetPath,
      ambientSetSha256: validated.ambientSetSha256,
    } : {}),
    trackSets: Object.fromEntries(
      Object.values(validated.tracks).map((track) => [
        track.id,
        { setPath: track.setPath, setSha256: track.setSha256 },
      ]),
    ),
    trackSetSha256s: trackSetSha256s(validated),
    atlasPath: atlasRel,
    atlasSha256,
    geometry: {
      columns,
      // Each track's `{ start, count }` column span (#3016). Additive: readers
      // that predate it (and every atlas compiled before it) fall back to the
      // legacy column-name derivation in atlasGrid.deriveTracks, so no migration
      // is needed and imported/pre-#2986 grids keep describing themselves.
      tracks,
      directionOrder: SPRITE_DIRECTIONS,
      rows: SPRITE_DIRECTIONS.length,
      cellSize,
      pivot: geometry.pivot,
      targetMaxHeight: geometry.targetMaxHeight,
      targetMaxWidth: geometry.targetMaxWidth,
      widthPx: atlasWidth,
      heightPx: atlasHeight,
      // Runtime playback metadata: the external game reads these to animate the
      // walk row at the authored speed over the right number of columns.
      walkFrameCount: validated.walkFrameCount,
      walkFps: validated.walkFps,
      // Match every compiled track to the convenience field its registry row
      // declares. The duplicate walk assignment preserves the existing field
      // position, while seeded scanner/ambient rows keep their wire names.
      ...frameCountFields,
    },
    directions: rows.map((row) => ({
      direction: row.direction,
      runId: row.runId,
      runManifestPath: row.runManifestPath,
      walkDirectionScale: row.walkDirectionScale,
      trackScales: row.trackScales,
      idleScale: row.idleScale,
      idlePolicy: row.idlePolicy,
      // The index the compositor stamped on, so the manifest cannot claim a
      // cell sits somewhere other than where its pixels actually landed.
      cells: row.cells.map((cell) => ({
        column: cell.column,
        columnIndex: cell.columnIndex,
        translation: cell.meta.translation,
        scale: cell.meta.scale,
        occupiedBounds: cell.meta.occupiedBounds,
        sourcePath: cell.sourcePath,
        sourceSha256: cell.sourceSha256,
        ...(cell.policy ? { policy: cell.policy } : {}),
      })),
    })),
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeImmutable(manifestAbs, manifestBuffer);

  const pointer = {
    schemaVersion: 1,
    kind: 'runtime-atlas-selection',
    characterId: recordId,
    version,
    atlasPath: atlasRel,
    atlasSha256,
    manifestPath: manifestRel,
    manifestSha256: sha256Buffer(manifestBuffer),
    ...(validated.walkSet ? { walkSetSha256: validated.walkSetSha256 } : {}),
    ...(validated.scannerSet ? { scannerSetSha256: validated.scannerSetSha256 } : {}),
    ...(validated.ambientSet ? { ambientSetSha256: validated.ambientSetSha256 } : {}),
    trackSetSha256s: trackSetSha256s(validated),
    geometry: manifest.geometry,
    compiledAt: manifest.createdAt,
  };
  await atomicWrite(join(dir, RUNTIME_POINTER_REL), pointer);
  console.log(`🧩 sprite atlas compiled for ${recordId} → v${version}`);
  return { ...pointer, created: true };
}

/** Atlas view for the detail endpoint: current pointer + publish history. */
export async function getAtlasState(recordId) {
  const dir = spriteDir(recordId);
  const [current, publications] = await Promise.all([
    readJSONFile(join(dir, RUNTIME_POINTER_REL), null, { strict: true }),
    readJSONFile(join(dir, RUNTIME_PUBLICATIONS_REL), [], { strict: true }),
  ]);
  return { current, publications: [...publications].reverse() };
}
