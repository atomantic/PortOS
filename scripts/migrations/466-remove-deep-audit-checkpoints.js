import { lstat, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

/**
 * Remove data/cos/deep-audit-checkpoints: per-agent assignment, ledger and
 * report files of the Deep certification engine retired in #16910. No code
 * reads or writes them; GET /api/cos/schedule/deep-audits/:id serves the
 * `deep_audit_ledgers` rows they were imported into. One install held 686 MB,
 * copied into every backup. A symlink or non-directory is left alone.
 */
export async function removeDeepAuditCheckpoints({ rootDir }) {
  const dataDir = resolve(rootDir, 'data');
  const target = resolve(dataDir, 'cos', 'deep-audit-checkpoints');
  if (relative(dataDir, target) !== join('cos', 'deep-audit-checkpoints')) return { removed: false };
  const info = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return { removed: false };
  await rm(target, { recursive: true, force: true });
  return { removed: true };
}

export default {
  up: removeDeepAuditCheckpoints,
};
