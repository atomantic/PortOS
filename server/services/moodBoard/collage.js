/**
 * Mood Board — collage compilation + video frame extraction.
 *
 * `composeBoardCollage` flattens every visual on a board into ONE near-square
 * grid image saved to the gallery, led by the board poster when it has one.
 * Image pins contribute themselves; video pins
 * are sampled into N evenly spaced frames, each becoming a cell. Text pins and
 * pins with no local file (external URLs not yet re-hosted) are skipped and
 * counted. `extractItemFrames` does the same sampling for a single video pin and
 * appends the frames to the board as image items.
 *
 * ffmpeg/sharp work runs OUTSIDE the board row lock; only the final append is a
 * locked write (store.appendImportedItems), which dedupes on `source`.
 */

import { createHash } from 'crypto';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, atomicWrite } from '../../lib/fileUtils.js';
import { findFfmpeg, runFfmpegProcess, probeVideoDuration, safeUnder } from '../../lib/ffmpeg.js';
import { assetBasename } from '../../lib/localImageFilename.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { boardItemLocalImage, squareGridDims, frameSampleTimes } from './logic.js';
import * as store from './db.js';
import { moodBoardItemCaption } from './styleContext.js';

export const MAX_FRAMES_PER_VIDEO = 24;
export const DEFAULT_CELL_SIZE = 512;
const MAX_COLLAGE_SIDE_PX = 8192;
const GAP_PX = 4;
const BG = { r: 15, g: 15, b: 15 };
const RESIZE_CONCURRENCY = 6;

function videoFilename(item) {
  if (item?.type !== 'video' || typeof item.mediaKey !== 'string' || !item.mediaKey.startsWith('video:')) return null;
  return assetBasename(item.mediaKey.slice('video:'.length)) || null;
}

async function requireBoard(boardId) {
  const board = await store.getBoard(boardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  return board;
}

/**
 * Sample `count` frames from a local video into `outDir` as `<prefix><i>.jpg`.
 * Returns the written paths in timeline order. Throws a 422 when ffmpeg is
 * missing, the file is unreadable, or no frame could be decoded.
 */
async function sampleVideoFrames(videoFile, count, outDir, prefix, picked = null) {
  const videoPath = safeUnder(PATHS.videos, videoFile);
  if (!videoPath) throw new ServerError('Invalid video reference', { status: 400, code: 'VALIDATION_ERROR' });
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg is not installed', { status: 422, code: 'FFMPEG_MISSING' });
  const duration = await probeVideoDuration(videoPath);
  if (!duration) throw new ServerError('Could not read that video (missing or unreadable)', { status: 422, code: 'VIDEO_UNREADABLE' });

  // Picked times are clamped just inside the end so the last frame still decodes.
  const times = picked ? picked.map((t) => Math.min(Math.max(0, t), Math.max(0, duration - 0.05))) : frameSampleTimes(duration, count);
  const paths = [];
  for (let i = 0; i < times.length; i++) {
    const out = join(outDir, `${prefix}${i + 1}.jpg`);
    // Input seek decodes forward from the prior keyframe to the exact time;
    // the frame is written at source resolution at JPEG's top quality.
    const result = await runFfmpegProcess({
      bin: ffmpeg,
      args: ['-ss', times[i].toFixed(3), '-i', videoPath, '-frames:v', '1', '-q:v', '1', '-qmin', '1', '-y', out],
      stderrTailBytes: 0,
    });
    if (result.ok) paths.push({ path: out, time: times[i] });
  }
  if (!paths.length) throw new ServerError('No frames could be extracted from that video', { status: 422, code: 'FRAME_EXTRACT_FAILED' });
  return paths;
}

/** Copy sampled frames into the gallery under stable, content-keyed names. */
async function storeFramesInGallery(frames, videoFile, count) {
  await ensureDir(PATHS.images);
  const key = createHash('sha1').update(`${videoFile}|${count}`).digest('hex').slice(0, 12);
  const names = [];
  for (let i = 0; i < frames.length; i++) {
    const name = `board-frame-${key}-${i + 1}of${count}.jpg`;
    await atomicWrite(join(PATHS.images, name), await readFile(frames[i].path));
    names.push(name);
  }
  return names;
}

// Picked frames are keyed by their time (to the millisecond), so picking the
// same moment twice dedupes and different picks never overwrite each other.
async function storePickedFramesInGallery(frames, videoFile) {
  await ensureDir(PATHS.images);
  const key = createHash('sha1').update(videoFile).digest('hex').slice(0, 12);
  const names = [];
  for (const frame of frames) {
    const name = `board-frame-${key}-at${Math.round(frame.time * 1000)}ms.jpg`;
    await atomicWrite(join(PATHS.images, name), await readFile(frame.path));
    names.push(name);
  }
  return names;
}

// Rounded to centiseconds before splitting, so 59.996 s reads 1:00.00, not 0:60.00.
const clock = (sec) => {
  const cs = Math.round(sec * 100);
  return `${Math.floor(cs / 6000)}:${((cs % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};

/**
 * Extract frames from one video pin and append them to the board as image
 * items: `count` evenly spaced frames, or the exact `times` (seconds) picked in
 * the frame picker. Re-running the same request is a no-op (source-deduped).
 * Returns `{ board, added, frames }`.
 */
export async function extractItemFrames(boardId, itemId, { count, times }) {
  const board = await requireBoard(boardId);
  const item = (board.items || []).find((it) => it.id === itemId);
  if (!item) throw new ServerError('Item not found', { status: 404, code: 'NOT_FOUND' });
  const file = videoFilename(item);
  if (!file) throw new ServerError('Only video items can have frames extracted', { status: 400, code: 'VALIDATION_ERROR' });

  const tmp = await mkdtemp(join(tmpdir(), 'portos-board-frames-'));
  try {
    const picked = Array.isArray(times) ? [...new Set(times.map((t) => Math.round(t * 1000) / 1000))].sort((a, b) => a - b) : null;
    const frames = await sampleVideoFrames(file, picked ? picked.length : count, tmp, 'f', picked);
    const names = picked ? await storePickedFramesInGallery(frames, file) : await storeFramesInGallery(frames, file, count);
    const label = (i) => (picked ? `frame at ${clock(frames[i].time)}` : `frame ${i + 1}/${count}`);
    // An imported video's caption is someone else's text; frames never copy it.
    const ownCaption = moodBoardItemCaption(item);
    const imported = names.map((name, i) => ({
      type: 'image',
      imageUrl: `/data/images/${name}`,
      source: picked ? `frame:${file}@${Math.round(frames[i].time * 1000)}ms` : `frame:${file}#${i + 1}of${count}`,
      caption: ownCaption ? `${ownCaption} (${label(i)})` : `${label(i)[0].toUpperCase()}${label(i).slice(1)} of ${file}`,
    }));
    // The append first names the frame files, so it commits under the backup lease (#9982).
    const { board: next, added } = await withBackupAssetPublication(() => store.appendImportedItems(boardId, imported));
    if (added) emitRecordUpdated('moodBoard', boardId);
    console.log(`🎞️ Mood board ${boardId}: extracted ${names.length} frame(s) from ${file}, added ${added}`);
    return { board: next, added, frames: names };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function resizeCell(source, cell) {
  return sharp(source).rotate().resize(cell, cell, { fit: 'cover', position: 'centre' }).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Compile the whole board into one square-ish grid image in the gallery.
 * Options: `framesPerVideo` (frames sampled from each video pin),
 * `addFramesToBoard` (also append those frames as board items), `cellSize`.
 * Returns `{ filename, url, width, height, cols, rows, cells, skipped, board }`.
 */
export async function composeBoardCollage(boardId, { framesPerVideo, addFramesToBoard = false, cellSize = DEFAULT_CELL_SIZE }) {
  const board = await requireBoard(boardId);
  const items = Array.isArray(board.items) ? board.items : [];
  const tmp = await mkdtemp(join(tmpdir(), 'portos-board-collage-'));
  try {
    const sources = []; // file paths or Buffers, in board order
    const imported = [];
    let skipped = 0;

    // The board's poster is its cover image: it leads the grid. A pin of the
    // same file is not repeated.
    const posterName = typeof board.posterImageRef === 'string' ? assetBasename(board.posterImageRef.trim()) : null;
    const posterPath = posterName ? safeUnder(PATHS.images, posterName) : null;
    if (posterPath) sources.push(posterPath);

    for (const item of items) {
      if (item.type === 'image') {
        const local = boardItemLocalImage(item);
        const dir = local?.kind === 'image' ? PATHS.images : local?.kind === 'image-ref' ? PATHS.imageRefs : null;
        const path = dir ? safeUnder(dir, local.filename) : null;
        if (!path) skipped += 1;
        else if (path !== posterPath) sources.push(path);
      } else if (item.type === 'video') {
        const file = videoFilename(item);
        if (!file) { skipped += 1; continue; }
        const frames = await sampleVideoFrames(file, framesPerVideo, tmp, `${item.id}-`).catch((err) => {
          console.warn(`⚠️ Mood board ${boardId}: collage skipped video ${file}: ${err.message}`);
          return [];
        });
        if (!frames.length) { skipped += 1; continue; }
        sources.push(...frames.map((f) => f.path));
        if (addFramesToBoard) {
          const ownCaption = moodBoardItemCaption(item);
          const names = await storeFramesInGallery(frames, file, framesPerVideo);
          names.forEach((name, i) => imported.push({
            type: 'image',
            imageUrl: `/data/images/${name}`,
            source: `frame:${file}#${i + 1}of${framesPerVideo}`,
            caption: ownCaption ? `${ownCaption} (frame ${i + 1}/${framesPerVideo})` : `Frame ${i + 1}/${framesPerVideo} of ${file}`,
          }));
        }
      } // text pins carry no image — not a collage cell, not counted as skipped
    }

    if (!sources.length) throw new ServerError('This board has no local images or videos to compile', { status: 422, code: 'NOTHING_TO_COMPOSE' });

    const { cols, rows } = squareGridDims(sources.length);
    const cell = Math.max(64, Math.min(cellSize, Math.floor((MAX_COLLAGE_SIDE_PX - GAP_PX * (cols + 1)) / cols)));
    const width = cols * cell + GAP_PX * (cols + 1);
    const height = rows * cell + GAP_PX * (rows + 1);

    const buffers = [];
    for (let i = 0; i < sources.length; i += RESIZE_CONCURRENCY) {
      const batch = sources.slice(i, i + RESIZE_CONCURRENCY);
      const results = await Promise.all(batch.map((s) => resizeCell(s, cell).catch(() => null)));
      buffers.push(...results);
    }
    const composites = buffers.filter(Boolean);
    skipped += buffers.length - composites.length;
    if (!composites.length) throw new ServerError('None of the board images could be decoded', { status: 422, code: 'NOTHING_TO_COMPOSE' });

    // Re-pack decoded cells so a failed decode leaves no hole, centering a short last row.
    const placed = composites.map((input, idx) => {
      const row = Math.floor(idx / cols);
      const inRow = row === rows - 1 ? composites.length - row * cols : cols;
      const offset = Math.floor(((cols - inRow) * (cell + GAP_PX)) / 2);
      return { input, left: GAP_PX + offset + (idx % cols) * (cell + GAP_PX), top: GAP_PX + row * (cell + GAP_PX) };
    });

    const jpeg = await sharp({ create: { width, height, channels: 3, background: BG } })
      .composite(placed)
      .jpeg({ quality: 90 })
      .toBuffer();

    await ensureDir(PATHS.images);
    const filename = `board-collage-${boardId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}-${Date.now()}.jpg`;
    await atomicWrite(join(PATHS.images, filename), jpeg);

    // The frame items and the collage ref first name files written above, so
    // both commit under one backup lease (#9982).
    const nextBoard = await withBackupAssetPublication(async () => {
      if (imported.length) await store.appendImportedItems(boardId, imported);
      return store.updateBoard(boardId, { collageImageRef: filename });
    });
    emitRecordUpdated('moodBoard', boardId);
    console.log(`🧩 Mood board ${boardId}: collage ${cols}x${rows} (${composites.length} cells, ${skipped} skipped) → ${filename}`);
    return { filename, url: `/data/images/${filename}`, width, height, cols, rows, cells: composites.length, skipped, board: nextBoard };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
