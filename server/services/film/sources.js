/**
 * The authored film source under a Blender workspace's src/: list it, read and
 * write one text file, delete one file, and scaffold it from the shipped
 * starter. The tree rules (what src/ may hold, containment, size caps) are the
 * shared ones in ../blenderWorkspace/sourceTree.js.
 */
import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathWithin } from '../../../lib/pathWithin.js';
import { blenderSourceFileKind } from '../../lib/musicVideo/musicVideoBlender.js';
import { deleteSourceFile, presentSourceFiles, readSourceText, walkSourceTree, writeSourceText } from '../blenderWorkspace/sourceTree.js';
import { assertInsideWithoutSymlinks, blenderRefusal, blenderSourceDirs, blenderSrcDir, blenderWorkspaceDir, resolveBlenderSourceFile } from './workspace.js';

const STARTER_DIRS = Object.freeze({
  film: fileURLToPath(new URL('./py/starter/', import.meta.url)),
  showcase: fileURLToPath(new URL('./py/showcase/', import.meta.url)),
});

/** Every film source file, sorted by path: `{ path, absolute, bytes, mtimeMs, kind }`. */
export const walkBlenderSources = (owner) => walkSourceTree(blenderSrcDir(owner));

export const listBlenderFiles = async (owner) => presentSourceFiles(await walkBlenderSources(owner));

export const readBlenderFile = (owner, path) => readSourceText(blenderSourceDirs(owner), path);

export const writeBlenderFile = (owner, path, content) => writeSourceText(blenderSourceDirs(owner), path, content);

export const deleteBlenderFile = (owner, path) => deleteSourceFile(blenderSourceDirs(owner), path);

/** A shipped starter file by its `/`-separated path; a path that climbs out of the starter throws (`pathWithin`). */
export const starterSourcePath = (path, starter = 'film') => pathWithin(STARTER_DIRS[starter], ...path.split('/'));

async function starterFiles(starter, prefix = '') {
  const files = [];
  // Recursion used to `join` the directory parameter with `entry.name`. That
  // segment can climb out of the starter, so the test memo refused every
  // importer. `pathWithin` throws instead, and the memo keys this tree.
  for (const entry of await readdir(pathWithin(STARTER_DIRS[starter], prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await starterFiles(starter, path));
    else if (entry.isFile() && blenderSourceFileKind(path)) files.push(path);
  }
  return files.sort();
}

/**
 * Copy the shipped starter film into src/. Refuses once the workspace has a
 * film.py; a file the author already placed is never overwritten. `starter` is
 * `film` (the song starter) or `showcase` (the model showcase, py/showcase/).
 */
export async function scaffoldBlenderWorkspace(owner, starter = 'film') {
  const src = blenderSrcDir(owner);
  await assertInsideWithoutSymlinks(blenderWorkspaceDir(owner), join(src, 'film.py'));
  if (await lstat(join(src, 'film.py')).catch(() => null)) {
    throw blenderRefusal('This workspace already has a film (src/film.py). Edit it, or delete it to start again from the starter.', 'MUSIC_VIDEO_BLENDER_WORKSPACE_EXISTS', 409);
  }
  const copied = [];
  for (const path of await starterFiles(starter)) {
    const { absolute } = await resolveBlenderSourceFile(owner, path);
    await mkdir(dirname(absolute), { recursive: true });
    const placed = await copyFile(starterSourcePath(path, starter), absolute, constants.COPYFILE_EXCL).then(() => true, (error) => {
      if (error.code === 'EEXIST') return false;
      throw error;
    });
    if (placed) copied.push(path);
  }
  return { copied };
}
