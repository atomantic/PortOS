/**
 * Sprites — runtime atlas compiler (issue #2898, phase 4).
 *
 * Compiles the immutable runtime sprite-sheet from a finalized eight-direction
 * walk set: an (idle + N walk phases)-column × 8-row grid (× S/SE/E/
 * NE/N/NW/W/SW) of fixed-size cells, each frame scaled once per direction and
 * translated so it anchors on the pivot x and its sole lands exactly on the
 * pivot ground line. Placement is anchored on the HIP, not the silhouette
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
  pyRound, pyRoundTo, median, decodeRgbaFrame, premultipliedResize,
  sampleBorderKey, validateMeasuredKey, recoverAlphaFrame, despillKeyFrame,
  alphaBbox, robustBottomRow, rootX, ROBUST_BASELINE_MIN_PIXELS, compositeOnto, sha256Buffer,
} from './walkPostprocess.js';
import { ATLAS_IDLE_COLUMN } from './walkBounds.js';
import { WALK_TRACK, ANIMATION_TRACK_IDS } from './animationTracks.js';
import {
  buildAtlasGrid, resolveTrackUniformity, compiledGridUpToDate, trackDirections,
} from './atlasGrid.js';
import {
  withWalkWriteTail, walkSetRelPath, importedWalkDirections,
} from './walk.js';
import { verifyPackagedFrames } from './walkFrames.js';

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
// Compiled idle height must match the walk row's median height within 2px.
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
 * Decode a validated source buffer as a straight-alpha transparent frame.
 * Already-keyed sources (packaged walk frames) get a despill safety pass;
 * opaque key-matte sources (locked anchors) go through measured-key alpha
 * recovery first — the same treatment the walk postprocess gives its raw
 * frames. Takes the in-memory bytes validateForCompile already hashed, so
 * the pixels compiled are provably the pixels verified.
 */
async function transparentSource(bytes, split, keyHex) {
  const frame = await decodeRgbaFrame(bytes);
  const { data } = frame;
  let alphaMin = 255; let alphaMax = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a < alphaMin) alphaMin = a;
    if (a > alphaMax) alphaMax = a;
  }
  if (alphaMin < alphaMax) return despillKeyFrame(frame, split);
  const measured = sampleBorderKey(frame);
  validateMeasuredKey(measured, split, keyHex);
  return despillKeyFrame(recoverAlphaFrame(frame, measured, split), split);
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
 * Anchoring on the packer's hip pivot rather than each cell's own silhouette
 * centre is what preserves registration through compile (#3021) — but it also
 * moves content off-centre by however far the hip sits from the silhouette
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
 * Revalidate the full evidence chain: finalized walk set → selection →
 * per-direction run manifests → packaged frame bytes, plus the locked
 * reference set's anchors. Returns everything the compiler consumes.
 */
export async function validateForCompile(recordId) {
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
  const walkSetRel = walkSetRelPath(recordId);
  const walkSetBytes = await readFile(join(dir, walkSetRel)).catch(() => null);
  if (!walkSetBytes) throw compileError('No finalized walk set — approve all 8 directions first', 'WALK_SET_REQUIRED');
  let walkSet;
  try {
    walkSet = JSON.parse(walkSetBytes);
  } catch {
    throw compileError('Walk set manifest is unreadable');
  }
  if (walkSet.kind !== 'finalized-eight-direction-walk-set' || walkSet.status !== 'final') {
    throw compileError('Walk set manifest is not a finalized eight-direction walk set');
  }
  if (walkSet.characterId !== recordId) throw compileError('Walk set characterId mismatch');
  // A direction still packaged by the source pipeline is copied verbatim: its
  // paths are repo-root (`art-source/sprites/<id>/…`) and — decisively — its
  // per-frame PNGs were never imported (the importer skips frames/ to minimize
  // copies). Compiling from it is structurally impossible; say so plainly
  // instead of the misleading tamper error the sha check below would produce.
  //
  // Unlike the original guard this is per-direction (#2993), because a direction
  // CAN now leave that state: re-deriving it from its imported clip regenerates
  // the frames here and re-approving rewrites its entry record-relative, so a set
  // whose directions have all been re-derived compiles like any native one. Only
  // the directions still carrying source-pipeline provenance block the compile,
  // and the message names them so the remedy is per-direction too. Their
  // already-published runtime atlases were imported and remain browsable.
  // `isImportedWalkSet` expanded so the direction list is built once. The
  // selectionPath disjunct is the set-level marker on its own — a set that is
  // imported but lists no source-packaged direction.
  const stale = importedWalkDirections(walkSet);
  if (stale.length || isSourcePipelinePath(walkSet.selectionPath)) {
    const which = stale.length ? `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'}` : 'This walk set is';
    throw new ServerError(
      `${which} still packaged by the source pipeline, whose per-frame images were not imported — PortOS cannot compile from them. `
      + 'Reopen each such direction and reprocess it from its imported clip to re-derive the frames here, then compile. '
      + 'A direction with no imported clip cannot be re-derived at all — re-import the character to bring its clips across. '
      + 'The imported runtime atlases remain available in the asset library.',
      { status: 409, code: 'LEGACY_IMPORTED_WALK_SET' },
    );
  }
  if (JSON.stringify(walkSet.directionOrder) !== JSON.stringify(SPRITE_DIRECTIONS)) {
    throw compileError('Walk set direction order does not match the runtime contract');
  }
  await readVerified(walkSet.selectionPath, walkSet.selectionSha256, 'Walk selection file');

  const referenceManifest = await loadManifest(recordId);
  if (!referenceManifest || referenceManifest.status !== 'complete') {
    throw compileError('Reference set is not complete — all 8 anchors must be locked', 'REFERENCE_INCOMPLETE');
  }
  const chromaKey = referenceManifest.chromaKey;
  if (!chromaKey) throw compileError('Reference manifest has no frozen chroma key');

  const anchors = {};
  for (const direction of SPRITE_DIRECTIONS) {
    const anchor = (referenceManifest.anchors || []).find((a) => a.direction === direction);
    if (!anchor || anchor.status !== 'locked' || !anchor.path) {
      throw compileError(`Anchor for ${direction} is not locked`);
    }
    const bytes = await readVerified(anchor.path, anchor.sha256, `Anchor for ${direction}`);
    anchors[direction] = { ...anchor, bytes };
  }

  // TWO PASSES, cheap first. Pass 1 reads the (small) run manifests and resolves
  // each track's frame count and fps; pass 2 does the expensive per-frame byte
  // verification. Doing it the other way round would byte-verify 8 directions
  // (48–128 PNGs read and hashed) before noticing a frame count that was out of
  // range or ragged — and verifyPackagedFrames documents the frame count as
  // already agreed across directions when it runs.
  //
  // Rows are keyed by TRACK because uniformity is a within-track rule (#3016):
  // every facing of one track must share a frame count and speed since the
  // atlas is a rectangular grid, but a second track is free to differ. HOW MANY
  // facings a track has is per-track too (#3017) — `trackDirections` answers it
  // from the registry, so a non-directional track is authored and approved as
  // one row rather than being held to eight. Only `walk` is registered today
  // (directional, so this is exactly SPRITE_DIRECTIONS); a second track adds a
  // sibling row list here and is resolved by the same loop.
  const walkDirections = trackDirections(WALK_TRACK, SPRITE_DIRECTIONS);
  const manifests = {};
  const trackRows = { [WALK_TRACK]: [] };
  for (const direction of walkDirections) {
    const entry = walkSet.directions?.[direction];
    if (!entry || entry.status !== 'approved') throw compileError(`Direction ${direction} is not approved`);
    const manifestBytes = await readVerified(entry.runManifest, entry.runManifestSha256, `Run manifest for ${direction}`);
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes);
    } catch {
      manifest = null;
    }
    if (!manifest || manifest.direction !== direction) {
      throw compileError(`Run manifest for ${direction} is unreadable or mislabeled`);
    }
    manifests[direction] = { entry, manifest };
    trackRows[WALK_TRACK].push({
      direction,
      frameCount: (manifest.frames || []).length,
      declaredFrameCount: manifest.frameCount,
      fps: manifest.frameRate,
    });
  }

  // Registration order, so the compiled grid's span order is stable regardless
  // of the order the rows happened to be collected in.
  const tracks = ANIMATION_TRACK_IDS
    .filter((id) => trackRows[id]?.length)
    .map((id) => resolveTrackUniformity(id, trackRows[id], {
      error: compileError,
      defaultFps: LEGACY_MANIFEST_FPS[id],
      // The count this loop actually collected against, not a re-derivation.
      expectedRows: trackDirections(id, SPRITE_DIRECTIONS).length,
    }));
  const walk = tracks.find((t) => t.id === WALK_TRACK);

  const runs = {};
  for (const direction of walkDirections) {
    const { entry, manifest } = manifests[direction];
    // Same frame-validity definition the approve gate uses (verifyPackagedFrames),
    // here in its byte-verifying mode: existence + per-frame sha256 + gait-phase/
    // order, reading each frame's bytes exactly once for read-once-verify-in-memory.
    // Approve runs the existence-only prefix, so a set that passed approve cannot
    // fail this for frame-existence reasons (#3001).
    const { frameBytes } = await verifyPackagedFrames(recordId, manifest, { bytes: true });
    runs[direction] = { runId: entry.runId, manifestPath: entry.runManifest, manifest, frameBytes };
  }

  return {
    walkSet,
    walkSetPath: walkSetRel,
    walkSetSha256: sha256Buffer(walkSetBytes),
    referenceManifest,
    chromaKey,
    anchors,
    runs,
    tracks,
    // The walk view of `tracks`, kept because the published geometry names these
    // exact fields in the runtime contract (walkFrameCount / walkFps).
    walkFrameCount: walk?.frameCount ?? null,
    walkFps: walk?.fps ?? null,
  };
}

async function compileDirectionRow(recordId, direction, validated, geometry) {
  const split = keyChannelSplit(validated.chromaKey);
  const { manifest, runId, manifestPath, frameBytes } = validated.runs[direction];

  const walkSources = [];
  for (const bytes of frameBytes) {
    walkSources.push(await transparentSource(bytes, split, validated.chromaKey));
  }
  const dims = walkSources.map((f, i) => occupiedDimensions(f, ALPHA_THRESHOLD, `${direction}-${manifest.frames[i].phase}`, true));
  const directionScale = Math.min(
    geometry.targetMaxHeight / Math.max(...dims.map((d) => d.height)),
    geometry.targetMaxWidth / Math.max(...dims.map((d) => d.width)),
  );

  const cells = [];
  const anchor = validated.anchors[direction];
  const idleSource = await transparentSource(anchor.bytes, split, validated.chromaKey);
  const idleDims = occupiedDimensions(idleSource, SILHOUETTE_ALPHA_THRESHOLD, `${direction}-idle`);
  const desiredIdleHeight = median(dims.map((d) => d.height)) * directionScale;
  const idleScale = Math.min(desiredIdleHeight / idleDims.height, geometry.targetMaxWidth / idleDims.width);
  const idleLabel = `${direction}-idle`;
  const idleScaled = await scaleForCell(idleSource, idleScale, idleLabel);
  // The idle anchor is a raw reference with no packer alignment behind it, so
  // its hip is measured directly — the same `rootX` band the packer uses. It
  // must be hip-anchored like the walk cells rather than silhouette-centred: the
  // two rules differ by however far the hip sits off centre, and with idle on one
  // rule and walk on the other the character visibly pops sideways the instant
  // the game starts or stops the gait (#3021). Measured at the silhouette
  // threshold, matching how this cell's scale was derived.
  const idleHipX = rootX(idleScaled.scaled, alphaBbox(idleScaled.scaled, SILHOUETTE_ALPHA_THRESHOLD) || idleScaled.bounds);
  const idle = placeCell(
    idleScaled.scaled, idleScaled.bounds, idleScaled.baseline,
    sharedRowPasteX(pyRound(geometry.pivot[0] - idleHipX), [idleScaled.bounds], geometry),
    idleLabel, geometry, idleScale,
  );
  if (Math.abs(idle.meta.occupiedBounds.height - desiredIdleHeight) > IDLE_HEIGHT_TOLERANCE) {
    throw compileError(`${direction} idle height ${idle.meta.occupiedBounds.height} misses the walk median ${pyRoundTo(desiredIdleHeight, 2)}`);
  }
  cells.push({
    column: ATLAS_IDLE_COLUMN,
    // `track` + `frameIndex` are what place this cell in the grid: the compiler
    // looks the pair up in the track spans rather than trusting the order cells
    // happen to be pushed in (#3017). The idle anchor is a one-column track of
    // its own, exactly as the sidecar has always described it.
    track: ATLAS_IDLE_COLUMN,
    frameIndex: 0,
    ...idle,
    sourcePath: anchor.path,
    sourceSha256: anchor.sha256,
    policy: 'locked-directional-reference-anchor',
  });

  // The packer's pivot x, in the walk frame's own coordinates — the anchor every
  // frame of this direction already shares (#3021). Read from the manifest so a
  // future packer geometry change flows through instead of being duplicated
  // here; a manifest predating `alignment.targetPivot` falls back to the cell
  // centre, which is what WALK_PIVOT has always been.
  const packerPivotX = Number(manifest.alignment?.targetPivot?.[0]);
  const walkPivotX = Number.isFinite(packerPivotX)
    ? packerPivotX
    : (Number(manifest.alignment?.cellSize) || walkSources[0].width) / 2;

  // Scale every walk frame BEFORE placing any of them: the row's x is shared, so
  // it can only be corrected for cell-edge overflow once all the bounds are known.
  const walkScaled = [];
  for (let i = 0; i < walkSources.length; i++) {
    walkScaled.push(await scaleForCell(walkSources[i], directionScale, `${direction}-${manifest.frames[i].phase}`));
  }
  const walkPasteX = sharedRowPasteX(
    pyRound(geometry.pivot[0] - walkPivotX * directionScale),
    walkScaled.map((w) => w.bounds),
    geometry,
  );

  for (let i = 0; i < walkScaled.length; i++) {
    const frame = manifest.frames[i];
    const { scaled, bounds, baseline } = walkScaled[i];
    const normalized = placeCell(scaled, bounds, baseline, walkPasteX, `${direction}-${frame.phase}`, geometry, directionScale);
    cells.push({
      column: frame.phase,
      track: WALK_TRACK,
      frameIndex: i,
      ...normalized,
      sourcePath: frame.path,
      sourceSha256: frame.sha256,
    });
  }

  return {
    direction,
    runId,
    runManifestPath: manifestPath,
    walkDirectionScale: pyRoundTo(directionScale, 8),
    idleScale: pyRoundTo(idleScale, 8),
    idlePolicy: 'locked-directional-reference-anchor',
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

export async function compileAtlasInTail(recordId, { geometry: geometryOverride } = {}) {
  // The track-presence gate (#3017), not a literal kind check: a record may
  // compile an atlas when its kind carries at least one registered animation
  // track. Walk is character-only, so this refuses exactly what it always did —
  // but registering a non-directional ambient track that lists `place`/`object`
  // unlocks those records here with no edit to this line.
  await requireAnimatable(recordId);
  const geometry = mergeGeometry(geometryOverride);
  const validated = await validateForCompile(recordId);
  const dir = spriteDir(recordId);

  // Columns/width follow the set's actual per-track frame counts, not the
  // historical 8 — and `tracks` names each track's `{ start, count }` span, so
  // the grid, the manifest geometry and the published sidecar can never
  // disagree about where a track's columns are.
  const { columns, tracks } = buildAtlasGrid(validated.tracks);

  // Pre-pixel idempotency: the compile is deterministic, so an unchanged
  // walk set + identical geometry means identical bytes by construction —
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
  const current = await readJSONFile(join(dir, RUNTIME_POINTER_REL), null);
  const currentAtlasOnDisk = current ? await pathExists(join(dir, current.atlasPath)) : false;
  if (
    current
    && currentAtlasOnDisk
    && current.walkSetSha256 === validated.walkSetSha256
    && compiledGridUpToDate(current.geometry, { ...geometry, columns, tracks })
  ) {
    return { ...current, created: false };
  }

  // compileDirectionRow still emits `idle` + this direction's walk frames, and
  // verifyPackagedFrames has already asserted each frame's phase against the
  // walk labels. What #3017 changes is that placement no longer *assumes* that:
  // every cell states its `track` and `frameIndex` and is placed through the
  // grid's spans, so a track that occupies fewer columns or fewer rows lands
  // where the sidecar says it does or the compile fails loudly. Producing the
  // frames for a second track is still #3018's job; this is the grid contract
  // that track will slot into.
  const rows = [];
  for (const direction of SPRITE_DIRECTIONS) {
    rows.push(await compileDirectionRow(recordId, direction, validated, geometry));
  }

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

  if (current && currentAtlasOnDisk && current.walkSetSha256 === validated.walkSetSha256 && current.atlasSha256 === atlasSha256) {
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
    const survivor = await readJSONFile(join(runtimeAbs, `v${version}`, `${stem}-v${version}-manifest.json`), null);
    if (!survivor || survivor.atlasSha256 === atlasSha256) break;
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
  const survivingManifest = await readJSONFile(manifestAbs, null);
  if (survivingManifest?.atlasSha256 === atlasSha256) {
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
      walkSetSha256: validated.walkSetSha256,
      geometry: survivingManifest.geometry,
      compiledAt: survivingManifest.createdAt,
    };
    await atomicWrite(join(dir, RUNTIME_POINTER_REL), pointer);
    console.log(`🧩 sprite atlas re-materialized for ${recordId} → v${version}`);
    return { ...pointer, created: true };
  }

  const manifest = {
    schemaVersion: 1,
    kind: 'reviewed-walk-set-runtime-atlas',
    characterId: recordId,
    version,
    createdAt: new Date().toISOString(),
    chromaKey: validated.chromaKey,
    compilerPath: 'server/services/sprites/atlas.js',
    walkSetPath: validated.walkSetPath,
    walkSetSha256: validated.walkSetSha256,
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
    },
    directions: rows.map((row) => ({
      direction: row.direction,
      runId: row.runId,
      runManifestPath: row.runManifestPath,
      walkDirectionScale: row.walkDirectionScale,
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
    walkSetSha256: validated.walkSetSha256,
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
    readJSONFile(join(dir, RUNTIME_POINTER_REL), null),
    readJSONFile(join(dir, RUNTIME_PUBLICATIONS_REL), []),
  ]);
  return { current, publications: [...publications].reverse() };
}
