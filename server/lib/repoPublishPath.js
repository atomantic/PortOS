/**
 * Symlink-aware containment for writing generated files into a managed app's
 * repository. The lexical `isPathInsideDir` guard cannot see that
 * `<repo>/linked-assets` is a symlink to a directory elsewhere, so a publish
 * that only checks the string path can be redirected out of the repo (#10894,
 * after the Sprite equivalent #9668). Shared by the chiptune and sprite
 * publishers.
 */

import { lstat, realpath } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { isPathAtOrInsideDir } from './pathContainment.js';

/**
 * True when `absPath` can be written below `repoRoot` without crossing a
 * symlink. Walks every EXISTING component from the root with `lstat`, so
 * dangling and still-contained symlinks are refused rather than mistaken for a
 * missing destination or silently followed. A missing tail is fine — the first
 * absent component ends the walk and everything below it will be created under
 * the verified ancestor.
 *
 * `leaf` says what the final component may be when it already exists:
 * `'dir'` for a directory a publish will populate, `'file'` for a destination
 * file (a directory or link there would redirect or block the write). Every
 * intermediate component must be a plain directory.
 *
 * Pass the REAL repo root (`realpath`); a root that is itself a symlink is
 * refused.
 */
export async function isSymlinkFreeRepoPath(repoRoot, absPath, { leaf }) {
  const root = resolve(repoRoot);
  const target = resolve(absPath);
  if (!isPathAtOrInsideDir(root, target)) return false;
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
  let existing = root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    const next = join(existing, part);
    const info = await lstat(next).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!info) break;
    const isLeaf = index === parts.length - 1;
    const wantedKind = isLeaf && leaf === 'file' ? info.isFile() : info.isDirectory();
    if (info.isSymbolicLink() || !wantedKind) return false;
    existing = next;
  }
  return isPathAtOrInsideDir(root, await realpath(existing));
}
