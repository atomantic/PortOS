/**
 * What has been rendered for each shot of a Blender film, read from the
 * workspace: the preview and final shot videos (render.json beside each), the
 * stills, and a saved .blend. Nothing is cached or stored on the project;
 * "stale" compares a render's recorded hashes with the source, settings and
 * film options as they are when this is read.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  blenderEffectiveOptions, blenderShotFrameRange, blenderShotHandleRanges, normalizeBlenderHandles,
} from '../../lib/musicVideoBlender.js';
import { blenderMediaPath, blenderShotDir, readBlenderJson } from './workspace.js';
import { BLENDER_NO_OPTIONS_HASH, blenderImportsChanged, blenderOptionsHash, blenderSettingsHash, blenderShotHash, blenderSongHash, codeModuleClosures, hashBlenderSources } from './hashing.js';
import { getBlenderSong } from './song.js';

export const BLENDER_RENDER_QUALITIES = Object.freeze(['preview', 'final']);
const FRAME_NAME = /^frame_(\d{6,})\.(?:jpg|png)$/;
const HANDLE_FRAME_NAME = /^handle_(in|out)_(\d{6,})\.(?:jpg|png)$/;
const frameExtension = (quality) => (quality === 'preview' || quality === 'sheet' ? 'jpg' : 'png');

const isFile = async (path) => (await lstat(path).catch(() => null))?.isFile() === true;

export const blenderRenderFile = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'render.json');
export const blenderShotVideo = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'shot.mp4');
/** A small JPEG of the shot's middle frame, made when its video is encoded: it outlives the frames. */
export const blenderShotPoster = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'poster.jpg');
export const blenderFramesDir = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'frames');
/** Code layers of one shot: `layers/<index>/` beside `frames/`, PNG with alpha. */
export const blenderLayersRoot = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'layers');
/** Handle frames with code layers already painted on, so a cut reads the same picture as the shot. */
export const blenderCompositedHandlesDir = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'handles');
export const blenderCompositedHandleName = (side, frame) => `handle_${side}_${String(frame).padStart(6, '0')}.png`;
export const blenderCompositedHandlePattern = (side) => `handle_${side}_%06d.png`;
export const blenderLayerFramesDir = (owner, shotId, quality, index) => join(blenderLayersRoot(owner, shotId, quality), String(index));
export const blenderFrameName = (frame, quality) => `frame_${String(frame).padStart(6, '0')}.${frameExtension(quality)}`;
export const blenderHandleFrameName = (side, frame, quality) => `handle_${side}_${String(frame).padStart(6, '0')}.${frameExtension(quality)}`;
export const blenderLayerFrameName = (frame) => `frame_${String(frame).padStart(6, '0')}.png`;
export const blenderLayerHandleFrameName = (side, frame) => `handle_${side}_${String(frame).padStart(6, '0')}.png`;
export const blenderLayerFramePattern = () => 'frame_%06d.png';
/** The frame sequence as ffmpeg reads it. */
export const blenderFramePattern = (quality) => `frame_%06d.${frameExtension(quality)}`;
export const blenderHandleFramePattern = (side, quality) => `handle_${side}_%06d.${frameExtension(quality)}`;
export const blenderStillsFile = (owner, shotId) => join(blenderShotDir(owner, shotId, 'stills'), 'stills.json');
export const blenderSheetsFile = (owner, shotId) => join(blenderShotDir(owner, shotId, 'sheets'), 'sheets.json');
export const blenderSheetName = (firstFrame, lastFrame, every) => `sheet-${firstFrame}-${lastFrame}-e${every}.jpg`;

/** How many of the frames `[startFrame, endFrame)` are on disk. */
export async function countBlenderFrames(owner, shotId, quality, { startFrame, endFrame }) {
  const names = await readdir(blenderFramesDir(owner, shotId, quality)).catch(() => []);
  return names.filter((name) => {
    const frame = Number(FRAME_NAME.exec(name)?.[1]);
    return Number.isInteger(frame) && frame >= startFrame && frame < endFrame;
  }).length;
}

/** How many in/out handle frames inside `handleRanges` are on disk. */
export async function countBlenderHandleFrames(owner, shotId, quality, handleRanges) {
  const names = await readdir(blenderFramesDir(owner, shotId, quality)).catch(() => []);
  let inFrames = 0;
  let outFrames = 0;
  for (const name of names) {
    const match = HANDLE_FRAME_NAME.exec(name);
    if (!match) continue;
    const frame = Number(match[2]);
    if (!Number.isInteger(frame)) continue;
    if (match[1] === 'in' && frame >= handleRanges.in.startFrame && frame < handleRanges.in.endFrame) inFrames += 1;
    if (match[1] === 'out' && frame >= handleRanges.out.startFrame && frame < handleRanges.out.endFrame) outFrames += 1;
  }
  return { inFrames, outFrames };
}

/**
 * Why a render recorded as `meta` is out of date, in the order of
 * MUSIC_VIDEO_BLENDER_STALE_REASONS; empty when it is current. `source` is the
 * shot's dependency files; a shot that moved on the song is `timing` (its
 * source may have changed as well: the one hash covers both).
 */
function staleReasons(meta, range, handleRanges, { fps, shotHash, settingsHash, optionsHash, songHash, files }) {
  const reasons = [];
  if (meta.srcHash !== shotHash) {
    const moved = meta.fps === fps && Number.isInteger(meta.startFrame) && (meta.startFrame !== range.startFrame || meta.endFrame !== range.endFrame);
    reasons.push(moved ? 'timing' : 'source');
  }
  if (blenderImportsChanged(meta.imports, files) && !reasons.includes('source')) reasons.push('source');
  const prevHandles = normalizeBlenderHandles(meta.handles);
  const metaFps = meta.fps || fps;
  if (Math.round(prevHandles.in * metaFps) !== handleRanges.in.frameCount
    || Math.round(prevHandles.out * metaFps) !== handleRanges.out.frameCount) {
    reasons.push('handles');
  }
  if (meta.settingsHash !== settingsHash) reasons.push('settings');
  if ((meta.optionsHash ?? BLENDER_NO_OPTIONS_HASH) !== optionsHash) reasons.push('options');
  // Older renders have no song hash and retain their declared contract.
  if (meta.songHash != null && meta.songHash !== songHash) reasons.push('song');
  return reasons;
}

// Only small, completed-render posters belong in lists, never lossless frame PNGs.
async function posterOf(owner, shot, quality, complete) {
  if (!complete) return null;
  const poster = blenderShotPoster(owner, shot.id, quality);
  return await isFile(poster) ? blenderMediaPath(owner, poster) : null;
}

/** The small JPEG beside a still; older stills may not have one. */
export const blenderStillThumbnail = (file) => file.replace(/\.png$/, '.thumb.jpg');

async function readQuality(owner, shot, quality, current) {
  const meta = await readBlenderJson(blenderRenderFile(owner, shot.id, quality));
  if (!meta || typeof meta !== 'object') return null;
  const video = blenderShotVideo(owner, shot.id, quality);
  const hasVideo = await isFile(video);
  const range = blenderShotFrameRange(shot, current.fps);
  const handleRanges = blenderShotHandleRanges(shot, current.fps);
  const complete = meta.complete === true && hasVideo;
  const reasons = staleReasons(meta, range, handleRanges, current);
  const poster = await posterOf(owner, shot, quality, complete);
  const hasAnyHandles = handleRanges.in.frameCount > 0 || handleRanges.out.frameCount > 0;
  const handleFrames = complete && hasAnyHandles ? await countBlenderHandleFrames(owner, shot.id, quality, handleRanges) : null;
  return {
    file: hasVideo ? blenderMediaPath(owner, video) : null,
    frames: Number.isInteger(meta.frameCount) ? meta.frameCount : range.frameCount,
    complete,
    stale: reasons.length > 0,
    staleReasons: reasons,
    finishedAt: meta.finishedAt || null,
    durationMs: Number.isFinite(meta.durationMs) ? meta.durationMs : null,
    // What the shot video was encoded at: a cut conforms a video made at another size or rate.
    width: meta.width ?? null,
    height: meta.height ?? null,
    fps: meta.fps ?? null,
    ...(handleFrames ? { handleFrames } : {}),
    ...(complete ? {} : { partialFrames: await countBlenderFrames(owner, shot.id, quality, range) }),
    ...(poster ? { poster } : {}),
  };
}

async function readStills(owner, shot, { shotHash, optionsHash, songHash, files }) {
  const listed = await readBlenderJson(blenderStillsFile(owner, shot.id), []);
  const stills = [];
  for (const still of Array.isArray(listed) ? listed : []) {
    if (typeof still?.file !== 'string' || !/^t\d{9,}\.png$/.test(still.file)) continue;
    const absolute = join(blenderShotDir(owner, shot.id, 'stills'), still.file);
    if (!(await isFile(absolute))) continue;
    const thumbnail = blenderStillThumbnail(absolute);
    stills.push({
      ...(await isFile(thumbnail) ? { thumbnail: blenderMediaPath(owner, thumbnail) } : {}),
      file: blenderMediaPath(owner, absolute), timeSec: still.timeSec, createdAt: still.createdAt || null,
      stale: (still.songHash != null && still.songHash !== songHash) || still.srcHash !== shotHash || blenderImportsChanged(still.imports, files) || (still.optionsHash ?? BLENDER_NO_OPTIONS_HASH) !== optionsHash,
    });
  }
  // Newest first: the first still is the shot's freshest picture.
  return stills.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** The `render.json` metadata when `quality` of `shot` is complete and current, or null. */
export async function isBlenderRenderCurrent(owner, shot, quality, current) {
  const meta = await readBlenderJson(blenderRenderFile(owner, shot.id, quality));
  if (!meta || typeof meta !== 'object' || meta.complete !== true) return null;
  if (!(await isFile(blenderShotVideo(owner, shot.id, quality)))) return null;
  const range = blenderShotFrameRange(shot, current.fps);
  const handleRanges = blenderShotHandleRanges(shot, current.fps);
  return staleReasons(meta, range, handleRanges, current).length === 0 ? meta : null;
}

const SHEET_FILE = /^sheet-\d+-\d+-e\d+\.jpg$/;

async function readSheets(owner, shot, { shotHash, optionsHash, songHash, files }) {
  const listed = await readBlenderJson(blenderSheetsFile(owner, shot.id), []);
  const sheets = [];
  for (const sheet of Array.isArray(listed) ? listed : []) {
    if (typeof sheet?.file !== 'string' || !SHEET_FILE.test(sheet.file)) continue;
    const absolute = join(blenderShotDir(owner, shot.id, 'sheets'), sheet.file);
    if (!(await isFile(absolute))) continue;
    sheets.push({
      file: blenderMediaPath(owner, absolute),
      firstFrame: sheet.firstFrame,
      lastFrame: sheet.lastFrame,
      every: sheet.every,
      columns: sheet.columns,
      tiles: sheet.tiles,
      startSec: sheet.startSec,
      endSec: sheet.endSec,
      fromPreview: Boolean(sheet.fromPreview),
      createdAt: sheet.createdAt || null,
      stale: (sheet.songHash != null && sheet.songHash !== songHash)
        || sheet.srcHash !== shotHash
        || blenderImportsChanged(sheet.imports, files)
        || (sheet.optionsHash ?? BLENDER_NO_OPTIONS_HASH) !== optionsHash,
    });
  }
  // Newest batch first, in frame order within a batch.
  return sheets.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || (a.firstFrame - b.firstFrame));
}

/** The film options a render of `manifest` is built with now (`ctx.options`). */
export const blenderFilmOptions = (manifest, settings) => blenderEffectiveOptions(manifest?.options, settings.options);

/**
 * The renders of a film's shots: `{ [shotId]: { preview?, final?, stills, sheets, blend? } }`.
 * `manifest` is the synced manifest (its stored shots carry the `deps` that
 * decide staleness); `shots` narrows to some of them. `sources` is
 * `hashBlenderSources()`'s result when the caller already has it. `finalsOnly`
 * reads just each shot's final render (the Shots step on a project read).
 */
export async function readBlenderRenders(owner, manifest, { settings, sources = null, shots = manifest.shots, finalsOnly = false }) {
  const { files } = sources || await hashBlenderSources(owner);
  const closures = await codeModuleClosures(owner, shots);
  const qualities = finalsOnly ? ['final'] : BLENDER_RENDER_QUALITIES;
  const settingsHashes = Object.fromEntries(qualities.map((quality) => [quality, blenderSettingsHash(settings, quality)]));
  const optionsHash = blenderOptionsHash(blenderFilmOptions(manifest, settings));
  const songHash = blenderSongHash(await getBlenderSong(owner, settings));
  const renders = {};
  for (const shot of shots) {
    const shotHash = blenderShotHash(shot, files, { closures });
    const entry = {
      stills: finalsOnly ? [] : await readStills(owner, shot, { shotHash, optionsHash, songHash, files }),
      sheets: finalsOnly ? [] : await readSheets(owner, shot, { shotHash, optionsHash, songHash, files }),
    };
    for (const quality of qualities) {
      const render = await readQuality(owner, shot, quality, { fps: settings.fps, shotHash, settingsHash: settingsHashes[quality], optionsHash, songHash, files });
      if (render) entry[quality] = render;
    }
    const blend = join(blenderShotDir(owner, shot.id), 'shot.blend');
    if (!finalsOnly && await isFile(blend)) entry.blend = blenderMediaPath(owner, blend);
    renders[shot.id] = entry;
  }
  return renders;
}

/**
 * Which final shot renders a film's final video is joined from: one hash over
 * each shot's id and the time its final render finished. Any shot rendered
 * again, added or removed changes it.
 */
export function blenderFinalsSignature(shots, renders) {
  return createHash('sha256')
    .update(JSON.stringify(shots.map((shot) => [shot.id, renders[shot.id]?.final?.complete ? renders[shot.id].final.finishedAt : null])))
    .digest('hex');
}
