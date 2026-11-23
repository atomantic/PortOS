/**
 * The authored source under a Blender workspace's src/ (a film's or a model's):
 * resolve one path, list the tree, read and write one text file, delete one
 * file. Binary assets (images, HDRIs, fonts, audio, models) are placed on disk
 * by the operator or an agent and are listed but never sent through the API.
 *
 * `dirs` is `{ workspace, src }`: containment is checked from the workspace
 * root, so a linked src/ is refused like any other link. Only regular files
 * whose path src/ may hold are seen; symlinks, dotfiles and other types
 * (Python's bytecode cache included) are skipped everywhere, so the listing,
 * the hashes and the routes agree on what the source is.
 */
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../../lib/fileCore.js';
import { MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES, blenderSourceFileKind } from '../../lib/musicVideo/musicVideoBlender.js';
import { assertInsideWithoutSymlinks, blenderRefusal } from './containment.js';

const MAX_DEPTH = 6;
// Refuse oversized source trees whole: partial hashes or copies misrepresent the source.
const MAX_FILES = 5000;

/**
 * One file under src/ named by a request: `{ absolute, kind }` (`kind` is
 * `'text'` or `'binary'`). Throws 400 for a path src/ may not hold.
 */
export async function resolveSourceFile(dirs, path) {
  const kind = blenderSourceFileKind(path);
  if (!kind) throw blenderRefusal('That is not a file the Blender workspace can hold (check the folder depth and the file type)', 'MUSIC_VIDEO_BLENDER_PATH');
  const absolute = join(dirs.src, ...path.split('/'));
  await assertInsideWithoutSymlinks(dirs.workspace, absolute);
  return { absolute, kind };
}

async function walk(root, prefix, depth, found) {
  if (depth > MAX_DEPTH) return;
  const entries = await readdir(join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(entry.name)) await walk(root, path, depth + 1, found);
      continue;
    }
    const kind = entry.isFile() ? blenderSourceFileKind(path) : null;
    if (!kind) continue;
    const absolute = join(root, ...path.split('/'));
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile()) continue;
    if (found.length >= MAX_FILES) {
      throw blenderRefusal(`The Blender workspace has more than ${MAX_FILES} supported source files`, 'MUSIC_VIDEO_BLENDER_SOURCE_LIMIT', 413);
    }
    found.push({ path, absolute, bytes: info.size, mtimeMs: info.mtimeMs, kind });
  }
}

/** Every source file under `src`, sorted by path: `{ path, absolute, bytes, mtimeMs, kind }`. */
export async function walkSourceTree(src) {
  const top = await lstat(src).catch(() => null);
  // A linked src/ is not this workspace's source.
  if (!top?.isDirectory() || top.isSymbolicLink()) return [];
  const found = [];
  await walk(src, '', 1, found);
  return found;
}

/** What a listing route answers: `{ files: [{ path, bytes, mtime, text }] }`. */
export const presentSourceFiles = (files) => ({
  files: files.map(({ path, bytes, mtimeMs, kind }) => ({ path, bytes, mtime: new Date(mtimeMs).toISOString(), text: kind === 'text' })),
});

const notText = () => blenderRefusal('Only text source files (.py, .js, .mjs, .json, .txt, .md) are read and written here; place other assets in the workspace folder', 'MUSIC_VIDEO_BLENDER_NOT_TEXT');

export async function readSourceText(dirs, path) {
  const { absolute, kind } = await resolveSourceFile(dirs, path);
  if (kind !== 'text') throw notText();
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile()) throw blenderRefusal('That file is not in the workspace', 'NOT_FOUND', 404);
  if (info.size > MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES) throw blenderRefusal('That file is too large to open here (over 2 MiB)', 'MUSIC_VIDEO_BLENDER_FILE_TOO_LARGE', 413);
  return { path, content: await readFile(absolute, 'utf8') };
}

export async function writeSourceText(dirs, path, content) {
  const { absolute, kind } = await resolveSourceFile(dirs, path);
  if (kind !== 'text') throw notText();
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES) throw blenderRefusal('A source file can hold at most 2 MiB of text', 'MUSIC_VIDEO_BLENDER_FILE_TOO_LARGE', 413);
  const existing = await lstat(absolute).catch(() => null);
  if (existing && !existing.isFile()) throw blenderRefusal('A folder already has that name', 'MUSIC_VIDEO_BLENDER_PATH');
  // The temp file is renamed over the target, so a link planted between the
  // check above and this write is replaced, never followed.
  await atomicWrite(absolute, content);
  return { path, bytes };
}

export async function deleteSourceFile(dirs, path) {
  const { absolute } = await resolveSourceFile(dirs, path);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile()) throw blenderRefusal('That file is not in the workspace', 'NOT_FOUND', 404);
  await rm(absolute);
  return { path };
}
