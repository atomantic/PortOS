/**
 * Pre-reap backup for a SUPERSEDED branch.
 *
 * `branch-reconcile` records a SUPERSEDED verdict and then deletes the branch and
 * its worktree (see `reapSupersededBranches` in `branchReconcile.js`). That is the
 * only way the reconciler converges — a branch whose work landed on the default
 * branch under other names is never `isMerged`, so nothing else ever reaps it and
 * every recheck re-derives the same verdict at full coordinator cost.
 *
 * Deleting a worktree is irreversible, and a superseded branch's uncommitted work
 * is redundant rather than worthless — so nothing is removed until a recoverable
 * copy exists on disk. This module writes that copy, and the reap is gated on it
 * succeeding: no backup, no delete.
 *
 * Layout, one directory per branch under `data/cos/abandoned-worktree-backups/`:
 *   <slug>/manifest.json   what it was, why it was reaped, how to restore it
 *   <slug>/commits.patch   `git format-patch <default>..<branch>` (branch commits)
 *   <slug>/worktree.diff   `git diff HEAD` in its worktree (tracked edits)
 *   <slug>/untracked/…     verbatim copies of its untracked, non-ignored files
 *
 * Untracked files are COPIED rather than rendered as a `--no-index` patch: they
 * are usually the whole deliverable of an abandoned agent worktree, and a copy
 * survives binary content and needs no patch tooling to read back.
 */

import { createHash } from 'node:crypto';
import { cp, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWrite, ensureDir, PATHS } from '../lib/fileUtils.js';
import { isAgentScratchPath } from '../lib/agentScratchPaths.js';
import { kebabCase } from '../lib/textUtils.js';
import { execGitSafe } from './git.js';

/** Where an install keeps its pre-reap backups. */
export const backupRoot = (cosDir = PATHS.cos) => join(cosDir, 'abandoned-worktree-backups');

/**
 * Branch name → a filesystem-safe, collision-free directory name. Pure.
 *
 * The hash suffix is not decoration: `kebabCase` maps `feature/foo-bar` and
 * `feature/foo/bar` to the same slug, and reaping the second would overwrite the
 * first's backup — which by then is the only remaining copy of that branch.
 */
export const backupSlug = (branch) => {
  const name = String(branch || '');
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${kebabCase(name) || 'branch'}-${digest}`;
};

// Bounds on what one backup may copy, so a stray build artifact or model blob
// can't turn it into a disk-filling operation. Exceeding either REFUSES the
// backup (and with it the reap) rather than copying a subset — a partial backup
// would hand the caller a success it then deletes real work on. The tracked diff
// is deliberately uncapped by contrast: every byte of it is authored.
const MAX_UNTRACKED_FILE_BYTES = 5 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * git stdout, or a THROW on a non-zero exit.
 *
 * `execGitSafe` never rejects — a locked index, an unreadable worktree or a bad
 * ref all come back as `{ exitCode: 1, stdout: '' }`. Reading only `.stdout` would
 * make every one of those indistinguishable from a legitimately empty result (a
 * branch with no commits of its own, a worktree with no tracked edits), and the
 * caller's contract is that a resolved backup means the work is safe on disk. So
 * exit status is the signal here, never emptiness: a failure throws, the reap
 * treats that as "do not delete", and the branch waits for the next pass.
 */
const gitText = async (args, cwd) => {
  const result = await execGitSafe(args, cwd, { ignoreExitCode: true });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd} (exit ${result.exitCode}): ${(result.stderr || '').trim() || 'no stderr'}`);
  }
  return result.stdout || '';
};

/** Newline-separated git stdout → trimmed non-empty lines. */
const gitLines = (stdout) => (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Copy a worktree's untracked, non-ignored files into the backup, preserving
 * their relative layout.
 * @returns {Promise<{copied:string[], skipped:{path:string,reason:string}[]}>}
 */
async function copyUntracked(worktreePath, destDir) {
  // PortOS's own scratch is not work product and must not be preserved — and on a
  // worktree branched before this scratch was gitignored, `--exclude-standard`
  // still reports it, so filtering here is what keeps it from eating the budget
  // below and pushing a real file into the refusal path.
  const paths = gitLines(await gitText(['ls-files', '--others', '--exclude-standard'], worktreePath))
    .filter((rel) => !isAgentScratchPath(rel));
  const copied = [];
  const skipped = [];
  const created = new Set();
  let total = 0;
  for (const rel of paths) {
    const source = join(worktreePath, rel);
    const size = await stat(source).then((s) => s.size, () => null);
    if (size === null) {
      skipped.push({ path: rel, reason: 'unreadable' });
      continue;
    }
    // The running total makes the budget order-dependent on purpose — a copy is
    // either fully made or not made at all, never truncated.
    if (size > MAX_UNTRACKED_FILE_BYTES || total + size > MAX_UNTRACKED_TOTAL_BYTES) {
      skipped.push({ path: rel, reason: `too-large (${size} bytes)` });
      continue;
    }
    const destination = join(destDir, rel);
    const parent = dirname(destination);
    if (!created.has(parent)) {
      await ensureDir(parent);
      created.add(parent);
    }
    const ok = await cp(source, destination).then(() => true, () => false);
    if (ok) {
      copied.push(rel);
      total += size;
    } else {
      skipped.push({ path: rel, reason: 'copy-failed' });
    }
  }
  return { copied, skipped };
}

/**
 * Write the recoverable copy of a branch before it is reaped.
 *
 * Throws on any failure that would leave the backup incomplete — the caller
 * treats that as "do not reap", which is the whole point of the gate.
 *
 * @param {string} repoPath
 * @param {object} branch - a reconcile entry: { branch, tip, worktreePath, verdict }
 * @param {{ defaultBranch?: string, cosDir?: string }} [opts]
 * @returns {Promise<{ dir:string, manifest:string, untracked:string[] }>}
 */
export async function backupSupersededBranch(repoPath, branch, { defaultBranch = 'main', cosDir = PATHS.cos } = {}) {
  const dir = join(backupRoot(cosDir), backupSlug(branch.branch));
  await ensureDir(dir);

  const commitsPath = join(dir, 'commits.patch');
  const commits = await gitText(['format-patch', `${defaultBranch}..${branch.branch}`, '--stdout'], repoPath);
  const hasCommits = Boolean(commits.trim());
  if (hasCommits) await writeFile(commitsPath, commits);

  const diffPath = join(dir, 'worktree.diff');
  let hasDiff = false;
  let untracked = { copied: [], skipped: [] };
  if (branch.worktreePath) {
    const worktreeDiff = await gitText(['diff', 'HEAD', '--binary'], branch.worktreePath);
    hasDiff = Boolean(worktreeDiff.trim());
    if (hasDiff) await writeFile(diffPath, worktreeDiff);
    // No upfront mkdir: copyUntracked creates each parent lazily, so a worktree
    // with nothing untracked leaves no empty directory behind.
    untracked = await copyUntracked(branch.worktreePath, join(dir, 'untracked'));
    // A file we could not copy is a file the reap would then delete with no copy
    // anywhere. That includes the size caps: their job is to stop one stray blob
    // from filling the disk, not to license deleting it — so an oversized file
    // refuses the reap and the branch stays put for a human to look at.
    if (untracked.skipped.length) {
      const detail = untracked.skipped.map((s) => `${s.path} (${s.reason})`).join(', ');
      throw new Error(`could not back up ${untracked.skipped.length} untracked file(s): ${detail}`);
    }
  }

  const manifest = {
    branch: branch.branch,
    repoPath,
    defaultBranch,
    tip: branch.tip || null,
    worktreePath: branch.worktreePath || null,
    reapedAt: new Date().toISOString(),
    verdict: branch.verdict || null,
    captured: {
      commitsPatch: hasCommits,
      worktreeDiff: hasDiff,
      untrackedFiles: untracked.copied,
      untrackedSkipped: untracked.skipped,
    },
    // The branch ref is gone after the reap, but its objects are not — git keeps
    // them until they are gc'd (90 days by default), so the tip SHA is a real
    // restore path for as long as that lasts, and the patches outlive even that.
    restore: [
      branch.tip ? `git -C ${repoPath} branch ${branch.branch} ${branch.tip}` : null,
      hasCommits ? `git -C ${repoPath} am ${commitsPath}` : null,
      hasDiff ? `git -C ${repoPath} apply ${diffPath}` : null,
      untracked.copied.length ? `cp -R ${join(dir, 'untracked')}/. <worktree>/` : null,
    ].filter(Boolean),
  };
  const manifestPath = join(dir, 'manifest.json');
  await atomicWrite(manifestPath, manifest);
  return { dir, manifest: manifestPath, untracked: untracked.copied };
}
