/** Bytes live only in server-owned, write-once revision directories. */
import { constants } from 'fs';
import { mkdir, lstat, open, rm } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../../lib/paths.js';
import { ServerError } from '../../lib/errorHandler.js';

const unsafe = () => new ServerError('Managed revision storage is not a regular directory or file', {
  status: 409, code: 'CODE_ANIMATION_UNSAFE_STORAGE',
});

async function directory(path, create) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw unsafe();
}

async function root(projectId, revisionId, create) {
  // IDs originate in the service, never in package paths or local settings.
  let path = PATHS.data;
  await directory(path, false);
  for (const part of ['code-animations', 'projects', projectId, 'revisions']) {
    path = join(path, part);
    await directory(path, create);
  }
  path = join(path, revisionId);
  if (create) {
    // Exclusive ownership: an existing UUID destination is never reused.
    await mkdir(path, { mode: 0o700 });
  } else await directory(path, false);
  return path;
}

export async function stageProjectFiles(projectId, revisionId, files) {
  const owned = await root(projectId, revisionId, true);
  try {
    for (const file of files) {
      let parent = owned;
      for (const part of file.path.split('/').slice(0, -1)) {
        parent = join(parent, part);
        await directory(parent, true);
      }
      const handle = await open(join(owned, file.path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o444);
      try {
        await handle.writeFile(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'));
        await handle.sync();
      } finally { await handle.close(); }
    }
  } catch (error) {
    // Only this invocation's exclusively-created directory can be removed.
    await rm(owned, { recursive: true, force: true });
    throw error;
  }
  return { relativePath: `code-animations/projects/${projectId}/revisions/${revisionId}` };
}

export async function readProjectFiles(projectId, revisionId, files) {
  const owned = await root(projectId, revisionId, false);
  const result = [];
  for (const file of files) {
    const path = join(owned, file.path);
    let parent = owned;
    for (const part of file.path.split('/').slice(0, -1)) {
      parent = join(parent, part);
      await directory(parent, false);
    }
    if (!(await lstat(path)).isFile()) throw unsafe();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      if (!(await handle.stat()).isFile()) throw unsafe();
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new ServerError('Stored revision bytes failed integrity validation', { status: 409, code: 'CODE_ANIMATION_REVISION_CORRUPT' });
    }
    result.push({ ...file, content: bytes.toString(file.encoding === 'base64' ? 'base64' : 'utf8') });
  }
  return result;
}
