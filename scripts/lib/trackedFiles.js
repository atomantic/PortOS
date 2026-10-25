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

/** Git-tracked paths that are still present, with NUL-safe inventory parsing. */
export function trackedFiles(cwd, pathspecs = []) {
  const args = ['ls-files', '--cached', '--deduplicate', '-z'];
  const paths = execFileSync('git', [...args, '--', ...pathspecs], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  }).split('\0').filter(Boolean);
  return existingPaths(cwd, paths);
}
