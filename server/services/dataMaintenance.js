import { getNavPageForPath } from '../lib/navManifest.js';
import { withRetiredDataRemoval } from '../lib/retiredLoraTraining.js';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PATHS, renameGuarded, rmGuarded } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { createMutex } from '../lib/asyncMutex.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { listJobs } from './mediaJobQueue/index.js';
import { trainingRunsBusy } from './dataManagerBusy.js';
import { getActiveCaptionRun } from './loraDatasetCaption.js';

// Operations own their paths. Neither the client nor a preview can supply one.
export const MAINTENANCE_OPERATIONS = Object.freeze([
  { id: 'retired-training-runs', directory: 'training-runs', label: 'Retired LoRA training artifacts', category: 'Unique checkpoints and regenerable scratch', warning: 'May contain the only copy of an adapter, optimizer checkpoint, logs or preview. PostgreSQL run history is retained but will point to missing artifacts.', deletable: true },
  { id: 'retired-lora-datasets', directory: 'lora-datasets', label: 'Retired LoRA datasets', category: 'Unique source images and captions', warning: 'Source images, captions and dataset metadata may be irreplaceable. Copy anything you want to retain before deleting.', deletable: true },
  { id: 'shared-lora-adapters', directory: 'loras', label: 'Installed LoRA adapters', category: 'Shared inference assets', warning: `Adapters still work in image and media generation. Manage individual adapters in ${getNavPageForPath('/models/loras')?.breadcrumb}. Shared Python runtimes and model caches remain supported.`, deletable: false },
]);
const fail = (message, code = 'MAINTENANCE_UNSAFE') => new ServerError(message, { status: 409, code });
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const previews = new Map();
const withLock = createMutex();
const PREVIEW_TTL = 5 * 60_000;

async function dataRootSnapshot() {
  let cursor = resolve(PATHS.data);
  for (;;) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw fail('Data root contains a symbolic link; removal is unavailable.');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Native canonicalization also expands Windows short names/casing. A changed
  // spelling is not evidence of a link; lstat above establishes that boundary.
  const root = await realpath(PATHS.data);
  const info = await lstat(root);
  return { root, identity: [info.dev, info.ino] };
}

async function inspect(directory, logicalDirectory = directory) {
  const { root, identity: rootIdentity } = await dataRootSnapshot();
  const hash = createHash('sha256');
  let identity = null;
  let bytes = 0;
  let files = 0;
  async function walk(path, relative) {
    const info = await lstat(path).catch(missing);
    if (!info) return;
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw fail('Unsupported file or symbolic link found; no files removed.');
    if (relative === logicalDirectory) identity = [info.dev, info.ino];
    hash.update(JSON.stringify([relative, info.dev, info.ino, info.mode, info.size, info.mtimeMs, relative === logicalDirectory ? null : info.ctimeMs]) + '\n');
    if (info.isFile()) { bytes += info.size; files += 1; }
    else for (const name of (await readdir(path)).sort()) await walk(join(path, name), `${relative}/${name}`);
  }
  await walk(join(root, directory), logicalDirectory);
  return { canonicalRoot: root, rootIdentity, bytes, files, present: identity !== null, fingerprint: hash.digest('hex'), identity };
}

async function assertIdle() {
  // Retired producers cannot start. Outstanding generation/caption requests may
  // still own dataset inputs, including work admitted by the outgoing server.
  if (listJobs().some(job => ['queued', 'running'].includes(job.status))) throw fail('Media work is queued or running. Wait for it to finish or cancel it explicitly.', 'MAINTENANCE_BUSY');
  const busy = await trainingRunsBusy();
  if (busy.busy !== false) throw fail(busy.reason || 'Training ownership could not be determined.', 'MAINTENANCE_BUSY');
  const datasets = await readdir(join(PATHS.data, 'lora-datasets')).catch(error => missing(error) || []);
  if (datasets.some(id => getActiveCaptionRun(id))) throw fail('Dataset captioning is still active; finish or cancel it first.', 'MAINTENANCE_BUSY');
}

export async function getMaintenanceInventory() {
  return Promise.all(MAINTENANCE_OPERATIONS.map(async operation => {
    try {
      const { bytes, files, present } = await inspect(operation.directory);
      return { ...operation, path: `data/${operation.directory}`, bytes, files, status: present ? 'retained' : 'absent', actions: operation.deletable && present ? ['delete'] : [] };
    } catch (error) {
      return { ...operation, path: `data/${operation.directory}`, bytes: null, files: null, status: 'unavailable', actions: [], error: error.code === 'MAINTENANCE_UNSAFE' ? error.message : 'Inventory could not be read. Check directory access before retrying.' };
    }
  }));
}

export async function previewMaintenance(id) {
  const operation = MAINTENANCE_OPERATIONS.find(item => item.id === id && item.deletable);
  if (!operation) throw new ServerError('Unsupported maintenance operation', { status: 404, code: 'NOT_FOUND' });
  await assertIdle();
  const inventory = await inspect(operation.directory);
  if (!inventory.present) throw fail('Nothing remains to delete. Refresh inventory.', 'MAINTENANCE_STALE');
  const now = Date.now();
  for (const [key, value] of previews) if (value.expiresAt < now) previews.delete(key);
  if (previews.size >= 100) throw fail('Too many outstanding previews. Wait for them to expire.');
  const preview = { token: randomUUID(), operationId: id, path: `data/${operation.directory}`, warning: operation.warning, bytes: inventory.bytes, files: inventory.files, confirmation: `DELETE ${operation.directory}`, expiresAt: now + PREVIEW_TTL };
  previews.set(preview.token, { ...preview, inventory, directory: operation.directory });
  return preview;
}

export async function executeMaintenance({ token, confirmation }) {
  return withLock(() => withBackupAssetPublication(() => withRetiredDataRemoval(async () => {
    const preview = previews.get(token);
    if (!preview || preview.expiresAt < Date.now()) throw fail('Preview expired. Refresh and preview again.', 'MAINTENANCE_STALE');
    if (confirmation !== preview.confirmation) throw new ServerError('Confirmation must match the preview exactly', { status: 400, code: 'CONFIRMATION_REQUIRED' });
    if (preview.result) return preview.result;
    await assertIdle();
    const current = await inspect(preview.directory);
    if (current.fingerprint !== preview.inventory.fingerprint || JSON.stringify(current.rootIdentity) !== JSON.stringify(preview.inventory.rootIdentity)) throw fail('Files changed since preview. Refresh and preview again.', 'MAINTENANCE_STALE');
    const source = join(current.canonicalRoot, preview.directory);
    const stagedName = `.maintenance-${preview.token}`;
    const staged = join(current.canonicalRoot, stagedName);
    await renameGuarded(source, staged);
    // Renaming first detaches the exact inspected directory from normal writers.
    // Revalidate identity and contents before removing anything. On uncertainty,
    // preserve the detached tree and report its recovery location.
    try {
      const detached = await inspect(stagedName, preview.directory);
      if (JSON.stringify(detached.rootIdentity) !== JSON.stringify(current.rootIdentity) || JSON.stringify(detached.identity) !== JSON.stringify(current.identity) || detached.fingerprint !== current.fingerprint) throw fail('Files changed while preparing deletion.');
      await assertIdle();
      const finalRoot = await dataRootSnapshot();
      if (finalRoot.root !== current.canonicalRoot || JSON.stringify(finalRoot.identity) !== JSON.stringify(current.rootIdentity)) throw fail('Data root changed while preparing deletion.');
      if (await lstat(source).catch(missing)) throw fail('The source directory was recreated while preparing deletion.');
      await rmGuarded(staged, { recursive: true, force: false });
    } catch (error) {
      const replacement = await lstat(source).catch(missing);
      if (!replacement) await renameGuarded(staged, source).catch(() => {});
      throw new ServerError(`Removal did not complete. Inspect data/${preview.directory} and data/${stagedName} before trying again.`, { status: 409, code: 'MAINTENANCE_INCOMPLETE', cause: error });
    }
    const remaining = await inspect(preview.directory).catch(() => null);
    preview.result = { ok: true, operationId: preview.operationId, removedBytes: current.bytes, removedFiles: current.files, status: remaining === null ? 'unavailable' : remaining.present ? 'retained' : 'deleted', remainingBytes: remaining?.bytes ?? null, remainingFiles: remaining?.files ?? null };
    return preview.result;
  })));
}
