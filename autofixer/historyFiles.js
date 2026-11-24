import { chmod, rename, writeFile } from 'node:fs/promises';

export async function writeHistoryFile(path, contents) {
  // A retry can reuse an inode created before history writes were private.
  await chmod(path, 0o600).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  await writeFile(path, contents, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function writeHistoryJson(path, value) {
  // Preserve the previous complete record until its replacement is private
  // and fully written. Callers serialize writes to each destination.
  const temp = `${path}.tmp`;
  await writeHistoryFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, path);
}
