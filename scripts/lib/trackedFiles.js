import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Working-tree inventory for source scanners; paths are relative to cwd.
 * Only missing entries are excluded. Metadata and subsequent read errors still
 * fail the scan, and dangling symlinks remain visible rather than hiding damage.
 */
export function existingPaths(cwd, paths) {
  return paths.filter(path => lstatSync(join(cwd, path), { throwIfNoEntry: false }) !== undefined);
}

function gitFiles(cwd, pathspecs, includeUntracked) {
  const args = ['ls-files', '--cached', '--deduplicate', '-z'];
  if (includeUntracked) args.push('--others', '--exclude-standard');
  const paths = execFileSync('git', [...args, '--', ...pathspecs], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  }).split('\0').filter(Boolean);
  return existingPaths(cwd, paths);
}

/** Git-tracked paths that are still present, with NUL-safe inventory parsing. */
export function trackedFiles(cwd, pathspecs = []) {
  return gitFiles(cwd, pathspecs, false);
}

/** Present tracked paths plus non-ignored untracked paths for working-tree scans. */
export function workingTreeFiles(cwd, pathspecs = []) {
  return gitFiles(cwd, pathspecs, true);
}
