/**
 * Forking a Blender film: a new version of a project gets its own copy of the
 * film (src/, the synced manifest.json and song.json), so a variant can be
 * made without touching the original. Renders are never copied: they are the
 * source's output, and the fork renders its own.
 */
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { blenderManifestFile, blenderSongFile, blenderSrcDir, blenderWorkspaceDir } from './workspace.js';
import { walkBlenderSources } from './sources.js';

/**
 * Copy the film of `sourceId` into the (new, empty) workspace of `targetId`.
 * Resolves false, having written nothing, when the source has no film source.
 * Only what the film itself is made of is copied: the files the source walk
 * lists (regular files of the kinds src/ may hold; no links, no bytecode).
 */
export async function copyBlenderFilm(sourceId, targetId) {
  const files = await walkBlenderSources(sourceId);
  if (!files.length) return false;
  const copy = async () => {
    for (const file of files) {
      const target = join(blenderSrcDir(targetId), ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(file.absolute, target);
    }
    for (const [from, to] of [[blenderManifestFile(sourceId), blenderManifestFile(targetId)], [blenderSongFile(sourceId), blenderSongFile(targetId)]]) {
      if ((await lstat(from).catch(() => null))?.isFile()) await copyFile(from, to);
    }
  };
  // A half-copied film would sync as a different film: all of it, or none.
  await copy().catch(async (error) => {
    await removeBlenderFilmCopy(targetId);
    throw error;
  });
  return true;
}

/** Remove the workspace a fork that did not complete left behind. */
export const removeBlenderFilmCopy = (targetId) => rm(blenderWorkspaceDir(targetId), { recursive: true, force: true });
