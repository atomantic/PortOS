/**
 * Branch-reconcile persists its last inventory (`remaining`) so the Schedule view
 * can offer per-row actions. Anything else that retires a checkout or branch
 * (a claim run's own cleanup, `git worktree prune`, a later sweep) leaves that
 * stored row behind, and the UI then offers an action on something that no
 * longer exists. This decides which stored rows are such ghosts.
 */
import { execGit } from '../lib/execGit.js';
import { pathExists } from '../lib/fileCore.js';

// Rows that bind a retirement-receipt obligation are evidence, not display data.
const isObligationRow = row => ['retirement-review-pending', 'retirement-receipt-unverified'].includes(row?.reason);

async function registeredPaths(repoPath) {
  const { stdout } = await execGit(['worktree', 'list', '--porcelain'], repoPath);
  return new Set(stdout.split(/\r?\n/).filter(line => line.startsWith('worktree ')).map(line => line.slice(9)));
}

/**
 * Stored inventory rows whose checkout (or, for a branch-only row, local branch)
 * is gone from the repository. A row whose branch survives but whose checkout is
 * gone is still a ghost checkout; the next sweep lists the branch afresh.
 * Fails open: any git read error yields no ghosts, so a flaky read hides nothing.
 *
 * @param {string} repoPath
 * @param {object[]} rows
 * @returns {Promise<object[]>}
 */
export async function findGoneInventoryRows(repoPath, rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const registered = await registeredPaths(repoPath);
  const gone = [];
  for (const row of rows) {
    if (isObligationRow(row)) continue;
    if (typeof row?.path === 'string' && row.path) {
      if (!registered.has(row.path) && !await pathExists(row.path)) gone.push(row);
    } else if (typeof row?.branch === 'string' && row.branch) {
      const ref = await execGit(['rev-parse', '--verify', '--quiet', `refs/heads/${row.branch}`], repoPath, { ignoreExitCode: true });
      if (ref.exitCode === 1) gone.push(row);
    }
  }
  return gone;
}
