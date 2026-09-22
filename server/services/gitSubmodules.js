/**
 * Git submodule inspection and lifecycle operations.
 *
 * Extracted from `server/services/git.js` to decouple submodule status inspection,
 * remote tracking, and default-branch pointer bumps from the monolithic Git service.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { execGit, execGitSafe } from '../lib/execGit.js';
import { clearStaleGitLock } from '../lib/gitStaleLock.js';
import { parseSubmoduleStatusLine } from '../lib/gitOutputParsers.js';
import { toLiteralPathspec } from '../lib/gitArgs.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  getBranch,
  getRepoBranches,
  stageFiles,
  commit
} from './git.js';

/**
 * Get submodule status for a repo.
 * @param {string} [repoPath] - Repo root; defaults to the PortOS checkout.
 */
export async function getSubmodules(repoPath) {
  const root = repoPath || PATHS.root;
  const result = await execGit(['submodule', 'status'], root);
  // Split before trimming — the leading space is a status character (means "up to date")
  const lines = result.stdout.split('\n').filter(l => l.trimEnd());

  const parsed = lines.map(parseSubmoduleStatusLine).filter(Boolean);

  const submodules = await Promise.all(parsed.map(async ({ statusChar, commit, path: subPath }) => {
    const name = subPath.split('/').pop();
    const fullPath = join(root, subPath);
    const initialized = statusChar !== '-';
    const conflicted = statusChar === 'U';
    const exists = existsSync(fullPath);

    // Skip remote-info fetch when submodule is uninitialized or has merge conflicts
    const canFetchRemote = exists && initialized && !conflicted;

    // Run independent git queries concurrently
    const [urlResult, remoteInfo] = await Promise.all([
      execGitSafe(['config', `submodule.${subPath}.url`], root),
      canFetchRemote ? fetchRemoteInfo(fullPath, commit) : Promise.resolve({ latestCommit: null, behind: 0, latestMessage: null })
    ]);

    return {
      name,
      path: subPath,
      currentCommit: commit.substring(0, 7),
      ...remoteInfo,
      statusChar,
      initialized,
      conflicted,
      outOfSync: statusChar === '+',
      url: urlResult.stdout.trim() || null
    };
  }));

  return submodules;
}

async function fetchRemoteInfo(fullPath, currentCommit) {
  await execGitSafe(['fetch', 'origin'], fullPath, { timeout: 15000 });

  // Resolve the remote default branch — origin/HEAD may not exist in all clones
  let remoteRef = 'origin/HEAD';
  const headCheck = await execGitSafe(['rev-parse', 'origin/HEAD'], fullPath);
  if (headCheck.exitCode !== 0) {
    // Fallback: try origin/main then origin/master
    const mainCheck = await execGitSafe(['rev-parse', 'origin/main'], fullPath);
    if (mainCheck.exitCode === 0) {
      remoteRef = 'origin/main';
    } else {
      const masterCheck = await execGitSafe(['rev-parse', 'origin/master'], fullPath);
      if (masterCheck.exitCode === 0) {
        remoteRef = 'origin/master';
      }
    }
  }

  const [latestResult, msgResult] = await Promise.all([
    execGitSafe(['rev-parse', remoteRef], fullPath),
    execGitSafe(['log', '-1', '--format=%s', remoteRef], fullPath)
  ]);

  let latestCommit = null;
  let behind = 0;
  if (latestResult.exitCode === 0) {
    latestCommit = latestResult.stdout.trim().substring(0, 7);
    const countResult = await execGitSafe(
      ['rev-list', '--count', `${currentCommit}..${remoteRef}`],
      fullPath
    );
    behind = parseInt(countResult.stdout.trim(), 10) || 0;
  }

  return {
    latestCommit,
    behind,
    latestMessage: msgResult.stdout.trim() || null
  };
}

/**
 * Submodule statuses plus the branch a pointer bump would be committed on, so
 * a caller that needs both doesn't pay for the whole `getGitInfo` fan-out
 * (status + log + diffstat + remote) to read one branch name.
 * @param {string} [repoPath] - Repo root; defaults to the PortOS checkout.
 * @returns {Promise<{submodules: object[], defaultBranch: string}>}
 */
export async function getSubmoduleOverview(repoPath) {
  const root = repoPath || PATHS.root;
  const [submodules, { baseBranch }] = await Promise.all([
    getSubmodules(root),
    getRepoBranches(root)
  ]);
  return { submodules, defaultBranch: baseBranch || 'main' };
}

/**
 * Get known submodule paths
 * @param {string} [repoPath] - Repo root; defaults to the PortOS checkout.
 */
export async function getSubmodulePaths(repoPath) {
  const root = repoPath || PATHS.root;
  const result = await execGit(['submodule', 'status'], root);
  return result.stdout.split('\n').filter(l => l.trimEnd())
    .map(parseSubmoduleStatusLine).filter(Boolean).map(s => s.path);
}

/**
 * @typedef {object} SubmoduleCommitResult
 * @property {boolean} committed - Whether a commit was written.
 * @property {string} [commitSha] - Sha of the commit, when one was written.
 * @property {string} [commitMessage] - Subject of the commit, when one was written.
 * @property {'not-on-default-branch'|'no-changes'} [commitSkipped] - Why nothing was committed.
 * @property {string} commitNote - One-phrase rendering of the outcome, for the UI.
 * @property {string} defaultBranch - Branch a pointer bump commits to.
 * @property {string} currentBranch - Branch the repo is actually checked out on.
 */

/**
 * Commit a submodule pointer bump on the repo's default branch.
 *
 * Stages ONLY the submodule path — a repo mid-edit keeps its other dirty files
 * out of the commit. Refuses to commit when the checkout is on any other branch:
 * "we updated the submodule" belongs on the default branch, and silently landing
 * it on whatever feature branch happens to be checked out would pollute unrelated
 * work. The caller gets a reason back instead of a silent no-op.
 *
 * The skip reason ships as both a code and a rendered `commitNote`, so the UI
 * reports what happened without keeping its own copy of the reason table.
 *
 * @param {string} root - Repo root
 * @param {string} subPath - Repo-relative submodule path
 * @param {string|null} newCommit - Short sha the submodule now points at (message detail)
 * @returns {Promise<SubmoduleCommitResult>}
 */
async function commitSubmoduleBump(root, subPath, newCommit) {
  const [{ baseBranch }, currentBranch] = await Promise.all([
    getRepoBranches(root),
    getBranch(root)
  ]);
  const defaultBranch = baseBranch || 'main';
  if (currentBranch !== defaultBranch) {
    console.log(`⏭️  Skipping submodule commit — ${root} is on ${currentBranch}, not ${defaultBranch}`);
    return {
      committed: false,
      commitSkipped: 'not-on-default-branch',
      commitNote: `not committed — repo is on ${currentBranch}, not ${defaultBranch}`,
      defaultBranch,
      currentBranch
    };
  }

  await stageFiles(root, [subPath]);
  const staged = await execGitSafe(['diff', '--cached', '--name-only', '--', toLiteralPathspec(subPath)], root);
  if (!staged.stdout.trim()) {
    return {
      committed: false,
      commitSkipped: 'no-changes',
      commitNote: 'pointer already committed',
      defaultBranch,
      currentBranch
    };
  }

  const message = `chore: update ${subPath} submodule${newCommit ? ` to ${newCommit}` : ''}`;
  const { hash } = await commit(root, message);
  console.log(`📝 Committed submodule bump ${subPath} on ${defaultBranch} (${hash || 'unknown sha'})`);
  return {
    committed: true,
    commitSha: hash,
    commitMessage: message,
    commitNote: `committed on ${defaultBranch}`,
    defaultBranch,
    currentBranch
  };
}

/**
 * Update a specific submodule to the latest remote version.
 * @param {string} subPath - Repo-relative submodule path
 * @param {object} [options]
 * @param {string} [options.repoPath] - Repo root; defaults to the PortOS checkout.
 * @param {boolean} [options.commit] - Commit the pointer bump on the default branch.
 * @returns {Promise<{newCommit: string|null} & SubmoduleCommitResult>}
 */
export async function updateSubmodule(subPath, { repoPath, commit: shouldCommit = false } = {}) {
  const root = repoPath || PATHS.root;
  // Owns the known-submodule invariant for every caller — thrown as a ServerError
  // so the route doesn't have to re-list the submodules just to answer with a 400.
  const knownPaths = await getSubmodulePaths(root);
  if (!knownPaths.includes(subPath)) {
    throw new ServerError(`Unknown submodule path: ${subPath}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  console.log(`📦 Updating submodule ${subPath}...`);
  const updateArgs = ['submodule', 'update', '--init', '--recursive', '--remote', subPath];
  // A submodule's lock lives in `.git/modules/<subPath>/`, which every worktree
  // of the parent repo shares, so one killed git process wedges this button
  // permanently — each press re-reports a concurrent git process that exited
  // long ago. Clear the abandoned lock and retry ONCE; a lock too young to call
  // stale, or a failure that names no lock, rethrows untouched so a genuinely
  // concurrent update still reports contention rather than racing it.
  await execGit(updateArgs, root, { timeout: 60000 }).catch(async (err) => {
    if (!clearStaleGitLock(err.message)) throw err;
    await execGit(updateArgs, root, { timeout: 60000 });
  });
  console.log(`✅ Submodule ${subPath} updated`);
  const statusResult = await execGit(['submodule', 'status', subPath], root);
  const parsed = parseSubmoduleStatusLine(statusResult.stdout);
  const newCommit = parsed ? parsed.commit.substring(0, 7) : null;

  if (!shouldCommit) return { newCommit, committed: false };
  return { newCommit, ...(await commitSubmoduleBump(root, subPath, newCommit)) };
}
