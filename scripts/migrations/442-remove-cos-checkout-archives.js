import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

const DIRS = [
  'cos/held-checkout-archives',
  'cos/branch-retirement-archives',
  'cos/initialized-checkout-retirements',
];

/** One idempotent boot cleanup. Deletes only these three directories. */
export default {
  async up({ rootDir }) {
    for (const rel of DIRS) {
      const directory = join(rootDir, 'data', rel);
      const info = await lstat(directory).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      await rm(directory, { recursive: true, force: true });
    }
  },
};
