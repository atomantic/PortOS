import { createHash } from 'node:crypto';
import { execGit } from './execGit.js';

/** Server-observed launch context, NOT a scan manifest or coverage certificate.
 * Hash the captured commit's tree (paths, modes and object IDs), never a later
 * HEAD. Quoted ls-tree output is ASCII and stable even for unusual filenames.
 * Dirty/untracked bytes and submodule contents are not part of this inventory.
 */
export async function captureAuditSourceEvidence(workspacePath, { runGit = execGit } = {}) {
  const capturedAt = new Date().toISOString();
  const unavailable = { version: 1, status: 'unavailable', capturedAt };
  const read = args => runGit(args, workspacePath, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return (async () => {
    const revision = (await read(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) return unavailable;
    const [tree, status, finalHead] = await Promise.all([
      read(['-c', 'core.quotePath=true', 'ls-tree', '-r', '--full-tree', revision]),
      read(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=none']).catch(() => null),
      read(['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => null),
    ]);
    return {
      version: 1,
      status: 'captured',
      capturedAt,
      revision,
      inventoryScope: 'committed-tree',
      inventorySha256: createHash('sha256').update(tree.stdout).digest('hex'),
      trackedEntryCount: tree.stdout.split('\n').filter(Boolean).length,
      workingTreeState: !status || finalHead?.stdout.trim() !== revision
        ? 'unknown' : status.stdout ? 'modified' : 'clean',
    };
  })().catch(() => unavailable);
}
