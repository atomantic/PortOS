/**
 * "Is this checkout in a state an unattended update may run against?"
 *
 * An update — either channel — moves the checkout: `update.sh` switches to the
 * default branch and stashes whatever was in the way, and the App Management
 * path runs `updateDefaultBranch`, which checks out, fast-forwards, and falls
 * back to `pull --rebase --autostash`. Both are fine when a human is watching
 * and can read the stash instructions. Unattended, they are not: a stash nobody
 * is told about reads as lost work, and a rebase conflict leaves the install
 * half-updated with nothing to notice it.
 *
 * So the auto-updater refuses to start until the checkout is ON the default
 * branch and CLEAN, and this module is what decides that — plus what can be put
 * right mechanically. Two remedies are safe enough to run unattended, because
 * neither can destroy work:
 *
 *   - checking out the default branch from a CLEAN feature branch (the commits
 *     stay on the branch ref; nothing is discarded), and
 *   - restoring modified auto-generated lockfiles (`npm install` rewrites them
 *     as a side effect, and the update reinstalls anyway).
 *
 * Everything else — uncommitted work, an unpushed commit, an interrupted
 * rebase/merge, conflict markers — is judgement no script should make on a
 * user's repository. That queues a CoS task instead, which is the same
 * escalation `appUpdater.failWithGitConflict` already uses for a conflicted
 * managed-app pull.
 */

import { existsSync } from 'fs';
import { join, isAbsolute } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { execGit } from '../lib/execGit.js';
import * as gitService from './git.js';
import { classifyWorktreeDirt } from './worktreeManager.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';

/** First line of the repair task — stable so `addTask`'s dedup collapses reruns. */
export const REPO_REPAIR_TASK_DESCRIPTION = 'Restore the PortOS checkout to a clean default branch so automatic updates can run';

/** Why a checkout is not ready, ordered most-blocking first for the UI. */
const REASON_LABELS = {
  'git-unreadable': 'the checkout could not be inspected',
  'no-default-branch': 'the origin default branch could not be resolved',
  'merge-in-progress': 'a merge or rebase is in progress',
  'conflicted-files': 'the working tree has unresolved conflicts',
  'uncommitted-changes': 'the working tree has uncommitted changes',
  'unpushed-commits': 'the default branch has local commits that are not on origin',
  'detached-head': 'HEAD is detached',
  'wrong-branch': 'the checkout is not on the default branch',
};

const describe = (code) => REASON_LABELS[code] || code;

/** Absolute paths only — a relative path would resolve against the server's cwd. */
const resolveRepoPath = (repoPath) => (isAbsolute(repoPath || '') ? repoPath : PATHS.root);

async function gitDirPath(repoPath) {
  const result = await execGit(['rev-parse', '--absolute-git-dir'], repoPath, { ignoreExitCode: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** An interrupted merge/rebase/cherry-pick leaves a marker in the git dir. */
async function interruptedOperation(repoPath) {
  const gitDir = await gitDirPath(repoPath);
  if (!gitDir) return null;
  const markers = [
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert'],
  ];
  for (const [name, kind] of markers) {
    if (existsSync(join(gitDir, name))) return kind;
  }
  return null;
}

/** How far HEAD and its origin counterpart have diverged. */
async function divergence(repoPath, branch) {
  const counts = await execGit(
    ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${branch}`],
    repoPath,
    { ignoreExitCode: true },
  );
  if (counts.exitCode !== 0) return { ahead: null, behind: null };
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  return {
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
  };
}

/**
 * Inspect the checkout without touching it.
 *
 * @param {object} [options]
 * @param {string} [options.repoPath] - defaults to this install's root.
 * @param {boolean} [options.fetch] - refresh origin refs first, so `behind`
 *   answers "is there anything to update to?" rather than "was there, last
 *   time something fetched?". The auto-updater wants this; a status read for
 *   the UI does not.
 * @returns {Promise<object>} the readiness verdict.
 */
export async function checkUpdateRepoReadiness({ repoPath = PATHS.root, fetch = false } = {}) {
  const dir = resolveRepoPath(repoPath);
  const base = {
    repoPath: dir, branch: null, defaultBranch: null, clean: null, lockfilePaths: [], dirtyPaths: [],
    ahead: null, behind: null, reasons: [], repairable: [], ready: false, needsAgent: false,
  };

  if (!(await gitService.isRepo(dir).catch(() => false))) {
    return { ...base, reasons: ['git-unreadable'], needsAgent: false };
  }
  if (fetch) await gitService.fetchOrigin(dir).catch(() => undefined);

  const defaultBranch = await gitService.getDefaultBranch(dir, { strict: true }).catch(() => null);
  const branch = await gitService.getBranch(dir).catch(() => null);
  const porcelain = await gitService.getStatusPorcelain(dir).catch(() => null);
  if (branch === null || porcelain === null) {
    return { ...base, defaultBranch, reasons: ['git-unreadable'] };
  }

  const dirt = classifyWorktreeDirt(porcelain);
  const conflicted = porcelain.split('\n').some((line) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(line));
  const interrupted = await interruptedOperation(dir);
  const detached = branch === 'HEAD';
  const onDefaultBranch = Boolean(defaultBranch) && branch === defaultBranch;
  const { ahead, behind } = defaultBranch ? await divergence(dir, defaultBranch) : { ahead: null, behind: null };

  const reasons = [];
  const repairable = [];
  if (!defaultBranch) reasons.push('no-default-branch');
  if (interrupted) reasons.push('merge-in-progress');
  if (conflicted) reasons.push('conflicted-files');
  if (dirt.hasRealChanges) reasons.push('uncommitted-changes');
  else if (!dirt.clean) repairable.push('restore-lockfiles');
  if (detached) reasons.push('detached-head');
  else if (defaultBranch && !onDefaultBranch) {
    // A clean feature branch is a mechanical checkout away from ready; a dirty
    // one is already refused above, so the branch move is never what loses work.
    if (dirt.hasRealChanges || conflicted || interrupted) reasons.push('wrong-branch');
    else repairable.push('checkout-default');
  }
  // Only meaningful ON the default branch: a feature branch is expected to be
  // ahead, and the checkout-default remedy leaves those commits where they are.
  if (onDefaultBranch && ahead > 0) reasons.push('unpushed-commits');

  return {
    repoPath: dir,
    branch,
    defaultBranch,
    onDefaultBranch,
    clean: dirt.clean,
    lockfileOnlyDirt: !dirt.clean && !dirt.hasRealChanges,
    lockfilePaths: dirt.lockfilePaths,
    dirtyPaths: dirt.realChangePaths,
    interrupted,
    ahead,
    behind,
    reasons,
    repairable,
    // Ready means: nothing to refuse AND nothing left to repair. A repairable
    // checkout becomes ready only after `prepareUpdateRepo` actually repairs it.
    ready: reasons.length === 0 && repairable.length === 0,
    // A checkout that is merely repairable must NOT wake an agent — that is the
    // whole point of the repairable/blocking split.
    needsAgent: reasons.length > 0 && !reasons.includes('git-unreadable'),
    summary: reasons.length ? reasons.map(describe).join('; ') : null,
  };
}

/**
 * Apply the mechanical remedies, then re-inspect.
 *
 * Never destroys work: the only discard is a modified auto-generated lockfile,
 * and the only branch move happens from a clean tree.
 *
 * @returns {Promise<{verdict: object, actions: string[]}>} the POST-repair
 *   verdict, plus what was actually done (for the log line and the runtime record).
 */
export async function prepareUpdateRepo({ repoPath = PATHS.root } = {}) {
  const dir = resolveRepoPath(repoPath);
  const before = await checkUpdateRepoReadiness({ repoPath: dir, fetch: true });
  if (before.ready || before.repairable.length === 0) return { verdict: before, actions: [] };

  const actions = [];
  if (before.repairable.includes('restore-lockfiles') && before.lockfilePaths.length) {
    // By explicit path, never `-- .`: the classifier proved these specific
    // paths are auto-generated lockfiles, and a pathspec of `.` would discard
    // anything the classifier had not looked at (a file that appeared between
    // the two calls, say) along with them.
    const restore = await execGit(['checkout', '--', ...before.lockfilePaths], dir, { ignoreExitCode: true });
    if (restore.exitCode === 0) actions.push(`restored ${before.lockfilePaths.length} auto-generated lockfile(s)`);
  }
  if (before.repairable.includes('checkout-default') && before.defaultBranch) {
    const checkout = await execGit(['checkout', before.defaultBranch], dir, { ignoreExitCode: true });
    if (checkout.exitCode === 0) actions.push(`switched to ${before.defaultBranch}`);
  }

  // Re-inspect rather than assuming the remedies worked: a checkout can still
  // fail (a permission problem, a hook), and a verdict that claimed otherwise
  // would hand the updater a checkout it never verified.
  const verdict = await checkUpdateRepoReadiness({ repoPath: dir, fetch: false });
  if (actions.length) console.log(`🧹 Auto-update repo prep: ${actions.join(', ')}`);
  return { verdict, actions };
}

/**
 * Queue a CoS agent to resolve what no script should: uncommitted work, an
 * unpushed commit, an interrupted rebase, conflict markers.
 *
 * The first line is constant, so `addTask`'s description+app dedup collapses
 * every subsequent tick onto the one open task instead of queueing an agent per
 * poll. The task store is imported lazily — this module is on the update path,
 * the repair branch is rare, and a static import would pull the whole CoS state
 * graph into that closure.
 *
 * Never rejects: a failed enqueue must not mask the readiness refusal itself.
 *
 * @returns {Promise<{id: string, duplicate?: boolean}|null>}
 */
export async function queueRepoRepairTask(verdict) {
  const context = [
    'Automatic PortOS updates are configured, but they are held back because this checkout is not in a state an unattended update may run against.',
    '',
    `Repository: ${verdict.repoPath}`,
    `Current branch: ${verdict.branch || 'unknown'}`,
    `Default branch: ${verdict.defaultBranch || 'unknown'}`,
    verdict.interrupted ? `Interrupted operation: ${verdict.interrupted}` : null,
    Number.isFinite(verdict.ahead) ? `Local commits not on origin: ${verdict.ahead}` : null,
    '',
    'What is blocking the update:',
    ...verdict.reasons.map((code, index) => `${index + 1}. ${describe(code)}`),
    '',
    `Resolve it so the checkout ends up clean on ${verdict.defaultBranch || 'the default branch'}: finish or abort any in-progress `
      + 'rebase/merge, land or park uncommitted work (commit and open a PR, or restore it — never discard it silently), '
      + 'and push or PR any local commits that are not on origin. Do not run the update itself; PortOS resumes automatically '
      + 'once the checkout is clean.',
    '',
    'Work in the primary checkout, not a worktree — the state that needs fixing is there.',
  ].filter((line) => line !== null).join('\n');

  return import('./cosTaskStore.js')
    .then(({ addTask }) => addTask({
      description: REPO_REPAIR_TASK_DESCRIPTION,
      priority: 'HIGH',
      app: PORTOS_APP_ID,
      context,
      useWorktree: false,
    }, 'internal'))
    .catch((err) => {
      console.error(`❌ Failed to queue auto-update repo repair task: ${err.message}`);
      return null;
    });
}
