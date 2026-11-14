/** Inventory reflects current local paths/refs; unreadable and remote-only rows stay. */
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';
import { execGit } from '../lib/execGit.js';

export const sameRetirementCheckout = (left, right) => (left.branch ?? null) === (right.branch ?? null)
  && left.path === right.path && left.head === right.head;
export const sameRetirementObservation = (left, right) => sameRetirementCheckout(left, right)
  && (left.checkoutIdentity || null) === (right.checkoutIdentity || null);

export async function reconcileInventoryRows(repoPath, rows) {
  const current = [];
  for (const row of rows) {
    if (row?.reason === 'remote-branch-held' || (!row?.path && !row?.branch)) { current.push(row); continue; }
    const pathPresent = row.path ? await readCheckoutPathPresence(row.path).catch(() => null) : false;
    if (pathPresent !== false) { current.push(row); continue; }
    if (!row.branch) continue;
    const present = await readLocalBranchPresence(repoPath, row.branch).catch(() => null);
    if (present === null) { current.push(row); continue; }
    if (!present) continue;
    const head = await execGit(['rev-parse', '--verify', `refs/heads/${row.branch}`], repoPath)
      .then(result => result.stdout.trim(), () => null);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head || '')) { current.push(row); continue; }
    if (!row.path) { current.push({ ...row, head }); continue; }
    // Checkout identities/locks belong to the vanished path, never to its ref.
    const branch = { branch: row.branch, head, locked: false, lockReason: null, reason: 'branch-cleanup-pending' };
    if (!current.some(entry => !entry.path && entry.reason !== 'remote-branch-held' && entry.branch === branch.branch)) current.push(branch);
  }
  return current;
}
