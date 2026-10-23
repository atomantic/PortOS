/** Repair directories pre-created by Spotlight setup without weakening private stores. */
import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { SPOTLIGHT_EXCLUDED_DIRS } from '../lib/spotlightExclude.js';

export default {
  async up({ rootDir, platform = process.platform, uid = process.getuid?.() }) {
    if (platform !== 'darwin' || uid === undefined) return;
    for (const rel of SPOTLIGHT_EXCLUDED_DIRS) {
      const directory = join(rootDir, 'data', rel);
      const info = await lstat(directory).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) === 0) continue;
      await chmod(directory, 0o700);
    }
  },
};
