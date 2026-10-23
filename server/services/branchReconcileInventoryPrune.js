/**
 * Branch-reconcile persists its last inventory (`remaining`) so the Schedule view
 * can offer per-row actions. Disappearance establishes missing source, never
 * preservation. Callers must retain it as an obligation without an exact receipt.
 */
import { execGit } from '../lib/execGit.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';

// Rows that bind a retirement-receipt obligation are evidence, not display data.
export const isObligationRow = row => ['retirement-review-pending', 'retirement-receipt-unverified',
  'retirement-provenance-unverified'].includes(row?.reason);

async function registeredPaths(repoPath) {
  const { stdout } = await execGit(['worktree', 'list', '--porcelain'], repoPath);
  return new Set(stdout.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9)));
}

/**
 * Stored inventory rows whose checkout (or, for a branch-only row, local branch)
 * is gone from the repository. A row whose branch survives but whose checkout is
 * gone still has unproven preservation; the next sweep lists the branch afresh.
 * Unreadable paths are not absent. Git read errors reject for the caller to retain.
 *
 * @param {string} repoPath
 * @param {object[]} rows
 * @param {{ includeObligations?: boolean }} [options] Include missing originals for display only; never prune these obligations.
 * @returns {Promise<object[]>}
 */
export async function findGoneInventoryRows(repoPath, rows, { includeObligations = false } = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const registered = await registeredPaths(repoPath);
  const gone = [];
  for (const row of rows) {
    // A remote-only hold has no local ref by definition. Only a new forge scan
    // can establish that its remote preservation obligation is gone.
    if (row?.reason === 'remote-branch-held') continue;
    if (!includeObligations && (isObligationRow(row) || row?.reason === 'claim-reservation-owner-unverified')) continue;
    if (typeof row?.path === 'string' && row.path) {
      if (!registered.has(row.path) && await readCheckoutPathPresence(row.path) === false) gone.push(row);
    } else if (typeof row?.branch === 'string' && row.branch) {
      if (await readLocalBranchPresence(repoPath, row.branch) === false) gone.push(row);
    }
  }
  return gone;
}
