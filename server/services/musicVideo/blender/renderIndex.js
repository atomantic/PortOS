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
  blenderEffectiveOptions, blenderShotFrameRange, normalizeBlenderRecord, summarizeBlenderShots,
} from '../../../lib/musicVideoBlender.js';
import { blenderMediaPath, blenderShotDir, readBlenderJson } from './workspace.js';
import { BLENDER_NO_OPTIONS_HASH, blenderOptionsHash, blenderSettingsHash, blenderShotHash, hashBlenderSources } from './hashing.js';
import { readBlenderManifest } from './manifest.js';

export const BLENDER_RENDER_QUALITIES = Object.freeze(['preview', 'final']);
const FRAME_NAME = /^frame_(\d{6,})\.(?:jpg|png)$/;
const frameExtension = (quality) => (quality === 'preview' ? 'jpg' : 'png');

const isFile = async (path) => (await lstat(path).catch(() => null))?.isFile() === true;

export const blenderRenderFile = (projectId, shotId, quality) => join(blenderShotDir(projectId, shotId, quality), 'render.json');
export const blenderShotVideo = (projectId, shotId, quality) => join(blenderShotDir(projectId, shotId, quality), 'shot.mp4');
/** A small JPEG of the shot's middle frame, made when its video is encoded: it outlives the frames. */
export const blenderShotPoster = (projectId, shotId, quality) => join(blenderShotDir(projectId, shotId, quality), 'poster.jpg');
export const blenderFramesDir = (projectId, shotId, quality) => join(blenderShotDir(projectId, shotId, quality), 'frames');
export const blenderFrameName = (frame, quality) => `frame_${String(frame).padStart(6, '0')}.${frameExtension(quality)}`;
/** The frame sequence as ffmpeg reads it. */
export const blenderFramePattern = (quality) => `frame_%06d.${frameExtension(quality)}`;
export const blenderStillsFile = (projectId, shotId) => join(blenderShotDir(projectId, shotId, 'stills'), 'stills.json');

/** How many of the frames `[startFrame, endFrame)` are on disk. */
export async function countBlenderFrames(projectId, shotId, quality, { startFrame, endFrame }) {
  const names = await readdir(blenderFramesDir(projectId, shotId, quality)).catch(() => []);
  return names.filter((name) => {
    const frame = Number(FRAME_NAME.exec(name)?.[1]);
    return Number.isInteger(frame) && frame >= startFrame && frame < endFrame;
  }).length;
}

/**
 * Why a render recorded as `meta` is out of date, in the order of
 * MUSIC_VIDEO_BLENDER_STALE_REASONS; empty when it is current. `source` is the
 * shot's dependency files; a shot that moved on the song is `timing` (its
 * source may have changed as well: the one hash covers both).
 */
function staleReasons(meta, range, { fps, shotHash, settingsHash, optionsHash }) {
  const reasons = [];
  if (meta.srcHash !== shotHash) {
    const moved = meta.fps === fps && Number.isInteger(meta.startFrame) && (meta.startFrame !== range.startFrame || meta.endFrame !== range.endFrame);
    reasons.push(moved ? 'timing' : 'source');
  }
  if (meta.settingsHash !== settingsHash) reasons.push('settings');
  if ((meta.optionsHash ?? BLENDER_NO_OPTIONS_HASH) !== optionsHash) reasons.push('options');
  return reasons;
}

// Only small, completed-render posters belong in lists, never lossless frame PNGs.
async function posterOf(projectId, shot, quality, complete) {
  if (!complete) return null;
  const poster = blenderShotPoster(projectId, shot.id, quality);
  return await isFile(poster) ? blenderMediaPath(projectId, poster) : null;
}

/** The small JPEG beside a still; older stills may not have one. */
export const blenderStillThumbnail = (file) => file.replace(/\.png$/, '.thumb.jpg');

async function readQuality(projectId, shot, quality, current) {
  const meta = await readBlenderJson(blenderRenderFile(projectId, shot.id, quality));
  if (!meta || typeof meta !== 'object') return null;
  const video = blenderShotVideo(projectId, shot.id, quality);
  const hasVideo = await isFile(video);
  const range = blenderShotFrameRange(shot, current.fps);
  const complete = meta.complete === true && hasVideo;
  const reasons = staleReasons(meta, range, current);
  const poster = await posterOf(projectId, shot, quality, complete);
  return {
    file: hasVideo ? blenderMediaPath(projectId, video) : null,
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
    ...(complete ? {} : { partialFrames: await countBlenderFrames(projectId, shot.id, quality, range) }),
    ...(poster ? { poster } : {}),
  };
}

async function readStills(projectId, shot, { shotHash, optionsHash }) {
  const listed = await readBlenderJson(blenderStillsFile(projectId, shot.id), []);
  const stills = [];
  for (const still of Array.isArray(listed) ? listed : []) {
    if (typeof still?.file !== 'string' || !/^t\d{9,}\.png$/.test(still.file)) continue;
    const absolute = join(blenderShotDir(projectId, shot.id, 'stills'), still.file);
    if (!(await isFile(absolute))) continue;
    const thumbnail = blenderStillThumbnail(absolute);
    stills.push({
      ...(await isFile(thumbnail) ? { thumbnail: blenderMediaPath(projectId, thumbnail) } : {}),
      file: blenderMediaPath(projectId, absolute), timeSec: still.timeSec, createdAt: still.createdAt || null,
      stale: still.srcHash !== shotHash || (still.optionsHash ?? BLENDER_NO_OPTIONS_HASH) !== optionsHash,
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
export async function readBlenderRenders(projectId, manifest, { settings, sources = null, shots = manifest.shots, finalsOnly = false }) {
  const { files } = sources || await hashBlenderSources(projectId);
  const qualities = finalsOnly ? ['final'] : BLENDER_RENDER_QUALITIES;
  const settingsHashes = Object.fromEntries(qualities.map((quality) => [quality, blenderSettingsHash(settings, quality)]));
  const optionsHash = blenderOptionsHash(blenderFilmOptions(manifest, settings));
  const renders = {};
  for (const shot of shots) {
    const shotHash = blenderShotHash(shot, files);
    const entry = { stills: finalsOnly ? [] : await readStills(projectId, shot, { shotHash, optionsHash }) };
    for (const quality of qualities) {
      const render = await readQuality(projectId, shot, quality, { fps: settings.fps, shotHash, settingsHash: settingsHashes[quality], optionsHash });
      if (render) entry[quality] = render;
    }
    const blend = join(blenderShotDir(projectId, shot.id), 'shot.blend');
    if (!finalsOnly && await isFile(blend)) entry.blend = blenderMediaPath(projectId, blend);
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

/**
 * What a project read says about its Blender film: `shots` is how far the
 * final shots are (`{ total, finalReady, ready }`; `ready` is the Shots step:
 * every manifest shot has a complete, current final render), and `finalStale`
 * whether the project's final video no longer matches them: a shot went out
 * of date or was rendered again since that video was joined (null when the
 * project has no final this film recorded). Read-time only; a project without
 * a synced film is `{ 0, 0, false }`.
 */
export async function blenderFilmReadState(project) {
  const manifest = await readBlenderManifest(project.id);
  const { settings } = normalizeBlenderRecord(project.blender);
  const shots = manifest?.shots || [];
  const renders = shots.length ? await readBlenderRenders(project.id, manifest, { settings, finalsOnly: true }) : {};
  return { shots: summarizeBlenderShots(shots, renders), finalStale: blenderFinalStale(project, shots, renders) };
}

/**
 * Whether the project's final video no longer matches its film's shots; null
 * when the project's current final is not one this film recorded joining.
 */
export function blenderFinalStale(project, shots, renders) {
  const { final } = normalizeBlenderRecord(project.blender);
  if (!project.renderHistoryId || final?.jobId !== project.renderHistoryId) return null;
  return !summarizeBlenderShots(shots, renders).ready || final.signature !== blenderFinalsSignature(shots, renders);
}
