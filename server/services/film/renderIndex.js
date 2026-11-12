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
import { BLENDER_NO_OPTIONS_HASH, blenderImportsChanged, blenderOptionsHash, blenderSettingsHash, blenderShotHash, blenderSongHash, hashBlenderSources } from './hashing.js';
import { getBlenderSong } from './song.js';

export const BLENDER_RENDER_QUALITIES = Object.freeze(['preview', 'final']);
const FRAME_NAME = /^frame_(m)?(\d{6,})\.(?:jpg|png)$/;
const HANDLE_FRAME_NAME = /^handle_(in|out)_(m)?(\d{6,})\.(?:jpg|png)$/;
const frameExtension = (quality) => (quality === 'preview' ? 'jpg' : 'png');

/** `frame_%06d` cannot name a negative frame (the sign eats a pad slot and resume misses the file). */
export function blenderFrameToken(frame) {
  const index = Math.trunc(frame);
  return index < 0 ? `m${String(-index).padStart(6, '0')}` : String(index).padStart(6, '0');
}

function signedFrame(marker, digits) {
  const index = Number(digits);
  if (!Number.isInteger(index)) return null;
  return marker ? -index : index;
}

export function blenderFrameNumber(name) {
  const match = FRAME_NAME.exec(name);
  return match ? signedFrame(match[1], match[2]) : null;
}

export function blenderHandleFrameParts(name) {
  const match = HANDLE_FRAME_NAME.exec(name);
  if (!match) return null;
  const frame = signedFrame(match[2], match[3]);
  return frame == null ? null : { side: match[1], frame };
}

const isFile = async (path) => (await lstat(path).catch(() => null))?.isFile() === true;

export const blenderRenderFile = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'render.json');
export const blenderShotVideo = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'shot.mp4');
/** A small JPEG of the shot's middle frame, made when its video is encoded: it outlives the frames. */
export const blenderShotPoster = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'poster.jpg');
export const blenderFramesDir = (owner, shotId, quality) => join(blenderShotDir(owner, shotId, quality), 'frames');
export const blenderFrameName = (frame, quality) => `frame_${blenderFrameToken(frame)}.${frameExtension(quality)}`;
export const blenderHandleFrameName = (side, frame, quality) => `handle_${side}_${blenderFrameToken(frame)}.${frameExtension(quality)}`;
/** The frame sequence as ffmpeg reads it. */
export const blenderFramePattern = (quality) => `frame_%06d.${frameExtension(quality)}`;
export const blenderHandleFramePattern = (side, quality) => `handle_${side}_%06d.${frameExtension(quality)}`;
export const blenderStillsFile = (owner, shotId) => join(blenderShotDir(owner, shotId, 'stills'), 'stills.json');

/** How many of the frames `[startFrame, endFrame)` are on disk. */
export async function countBlenderFrames(owner, shotId, quality, { startFrame, endFrame }) {
  const names = await readdir(blenderFramesDir(owner, shotId, quality)).catch(() => []);
  return names.filter((name) => {
    const frame = blenderFrameNumber(name);
    return frame != null && frame >= startFrame && frame < endFrame;
  }).length;
}

/** How many in/out handle frames inside `handleRanges` are on disk. */
export async function countBlenderHandleFrames(owner, shotId, quality, handleRanges) {
  const names = await readdir(blenderFramesDir(owner, shotId, quality)).catch(() => []);
  let inFrames = 0;
  let outFrames = 0;
  for (const name of names) {
    const parsed = blenderHandleFrameParts(name);
    if (!parsed) continue;
    const { side, frame } = parsed;
    if (side === 'in' && frame >= handleRanges.in.startFrame && frame < handleRanges.in.endFrame) inFrames += 1;
    if (side === 'out' && frame >= handleRanges.out.startFrame && frame < handleRanges.out.endFrame) outFrames += 1;
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
    if (typeof still?.file !== 'string' || !/^t(?:m\d{9,}|\d{9,})\.png$/.test(still.file)) continue;
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

/** The film options a render of `manifest` is built with now (`ctx.options`). */
export const blenderFilmOptions = (manifest, settings) => blenderEffectiveOptions(manifest?.options, settings.options);

/**
 * The renders of a film's shots: `{ [shotId]: { preview?, final?, stills, blend? } }`.
 * `manifest` is the synced manifest (its stored shots carry the `deps` that
 * decide staleness); `shots` narrows to some of them. `sources` is
 * `hashBlenderSources()`'s result when the caller already has it. `finalsOnly`
 * reads just each shot's final render (the Shots step on a project read).
 */
export async function readBlenderRenders(owner, manifest, { settings, sources = null, shots = manifest.shots, finalsOnly = false }) {
  const { files } = sources || await hashBlenderSources(owner);
  const qualities = finalsOnly ? ['final'] : BLENDER_RENDER_QUALITIES;
  const settingsHashes = Object.fromEntries(qualities.map((quality) => [quality, blenderSettingsHash(settings, quality)]));
  const optionsHash = blenderOptionsHash(blenderFilmOptions(manifest, settings));
  const songHash = blenderSongHash(await getBlenderSong(owner, settings));
  const renders = {};
  for (const shot of shots) {
    const shotHash = blenderShotHash(shot, files);
    const entry = { stills: finalsOnly ? [] : await readStills(owner, shot, { shotHash, optionsHash, songHash, files }) };
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
