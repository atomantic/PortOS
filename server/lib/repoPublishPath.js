/**
 * `isSymlinkFreeRepoPath(realRepoRoot, absPath, { leaf: 'dir' | 'file' })`.
 *
 * symlink-aware containment for publishing generated files into a managed app's repo, shared by the chiptune and sprite publishers. `lstat`-walks every existing component below the real root and refuses any symlink (dangling or contained), a wrong-kind leaf, or a realpath outside the root; a missing tail is allowed below a verified ancestor. The lexical `isPathInsideDir` can't see that `<repo>/linked-assets` is a symlink to a directory elsewhere, so a string-checked publish can be redirected out of the repo (#10894, after the Sprite equivalent #9668).
 */

import { lstat, realpath } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { isPathAtOrInsideDir } from './pathContainment.js';

/**
 * True when `absPath` can be written below `repoRoot` without crossing a symlink: walks every EXISTING component from the root with `lstat` (dangling and still-contained symlinks are refused, not mistaken for a missing destination or followed); the first absent component ends the walk and the tail is created under the verified ancestor.
 * `leaf` is what an existing final component may be: `'dir'` for a directory a publish populates, `'file'` for a destination file (a directory or link there would redirect or block the write); intermediates must be plain directories. Pass the REAL repo root (`realpath`); a root that is itself a symlink is refused.
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
