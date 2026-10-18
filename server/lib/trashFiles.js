/** Recoverable deletion for user-owned files; temporary cleanup still uses unlink. */
import { moveToNativeTrash } from './nativeTrash.js';
import { lstat } from 'node:fs/promises';
import { ServerError } from './errorHandler.js';
import { isVitestRunner } from './runtimeEnv.js';

export async function trashFiles(paths) {
  const existing = [];
  for (const path of [...new Set(paths.filter(Boolean))]) {
    if (isVitestRunner()) {
      const { assertNotRealDataWrite } = await import('./testDataIsolation.js');
      assertNotRealDataWrite(path, 'trash');
    }
    const info = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isDirectory()) throw new ServerError('Media deletion requires a file', { status: 400, code: 'INVALID_MEDIA_FILE' });
    if (info) existing.push(path);
  }
  if (!existing.length) return;
  // Literal paths only; the native helper owns its OS-specific recycling.
  await moveToNativeTrash(existing).then(async () => {
    for (const path of existing) {
      await lstat(path).then(() => {
        throw new Error('File remains after trash operation');
      }, error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }).catch(error => {
    console.error(`❌ Media trash failed (${error.code || 'TRASH_FAILED'})`);
    throw new ServerError('Could not move media to Trash or Recycle Bin. No permanent deletion was attempted.', {
      status: 503, code: 'MEDIA_TRASH_FAILED',
    });
  });
}
