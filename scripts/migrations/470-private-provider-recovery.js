import { chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';

function metadata(path) {
  return lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function restrict(path, info, allowedMode) {
  const mode = info.mode & allowedMode;
  if ((info.mode & 0o7777) !== mode) await chmod(path, mode);
}

export default {
  async up({ rootDir }) {
    if (process.platform === 'win32') return;

    const data = join(rootDir, 'data');
    if (!(await metadata(data))?.isDirectory()) return;

    const directory = join(data, 'private');
    const parent = await metadata(directory);
    if (!parent?.isDirectory()) return;

    const recovery = join(directory, 'providers.pre-graph.json');
    const file = await metadata(recovery);
    // Skip symlinks and shared inodes so repair cannot change another file's permissions.
    if (!file?.isFile() || file.nlink !== 1) return;

    await restrict(directory, parent, 0o700);
    // Recheck after removing shared directory access to avoid acting on a replaced entry.
    const current = await metadata(recovery);
    if (current?.isFile() && current.nlink === 1) await restrict(recovery, current, 0o600);
  },
};
