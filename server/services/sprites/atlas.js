/**
 * Sprites — runtime atlas compiler (issue #2898, phase 4).
 *
 * Compiles the immutable runtime sprite-sheet from a finalized eight-direction
 * walk set: a 10-column × 8-row grid (idle, the 8 named gait phases, scanner ×
 * S/SE/E/NE/N/NW/W/SW) of fixed-size cells, each frame scaled once per
 * direction and translated so its silhouette centers on the pivot x and its
 * feet land exactly on the pivot ground line. Ports the source pipeline's
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
import { readdir } from 'fs/promises';
import { createHash } from 'crypto';
import sharp from 'sharp';
import {
  atomicWrite, ensureDir, pathExists, readJSONFile, sha256File, tryReadFile,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { spriteDir } from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS } from './prompts.js';
import { keyChannelSplit } from './chromaKey.js';
import {
  WALK_PHASES, pyRound, pyRoundTo, median, decodeRgbaFrame, premultipliedResize,
  sampleBorderKey, validateMeasuredKey, recoverAlphaFrame, despillKeyFrame,
} from './walkPostprocess.js';
import { withWalkWriteTail } from './walk.js';

// Player atlas contract (source pipeline runtime_publish.py): 96px cells,
// pivot (48,88) — silhouette centered on x=48, feet on the y=88 ground line —
// content bounded to 86×74 so nothing touches a cell edge.
export const ATLAS_COLUMNS = ['idle', ...WALK_PHASES, 'scanner'];
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
const CURRENT_POINTER = 'runtime/current.json';
const atlasStem = (recordId) => `${recordId}-animation-atlas`;

const compileError = (message, code = 'ATLAS_COMPILE_INVALID') =>
  new ServerError(message, { status: 422, code });

const sha256Buffer = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Tight bbox of pixels with alpha > threshold; exclusive right/bottom. */
function thresholdBbox(frame, threshold) {
  const { data, width, height } = frame;
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  return { left, top, right: right + 1, bottom: bottom + 1 };
}

function occupiedDimensions(frame, threshold, label) {
  const bounds = thresholdBbox(frame, threshold);
  if (!bounds) throw compileError(`${label} has no visible pixels`);
  return { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
}

/**
 * Load a source image as a straight-alpha transparent frame. Already-keyed
 * sources (packaged walk frames) get a despill safety pass; opaque key-matte
 * sources (locked anchors) go through measured-key alpha recovery first —
 * the same treatment the walk postprocess gives its raw frames.
 */
async function transparentSource(absPath, split, keyHex) {
  const frame = await decodeRgbaFrame(absPath);
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
  const bounds = thresholdBbox(scaled, ALPHA_THRESHOLD);
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
  blitFrame(cell, scaled, pasteX, pasteY);
  const final = thresholdBbox(cell, ALPHA_THRESHOLD);
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

/** Copy a straight-alpha frame onto a transparent canvas (no overlap). */
function blitFrame(canvas, frame, dx, dy) {
  for (let y = 0; y < frame.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= canvas.height) continue;
    for (let x = 0; x < frame.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= canvas.width) continue;
      const si = (y * frame.width + x) * 4;
      if (frame.data[si + 3] === 0) continue;
      frame.data.copy(canvas.data, (ty * canvas.width + tx) * 4, si, si + 4);
    }
  }
}

/**
 * Revalidate the full evidence chain: finalized walk set → selection →
 * per-direction run manifests → packaged frame bytes, plus the locked
 * reference set's anchors. Returns everything the compiler consumes.
 */
export async function validateForCompile(recordId) {
  const dir = spriteDir(recordId);
  const walkSetAbs = join(dir, `walk/${recordId}-walk-set-v1.json`);
  const walkSet = await readJSONFile(walkSetAbs, null);
  if (!walkSet) throw compileError('No finalized walk set — approve all 8 directions first', 'WALK_SET_REQUIRED');
  if (walkSet.kind !== 'finalized-eight-direction-walk-set' || walkSet.status !== 'final') {
    throw compileError('Walk set manifest is not a finalized eight-direction walk set');
  }
  if (walkSet.characterId !== recordId) throw compileError('Walk set characterId mismatch');
  if (JSON.stringify(walkSet.directionOrder) !== JSON.stringify(SPRITE_DIRECTIONS)) {
    throw compileError('Walk set direction order does not match the runtime contract');
  }
  const selectionAbs = join(dir, walkSet.selectionPath);
  if ((await sha256File(selectionAbs)) !== walkSet.selectionSha256) {
    throw compileError('Walk selection file no longer matches its finalized sha256');
  }

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
    const anchorAbs = join(dir, anchor.path);
    if ((await sha256File(anchorAbs)) !== anchor.sha256) {
      throw compileError(`Anchor for ${direction} no longer matches its locked sha256`);
    }
    anchors[direction] = { ...anchor, abs: anchorAbs };
  }

  const runs = {};
  for (const direction of SPRITE_DIRECTIONS) {
    const entry = walkSet.directions?.[direction];
    if (!entry || entry.status !== 'approved') throw compileError(`Direction ${direction} is not approved`);
    const manifestAbs = join(dir, entry.runManifest);
    if ((await sha256File(manifestAbs)) !== entry.runManifestSha256) {
      throw compileError(`Run manifest for ${direction} no longer matches its approved sha256`);
    }
    const manifest = await readJSONFile(manifestAbs, null);
    if (!manifest || manifest.direction !== direction) {
      throw compileError(`Run manifest for ${direction} is unreadable or mislabeled`);
    }
    const frames = manifest.frames || [];
    if (frames.length !== WALK_PHASES.length) {
      throw compileError(`Direction ${direction} has ${frames.length} frames — expected ${WALK_PHASES.length}`);
    }
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].phase !== WALK_PHASES[i] || frames[i].outputIndex !== i) {
        throw compileError(`Direction ${direction} frame ${i} is out of gait-phase order`);
      }
      if ((await sha256File(join(dir, frames[i].path))) !== frames[i].sha256) {
        throw compileError(`Direction ${direction} frame ${frames[i].phase} no longer matches its packaged sha256`);
      }
    }
    runs[direction] = { runId: entry.runId, manifestPath: entry.runManifest, manifest };
  }

  return {
    walkSet,
    walkSetPath: `walk/${recordId}-walk-set-v1.json`,
    walkSetSha256: await sha256File(walkSetAbs),
    referenceManifest,
    chromaKey,
    anchors,
    runs,
  };
}

async function compileDirectionRow(recordId, direction, validated, geometry) {
  const dir = spriteDir(recordId);
  const split = keyChannelSplit(validated.chromaKey);
  const { manifest, runId, manifestPath } = validated.runs[direction];

  const walkSources = [];
  for (const frame of manifest.frames) {
    walkSources.push(await transparentSource(join(dir, frame.path), split, validated.chromaKey));
  }
  const dims = walkSources.map((f, i) => occupiedDimensions(f, ALPHA_THRESHOLD, `${direction}-${WALK_PHASES[i]}`));
  const directionScale = Math.min(
    geometry.targetMaxHeight / Math.max(...dims.map((d) => d.height)),
    geometry.targetMaxWidth / Math.max(...dims.map((d) => d.width)),
  );

  const cells = [];
  const anchor = validated.anchors[direction];
  const idleSource = await transparentSource(anchor.abs, split, validated.chromaKey);
  const idleDims = occupiedDimensions(idleSource, SILHOUETTE_ALPHA_THRESHOLD, `${direction}-idle`);
  const desiredIdleHeight = median(dims.map((d) => d.height)) * directionScale;
  const idleScale = Math.min(desiredIdleHeight / idleDims.height, geometry.targetMaxWidth / idleDims.width);
  const idle = await normalizeCellFrame(idleSource, idleScale, `${direction}-idle`, geometry);
  if (Math.abs(idle.meta.occupiedBounds.height - desiredIdleHeight) > IDLE_HEIGHT_TOLERANCE) {
    throw compileError(`${direction} idle height ${idle.meta.occupiedBounds.height} misses the walk median ${pyRoundTo(desiredIdleHeight, 2)}`);
  }
  cells.push({
    column: 'idle',
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

  cells.push({
    column: 'scanner',
    cell: { ...idle.cell, data: Buffer.from(idle.cell.data) },
    meta: idle.meta,
    sourcePath: anchor.path,
    sourceSha256: anchor.sha256,
    policy: 'locked-idle-placeholder',
  });

  return {
    direction,
    runId,
    runManifestPath: manifestPath,
    walkDirectionScale: pyRoundTo(directionScale, 8),
    idleScale: pyRoundTo(idleScale, 8),
    idlePolicy: 'locked-directional-reference-anchor',
    scannerPolicy: 'locked-idle-placeholder',
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

  const rows = [];
  for (const direction of SPRITE_DIRECTIONS) {
    rows.push(await compileDirectionRow(recordId, direction, validated, geometry));
  }

  const { cellSize } = geometry;
  const atlasWidth = cellSize * ATLAS_COLUMNS.length;
  const atlasHeight = cellSize * SPRITE_DIRECTIONS.length;
  const atlas = { data: Buffer.alloc(atlasWidth * atlasHeight * 4), width: atlasWidth, height: atlasHeight };
  for (let r = 0; r < rows.length; r++) {
    rows[r].cells.forEach((cell, c) => blitFrame(atlas, cell.cell, c * cellSize, r * cellSize));
  }
  const atlasBuffer = await sharp(atlas.data, { raw: { width: atlasWidth, height: atlasHeight, channels: 4 } })
    .png()
    .toBuffer();
  const atlasSha256 = sha256Buffer(atlasBuffer);

  const current = await readJSONFile(join(dir, CURRENT_POINTER), null);
  if (current && current.walkSetSha256 === validated.walkSetSha256 && current.atlasSha256 === atlasSha256) {
    return { ...current, created: false };
  }

  const stem = atlasStem(recordId);
  const runtimeAbs = join(dir, RUNTIME_DIR);
  const version = await nextAtlasVersion(runtimeAbs, stem);
  const versionRel = `${RUNTIME_DIR}/v${version}`;
  const atlasRel = `${versionRel}/${stem}-v${version}.png`;
  const manifestRel = `${versionRel}/${stem}-v${version}-manifest.json`;
  await ensureDir(join(dir, versionRel));
  await writeImmutable(join(dir, atlasRel), atlasBuffer);

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
      columns: ATLAS_COLUMNS,
      directionOrder: SPRITE_DIRECTIONS,
      rows: SPRITE_DIRECTIONS.length,
      cellSize,
      pivot: geometry.pivot,
      targetMaxHeight: geometry.targetMaxHeight,
      targetMaxWidth: geometry.targetMaxWidth,
      widthPx: atlasWidth,
      heightPx: atlasHeight,
    },
    directions: rows.map((row) => ({
      direction: row.direction,
      runId: row.runId,
      runManifestPath: row.runManifestPath,
      walkDirectionScale: row.walkDirectionScale,
      idleScale: row.idleScale,
      idlePolicy: row.idlePolicy,
      scannerPolicy: row.scannerPolicy,
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
  await writeImmutable(join(dir, manifestRel), manifestBuffer);

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
  await atomicWrite(join(dir, CURRENT_POINTER), pointer);
  console.log(`🧩 sprite atlas compiled for ${recordId} → v${version}`);
  return { ...pointer, created: true };
}

/** Atlas view for the detail endpoint: current pointer + publish history. */
export async function getAtlasState(recordId) {
  const dir = spriteDir(recordId);
  const [current, publications] = await Promise.all([
    readJSONFile(join(dir, CURRENT_POINTER), null),
    readJSONFile(join(dir, 'runtime/publications.json'), []),
  ]);
  return { current, publications: [...publications].reverse() };
}
