/**
 * Keep Spotlight (mds_stores) and fseventsd from indexing the machinery under
 * `data/`: agent worktrees, checkout archives, browser profiles and the like
 * churn thousands of files per run and pin both daemons. macOS honors a
 * `.metadata_never_index` marker for a whole subtree, so we mark only these
 * directories — user media (videos, images, ...) stays searchable. Builtins only.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SPOTLIGHT_MARKER = '.metadata_never_index';

/** `data/`-relative directories that hold checkouts, archives, profiles or runtimes, never user media. */
export const SPOTLIGHT_EXCLUDED_DIRS = [
  'browser-profile',
  'cos/branch-retirement-archives',
  'cos/held-checkout-archives',
  'cos/initialized-checkout-fixtures',
  'cos/initialized-checkout-retirements',
  'cos/worktrees',
  'python',
  'repos',
  'training-runs',
];

/** @returns {'created'|'present'|'unsupported'} 'created' when any marker was newly written. */
export function excludeFromSpotlight(dataDir, { platform = process.platform, dirs = SPOTLIGHT_EXCLUDED_DIRS } = {}) {
  if (platform !== 'darwin') return 'unsupported';
  let created = false;
  for (const rel of dirs) {
    const dir = join(dataDir, rel);
    const marker = join(dir, SPOTLIGHT_MARKER);
    if (existsSync(marker)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, '');
    created = true;
  }
  return created ? 'created' : 'present';
}
