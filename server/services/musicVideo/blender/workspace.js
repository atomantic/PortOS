/**
 * A Blender film's workspace on this install:
 *
 *   data/music-video/<projectId>/blender/
 *     src/            authored film code (durable); entry point src/film.py
 *     manifest.json   the last synced shot manifest
 *     song.json       song context, rewritten before every job
 *     renders/        regenerable output: shot frames and videos, stills, cuts, logs
 *
 * Every path a request names is rebuilt from validated segments and re-checked
 * to sit inside the workspace with no symlink on the way, so neither a request
 * nor a link an authored script left behind can aim a read, write or delete
 * outside it. Reads and path math only: nothing here runs a process.
 */
import { lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PATHS } from '../../../lib/paths.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { isPathInsideDir } from '../../../lib/pathSafety.js';
import { readJSONFileStrict } from '../../../lib/jsonIo.js';
import { MUSIC_VIDEO_BLENDER_SHOT_ID, blenderSourceFileKind } from '../../../lib/musicVideoBlender.js';

// A project id is a path segment here; nothing else may be.
const PROJECT_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;
const MEDIA_TYPES = Object.freeze({
  mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', log: 'text/plain; charset=utf-8',
});

export const blenderRefusal = (message, code, status = 400, context = null) =>
  new ServerError(message, { status, code, ...(context ? { context } : {}) });

export function blenderWorkspaceDir(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_SEGMENT.test(projectId)) {
    throw blenderRefusal('Invalid project id', 'VALIDATION_ERROR');
  }
  return join(PATHS.data, 'music-video', projectId, 'blender');
}

/** The workspace as the operator finds it under the PortOS data folder. */
export const blenderWorkspaceLabel = (projectId) => `data/music-video/${projectId}/blender`;
export const blenderSrcDir = (projectId) => join(blenderWorkspaceDir(projectId), 'src');
export const blenderRendersDir = (projectId) => join(blenderWorkspaceDir(projectId), 'renders');
export const blenderManifestFile = (projectId) => join(blenderWorkspaceDir(projectId), 'manifest.json');
export const blenderSongFile = (projectId) => join(blenderWorkspaceDir(projectId), 'song.json');

export function assertBlenderShotId(shotId) {
  if (typeof shotId !== 'string' || !MUSIC_VIDEO_BLENDER_SHOT_ID.test(shotId)) {
    throw blenderRefusal('Invalid shot id', 'VALIDATION_ERROR');
  }
  return shotId;
}

/** `renders/<shotId>` or one of its `preview` / `final` / `stills` folders. */
export function blenderShotDir(projectId, shotId, part = null) {
  const dir = join(blenderRendersDir(projectId), assertBlenderShotId(shotId));
  return part ? join(dir, part) : dir;
}

/** A folder one assembly owns and removes; its dot name keeps it off the media route. */
export const blenderScratchDir = (projectId, jobId) => join(blenderRendersDir(projectId), `.scratch-${String(jobId).replace(/[^A-Za-z0-9_-]/g, '_')}`);

/** A path under renders/ as the media route takes it (always `/`-separated). */
export const blenderMediaPath = (projectId, absolute) => relative(blenderRendersDir(projectId), absolute).split(sep).join('/');

/**
 * Refuse `absolute` unless it sits inside `root` and no existing component from
 * `root` down is a symlink. A component that does not exist yet is fine: the
 * caller is about to create it.
 */
export async function assertInsideWithoutSymlinks(root, absolute) {
  if (!isPathInsideDir(root, absolute)) throw blenderRefusal('That path is outside the Blender workspace', 'MUSIC_VIDEO_BLENDER_PATH');
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const part of [null, ...parts]) {
    if (part) current = join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw blenderRefusal('Symbolic links are not followed inside the Blender workspace', 'MUSIC_VIDEO_BLENDER_PATH');
  }
}

/**
 * One file under src/ named by a request: `{ absolute, kind }` (`kind` is
 * `'text'` or `'binary'`). Throws 400 for a path src/ may not hold.
 */
export async function resolveBlenderSourceFile(projectId, path) {
  const kind = blenderSourceFileKind(path);
  if (!kind) throw blenderRefusal('That is not a file the Blender workspace can hold (check the folder depth and the file type)', 'MUSIC_VIDEO_BLENDER_PATH');
  const absolute = join(blenderSrcDir(projectId), ...path.split('/'));
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(projectId), absolute);
  return { absolute, kind };
}

/** A regular file under renders/ to serve, with its media type; 404 otherwise. */
export async function resolveBlenderMedia(projectId, path) {
  const missing = () => blenderRefusal('That render file is not on this machine', 'NOT_FOUND', 404);
  const type = MEDIA_TYPES[String(path).slice(String(path).lastIndexOf('.') + 1).toLowerCase()];
  if (!type || !String(path).includes('.')) throw missing();
  const parts = String(path).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw missing();
  const renders = blenderRendersDir(projectId);
  const absolute = join(renders, ...parts);
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(projectId), renders);
  await assertInsideWithoutSymlinks(renders, absolute);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile()) throw missing();
  return { absolute, type };
}

/**
 * A workspace JSON file, or `fallback` when it is absent or unreadable. Every
 * JSON file here is regenerable (a sync rewrites manifest.json, a render its
 * render.json, and the still and cut indexes only list files that stay on
 * disk), so an unreadable one reads as absent and the next job rewrites it.
 */
export async function readBlenderJson(file, fallback = null) {
  const { ok, value } = await readJSONFileStrict(file, fallback, { logError: false });
  return ok ? value : fallback;
}
