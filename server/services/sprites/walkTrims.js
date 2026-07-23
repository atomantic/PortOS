/**
 * Sprites — non-destructive loop trimmer (issue #2897, phase 3).
 *
 * Port of the source pipeline's `loop_trims.save_loop_trim`: crop the
 * enabled cells out of a packed atlas row (never mutating the atlas),
 * re-pack them as a trimmed strip + preview GIF + manifest, versioned
 * `<slug>-vNNN` so every trim is additive evidence. PortOS scopes trims to
 * the record (`walk/trims/`) instead of the source's global debug-captures
 * root, and encodes the GIF with ffmpeg (palettegen/paletteuse with
 * transparency) since PIL's GIF writer has no Node sibling.
 */

import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { ensureDir, atomicWrite, pathExists, sha256File } from '../../lib/fileUtils.js';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { ServerError } from '../../lib/errorHandler.js';
import { spriteDir, resolveSpriteAssetPath } from './paths.js';
import { requireCharacter } from './reference.js';

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
 * Save one loop trim. `payload` is route-validated (spriteWalkTrimSchema):
 * slug, atlasPath (record-relative), row, cellWidth/cellHeight, fps,
 * allColumns, enabledColumns (subset), optional sourceFrameIndices/Labels.
 */
export async function saveLoopTrim(recordId, payload) {
  await requireCharacter(recordId);
  const {
    slug, atlasPath, row, cellWidth, cellHeight, fps, allColumns, enabledColumns,
  } = payload;
  if (!enabledColumns.every((c) => allColumns.includes(c))) {
    throw new ServerError('enabledColumns must be a subset of allColumns', { status: 400, code: 'TRIM_COLUMNS_INVALID' });
  }
  const sourceFrameIndices = payload.sourceFrameIndices ?? enabledColumns;
  if (sourceFrameIndices.length !== enabledColumns.length) {
    throw new ServerError('sourceFrameIndices must match enabledColumns length', { status: 400, code: 'TRIM_COLUMNS_INVALID' });
  }
  const sourceFrameLabels = (payload.sourceFrameLabels ?? sourceFrameIndices.map(String))
    .map((l) => String(l).slice(0, 80));
  if (sourceFrameLabels.length !== enabledColumns.length) {
    throw new ServerError('sourceFrameLabels must match enabledColumns length', { status: 400, code: 'TRIM_COLUMNS_INVALID' });
  }

  const atlasAbs = resolveSpriteAssetPath(recordId, atlasPath);
  if (!await pathExists(atlasAbs)) {
    throw new ServerError(`Atlas not found: ${atlasPath}`, { status: 404, code: 'ATLAS_NOT_FOUND' });
  }
  const { data, info } = await sharp(atlasAbs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const maxColumn = Math.max(...allColumns);
  if ((maxColumn + 1) * cellWidth > info.width || (row + 1) * cellHeight > info.height) {
    throw new ServerError('Requested cells fall outside the atlas', { status: 400, code: 'TRIM_BOUNDS_INVALID' });
  }

  // Crop the enabled cells — straight pixel copies, no resampling.
  const frames = enabledColumns.map((col) => {
    const out = Buffer.alloc(cellWidth * cellHeight * 4);
    for (let y = 0; y < cellHeight; y++) {
      const srcStart = (((row * cellHeight) + y) * info.width + col * cellWidth) * 4;
      data.copy(out, y * cellWidth * 4, srcStart, srcStart + cellWidth * 4);
    }
    return { data: out, width: cellWidth, height: cellHeight };
  });

  const trimsAbs = join(spriteDir(recordId), TRIMS_DIR);
  await ensureDir(trimsAbs);
  const prefix = await nextTrimPrefix(trimsAbs, slug);

  const strip = Buffer.alloc(cellWidth * frames.length * cellHeight * 4);
  frames.forEach((frame, i) => {
    for (let y = 0; y < cellHeight; y++) {
      frame.data.copy(
        strip,
        (y * cellWidth * frames.length + i * cellWidth) * 4,
        y * cellWidth * 4,
        (y + 1) * cellWidth * 4,
      );
    }
  });
  const stripName = `${prefix}-strip.png`;
  const stripAbs = join(trimsAbs, stripName);
  await sharp(strip, { raw: { width: cellWidth * frames.length, height: cellHeight, channels: 4 } })
    .png()
    .toFile(stripAbs);

  const gifName = `${prefix}.gif`;
  await encodeTrimGif(frames, fps, join(trimsAbs, gifName));

  const manifest = {
    schemaVersion: 1,
    kind: 'animation-loop-trim',
    status: 'candidate',
    sourceAtlasPath: atlasPath,
    sourceAtlasSha256: await sha256File(atlasAbs),
    row,
    cellWidth,
    cellHeight,
    fps,
    allAtlasColumns: allColumns,
    enabledAtlasColumns: enabledColumns,
    disabledAtlasColumns: allColumns.filter((c) => !enabledColumns.includes(c)),
    selectedFrames: enabledColumns.map((atlasColumn, outputIndex) => ({
      outputIndex,
      atlasColumn,
      sourceFrameIndex: sourceFrameIndices[outputIndex],
      sourceFrameLabel: sourceFrameLabels[outputIndex],
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
