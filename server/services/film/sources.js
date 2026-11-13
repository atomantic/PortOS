/**
 * The authored film source under a Blender workspace's src/: list it, read and
 * write one text file, delete one file, and scaffold it from the shipped
 * starter. Binary assets (images, HDRIs, fonts, audio, models) are placed on
 * disk by the operator or an agent and are listed but never sent through the API.
 *
 * Only regular files whose path src/ may hold are seen; symlinks, dotfiles and
 * other types (Python's bytecode cache included) are skipped everywhere, so
 * the listing, the hashes and the routes agree on what the film is.
 */
import { copyFile, lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite } from '../../lib/fileCore.js';
import { MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES, blenderSourceFileKind } from '../../lib/musicVideoBlender.js';
import { assertInsideWithoutSymlinks, blenderRefusal, blenderSrcDir, blenderWorkspaceDir, resolveBlenderSourceFile } from './workspace.js';

const STARTER_DIR = fileURLToPath(new URL('./py/starter/', import.meta.url));
const MAX_DEPTH = 6;
// Refuse oversized source trees whole: partial hashes or copies misrepresent the film.
const MAX_FILES = 5000;

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

/** Every film source file, sorted by path: `{ path, absolute, bytes, mtimeMs, kind }`. */
export async function walkBlenderSources(owner) {
  const root = blenderSrcDir(owner);
  const top = await lstat(root).catch(() => null);
  // A linked src/ is not this workspace's source.
  if (!top?.isDirectory() || top.isSymbolicLink()) return [];
  const found = [];
  await walk(root, '', 1, found);
  return found;
}

export async function listBlenderFiles(owner) {
  const files = await walkBlenderSources(owner);
  return { files: files.map(({ path, bytes, mtimeMs, kind }) => ({ path, bytes, mtime: new Date(mtimeMs).toISOString(), text: kind === 'text' })) };
}

const notText = () => blenderRefusal('Only text source files (.py, .js, .mjs, .json, .txt, .md) are read and written here; place other assets in the workspace folder', 'MUSIC_VIDEO_BLENDER_NOT_TEXT');

export async function readBlenderFile(owner, path) {
  const { absolute, kind } = await resolveBlenderSourceFile(owner, path);
  if (kind !== 'text') throw notText();
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile()) throw blenderRefusal('That file is not in the workspace', 'NOT_FOUND', 404);
  if (info.size > MUSIC_VIDEO_BLENDER_TEXT_MAX_BYTES) throw blenderRefusal('That file is too large to open here (over 2 MiB)', 'MUSIC_VIDEO_BLENDER_FILE_TOO_LARGE', 413);
  return { path, content: await readFile(absolute, 'utf8') };
}

export async function writeBlenderFile(owner, path, content) {
  const { absolute, kind } = await resolveBlenderSourceFile(owner, path);
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

export async function deleteBlenderFile(owner, path) {
  const { absolute } = await resolveBlenderSourceFile(owner, path);
  const info = await lstat(absolute).catch(() => null);
  if (!info?.isFile()) throw blenderRefusal('That file is not in the workspace', 'NOT_FOUND', 404);
  await rm(absolute);
  return { path };
}

async function starterFiles(directory = STARTER_DIR, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await starterFiles(join(directory, entry.name), path));
    else if (entry.isFile() && blenderSourceFileKind(path)) files.push(path);
  }
  return files.sort();
}

/**
 * Copy the shipped starter film into src/. Refuses once the workspace has a
 * film.py; a file the author already placed is never overwritten.
 */
export async function scaffoldBlenderWorkspace(owner) {
  const src = blenderSrcDir(owner);
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), join(src, 'film.py'));
  if (await lstat(join(src, 'film.py')).catch(() => null)) {
    throw blenderRefusal('This workspace already has a film (src/film.py). Edit it, or delete it to start again from the starter.', 'MUSIC_VIDEO_BLENDER_WORKSPACE_EXISTS', 409);
  }
  const copied = [];
  for (const path of await starterFiles()) {
    const { absolute } = await resolveBlenderSourceFile(owner, path);
    await mkdir(dirname(absolute), { recursive: true });
    const placed = await copyFile(join(STARTER_DIR, ...path.split('/')), absolute, constants.COPYFILE_EXCL).then(() => true, (error) => {
      if (error.code === 'EEXIST') return false;
      throw error;
    });
    if (placed) copied.push(path);
  }
  return { copied };
}
