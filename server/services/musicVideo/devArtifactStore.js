/**
 * Music Video — development artifact files on disk.
 *
 * Every version of a development artifact is one immutable file:
 *
 *   data/music-video/<projectId>/dev/<artifactId>/v<N>.<ext>
 *
 * The project record holds only the data-relative path (devArtifacts.js), so a
 * version is never overwritten and a clone that carried the metadata over keeps
 * pointing at bytes that still exist. The folder is covered by the rsync
 * snapshot backup like every other `data/` subtree, and is NOT part of the
 * project's peer-sync asset manifest (the metadata is wire-local, see
 * devArtifacts.js).
 *
 * Every path read back from a record is re-resolved and checked to sit inside
 * `data/music-video/`, so a hand-edited record cannot point the file route at
 * an arbitrary file.
 */

import { copyFile, mkdir, stat, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isPathInsideDir } from '../../lib/pathSafety.js';

// A project/artifact id is used as a path segment; nothing else may be.
const SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;

/** Root of every music-video development file. */
export const devArtifactRoot = () => join(PATHS.data, 'music-video');

function assertSegment(value, what) {
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    throw new ServerError(`Invalid ${what}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
}

/** The data-relative path a version will be stored at. */
function devArtifactRelativePath(projectId, artifactId, version, ext) {
  assertSegment(projectId, 'project id');
  assertSegment(artifactId, 'artifact id');
  if (!Number.isInteger(version) || version < 1) throw new ServerError('Invalid version', { status: 400, code: 'VALIDATION_ERROR' });
  if (!/^[a-z0-9]{1,5}$/.test(ext)) throw new ServerError('Invalid extension', { status: 400, code: 'VALIDATION_ERROR' });
  return `music-video/${projectId}/dev/${artifactId}/v${version}.${ext}`;
}

/** Absolute path for a stored data-relative path, or null when it escapes the root. */
export function resolveDevArtifactFile(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) return null;
  const abs = resolve(PATHS.data, relativePath);
  return isPathInsideDir(devArtifactRoot(), abs) ? abs : null;
}

async function ensureParent(abs) {
  await mkdir(resolve(abs, '..'), { recursive: true });
}

/**
 * Store one version's bytes. `source` is either `{ buffer }` (generated) or
 * `{ tempPath }` (an upload the caller removes). Returns `{ file, bytes }`.
 */
export async function writeDevArtifactFile({ projectId, artifactId, version, ext, buffer = null, tempPath = null }) {
  const file = devArtifactRelativePath(projectId, artifactId, version, ext);
  const abs = resolveDevArtifactFile(file);
  if (!abs) throw new ServerError('Invalid artifact path', { status: 400, code: 'VALIDATION_ERROR' });
  // Versions are immutable: a leftover file from a write whose record update
  // never landed is replaced, but a version the record already names is not
  // reachable here because the version number always advances.
  await ensureParent(abs);
  if (buffer) await writeFile(abs, buffer);
  else await copyFile(tempPath, abs);
  const { size } = await stat(abs);
  return { file, bytes: size };
}

/** Remove a file written for a version whose record update failed. */
export async function discardDevArtifactFile(file) {
  const abs = resolveDevArtifactFile(file);
  if (abs && existsSync(abs)) await unlink(abs).catch(() => {});
}
