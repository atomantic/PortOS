import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

const LEGACY_ARCHIVE_DIRS = [
  'held-checkout-archives',
  'branch-retirement-archives',
  'initialized-checkout-retirements',
];

/**
 * Remove legacy CoS checkout and branch retirement archive directories.
 * Skips missing paths and symlinks while leaving sibling directories such as
 * `data/cos/worktrees` intact.
 */
export async function removeCosCheckoutArchives({ rootDir }) {
  const removed = [];
  for (const name of LEGACY_ARCHIVE_DIRS) {
    const target = join(rootDir, 'data', 'cos', name);
    const info = await lstat(target).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info || info.isSymbolicLink() || !info.isDirectory()) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(name);
  }
  return { removed };
}

export default {
  up: removeCosCheckoutArchives,
};
