import { basename, extname } from 'path';
import { dataPath, ensureDir, listDirectoryByExtension, makePathResolver } from '../../lib/fileUtils.js';

/**
 * User-owned clip files are file-primary: they are externally supplied binary
 * assets, travel with the install's data backup, and need no record graph or
 * search index until a retarget job references one.
 */
export const CLIP_LIBRARY_DIR = dataPath('rigging', 'clips');
export const CLIP_SOURCE_EXTENSIONS = ['.glb'];

export function clipSourceLabel(filename) {
  const name = basename(String(filename || ''));
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

/** List locally dropped animation-bearing GLB files, newest first. */
export async function listClipSources({ directory = CLIP_LIBRARY_DIR } = {}) {
  await ensureDir(directory);
  const entries = await listDirectoryByExtension(directory, {
    extensions: CLIP_SOURCE_EXTENSIONS,
    mapEntry: (filename, path, stats) => ({
      filename,
      label: clipSourceLabel(filename),
      path,
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
    }),
  });
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Resolve a library filename without accepting path traversal or extensions. */
export const resolveClipSource = makePathResolver(() => CLIP_LIBRARY_DIR, { extensions: CLIP_SOURCE_EXTENSIONS });
