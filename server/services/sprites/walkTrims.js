/**
 * Sprites — non-destructive loop trimmer (issue #2897, phase 3).
 *
 * Port of the source pipeline's `loop_trims.save_loop_trim`, re-anchored on
 * the run manifest: the caller names a packaged candidate run and which of
 * its frames stay enabled; the strip path, cell geometry, fps, and frame
 * labels all come from the run's own postprocess manifest (the server-owned
 * source of truth), never from client-echoed geometry. Enabled cells are
 * cropped out of the packed strip (never mutating it) and re-packed as a
 * trimmed strip + preview GIF + manifest, versioned `<slug>-vNNN` so every
 * trim is additive evidence. Trims land under the record's `walk/trims/`
 * (the source pipeline's global debug-captures root, scoped per record);
 * the GIF is encoded with ffmpeg (palettegen/paletteuse with transparency)
 * since PIL's GIF writer has no Node sibling.
 */

import { join } from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import sharp from 'sharp';
import {
  ensureDir, atomicWrite, pathExists, sha256File, readJSONFile,
} from '../../lib/fileUtils.js';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveSpriteAssetPath, spriteDir, toRecordRelativeAssetPath } from './paths.js';
import { requireCharacter } from './reference.js';
import { withWalkWriteTail, getWalkState } from './walk.js';
import { WALK_FPS } from './walkPostprocess.js';

const TRIMS_DIR = 'walk/trims';
const MAX_TRIM_VERSION = 999;

// First free -vNNN triple (strip + gif + json all absent), matching the
// source's next_trim_prefix scan.
async function nextTrimPrefix(trimsAbs, slug) {
  for (let n = 1; n <= MAX_TRIM_VERSION; n++) {
    const prefix = `${slug}-v${String(n).padStart(3, '0')}`;
    const taken = await Promise.all(
      [`${prefix}-strip.png`, `${prefix}.gif`, `${prefix}.json`].map((f) => pathExists(join(trimsAbs, f))),
    );
    if (!taken.some(Boolean)) return prefix;
  }
  throw new ServerError(`No free trim version left for ${slug}`, { status: 409, code: 'TRIM_VERSIONS_EXHAUSTED' });
}

async function encodeTrimGif(frames, fps, destAbs) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found — install ffmpeg to render trim GIFs', { status: 503, code: 'FFMPEG_MISSING' });
  const scratch = await mkdtemp(join(tmpdir(), 'portos-sprite-trim-'));
  for (let i = 0; i < frames.length; i++) {
    await sharp(frames[i].data, { raw: { width: frames[i].width, height: frames[i].height, channels: 4 } })
      .png()
      .toFile(join(scratch, `frame-${String(i).padStart(3, '0')}.png`));
  }
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: [
      '-y', '-framerate', String(fps),
      '-i', join(scratch, 'frame-%03d.png'),
      '-filter_complex', '[0:v]split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128',
      '-loop', '0',
      destAbs,
    ],
  });
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  if (!result.ok) throw new ServerError(`GIF encode failed: ${result.reason}`, { status: 500, code: 'GIF_ENCODE_FAILED' });
}

/**
 * Save one loop trim for a packaged run. `payload` is route-validated
 * (spriteWalkTrimSchema): runId, enabledColumns, optional fps and slug.
 * Geometry and labels are derived from the run's postprocess manifest.
 * Runs inside the per-record walk write tail — nextTrimPrefix is a
 * scan-then-write, so two concurrent trims could otherwise both claim the
 * same -vNNN and interleave writes over each other's artifacts.
 */
export function saveLoopTrim(recordId, payload) {
  return withWalkWriteTail(recordId, () => saveLoopTrimImpl(recordId, payload));
}

/**
 * Normalize a run — whatever its on-disk layout — into the geometry the trim
 * re-pack needs: `{ direction, stripPath, cellSize, allColumns, phaseByColumn,
 * defaultFps }`. The run is resolved through the single layout-agnostic
 * resolver (`getWalkState`), so a native run (`runs/`, or legacy `grok/`), an
 * imported run, and an imagegen redraw run all trim through one path — no
 * vendor directory is assumed. A native packaged run derives its geometry from
 * the authoritative postprocess manifest (per-column gait-phase labels);
 * anything else derives it from the run's own `stripPreview` (a packed row of
 * `frameCount` square cells) and labels columns numerically.
 */
async function resolveTrimSource(recordId, runId) {
  const state = await getWalkState(recordId);
  const run = state.runs.find((r) => r.id === runId);
  if (!run) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });

  // `getWalkState` re-anchors an imported run's `postprocessManifest` for us
  // (walk.js#normalizeRunAssetPaths), so this is already record-relative.
  // Absent vs. malformed are deliberately NOT collapsed (#2978): a manifest file
  // that simply isn't there falls through to the stripPreview branch below, which
  // carries everything a trim needs; a manifest that EXISTS but is malformed is
  // real corruption and still throws. Conflating the two either blocks trimming a
  // perfectly good strip or silently papers over a broken manifest.
  const manifestAbs = run.postprocessManifest
    ? resolveSpriteAssetPath(recordId, run.postprocessManifest)
    : null;
  if (manifestAbs && await pathExists(manifestAbs)) {
    const packaged = await readJSONFile(manifestAbs, null);
    // An imported manifest's own stripPath is repo-anchored (`art-source/…`) —
    // re-anchor it before it reaches resolveSpriteAssetPath downstream.
    const stripPath = toRecordRelativeAssetPath(recordId, packaged?.stripPath);
    if (!stripPath || !packaged.alignment?.cellSize || !Array.isArray(packaged.frames)) {
      throw new ServerError('Packaged run manifest is missing or inconsistent', { status: 409, code: 'RUN_MANIFEST_INVALID' });
    }
    return {
      direction: run.direction,
      stripPath,
      cellSize: packaged.alignment.cellSize,
      allColumns: packaged.frames.map((f) => f.outputIndex),
      phaseByColumn: Object.fromEntries(packaged.frames.map((f) => [f.outputIndex, f.phase])),
      defaultFps: packaged.frameRate,
    };
  }

  const sp = run.stripPreview;
  const cellSize = Number(sp?.cellHeight) || Number(sp?.cellWidth);
  const frameCount = Number(sp?.frameCount);
  if (!sp?.stripPath || !Number.isInteger(frameCount) || frameCount < 2 || !(cellSize > 0)) {
    throw new ServerError('Run has no packaged candidate to trim', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  }
  // The re-pack crops square cells; a non-square-celled strip isn't trimmable.
  if (sp.cellWidth && sp.cellHeight && Number(sp.cellWidth) !== Number(sp.cellHeight)) {
    throw new ServerError('Non-square strip cells are not trimmable', { status: 409, code: 'RUN_STRIP_INVALID' });
  }
  return {
    direction: run.direction,
    stripPath: sp.stripPath,
    cellSize,
    allColumns: Array.from({ length: frameCount }, (_, i) => i),
    phaseByColumn: {},
    defaultFps: Number(sp.fps) > 0 ? Number(sp.fps) : WALK_FPS,
  };
}

async function saveLoopTrimImpl(recordId, payload) {
  await requireCharacter(recordId);
  const { runId, enabledColumns } = payload;
  const source = await resolveTrimSource(recordId, runId);
  const { stripPath, cellSize, allColumns, phaseByColumn } = source;
  const invalid = enabledColumns.filter((c) => !allColumns.includes(c));
  if (invalid.length) {
    throw new ServerError(`Enabled frames not in the packed strip: ${invalid.join(', ')}`, { status: 400, code: 'TRIM_COLUMNS_INVALID' });
  }
  const enabled = [...enabledColumns].sort((a, b) => a - b);
  const fps = payload.fps ?? source.defaultFps;
  const slug = payload.slug || `${source.direction}-loop`;

  const atlasAbs = resolveSpriteAssetPath(recordId, stripPath);
  if (!await pathExists(atlasAbs)) {
    throw new ServerError(`Packed strip not found: ${stripPath}`, { status: 404, code: 'ATLAS_NOT_FOUND' });
  }
  const { data, info } = await sharp(atlasAbs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if ((Math.max(...allColumns) + 1) * cellSize > info.width || cellSize > info.height) {
    throw new ServerError('Packed strip does not match its manifest geometry', { status: 409, code: 'RUN_STRIP_INVALID' });
  }

  // Crop the enabled cells — straight pixel copies, no resampling.
  const frames = enabled.map((col) => {
    const out = Buffer.alloc(cellSize * cellSize * 4);
    for (let y = 0; y < cellSize; y++) {
      const srcStart = (y * info.width + col * cellSize) * 4;
      data.copy(out, y * cellSize * 4, srcStart, srcStart + cellSize * 4);
    }
    return { data: out, width: cellSize, height: cellSize };
  });

  const trimsAbs = join(spriteDir(recordId), TRIMS_DIR);
  await ensureDir(trimsAbs);
  const prefix = await nextTrimPrefix(trimsAbs, slug);

  const strip = Buffer.alloc(cellSize * frames.length * cellSize * 4);
  frames.forEach((frame, i) => {
    for (let y = 0; y < cellSize; y++) {
      frame.data.copy(
        strip,
        (y * cellSize * frames.length + i * cellSize) * 4,
        y * cellSize * 4,
        (y + 1) * cellSize * 4,
      );
    }
  });
  const stripName = `${prefix}-strip.png`;
  const stripBuf = await sharp(strip, { raw: { width: cellSize * frames.length, height: cellSize, channels: 4 } })
    .png()
    .toBuffer();
  await writeFile(join(trimsAbs, stripName), stripBuf);

  const gifName = `${prefix}.gif`;
  await encodeTrimGif(frames, fps, join(trimsAbs, gifName));

  const manifest = {
    schemaVersion: 1,
    kind: 'animation-loop-trim',
    status: 'candidate',
    runId,
    sourceAtlasPath: stripPath,
    sourceAtlasSha256: await sha256File(atlasAbs),
    row: 0,
    cellWidth: cellSize,
    cellHeight: cellSize,
    fps,
    allAtlasColumns: allColumns,
    enabledAtlasColumns: enabled,
    disabledAtlasColumns: allColumns.filter((c) => !enabled.includes(c)),
    selectedFrames: enabled.map((atlasColumn, outputIndex) => ({
      outputIndex,
      atlasColumn,
      sourceFrameIndex: atlasColumn,
      sourceFrameLabel: phaseByColumn[atlasColumn] || String(atlasColumn),
    })),
    stripPath: `${TRIMS_DIR}/${stripName}`,
    gifPath: `${TRIMS_DIR}/${gifName}`,
  };
  await atomicWrite(join(trimsAbs, `${prefix}.json`), manifest);
  console.log(`✂️ sprite loop trim saved ${recordId}/${prefix} (${frames.length}/${allColumns.length} frames)`);
  return {
    strip: manifest.stripPath,
    loop: manifest.gifPath,
    manifest: `${TRIMS_DIR}/${prefix}.json`,
    frameCount: frames.length,
    disabledFrameCount: manifest.disabledAtlasColumns.length,
  };
}
