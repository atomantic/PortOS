import { lstat, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/**
 * Remove data/cos/initialized-checkout-fixtures: scratch repos left by the
 * initialized-checkout recovery code removed in #14309/#16015. Nothing writes
 * it any more and it can hold gigabytes. Gated on the directory existing; a
 * symlink or non-directory at the path is left alone, and the target must
 * resolve to exactly that path under rootDir.
 */
export async function removeInitializedCheckoutFixtures({ rootDir }) {
  const dataDir = resolve(rootDir, 'data');
  const target = resolve(dataDir, 'cos', 'initialized-checkout-fixtures');
  if (relative(dataDir, target) !== join('cos', 'initialized-checkout-fixtures')) return { removed: false };
  const info = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return { removed: false };
  await rm(target, { recursive: true, force: true });
  return { removed: true };
}

export default {
  up: removeInitializedCheckoutFixtures,
};
