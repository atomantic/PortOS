/** Bytes live only in server-owned, write-once revision directories. */
import { constants } from 'fs';
import { mkdir, lstat, open, rm } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { PATHS } from '../../lib/paths.js';
import { ServerError } from '../../lib/errorHandler.js';
import { canonicalStringify } from '../../lib/objects.js';

/** Identity of a source: its file paths and content hashes, independent of file order. */
export const sourceHashOf = files => createHash('sha256').update(canonicalStringify(
  files.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))).digest('hex');

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

const RETAINED = Symbol('ownedStorageRetained');
function markOwnedStorageRetained(error, cleanupError) {
  if (error === null || typeof error !== 'object') return;
  error[RETAINED] = true;
  error.cleanupError = String(cleanupError?.code || cleanupError?.message || 'cleanup failed').slice(0, 200);
}

/**
 * True when staging failed after creating its owned revision directory and the
 * directory could not be confirmed removed, so its bytes still count against
 * the project's disk budget. Absent (never created) or removed means releasable.
 */
export const ownedStorageRetained = error => Boolean(error?.[RETAINED]);

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
    // Only this invocation's exclusively-created directory can be removed. If
    // removal fails, the partial bytes stay on disk: keep the staging error
    // (the real cause), flag it so the caller keeps the disk reservation, and
    // attach a bounded cleanup message.
    try {
      await rm(owned, { recursive: true, force: true });
    } catch (cleanupError) {
      markOwnedStorageRetained(error, cleanupError);
    }
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

// Stage-run output lives beside, never inside, the immutable revision bytes:
// data/code-animations/projects/<project>/runs/<run>/…, one exclusive
// directory per run so two runs can never write the same path.
async function runDirectory(projectId, runId, tail, { create, exclusive = false }) {
  let path = PATHS.data;
  await directory(path, false);
  const parts = ['code-animations', 'projects', projectId, 'runs', runId, ...tail];
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    if (exclusive && create && index === parts.length - 1) await mkdir(path, { mode: 0o700 });
    else await directory(path, create);
  }
  return path;
}

async function writeOwnedFile(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o444);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * Write one run artifact (a captured frame) under the run's own directory.
 * Never overwrites: a name collision is a bug in the caller.
 */
export async function writeRunArtifact(projectId, runId, name, bytes) {
  const dir = await runDirectory(projectId, runId, ['artifacts'], { create: true });
  await writeOwnedFile(join(dir, name), bytes);
  return {
    relativePath: `code-animations/projects/${projectId}/runs/${runId}/artifacts/${name}`,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  };
}

/**
 * Stage one revision for the browser: a private, write-once copy where the
 * entrypoint becomes index.html (transformed by `prepareEntry`). The renderer's
 * snapshot reads this copy; the revision's own bytes are never modified.
 */
export async function stageRenderSource(projectId, runId, revisionId, files, entryPath, prepareEntry) {
  if (entryPath !== 'index.html' && files.some(file => file.path === 'index.html')) {
    throw new ServerError('The entrypoint is not index.html and another index.html exists', { status: 409, code: 'CODE_ANIMATION_ENTRY_CONFLICT' });
  }
  const owned = await runDirectory(projectId, runId, ['render', revisionId], { create: true, exclusive: true });
  try {
    for (const file of files) {
      const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
      const isEntry = file.path === entryPath;
      let parent = owned;
      const target = isEntry ? 'index.html' : file.path;
      for (const part of target.split('/').slice(0, -1)) {
        parent = join(parent, part);
        await directory(parent, true);
      }
      await writeOwnedFile(join(owned, target), isEntry ? Buffer.from(prepareEntry(bytes.toString('utf8'))) : bytes);
    }
  } catch (error) {
    await rm(owned, { recursive: true, force: true });
    throw error;
  }
  return { directory: `code-animations/projects/${projectId}/runs/${runId}/render/${revisionId}` };
}

/** Read a known sound artifact with the same directory/no-follow/hash guard as source. */
export async function readRunArtifact(projectId, runId, name, sha256) {
  if (!/^sound-[a-f0-9-]+\.wav$/.test(name)) throw unsafe();
  const dir = await runDirectory(projectId, runId, ['artifacts'], { create: false });
  const handle = await open(join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 44 + 180 * 48000 * 2 * 2) throw unsafe();
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw unsafe();
    return bytes;
  } finally { await handle.close(); }
}
