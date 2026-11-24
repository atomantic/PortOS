/**
 * A Blender film's workspace on this install:
 *
 *   owner.workspaceDir/
 *     src/            authored film code (durable); entry point src/film.py
 *     manifest.json   the last synced shot manifest
 *     song.json       song context, rewritten before every job
 *     renders/        regenerable output: shot frames and videos, stills, cuts, logs
 *
 * Every path a request names is rebuilt from validated segments and re-checked
 * to sit inside the workspace with no symlink on the way, so neither a request
 * nor a link an authored script left behind can aim a read, write or delete
 * outside it. Reads and path math only: nothing here runs a process.
 *
 * Storage: `asset-file-db-indexed` — machine-local files; `src/` is durable and
 * backed up, `renders/` is regenerable and excluded from backups. The project
 * record keeps only small wire-local settings; render state, staleness, cuts and
 * job history are read from disk or memory, never stored on it. A clone copies
 * `src/`, `manifest.json` and `song.json`, never `renders/`.
 */
import { lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { readJSONFileStrict } from '../../lib/jsonIo.js';
import { MUSIC_VIDEO_BLENDER_SHOT_ID } from '../../lib/musicVideo/musicVideoBlender.js';
import { assertInsideWithoutSymlinks, blenderRefusal } from '../blenderWorkspace/containment.js';
import { resolveSourceFile } from '../blenderWorkspace/sourceTree.js';

export { assertInsideWithoutSymlinks, blenderRefusal };

const MEDIA_TYPES = Object.freeze({
  mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', log: 'text/plain; charset=utf-8',
});

export const blenderWorkspaceDir = (owner) => owner.workspaceDir;

/** The workspace as the operator finds it under the PortOS data folder. */
export const blenderWorkspaceLabel = (owner) => owner.workspaceLabel ?? owner.workspaceDir;
export const blenderSrcDir = (owner) => join(blenderWorkspaceDir(owner), 'src');
export const blenderRendersDir = (owner) => join(blenderWorkspaceDir(owner), 'renders');
export const blenderManifestFile = (owner) => join(blenderWorkspaceDir(owner), 'manifest.json');
export const blenderSongFile = (owner) => join(blenderWorkspaceDir(owner), 'song.json');
/** The `{ workspace, src }` pair the shared source-tree helpers take. */
export const blenderSourceDirs = (owner) => ({ workspace: blenderWorkspaceDir(owner), src: blenderSrcDir(owner) });

export function assertBlenderShotId(shotId) {
  if (typeof shotId !== 'string' || !MUSIC_VIDEO_BLENDER_SHOT_ID.test(shotId)) {
    throw blenderRefusal('Invalid shot id', 'VALIDATION_ERROR');
  }
  return shotId;
}

/** `renders/<shotId>` or one of its `preview` / `final` / `stills` folders. */
export function blenderShotDir(owner, shotId, part = null) {
  const dir = join(blenderRendersDir(owner), assertBlenderShotId(shotId));
  return part ? join(dir, part) : dir;
}

/** A folder one assembly owns and removes; its dot name keeps it off the media route. */
export const blenderScratchDir = (owner, jobId) => join(blenderRendersDir(owner), `.scratch-${String(jobId).replace(/[^A-Za-z0-9_-]/g, '_')}`);

/** A path under renders/ as the media route takes it (always `/`-separated). */
export const blenderMediaPath = (owner, absolute) => relative(blenderRendersDir(owner), absolute).split(sep).join('/');

/**
 * One file under src/ named by a request: `{ absolute, kind }` (`kind` is
 * `'text'` or `'binary'`). Throws 400 for a path src/ may not hold.
 */
export const resolveBlenderSourceFile = (owner, path) => resolveSourceFile(blenderSourceDirs(owner), path);

/** A regular file under renders/ to serve, with its media type; 404 otherwise. */
export async function resolveBlenderMedia(owner, path) {
  const missing = () => blenderRefusal('That render file is not on this machine', 'NOT_FOUND', 404);
  const type = MEDIA_TYPES[String(path).slice(String(path).lastIndexOf('.') + 1).toLowerCase()];
  if (!type || !String(path).includes('.')) throw missing();
  const parts = String(path).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) throw missing();
  const renders = blenderRendersDir(owner);
  const absolute = join(renders, ...parts);
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), renders);
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
