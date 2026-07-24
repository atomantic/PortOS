/**
 * Sprites — runtime atlas compiler (issue #2898, phase 4).
 *
 * Compiles the immutable runtime sprite-sheet from a finalized eight-direction
 * walk set: an (idle + N walk phases)-column × 8-row grid (× S/SE/E/
 * NE/N/NW/W/SW) of fixed-size cells, each frame scaled once per direction and
 * translated so its silhouette centers on the pivot x and its feet land exactly
 * on the pivot ground line. N (the walk frame count) is read from the approved
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
} from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS } from './prompts.js';
import { keyChannelSplit } from './chromaKey.js';
import {
  WALK_PHASES, walkPhaseLabels, WALK_MIN_FRAME_COUNT, WALK_MAX_FRAME_COUNT,
  WALK_MIN_FPS, WALK_MAX_FPS, WALK_FPS,
  pyRound, pyRoundTo, median, decodeRgbaFrame, premultipliedResize,
  sampleBorderKey, validateMeasuredKey, recoverAlphaFrame, despillKeyFrame,
  alphaBbox, compositeOnto, sha256Buffer,
} from './walkPostprocess.js';
import { ATLAS_IDLE_COLUMN } from './walkBounds.js';
import { withWalkWriteTail, walkSetRelPath, isImportedWalkSet } from './walk.js';

// Player atlas contract (source pipeline runtime_publish.py): 96px cells,
// pivot (48,88) — silhouette centered on x=48, feet on the y=88 ground line —
// content bounded to 86×74 so nothing touches a cell edge.
//
// The runtime grid is `idle` + the N walk-phase columns. N is the walk set's
// frame count (variable-frame walks: #sprite-walk-variable-frames); it is read
// from the approved run manifests, not hardcoded, so the atlas width
// grows/shrinks with the chosen count. ATLAS_COLUMNS is the historical 8-frame
// layout, kept as the default/fallback; atlasColumns(labels) builds the actual
// column list a given compile uses.
//
// A trailing `scanner` column used to follow the walk phases — a verbatim copy
// of the idle cell that no consumer ever sampled (#2986). It is no longer
// compiled: an action animation is its own named track (per-track spans in the
// layout sidecar, atlasLayout.js), not a column bolted onto the walk cycle.
// Imported/legacy atlases and manifests that still carry the column keep
// loading and displaying unchanged — this is a write-side change only.
export const atlasColumns = (walkLabels) => [ATLAS_IDLE_COLUMN, ...walkLabels];
export const ATLAS_COLUMNS = atlasColumns(WALK_PHASES);
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

function occupiedDimensions(frame, threshold, label) {
  const bounds = alphaBbox(frame, threshold);
  if (!bounds) throw compileError(`${label} has no visible pixels`);
  return { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
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
 * Scale a source frame once and translate it into a cell so the silhouette
 * centers on pivot x with its feet exactly on the pivot ground line —
 * translation-only placement, refusing any content that touches a cell edge.
 */
async function normalizeCellFrame(source, scale, label, geometry) {
  const { cellSize, pivot } = geometry;
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
  const centerX = (bounds.left + bounds.right - 1) / 2;
  const pasteX = pyRound(pivot[0] - centerX);
  const pasteY = pivot[1] - (bounds.bottom - 1);
  if (pasteX + bounds.left <= 0 || pasteY + bounds.top <= 0) {
    throw compileError(`${label} touches the top or left runtime cell edge`);
  }
  if (pasteX + bounds.right >= cellSize || pasteY + bounds.bottom >= cellSize) {
    throw compileError(`${label} touches the right or bottom runtime cell edge`);
  }
  const cell = { data: Buffer.alloc(cellSize * cellSize * 4), width: cellSize, height: cellSize };
  compositeOnto(cell, scaled, pasteX, pasteY);
  // Port-faithful belt-and-braces: re-measure the composed cell and verify
  // the feet really sit on the ground line (runtime_publish.py does the same
  // final _bounds check rather than trusting the placement math).
  const final = alphaBbox(cell, ALPHA_THRESHOLD);
  if (!final || final.bottom - 1 !== pivot[1]) {
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
  // Phase-1 imported walk sets are copied verbatim from the source pipeline:
  // their paths are repo-root (`art-source/sprites/<id>/…`) and — decisively —
  // the packaged per-frame PNGs were never imported (the importer skips
  // frames/ to minimize copies). Recompiling them here is structurally
  // impossible; say so plainly instead of a misleading tamper error. Their
  // already-published runtime atlases were imported and remain browsable.
  // Shared predicate (walk.js) so this recompile guard and unlockWalkSet's
  // stay in lockstep on what counts as a legacy import.
  if (isImportedWalkSet(walkSet)) {
    throw new ServerError(
      'This walk set was imported from the source pipeline — its packaged frames were not imported, so PortOS cannot recompile it. Imported runtime atlases remain available in the asset library; to compile here, run the walk workflow on a new character.',
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

  const runs = {};
  // Resolved from the first approved direction, then enforced identical across
  // the rest (see the loop body). null until the first direction is read.
  let frameCount = null;
  let walkFps = null;
  let walkLabels = null;
  for (const direction of SPRITE_DIRECTIONS) {
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
    const frames = manifest.frames || [];
    // Frame count is variable, but every direction in ONE atlas MUST share it —
    // the atlas is a rectangular grid, so a ragged set can't compile. The first
    // approved direction sets N; the rest must match. N must also be in range and
    // agree with the manifest's declared frameCount.
    if (frameCount === null) {
      frameCount = frames.length;
      if (!Number.isInteger(frameCount)
        || frameCount < WALK_MIN_FRAME_COUNT || frameCount > WALK_MAX_FRAME_COUNT) {
        throw compileError(`Direction ${direction} has ${frames.length} frames — outside the supported ${WALK_MIN_FRAME_COUNT}–${WALK_MAX_FRAME_COUNT} range`);
      }
      walkLabels = walkPhaseLabels(frameCount);
    } else if (frames.length !== frameCount) {
      throw compileError(`Direction ${direction} has ${frames.length} frames but the set uses ${frameCount} — reprocess all directions to the same frame count before compiling`);
    }
    if (Number.isInteger(manifest.frameCount) && manifest.frameCount !== frames.length) {
      throw compileError(`Direction ${direction} manifest declares ${manifest.frameCount} frames but carries ${frames.length}`);
    }
    // Playback fps likewise must agree across directions so the whole walk set
    // animates at one speed. Range-checked; falls back to the legacy 12 for
    // pre-fps manifests so older sets still compile.
    const dirFps = Number.isFinite(manifest.frameRate) ? manifest.frameRate : WALK_FPS;
    if (dirFps < WALK_MIN_FPS || dirFps > WALK_MAX_FPS) {
      throw compileError(`Direction ${direction} playback fps ${dirFps} is outside the supported ${WALK_MIN_FPS}–${WALK_MAX_FPS} range`);
    }
    if (walkFps === null) {
      walkFps = dirFps;
    } else if (dirFps !== walkFps) {
      throw compileError(`Direction ${direction} plays at ${dirFps} fps but the set uses ${walkFps} — reprocess all directions to the same speed before compiling`);
    }
    const frameBytes = [];
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].phase !== walkLabels[i] || frames[i].outputIndex !== i) {
        throw compileError(`Direction ${direction} frame ${i} is out of gait-phase order`);
      }
      frameBytes.push(await readVerified(frames[i].path, frames[i].sha256, `Direction ${direction} frame ${frames[i].phase}`));
    }
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
    walkFrameCount: frameCount,
    walkFps,
    walkLabels,
  };
}

async function compileDirectionRow(recordId, direction, validated, geometry) {
  const split = keyChannelSplit(validated.chromaKey);
  const { manifest, runId, manifestPath, frameBytes } = validated.runs[direction];

  const walkSources = [];
  for (const bytes of frameBytes) {
    walkSources.push(await transparentSource(bytes, split, validated.chromaKey));
  }
  const dims = walkSources.map((f, i) => occupiedDimensions(f, ALPHA_THRESHOLD, `${direction}-${manifest.frames[i].phase}`));
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
  const idle = await normalizeCellFrame(idleSource, idleScale, `${direction}-idle`, geometry);
  if (Math.abs(idle.meta.occupiedBounds.height - desiredIdleHeight) > IDLE_HEIGHT_TOLERANCE) {
    throw compileError(`${direction} idle height ${idle.meta.occupiedBounds.height} misses the walk median ${pyRoundTo(desiredIdleHeight, 2)}`);
  }
  cells.push({
    column: ATLAS_IDLE_COLUMN,
    ...idle,
    sourcePath: anchor.path,
    sourceSha256: anchor.sha256,
    policy: 'locked-directional-reference-anchor',
  });

  for (let i = 0; i < walkSources.length; i++) {
    const frame = manifest.frames[i];
    const normalized = await normalizeCellFrame(walkSources[i], directionScale, `${direction}-${frame.phase}`, geometry);
    cells.push({ column: frame.phase, ...normalized, sourcePath: frame.path, sourceSha256: frame.sha256 });
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
  await requireCharacter(recordId);
  const geometry = mergeGeometry(geometryOverride);
  const validated = await validateForCompile(recordId);
  const dir = spriteDir(recordId);

  // Columns/width follow the set's actual frame count, not the historical 8.
  const columns = atlasColumns(validated.walkLabels);

  // Pre-pixel idempotency: the compile is deterministic, so an unchanged
  // walk set + identical geometry means identical bytes by construction —
  // skip the whole pixel pipeline. The evidence chain was still revalidated
  // above; the post-encode sha comparison below stays as the fallback for a
  // pointer whose geometry fields predate a shape change.
  // The COLUMN LIST is part of that geometry comparison, not just the cell
  // metrics: a grid-shape change (#2986 dropping the trailing scanner column)
  // leaves every cell metric identical, so without it a pre-#2986 pointer would
  // be returned as up-to-date and the stale wider atlas would never recompile.
  // A pointer predating the columns field at all (undefined) also falls through,
  // which is correct — the post-encode sha compare then decides.
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
    && current.geometry?.cellSize === geometry.cellSize
    && JSON.stringify(current.geometry?.pivot) === JSON.stringify(geometry.pivot)
    && current.geometry?.targetMaxHeight === geometry.targetMaxHeight
    && current.geometry?.targetMaxWidth === geometry.targetMaxWidth
    && JSON.stringify(current.geometry?.columns) === JSON.stringify(columns)
  ) {
    return { ...current, created: false };
  }

  const rows = [];
  for (const direction of SPRITE_DIRECTIONS) {
    rows.push(await compileDirectionRow(recordId, direction, validated, geometry));
  }

  const { cellSize } = geometry;
  const atlasWidth = cellSize * columns.length;
  const atlasHeight = cellSize * SPRITE_DIRECTIONS.length;
  const atlas = { data: Buffer.alloc(atlasWidth * atlasHeight * 4), width: atlasWidth, height: atlasHeight };
  for (let r = 0; r < rows.length; r++) {
    rows[r].cells.forEach((cell, c) => compositeOnto(atlas, cell.cell, c * cellSize, r * cellSize));
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
      cells: row.cells.map((cell, c) => ({
        column: cell.column,
        columnIndex: c,
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
