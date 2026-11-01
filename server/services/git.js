import { existsSync, realpathSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, dirname, join, resolve } from 'path';
import { safeJSONParse, PATHS, sleep, rmGuarded } from '../lib/fileUtils.js';
import { isGitLockError, listWorktrees } from './worktreeManager.js';
import { execGit, execGitSafe } from '../lib/execGit.js';
import { clearStaleGitLock } from '../lib/gitStaleLock.js';
import { resolveForgeForRepo } from './forgeAuth.js';
export { resolveForgeForRepo, resolveForgeTokenEnv } from './forgeAuth.js';
import {
  parseStatus,
  parseDiffStat,
  parseBranchVerboseLine,
  parseSubmoduleStatusLine,
  extractAgentSummary,
  isBenignConcurrentFetchRefRace
} from '../lib/gitOutputParsers.js';
import {
  parseGitRemote,
  parseGitHubOwnerFromRemote,
  pickGhAccountForOwner,
  detectForgeCli,
  parsePullRequestUrl
} from '../lib/gitForge.js';
import { PROTECTED_BRANCHES, validateFilePaths, toLiteralPathspec, assertSafeRef } from '../lib/gitArgs.js';
import { ServerError } from '../lib/errorHandler.js';
import { securityScanPRDisclosure } from '../lib/securityScanEvidence.js';

// Re-export so callers that used to import from services/git.js keep working.
export { execGit, execGitSafe };
// Re-export the extracted pure helpers so existing
// `import { … } from 'services/git.js'` call sites keep working.
export {
  parseStatus,
  parseGitRemote,
  parseGitHubOwnerFromRemote,
  pickGhAccountForOwner,
  detectForgeCli,
  parsePullRequestUrl,
  extractAgentSummary
};

const checkoutMutations = new Map();
const checkoutMutationContext = new AsyncLocalStorage();

// Existing writers register so an exclusive rebase/push cannot overlap them.
// Nested calls retain their own publication lifetime, even if they outlive a parent.
async function withCheckoutMutation(dir, work, { exclusive = false } = {}) {
  let key;
  try { key = realpathSync(dir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = resolve(dir);
  }
  // API paths may name a subdirectory or a symlink into the same checkout.
  for (let root = key; ; root = dirname(root)) {
    if (existsSync(join(root, '.git'))) { key = root; break; }
    if (dirname(root) === root) break;
  }
  const active = checkoutMutations.get(key);
  const parent = checkoutMutationContext.getStore();
  const inherited = parent?.active && parent.key === key && parent.state === active;
  if (!inherited && (active?.exclusive || (exclusive && active))) {
    throw new ServerError('A Git operation is already running for this checkout', { status: 409, code: 'GIT_BUSY' });
  }
  const state = active || { count: 0, exclusive };
  state.count++;
  checkoutMutations.set(key, state);
  const context = { key, state, active: true };
  try {
    const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
    return await withCheckoutPublication(dir, () => checkoutMutationContext.run(context, work));
  } finally {
    context.active = false;
    if (--state.count === 0) checkoutMutations.delete(key);
  }
}

/**
 * Get git status for a directory.
 *
 * `paths` scopes the answer to a pathspec, for a caller whose follow-up write
 * is itself scoped — a repo-wide "is anything dirty?" does not answer "did THIS
 * file change?", and a partial `git commit -- <path>` exits 1 when that path
 * carries no change.
 */
export async function getStatus(dir, { paths = [] } = {}) {
  const result = await execGit(
    ['status', '--porcelain', ...(paths.length ? ['--', ...paths] : [])],
    dir,
    { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
  );
  // trimEnd (not trim): porcelain status codes use leading spaces (e.g. ' M' = unstaged)
  const lines = result.stdout.trimEnd().split('\n').filter(Boolean);

  const files = lines.map(line => {
    const status = line.substring(0, 2);
    const path = line.substring(3);
    return {
      path,
      status: parseStatus(status),
      staged: status[0] !== ' ' && status[0] !== '?',
      modified: status[1] === 'M',
      added: status[0] === 'A' || status === '??',
      deleted: status[0] === 'D' || status[1] === 'D'
    };
  });

  return {
    clean: files.length === 0,
    files,
    staged: files.filter(f => f.staged).length,
    unstaged: files.filter(f => !f.staged).length
  };
}

/**
 * Raw `git status --porcelain` output, for callers that need to feed it to
 * `classifyWorktreeDirt` (worktreeManager.js) rather than re-deriving "is this
 * dirt real work?" from the parsed shape. Kept separate from `getStatus` because
 * that one is returned verbatim by `POST /api/git/status`, where a raw duplicate
 * of `files[]` would just double the payload on every dirty tree.
 */
export async function getStatusPorcelain(dir) {
  return (await execGit(['status', '--porcelain'], dir,
    { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
}

/**
 * Get current branch name
 */
export async function getBranch(dir) {
  const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  return result.stdout.trim();
}

/**
 * Get recent commits
 */
export async function getCommits(dir, limit = 10) {
  // Validate limit is a positive integer to prevent injection
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const format = '--format={"hash":"%h","message":"%s","author":"%an","date":"%cI"}';
  const result = await execGit(['log', format, '-n', String(safeLimit)], dir);

  const commits = result.stdout.trim().split('\n').filter(Boolean)
    .map(line => safeJSONParse(line, null))
    .filter(Boolean);

  return commits;
}

/**
 * Get diff for unstaged changes
 */
export async function getDiff(dir, staged = false) {
  const args = staged ? ['diff', '--cached'] : ['diff'];
  const result = await execGit(args, dir, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
}

/**
 * Get diff stats
 */
export async function getDiffStats(dir) {
  const result = await execGit(['diff', '--stat'], dir);
  return parseDiffStat(result.stdout);
}

/**
 * Stage files. Paths are passed with `:(literal)` pathspec magic so git
 * treats wildcard characters as literal filename bytes — `[id].jsx` stages
 * that exact file, and a crafted `*` can't expand to the whole tree.
 */
export async function stageFiles(dir, files) {
  return withCheckoutMutation(dir, () => stageFilesAdmitted(dir, files));
}

async function stageFilesAdmitted(dir, files) {
  const safePaths = validateFilePaths(files).map(toLiteralPathspec);
  await execGit(['add', '--', ...safePaths], dir);
  return true;
}

/**
 * Unstage files (same literal-pathspec handling as stageFiles).
 */
export async function unstageFiles(dir, files) {
  return withCheckoutMutation(dir, () => unstageFilesAdmitted(dir, files));
}

async function unstageFilesAdmitted(dir, files) {
  const safePaths = validateFilePaths(files).map(toLiteralPathspec);
  await execGit(['reset', 'HEAD', '--', ...safePaths], dir);
  return true;
}

/**
 * Create commit.
 *
 * `paths` scopes the commit to those repo-relative files (`git commit -m … -- <pathspecs>`),
 * so an automated commit can never sweep in whatever the user happened to have staged.
 * Same `:(literal)` pathspec handling as stageFiles. Omitted = commit the index as-is.
 */
export async function commit(dir, message, { paths = [] } = {}) {
  return withCheckoutMutation(dir, () => commitAdmitted(dir, message, { paths }));
}

// Snapshot only read-only identities. Detached/unborn HEAD cannot verify an
// ambiguous result; ordinary successful commits there still work as before.
async function commitIdentity(dir) {
  const branch = await execGit(['symbolic-ref', '--quiet', 'HEAD'], dir, { ignoreExitCode: true });
  const head = await execGit(['rev-parse', '--verify', 'HEAD'], dir, { ignoreExitCode: true });
  return {
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    head: head.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : null
  };
}

async function verifyCommitReadback(dir, before, action) {
  const after = await commitIdentity(dir);
  if (!before.branch?.startsWith('refs/heads/') || !before.head
    || after.branch !== before.branch || !after.head || after.head === before.head) return { after, verified: false };
  const log = await execGit(['reflog', '-1', '--format=%H%x00%gs', before.branch], dir);
  const [hash, subject] = log.stdout.trim().split('\0');
  const parent = await execGit(['rev-parse', `${after.head}^1`], dir);
  // A matching tree/message alone could belong to a competing writer. The
  // per-invocation reflog action correlates this advance with our child process.
  const current = await commitIdentity(dir);
  return { after, verified: hash === after.head && subject?.startsWith(`${action}: `)
    && parent.stdout.trim() === before.head
    && current.branch === before.branch && current.head === after.head };
}

async function commitAdmitted(dir, message, { paths = [] } = {}) {
  const pathspecs = paths.length ? ['--', ...validateFilePaths(paths).map(toLiteralPathspec)] : [];
  const before = await commitIdentity(dir);
  const action = `portos-commit-${randomUUID()}`;
  // Rerere can fail AFTER commit updated the ref (#13292). Never repeat the
  // mutation or touch a lock. Timeouts/signals remain uncertain lifetime errors.
  const result = await execGit(['commit', '-m', message, ...pathspecs], dir, {
    ignoreExitCode: true, env: { ...process.env, GIT_REFLOG_ACTION: action }
  });
  if (result.exitCode !== 0) {
    const readback = Number.isInteger(result.exitCode) && !result.terminated
      ? await verifyCommitReadback(dir, before, action).catch(() => null) : null;
    const commitOutcome = {
      command: 'commit', exitCode: result.exitCode, beforeHead: before.head,
      afterHead: readback?.after?.head ?? null,
      status: readback?.verified ? 'verified-committed' : 'unverified'
    };
    if (readback?.verified) return { hash: readback.after.head, message, commitOutcome };
    throw Object.assign(new Error(result.stderr || `git exited with code ${result.exitCode}`), {
      commitOutcome, ...(result.terminated ? { name: 'AbortError', terminated: true, signal: result.signal } : {})
    });
  }
  // Stop at the header's hash before bracketed hexadecimal text in the subject.
  const hashMatch = result.stdout.match(/^\[[^\r\n]*? ([a-f0-9]+)\]/m);
  return {
    hash: hashMatch ? hashMatch[1] : null,
    message
  };
}

/**
 * Check if directory is a git repo
 */
export async function isRepo(dir, { unknownOnError = false } = {}) {
  const result = await execGit(['rev-parse', '--is-inside-work-tree'], dir, { ignoreExitCode: true }).catch(() => null);
  // Execution guards retain their default fail-closed boolean contract.
  if (!unknownOnError) return result?.stdout.trim() === 'true';
  // A display may only disable Git features after a conclusive probe. Git can
  // resolve nonzero (ownership/configuration errors), or report interruption.
  if (!result || result.terminated || result.signal) return undefined;
  const inside = result.stdout.trim();
  if (result.exitCode === 0 && (inside === 'true' || inside === 'false')) return inside === 'true';
  // Recognize only ordinary discovery failure (execGit keeps it in English).
  // Unrecognized errors remain unknown rather than misclassifying a valid but
  // inaccessible repo.
  // Git distinguishes reaching its search ceiling from reaching a mount point.
  const diagnostic = result.stderr.trim();
  const discoveryFailed = diagnostic === 'fatal: not a git repository (or any of the parent directories): .git'
    || /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.$/.test(diagnostic);
  if (result.exitCode === 128 && !inside
    && discoveryFailed) return false;
  return undefined;
}

/** Actionable refusal text shared by task creation and spawn-time worktree prep. */
export function notGitRepoMessage(appName) {
  return `${appName} is not a git repository — run \`git init\` in its directory (and add a remote if PRs are needed), or disable worktree/PR for this task`;
}

/**
 * Get remote info
 */
export async function getRemote(dir) {
  const result = await execGit(['remote', '-v'], dir, { ignoreExitCode: true }).catch(() => null);
  if (!result) return null;

  const lines = result.stdout.trim().split('\n');
  const origins = {};

  lines.forEach(line => {
    const [name, url, type] = line.split(/\s+/);
    if (!origins[name]) origins[name] = {};
    origins[name][type?.replace(/[()]/g, '')] = url;
  });

  return origins;
}

/**
 * Fetch from origin
 */
const FETCH_MAX_ATTEMPTS = 4;
const FETCH_RETRY_DELAY_MS = 250;
const FETCH_FRESHNESS_MS = 15000;
const SUBMODULE_UPDATE_TIMEOUT_MS = 60000;

const lastFetchTimes = new Map();
const activeFetches = new Map();

export function recordFetchSuccess(dir) {
  if (dir) lastFetchTimes.set(dir, Date.now());
}

export function isFetchFresh(dir, windowMs = FETCH_FRESHNESS_MS) {
  if (!dir) return false;
  const last = lastFetchTimes.get(dir);
  if (!last) return false;
  return (Date.now() - last) < windowMs;
}

export function clearFetchCache() {
  lastFetchTimes.clear();
  activeFetches.clear();
}

function fetchOriginAttempt(dir, attempt, prune = false) {
  return execGit(prune ? ['fetch', '--prune', 'origin'] : ['fetch', 'origin'], dir).then(
    () => {
      recordFetchSuccess(dir);
      return true;
    },
    (err) => {
      // A concurrent fetch that already wrote the exact refs this one wanted is
      // a SUCCESS reported as a failure — git exits non-zero on the lost
      // compare-and-swap even though the remote-tracking refs now hold the
      // right commits. Retrying re-runs a whole network fetch to learn there is
      // nothing to do, and on a busy repo every attempt loses the same race, so
      // the caller surfaced a red error for work that had actually completed.
      if (isBenignConcurrentFetchRefRace(err.message)) {
        recordFetchSuccess(dir);
        return true;
      }
      // Another PortOS surface or agent may advance the same remote ref mid-fetch.
      if (attempt >= FETCH_MAX_ATTEMPTS || !isGitLockError(err.message)) throw err;
      return sleep(FETCH_RETRY_DELAY_MS).then(() => fetchOriginAttempt(dir, attempt + 1, prune));
    }
  );
}

/**
 * Fetch origin with the concurrency handling a raw `git fetch` lacks: retries an
 * `index.lock` collision, and treats a lost compare-and-swap on refs another
 * PortOS surface already wrote as the SUCCESS it is.
 * @param {string} dir
 * @param {{prune?: boolean}} [opts] - `prune` also drops remote-tracking refs whose
 *   remote branch is gone, for callers that go on to reason about what origin still has.
 */
export async function fetchOrigin(dir, { prune = false } = {}) {
  const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
  return withCheckoutPublication(dir, () => fetchOriginAdmitted(dir, { prune }));
}

function fetchOriginAdmitted(dir, { prune = false } = {}) {
  return fetchOriginAttempt(dir, 1, prune);
}

/**
 * Update all local branches that have remote tracking branches.
 * Uses fetch refspecs for non-current branches to avoid checkout (which
 * would swap files on disk and trigger HMR/server restarts).
 */
export async function updateBranches(dir) {
  return withCheckoutMutation(dir, () => updateBranchesAdmitted(dir));
}

async function updateBranchesAdmitted(dir) {
  await fetchOrigin(dir);

  const status = await getStatus(dir);
  const currentBranch = await getBranch(dir);
  const allBranches = await getBranches(dir);
  const trackBranches = allBranches.filter(b => b.tracking).map(b => b.name);

  const results = { currentBranch };

  // Update non-current branches via fetch refspec (no checkout needed)
  for (const branch of trackBranches.filter(b => b !== currentBranch)) {
    const r = await execGit(['fetch', 'origin', `${branch}:${branch}`], dir, { ignoreExitCode: true });
    results[branch] = (r.stderr?.includes('fatal') || r.stderr?.includes('rejected')) ? 'failed' : 'updated';
  }

  // Update current branch if it's one of the tracked branches — requires merge
  // Skip if working tree is dirty — other agents may own those uncommitted changes
  if (trackBranches.includes(currentBranch)) {
    if (!status.clean) {
      results[currentBranch] = 'skipped-dirty';
    } else {
      const r = await execGit(['merge', '--ff-only', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
      results[currentBranch] = r.stderr?.includes('fatal') ? 'failed' : 'updated';
    }
  }

  return results;
}

/**
 * Get branch comparison (how far ahead headBranch is from baseBranch)
 */
export async function getBranchComparison(dir, baseBranch = 'main', headBranch = 'dev') {
  assertSafeRef(baseBranch);
  assertSafeRef(headBranch);
  const format = '--format={"hash":"%h","message":"%s","author":"%an","date":"%cI"}';
  const logResult = await execGit(
    ['log', format, `${baseBranch}..${headBranch}`], dir, { ignoreExitCode: true }
  );

  const commits = logResult.stdout.trim()
    .split('\n')
    .filter(Boolean)
    .map(line => safeJSONParse(line, null))
    .filter(Boolean);

  const statResult = await execGit(
    ['diff', '--stat', `${baseBranch}...${headBranch}`], dir, { ignoreExitCode: true }
  );

  return {
    ahead: commits.length,
    commits,
    stats: parseDiffStat(statResult.stdout)
  };
}

/**
 * Push to origin
 */
export async function push(dir, branch = null) {
  return withCheckoutMutation(dir, () => pushAdmitted(dir, branch));
}

async function pushAdmitted(dir, branch = null) {
  if (branch) assertSafeRef(branch);
  const args = branch ? ['push', 'origin', branch] : ['push'];
  const result = await execGit(args, dir);
  return { success: true, output: result.stdout + result.stderr };
}

/**
 * Push all local branches that are ahead of their remote tracking branch.
 * Never uses --force. Returns per-branch results.
 */
export async function pushAll(dir) {
  return withCheckoutMutation(dir, () => pushAllAdmitted(dir));
}

async function pushAllAdmitted(dir) {
  const allBranches = await getBranches(dir);
  const pushable = allBranches.filter(b => b.tracking && b.ahead > 0);

  if (pushable.length === 0) {
    return { success: true, pushed: 0, results: {}, message: 'Nothing to push' };
  }

  const results = {};
  let failed = 0;

  for (const branch of pushable) {
    const r = await execGit(['push', 'origin', branch.name], dir, { ignoreExitCode: true });
    const output = (r.stdout || '') + (r.stderr || '');
    const ok = r.exitCode === 0;
    results[branch.name] = { success: ok, output: output.trim() };
    if (!ok) failed++;
  }

  return {
    success: failed === 0,
    pushed: pushable.length - failed,
    failed,
    total: pushable.length,
    results
  };
}

/**
 * Create and switch to a new branch
 */
export async function createBranch(dir, branchName) {
  return withCheckoutMutation(dir, () => createBranchAdmitted(dir, branchName));
}

async function createBranchAdmitted(dir, branchName) {
  await execGit(['checkout', '-b', branchName], dir);
  return { success: true, branch: branchName };
}

/**
 * Switch to an existing branch
 */
export async function checkout(dir, branchName) {
  return withCheckoutMutation(dir, () => checkoutAdmitted(dir, branchName));
}

async function checkoutAdmitted(dir, branchName) {
  assertSafeRef(branchName);
  await execGit(['checkout', branchName], dir);
  return { success: true, branch: branchName };
}

async function execForgeCli(cli, args, dir, env) {
  if (cli === 'glab') {
    const { execGlab } = await import('./gitlab.js');
    return execGlab(args, dir, undefined, { env, rejectOnError: true });
  }
  const { execGh } = await import('./github.js');
  return execGh(args, undefined, { cwd: dir, env });
}

/**
 * Create a pull request (GitHub) or merge request (GitLab) using `gh` / `glab`.
 * Forge is auto-detected from the repo's `origin` URL; gh identity is auto-pinned
 * to the matching account when multiple gh accounts are logged in.
 * Fails gracefully if the relevant CLI is not installed.
 * @param {string} dir - Working directory (repo root)
 * @param {object} options - PR options
 * @param {string} options.title - PR/MR title
 * @param {string} options.body - PR/MR description
 * @param {string} options.base - Base branch (target)
 * @param {string} options.head - Head branch (source, must be pushed to remote)
 * @returns {Promise<{success: boolean, url?: string, error?: string, cli?: string, account?: string|null, owner?: string|null, host?: string|null}>}
 */
export async function createPR(dir, { title, body, base, head, draft = false }) {
  const { cli, env, host, owner, account } = await resolveForgeForRepo(dir);

  const args = cli === 'glab'
    ? ['mr', 'create', '--title', title, '--description', body || '', '--target-branch', base, '--source-branch', head]
    : ['pr', 'create', '--title', title, '--body', body || '', '--base', base, '--head', head];

  if (draft) args.push('--draft');
  const meta = { cli, account, owner, host };

  try {
    const stdout = await execForgeCli(cli, args, dir, env);
    if (stdout === null) {
      return { success: false, error: `${cli} command failed or timed out`, ...meta };
    }
    // Both gh and glab print the resulting URL on stdout (gh: just the URL;
    // glab: a couple lines ending in the URL — extract the last http(s)-looking line).
    const urlMatch = stdout.trim().match(/(https?:\/\/\S+)\s*$/);
    const url = urlMatch ? urlMatch[1] : stdout.trim();
    return { success: true, url, ...meta };
  } catch (err) {
    return { success: false, error: err.message || `${cli} command failed`, ...meta };
  }
}

/**
 * Merge an already-open GitHub pull request with the same owner-pinned `gh`
 * environment used to create it. Callers decide when CI is green; this helper
 * only performs the deterministic merge and reports its outcome.
 *
 * The actual `gh pr merge` invocation is the shared core in
 * `appPullRequestMerge.js` (`runForgeMerge`), lazily imported like the other
 * forge CLIs below — this stays the only owner of that argv (#7580), and its
 * `['pr', 'merge', prNumber, '--merge']` shape and 60s
 * default timeout are pinned by `git.forgeTimeout.test.js`.
 *
 * @param {string} dir - Working directory for the target repository
 * @param {number|string} prNumber - Pull request number
 * @returns {Promise<{success: boolean, error?: string, cli?: string, account?: string|null, owner?: string|null, host?: string|null}>}
 */
export async function mergePR(dir, prNumber, { forgeAccount = null, expectedHeadSha = null } = {}) {
  // The pin matters here as much as on the read side: an owner-match alone picks
  // the wrong account for an org repo, and the merge fails authorization (#7540).
  const { cli, env, host, owner, account } = await resolveForgeForRepo(dir, { forgeAccount });
  const meta = { cli, account, owner, host };
  if (cli !== 'gh') {
    return { success: false, error: `Merge-only PR automation requires gh, not ${cli}`, ...meta };
  }

  const { runForgeMerge } = await import('./appPullRequestMerge.js');
  const result = await runForgeMerge({
    cwd: dir,
    env,
    forge: 'github',
    repoSpec: null,
    number: prNumber,
    method: 'merge',
    deleteBranch: false,
    expectedHeadSha,
  });
  if (result.code === 'invalid-head') return { success: false, error: result.error, ...meta };

  // A zero exit may mean queued, and a timeout/nonzero exit may follow a
  // completed merge. Read back before reporting success or deleting anything.
  const { execGh } = await import('./github.js');
  const merged = await execGh(['pr', 'view', String(prNumber), '--json',
    'state,url,headRefName,headRefOid,baseRefName,isCrossRepository,headRepository'],
  undefined, { cwd: dir, env }).then(value => safeJSONParse(value, null), () => null);
  if (merged?.state !== 'MERGED') {
    return { success: false, error: result.error || 'Pull request merge is not yet verified',
      branchCleanup: { deleted: false, reason: 'merge-unverified' }, ...meta };
  }
  if (expectedHeadSha && (typeof merged.headRefOid !== 'string'
      || merged.headRefOid.toLowerCase() !== expectedHeadSha.toLowerCase())) {
    return { success: false, error: 'Merged pull request does not match the reviewed head',
      code: 'reviewed-head-changed', branchCleanup: { deleted: false, reason: 'reviewed-head-changed' }, ...meta };
  }
  const branchCleanup = await deleteVerifiedMergedHead(dir, merged, { expectedHeadSha, host, prNumber, env, account });
  return { success: true, mergedHeadSha: merged.headRefOid, branchCleanup, ...meta };
}

/** Remote cleanup is independent of merge success; local refs and worktrees
 * belong to the archive/ownership cleanup workflow, including ignored files. */
async function deleteVerifiedMergedHead(dir, merged, { expectedHeadSha, host, prNumber, env, account }) {
  const retain = reason => ({ deleted: false, reason });
  if (!expectedHeadSha) return retain('reviewed-head-unavailable');
  const target = parsePullRequestUrl(merged.url);
  if (!target || String(target.number) !== String(prNumber) || target.host.toLowerCase() !== String(host).toLowerCase()) {
    return retain('repository-unverified');
  }
  const fullName = `${target.owner}/${target.repo}`.toLowerCase();
  if (merged.isCrossRepository !== false || typeof merged.headRepository?.nameWithOwner !== 'string'
      || merged.headRepository.nameWithOwner.toLowerCase() !== fullName) {
    return retain('source-repository-unverified');
  }
  const branch = merged.headRefName;
  if (typeof branch !== 'string' || !branch || typeof merged.baseRefName !== 'string' || !merged.baseRefName
      || PROTECTED_BRANCHES.includes(branch) || branch === merged.baseRefName) {
    return retain('protected-or-unknown-source');
  }
  const { execGh } = await import('./github.js');
  const repository = await execGh(['repo', 'view', `${target.host}/${target.owner}/${target.repo}`, '--json', 'defaultBranchRef'],
    undefined, { cwd: dir, env }).then(value => safeJSONParse(value, null), () => null);
  const defaultBranch = repository?.defaultBranchRef?.name;
  if (typeof defaultBranch !== 'string' || !defaultBranch) return retain('default-branch-unverified');
  if (branch === defaultBranch) return retain('protected-default-source');
  // forgeAuth only mints a new environment for a successfully resolved
  // github.com account. A matched account plus ambient GH_TOKEN is not proof.
  if (host !== 'github.com' || !account || env === process.env || !env?.GH_TOKEN) {
    return retain('account-bound-push-unavailable');
  }
  const ref = `refs/heads/${branch}`;
  const valid = await execGitSafe(['check-ref-format', ref], dir);
  if (valid.exitCode !== 0) return retain('invalid-source-ref');
  const urls = await execGitSafe(['remote', 'get-url', '--push', '--all', 'origin'], dir);
  const pushUrls = urls.stdout.trim().split('\n').filter(Boolean);
  if (urls.exitCode !== 0 || pushUrls.length !== 1) return retain('push-target-ambiguous');
  const { parseGitRemoteUrl } = await import('../lib/gitRemote.js');
  const remote = parseGitRemoteUrl(pushUrls[0]);
  if (!remote || remote.host.toLowerCase() !== target.host.toLowerCase()
      || `${remote.owner}/${remote.repo}`.toLowerCase() !== fullName) return retain('push-target-mismatch');
  // SSH keys and embedded credentials can select a different identity from
  // the merge token. Keep those sources for explicit owner cleanup.
  if (!/^https:\/\/[^@/]+\//i.test(pushUrls[0])) return retain('account-bound-push-unavailable');

  // Capture the URL rather than re-resolving a remote name at write time. The
  // lease compares the server's actual ref, never a stale tracking branch.
  const deletion = await execGitSafe(['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    '-c', 'core.askPass=', 'push', `--force-with-lease=${ref}:${expectedHeadSha}`, '--', pushUrls[0], `:${ref}`], dir,
  { env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GH_PROMPT_DISABLED: '1' } });
  if (deletion.exitCode !== 0) return retain('remote-delete-failed-or-uncertain');
  return { deleted: true, branch };
}

/**
 * Request a Copilot code review on a GitHub PR. The reviewer login MUST include
 * the `[bot]` suffix or GitHub returns 422 "must be a collaborator". GitLab has
 * no equivalent — this is a GitHub-only no-op there, signaled with
 * `{ success: true, skipped: true }` so callers can treat it as a successful
 * non-event rather than a real failure (avoiding spurious warnings/notifications
 * on GitLab MRs).
 *
 * @param {string} dir - Working directory used to resolve gh auth
 * @param {string} prUrl - PR URL returned by createPR
 * @returns {Promise<{success: boolean, skipped?: boolean, error?: string}>}
 */
export async function requestCopilotReview(dir, prUrl) {
  const parsed = parsePullRequestUrl(prUrl);
  if (!parsed) return { success: false, error: `unparseable PR URL: ${prUrl}` };

  // Decide forge from the PR URL itself — that's the authoritative signal of where
  // the review request needs to go. Falling back to the repo's `origin` (via
  // resolveForgeForRepo) is wrong when `dir` isn't a parseable repo, or when the
  // repo origin disagrees with the PR URL (e.g. GitLab MR URL reached via a
  // mirror/fork on github.com). Non-GitHub PR URLs short-circuit as a successful
  // skip so cleanupAgentWorktree doesn't emit a warning for every GitLab MR.
  if (detectForgeCli(parsed.host) !== 'gh') return { success: true, skipped: true };

  const { cli, env } = await resolveForgeForRepo(dir);
  // Repo-side resolution might still come back non-gh (e.g. dir is empty/malformed
  // and resolveForgeForRepo returned a glab host). Belt and suspenders: skip rather
  // than try to talk to gh with the wrong env.
  if (cli !== 'gh') return { success: true, skipped: true };

  // Target the same GitHub instance the PR lives on. Without --hostname, gh uses
  // its current default host, which is wrong for GHES installs or when the user
  // has multiple gh hosts configured. github.com is gh's implicit default so we
  // only need to set it explicitly for non-default hosts.
  const args = ['api'];
  if (parsed.host && parsed.host !== 'github.com') {
    args.push('--hostname', parsed.host);
  }
  args.push(
    `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/requested_reviewers`,
    '-X', 'POST',
    '-f', 'reviewers[]=copilot-pull-request-reviewer[bot]'
  );

  try {
    const output = await execForgeCli('gh', args, dir, env);
    if (output === null) return { success: false, error: 'gh command failed or timed out' };
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || 'gh command failed' };
  }
}

/**
 * Generate a rich PR description from the agent's output summary.
 * Prefers explicit final-response segments, then the tail of agent output,
 * stripping tool-call artifacts and keeping only the meaningful explanation
 * of what was implemented (new APIs, UI elements, behaviors, etc.).
 * Falls back to commit messages when no agent output is available.
 * @param {string} dir - Working directory (repo root)
 * @param {string} baseBranch - Base branch (e.g., 'main')
 * @param {string} headBranch - Head branch (agent's branch)
 * @param {string} agentOutput - Raw agent output text
 * @returns {Promise<string>} Formatted PR body
 */
export async function generatePRDescription(dir, baseBranch, headBranch, agentOutput, securityScan, securityScanControl) {
  const summary = extractAgentSummary(agentOutput);
  const prefix = `Automated PR created by PortOS Chief of Staff.\n\n${securityScanPRDisclosure(securityScan, securityScanControl)}`;

  if (summary) {
    return `${prefix}## Summary\n\n${summary}`;
  }

  // Fallback: build from commit messages when no usable agent output
  const comparison = await getBranchComparison(dir, baseBranch, headBranch).catch(() => null);
  if (comparison?.commits?.length) {
    const commitLines = comparison.commits.map(c => `- ${c.message}`).join('\n');
    return `${prefix}## Changes\n\n${commitLines}`;
  }

  return prefix.trimEnd();
}

/**
 * Suggest a concise PR title from the branch's commits, falling back to a
 * provided text (typically the task description).
 *
 * The CoS task description is often verbose user prose (e.g. "on the
 * settings/backup page, we should have a button to run the backup. Also, we
 * should show default exclusions"). Commit subjects on the branch are far
 * better titles because the agent wrote them as conventional-commit summaries
 * of the actual change.
 *
 * Picks the OLDEST commit on the branch when present — for multi-commit
 * branches that include follow-ups like "address review:" or "/simplify"
 * cleanups, the first commit is usually the main feature/fix.
 *
 * @param {string} dir - Working directory (repo root or worktree)
 * @param {string} baseBranch - Base branch the PR will target
 * @param {string} headBranch - Branch the PR will be opened from
 * @param {string} fallbackText - Used when no commits are found
 * @returns {Promise<string>} PR title (<= 100 chars)
 */
export async function suggestPRTitle(dir, baseBranch, headBranch, fallbackText) {
  assertSafeRef(baseBranch);
  assertSafeRef(headBranch);
  // A worktree's local main may lag the PR target by many merged commits.
  // Compare against the fetched remote target, matching what the forge reviews.
  const remoteBase = `refs/remotes/origin/${baseBranch}`;
  const remote = await execGitSafe(['rev-parse', '--verify', remoteBase], dir);
  const baseRef = remote.exitCode === 0 ? remoteBase : baseBranch;
  const log = await execGitSafe(
    ['log', '--reverse', '--no-merges', '--format=%s', `${baseRef}..${headBranch}`], dir,
  );
  // Subjects are plain text: JSON interpolation drops titles containing quotes.
  const subject = log.stdout?.split(/\r?\n/).find(line => line.trim())?.trim();
  if (subject) return subject.substring(0, 100);
  const firstLine = (fallbackText || '').split(/[\r\n]/).find(l => l.trim()) || '';
  return firstLine.trim().substring(0, 100) || 'CoS automated task';
}

export async function getDefaultBranch(dir, { allowRemote = true, strict = false } = {}) {
  const symRef = await execGitSafe(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
  if (symRef.stdout?.trim()) {
    const branch = symRef.stdout.trim().replace(/^origin\//, '');
    // Verify the ref actually exists (origin/HEAD could be stale)
    const verify = await execGitSafe(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], dir);
    if (verify.exitCode === 0 || verify.stdout?.trim()) return branch;
  }

  // origin/HEAD not set locally — ask the remote (best-effort, short timeout)
  if (allowRemote) {
    await execGitSafe(['remote', 'set-head', 'origin', '--auto'], dir, { timeout: 5000 });
    const symRef2 = await execGitSafe(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
    if (symRef2.stdout?.trim()) {
      const branch2 = symRef2.stdout.trim().replace(/^origin\//, '');
      const verify2 = await execGitSafe(['rev-parse', '--verify', `refs/remotes/origin/${branch2}`], dir);
      if (verify2.exitCode === 0 || verify2.stdout?.trim()) return branch2;
    }
  }

  // Fall back to local branch detection
  const result = await execGitSafe(['branch', '--list'], dir);
  const branches = (result.stdout || '').trim().split('\n').map(b => b.replace(/^\*?\s+/, '')).filter(Boolean);
  if (branches.includes('main')) return 'main';
  if (branches.includes('master')) return 'master';

  // Callers that are about to mutate a checkout need a known default branch;
  // falling back to whichever feature branch happens to be checked out would
  // make a remote-sync operation treat that branch as the canonical target.
  if (strict) return null;

  // Last resort: use the currently checked-out branch
  const head = await execGitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (head.stdout?.trim() && head.stdout.trim() !== 'HEAD') {
    return head.stdout.trim();
  }

  return null;
}

/**
 * Detect base and dev branches from local refs (origin/HEAD, local branch list).
 * Does not contact the remote — safe for latency-sensitive request paths.
 * Computes the branch list once and reuses it for both base and dev detection.
 * @returns {{ baseBranch: string|null, devBranch: string|null }}
 */
export async function getRepoBranches(dir) {
  // Check origin/HEAD first (fast, local-only)
  const symRef = await execGitSafe(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir);
  let baseBranch = null;
  if (symRef.stdout?.trim()) {
    const candidate = symRef.stdout.trim().replace(/^origin\//, '');
    // Verify the ref actually exists (origin/HEAD could be stale)
    const verify = await execGitSafe(['rev-parse', '--verify', `refs/remotes/origin/${candidate}`], dir);
    if (verify.exitCode === 0 || verify.stdout?.trim()) {
      baseBranch = candidate;
    }
  }

  // Get local branches once — reused for both base fallback and dev detection
  const result = await execGitSafe(['branch', '--list'], dir);
  const branches = (result.stdout || '').trim().split('\n').map(b => b.replace(/^\*?\s+/, '')).filter(Boolean);

  if (!baseBranch) {
    if (branches.includes('main')) baseBranch = 'main';
    else if (branches.includes('master')) baseBranch = 'master';
  }

  return {
    baseBranch,
    devBranch: branches.includes('dev') ? 'dev' : branches.includes('develop') ? 'develop' : null
  };
}

/**
 * Get the set of local branch names merged into the default branch.
 * Prefers the local default-branch ref, but falls back to the remote-tracking
 * ref when there's no local branch by that name (single-branch clones,
 * feature-only worktrees) — otherwise `git branch --merged <defaultBranch>`
 * fails and every branch silently reports unmerged.
 * @param {string} dir - Working directory
 * @param {string} defaultBranch - Default branch name (e.g. "main")
 * @returns {Promise<Set<string>>}
 */
async function getLocalMergedBranchNames(dir, defaultBranch) {
  let result = await execGit(
    ['branch', '--merged', defaultBranch, '--format=%(refname:short)'],
    dir,
    { ignoreExitCode: true }
  );
  if (result.exitCode !== 0) {
    result = await execGit(
      ['branch', '--merged', `origin/${defaultBranch}`, '--format=%(refname:short)'],
      dir,
      { ignoreExitCode: true }
    );
  }
  return new Set(result.stdout.trim().split('\n').filter(Boolean));
}

/**
 * Get all local branches with tracking info
 * @returns {Promise<Array<{name: string, current: boolean, tracking: string|null, ahead: number, behind: number, isDefault: boolean, merged: boolean, worktree: boolean}>>}
 */
export async function getBranches(dir, { strict = false } = {}) {
  // Get branches with verbose info (includes tracking)
  const [result, { baseBranch }, worktreeBranches] = await Promise.all([
    execGit(
      ['branch', '-vv', '--format=%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)'],
      dir,
      { ignoreExitCode: true }
    ),
    getRepoBranches(dir),
    getWorktreeBranches(dir)
  ]);

  if (strict && result.exitCode !== 0) {
    throw new Error(result.stderr || `git branch -vv failed with exit code ${result.exitCode}`);
  }

  const defaultBranch = baseBranch || 'main';
  const protectedSet = new Set(PROTECTED_BRANCHES);
  protectedSet.add(defaultBranch);

  const mergedSet = await getLocalMergedBranchNames(dir, defaultBranch);

  return result.stdout.trim().split('\n').filter(Boolean)
    .map(parseBranchVerboseLine)
    .map(b => ({
      ...b,
      isDefault: b.name === defaultBranch,
      // A branch checked out in another worktree can't be `git branch -d`'d, so
      // cleanup-merged skips it. Flag it so the UI doesn't advertise it as
      // deletable (otherwise the "Clean N merged" button promises deletions the
      // server correctly refuses, and the user gets "No merged branches to clean up").
      worktree: !b.current && worktreeBranches.has(b.name),
      merged: !b.current && !protectedSet.has(b.name) && mergedSet.has(b.name)
    }));
}

/**
 * Pull changes from remote for current branch
 */
export async function pull(dir) {
  return withCheckoutMutation(dir, () => pullAdmitted(dir));
}

async function pullAdmitted(dir) {
  const result = await execGit(['pull', '--rebase', '--autostash'], dir).catch((err) => {
    // A rebase killed mid-flight can leave the repo in a rebase-in-progress
    // state, so a lock found here is cleared but NOT retried — blindly
    // re-running `pull --rebase` could stack onto that abandoned state instead
    // of starting clean. Surface it so the next explicit pull starts fresh.
    const clearedLock = clearStaleGitLock(err.message);
    if (clearedLock) {
      throw new Error(
        `Cleared an abandoned git lock (${clearedLock}) left by a killed git process. `
        + `The pull did not run — retry it now that the lock is clear.`
      );
    }
    throw err;
  });
  return { success: true, output: result.stdout + result.stderr };
}

function gitResultOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function gitResultError(result, fallback) {
  return [result.stdout, result.stderr]
    .map(stream => (stream || '').trim())
    .filter(Boolean)
    .join('\n') || fallback;
}

/**
 * Run a pinned-submodule command, retrying once when Git names an abandoned
 * lock. `git submodule update` is safe to retry after that specific rescue:
 * unlike a pull/rebase, it has no partially-applied history operation to stack
 * on top of.
 */
async function runPinnedSubmoduleCommand(args, dir) {
  let result = await execGitSafe(args, dir, { timeout: SUBMODULE_UPDATE_TIMEOUT_MS });
  if (result.exitCode === 0 || !clearStaleGitLock(result.stderr)) return result;
  result = await execGitSafe(args, dir, { timeout: SUBMODULE_UPDATE_TIMEOUT_MS });
  return result;
}

/**
 * Synchronize submodule URLs and check out the commits pinned by the parent.
 * The parent gitlink is the version contract; `--remote` is intentionally not
 * used because a managed-app update must not consume an unreviewed submodule
 * head. Kept private because callers need the parent update transaction, not
 * an independently exposed submodule workflow.
 */
async function updatePinnedSubmodules(dir) {
  const sync = await runPinnedSubmoduleCommand(['submodule', 'sync', '--recursive'], dir);
  if (sync.exitCode !== 0) {
    return {
      success: false,
      output: gitResultOutput(sync),
      error: gitResultError(sync, 'could not synchronize submodule metadata')
    };
  }

  const update = await runPinnedSubmoduleCommand(['submodule', 'update', '--init', '--recursive'], dir);
  return {
    success: update.exitCode === 0,
    output: gitResultOutput(update),
    ...(update.exitCode === 0
      ? {}
      : { error: gitResultError(update, 'could not update pinned submodules') })
  };
}

/**
 * Move a managed application's primary checkout onto origin's default branch
 * and bring it up to date. Non-destructive: nothing is discarded, and local
 * work is preserved either by carrying it across the checkout or by git's own
 * `--autostash` (which re-applies it after the rebase).
 *
 * Order of attempts:
 *   1. Reconcile submodules to the current parent gitlinks, so an interrupted
 *      earlier update cannot make the pull fail on a stale submodule checkout.
 *   2. `pull --ff-only` — the common case, no rewrite, no stash.
 *   3. `pull --rebase --autostash` — the checkout is dirty and/or the local
 *      branch has diverged from origin. This is what "Update App" used to
 *      refuse outright with DIRTY_WORKTREE.
 *   4. Reconcile submodules again after the parent pull, because a new commit
 *      can advance a gitlink while leaving its worktree at the old commit.
 *   5. On conflict, preserve the operation and report `conflict: true`
 *      so an agent or operator can inspect it and explicitly recover.
 *
 * A zero exit status is NOT enough to call the rebase clean. `--autostash`
 * re-applies the stash after the rebase finishes, and git only WARNS when that
 * apply conflicts ("Applying autostash resulted in conflicts") — the pull still
 * exits 0 with conflict markers in the working tree. So a successful rebase is
 * confirmed by asking git for unmerged paths, not by its exit code; otherwise
 * the caller would build and restart on a broken tree. There is no rebase to
 * abort in that state (it already completed).
 *
 * @param {string} dir
 * @returns {Promise<{success: boolean, branch: string, output: string, conflict: boolean, rebased?: boolean, error?: string}>}
 */
export async function updateDefaultBranch(dir) {
  return withCheckoutMutation(dir, () => updateDefaultBranchAdmitted(dir));
}

// Process-local lanes cannot exclude CLI actors or their conflict-resolution
// edits, even within a rebase this request started. Git has no conditional abort.
const SHARED_REBASE_RECOVERY = 'Git operation state and any autostash were preserved. Inspect git status and save any conflict-resolution edits before explicitly continuing or aborting the operation.';

async function updateDefaultBranchAdmitted(dir) {
  if (await rebaseInProgress(dir)) {
    return { success: false, branch: await getBranch(dir), output: '', conflict: true, error: `A rebase is already in progress. ${SHARED_REBASE_RECOVERY}` };
  }
  // Git splits a failed pull across both streams — fetch progress and rebase
  // instructions on stderr, the `CONFLICT (content): …` lines naming the files
  // on stdout — so an `stderr || stdout` pick would drop exactly the part that
  // says WHICH files collided from the UI message and the CoS task's context.
  const bothStreams = (result, fallback) => [result.stdout, result.stderr]
    .map(stream => (stream || '').trim())
    .filter(Boolean)
    .join('\n') || fallback;

  // A killed `fetch` can leave a shared ref lock (`refs/remotes/origin/*.lock`,
  // `packed-refs.lock`) that every worktree of this repo shares. `fetch` is
  // idempotent, so this uses the same clear-and-retry-once shape as
  // `updateSubmodule` rather than surfacing a permanent, confusing failure.
  await execGit(['fetch', 'origin'], dir).catch(async (err) => {
    if (!clearStaleGitLock(err.message)) throw err;
    await execGit(['fetch', 'origin'], dir);
  });
  const runtimeBranch = await execGit(['config', '--get', 'portos.runtimeBranch'], dir, { ignoreExitCode: true });
  const branch = runtimeBranch.stdout.trim() || await getDefaultBranch(dir, { strict: true });
  if (!branch) throw new ServerError('could not determine origin default branch', { status: 400, code: 'NO_DEFAULT_BRANCH' });

  const currentBranch = await getBranch(dir);
  let output = '';
  const reconcileSubmodules = async () => {
    const submodules = await updatePinnedSubmodules(dir);
    output += submodules.output;
    return submodules.success ? null : {
      success: false,
      branch,
      output,
      conflict: true,
      error: `pinned submodule update failed: ${submodules.error}`
    };
  };

  const currentSubmoduleError = await reconcileSubmodules();
  if (currentSubmoduleError) return currentSubmoduleError;

  if (currentBranch !== branch) {
    // Uncommitted changes ride along when they don't collide with the target
    // branch; when they do, git refuses and we route that to the conflict path
    // instead of throwing an unactionable error at the UI.
    const checkout = await execGit(['checkout', branch], dir, { ignoreExitCode: true });
    output += checkout.stdout + checkout.stderr;
    if (checkout.exitCode !== 0) {
      // Checkout can leave a partially-written index, so a lock found here is
      // cleared but NOT retried — the next explicit attempt starts from a
      // lock-free repo instead of racing this one.
      const clearedLock = clearStaleGitLock(checkout.stderr);
      return {
        success: false,
        branch,
        output,
        conflict: true,
        error: clearedLock
          ? `Cleared an abandoned git lock (${clearedLock}) left by a killed git process. The checkout onto ${branch} did not run — retry the update now that the lock is clear.`
          : bothStreams(checkout, `could not check out ${branch}`)
      };
    }

    // Checking out the target branch can change the gitlinks without moving
    // the submodule worktrees. Reconcile that target tree before pulling so a
    // previous branch's submodule checkout cannot make the pull fail.
    const targetSubmoduleError = await reconcileSubmodules();
    if (targetSubmoduleError) return targetSubmoduleError;
  }

  const fastForward = await execGit(['pull', '--ff-only', 'origin', branch], dir, { ignoreExitCode: true });
  output += fastForward.stdout + fastForward.stderr;
  if (await rebaseInProgress(dir) || fastForward.terminated) {
    return { success: false, branch, output, conflict: true, error: `${bothStreams(fastForward, 'Pull did not complete.')} ${SHARED_REBASE_RECOVERY}` };
  }
  if (fastForward.exitCode === 0) {
    const submoduleError = await reconcileSubmodules();
    if (submoduleError) return submoduleError;
    return { success: true, branch, output, conflict: false };
  }

  const fastForwardLock = clearStaleGitLock(fastForward.stderr);
  if (fastForwardLock) {
    return {
      success: false,
      branch,
      output,
      conflict: true,
      error: `Cleared an abandoned git lock (${fastForwardLock}) left by a killed git process. The fast-forward pull did not run — retry the update now that the lock is clear.`
    };
  }

  const rebase = await execGit(['pull', '--rebase', '--autostash', 'origin', branch], dir, { ignoreExitCode: true });
  output += rebase.stdout + rebase.stderr;
  const activeRebase = await rebaseInProgress(dir);
  if (rebase.exitCode === 0 && !rebase.terminated && !activeRebase) {
    const unmerged = await execGit(['diff', '--name-only', '--diff-filter=U'], dir, { ignoreExitCode: true });
    const conflicted = unmerged.stdout.trim().split('\n').filter(Boolean);
    if (unmerged.exitCode === 0 && !unmerged.terminated && !conflicted.length) {
      const submoduleError = await reconcileSubmodules();
      if (submoduleError) return submoduleError;
      return { success: true, branch, output, conflict: false, rebased: true };
    }
    return {
      success: false,
      branch,
      output,
      conflict: true,
      error: conflicted.length
        ? `re-applying the autostashed local changes conflicted in: ${conflicted.join(', ')}`
        : bothStreams(unmerged, 'Could not verify local changes after rebasing.')
    };
  }

  const rebaseLock = Number.isInteger(rebase.exitCode) && !rebase.terminated && !activeRebase
    && clearStaleGitLock(rebase.stderr);
  return {
    success: false,
    branch,
    output,
    conflict: true,
    error: rebaseLock
      ? `Cleared an abandoned git lock (${rebaseLock}). The rebase did not complete; inspect the checkout before retrying. ${SHARED_REBASE_RECOVERY}`
      : `${bothStreams(rebase, `rebase onto origin/${branch} did not complete`)} ${SHARED_REBASE_RECOVERY}`
  };
}

/**
 * Sync branch - pull then push
 */
export async function syncBranch(dir, branch = null) {
  return withCheckoutMutation(dir, () => syncBranchAdmitted(dir, branch), { exclusive: true });
}

/** Reconcile local default-branch commits with origin without stashing or force-pushing. */
export async function rebaseAndPushDefaultBranch(dir) {
  return withCheckoutMutation(dir, () => rebaseAndPushDefaultBranchAdmitted(dir), { exclusive: true });
}

async function rebaseAndPushDefaultBranchAdmitted(dir) {
  const refused = (error) => ({ success: false, pulled: false, pushed: false, error });
  const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], dir)).stdout.trim();
  if ([...SEQUENCER_STATE.map(([marker]) => marker), 'MERGE_HEAD', 'sequencer']
    .some(marker => existsSync(join(gitDir, marker)))) {
    return refused('Finish the Git operation already in progress before rebasing and pushing.');
  }
  const branch = await getBranch(dir);
  const defaultBranch = await getDefaultBranch(dir, { strict: true });
  if (!defaultBranch || branch !== defaultBranch) {
    return refused('Check out the default branch before rebasing and pushing.');
  }
  assertSafeRef(branch);
  if (!(await getStatus(dir)).clean) {
    return refused('Commit or stash local changes before rebasing and pushing.');
  }
  await fetchOrigin(dir);
  if (await getBranch(dir) !== branch || !(await getStatus(dir)).clean) {
    return refused('The checkout changed while fetching. Check its branch and local changes before retrying.');
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  const counts = await execGit(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], dir);
  if (!(Number(counts.stdout.trim().split(/\s+/)[0]) > 0)) {
    return refused('The default branch has no local commits ahead of origin.');
  }
  const localMerges = await execGit(['rev-list', '--merges', `${remoteRef}..HEAD`], dir);
  if (localMerges.stdout.trim()) {
    return refused('Local history contains merge commits. Reconcile these with an agent or in the terminal to preserve merge resolutions; nothing was rebased or pushed.');
  }
  // Fetch + rebase is the explicit-origin equivalent of pull --rebase. Avoid
  // pull.ff / upstream configuration and never move dirty work via autostash.
  const rebased = await execGit(['rebase', '--no-autostash', remoteRef], dir, { ignoreExitCode: true });
  if (rebased.exitCode !== 0 || rebased.terminated || await rebaseInProgress(dir)) {
    return refused(`${gitResultError(rebased, 'Rebase did not complete.')} ${SHARED_REBASE_RECOVERY} Nothing was pushed.`);
  }
  if (await getBranch(dir) !== branch) return refused('The checked-out branch changed; nothing was pushed.');
  const verifiedHead = (await execGit(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], dir)).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(verifiedHead)) return refused('Could not verify the default-branch commit; nothing was pushed.');
  const pushed = await execGit(['push', 'origin', `${verifiedHead}:refs/heads/${branch}`], dir, { ignoreExitCode: true });
  return {
    success: pushed.exitCode === 0,
    branch,
    pulled: true,
    pushed: pushed.exitCode === 0,
    output: gitResultOutput(rebased) + gitResultOutput(pushed),
    error: pushed.exitCode === 0 ? null : gitResultError(pushed, 'Push failed; rebased commits remain local.'),
  };
}

async function syncBranchAdmitted(dir, branch = null) {
  if (branch) assertSafeRef(branch);
  const refused = error => ({ success: false, pulled: false, pushed: false, error });
  const gitDir = (await execGit(['rev-parse', '--absolute-git-dir'], dir)).stdout.trim();
  const operationInProgress = () => [...SEQUENCER_STATE.map(([marker]) => marker), 'MERGE_HEAD', 'sequencer']
    .some(marker => existsSync(join(gitDir, marker)));
  if (operationInProgress()) {
    return refused('Finish the Git operation already in progress before syncing.');
  }
  const currentBranch = branch || await getBranch(dir);
  const pullResult = await execGit(['pull', '--rebase', '--autostash', 'origin', currentBranch], dir, { ignoreExitCode: true });
  if (pullResult.exitCode !== 0 || pullResult.terminated) {
    // The API lane does not exclude Git CLI actors. Even a request-specific
    // reflog proves only who started a rebase, not who now owns its edits. Git
    // has no generation-conditioned abort, so a check followed by --abort can
    // still discard another actor's work. Preserve shared-checkout recovery.
    const settled = Number.isInteger(pullResult.exitCode) && !pullResult.terminated;
    const activeOperation = operationInProgress();
    const clearedLock = settled && !activeOperation && clearStaleGitLock(pullResult.stderr);
    const recovery = activeOperation
      ? ' Git operation state and any autostash were preserved. Inspect git status and save any conflict-resolution edits before explicitly continuing or aborting the operation; nothing was pushed.' : '';
    const error = clearedLock
      ? `Cleared an abandoned git lock (${clearedLock}) left by a killed git process. The pull did not complete — inspect the checkout before retrying the sync.`
      : gitResultError(pullResult, 'Pull failed; nothing was pushed.');
    return refused(`${error}${recovery}`);
  }

  // A separate actor can start an operation during pull, including one with
  // staged resolutions that lets pull exit zero. It still must not be pushed.
  if (operationInProgress()) {
    return refused('A Git operation is in progress after pulling. Its state and edits were preserved; inspect git status and finish that operation before syncing again. Nothing was pushed.');
  }

  // Autostash reapplication can conflict after Git has exited successfully.
  // Preserve the conflicted files and Git's saved stash rather than aborting
  // an already-completed rebase or attempting to apply/drop the stash again.
  const unmerged = await execGit(['diff', '--name-only', '--diff-filter=U'], dir, { ignoreExitCode: true });
  if (unmerged.exitCode !== 0) {
    return refused(gitResultError(unmerged, 'Could not verify local changes after pulling; nothing was pushed.'));
  }
  if (unmerged.stdout.trim()) {
    return refused(`Re-applying autostashed local changes conflicted in: ${unmerged.stdout.trim()}. Resolve the conflicts before syncing again; nothing was pushed.`);
  }

  const pushResult = await execGit(['push', 'origin', currentBranch], dir, { ignoreExitCode: true });
  const pushSuccess = pushResult.exitCode === 0 && !pushResult.terminated;
  return {
    success: pushSuccess,
    pulled: true,
    pushed: pushSuccess,
    output: gitResultOutput(pullResult) + gitResultOutput(pushResult),
    error: pushSuccess ? null : gitResultError(pushResult, 'Push failed; local commits remain in the checkout.')
  };
}

/**
 * Check if a .changelog/ directory exists in the repo
 */
export function hasChangelogDir(dir) {
  return existsSync(join(dir, '.changelog'));
}

/**
 * Ensure workspace has the latest code from origin before agent work begins.
 * Scripted pull: fetch + fast-forward merge on the dev/default branch.
 * If the working tree is dirty, skips the pull — other agents may own those
 * uncommitted changes and stashing could interfere with their work.
 *
 * @param {string} dir - Git repository directory
 * @returns {{ success: boolean, branch: string, conflict: boolean, error: string|null }}
 */

// One pre-task pull per checkout at a time. Several agents for the same app
// prep concurrently; serialize them so a later request sees any stopped
// operation at preflight instead of launching Git on top of it.
const ensureLatestTails = new Map();

export async function ensureLatest(dir) {
  const gitCheck = await execGit(['rev-parse', '--is-inside-work-tree'], dir, { ignoreExitCode: true });
  if (gitCheck.exitCode === 128
    && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point)/im.test(gitCheck.stderr || '')) {
    return { success: true, branch: null, conflict: false, error: null, skipped: 'not-a-repo' };
  }
  if (gitCheck.exitCode !== 0 || gitCheck.stdout.trim() !== 'true') {
    throw new Error(gitCheck.stderr?.trim() || 'Could not verify Git working tree');
  }
  return withCheckoutMutation(dir, () => ensureLatestAdmitted(dir));
}

function ensureLatestAdmitted(dir) {
  const key = resolve(dir);
  const prev = ensureLatestTails.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => ensureLatestUnserialized(dir));
  const tail = run.catch(() => {});
  ensureLatestTails.set(key, tail);
  tail.then(() => { if (ensureLatestTails.get(key) === tail) ensureLatestTails.delete(key); });
  return run;
}

async function rebaseInProgress(dir) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const res = await execGit(['rev-parse', '--git-path', name], dir, { ignoreExitCode: true });
    const gitPath = res.stdout?.trim();
    if (gitPath && existsSync(resolve(dir, gitPath))) return true;
  }
  return false;
}

// git's rebase failure output is a multi-line block of `hint:` advice with a
// `\r`-overwritten progress line glued in front — the part worth logging is
// the error plus the CONFLICT lines naming the files.
function summarizeRebaseConflict({ stdout = '', stderr = '' } = {}) {
  const lines = `${stdout}\n${stderr}`.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const keep = lines.filter(l => /^(CONFLICT|error:|fatal:)/.test(l));
  return (keep.length ? keep : lines.filter(l => !l.startsWith('hint:')).slice(0, 3)).join('; ') || 'rebase failed';
}

async function ensureLatestUnserialized(dir) {
  // A rebase left in progress is someone's (a person's, or an agent resolving a
  // conflict) — never start a second one on top of it, and never abort it.
  if (await rebaseInProgress(dir)) {
    const branch = await getBranch(dir).catch(() => null);
    return {
      success: false,
      branch,
      conflict: true,
      error: 'a rebase is already in progress in this checkout; finish it (git rebase --continue) or abort it (git rebase --abort)'
    };
  }

  const currentBranch = await getBranch(dir).catch(() => null);
  if (!currentBranch) return { success: true, branch: null, conflict: false, error: null, skipped: 'no-branch' };

  // Check for remote — no remote means nothing to pull
  const remote = await getRemote(dir).catch(() => null);
  if (!remote?.origin) return { success: true, branch: currentBranch, conflict: false, error: null, skipped: 'no-remote' };

  // Fetch latest refs from origin. Idempotent, so an abandoned lock (left by a
  // killed git process, shared by every worktree of this repo) is cleared and
  // retried once rather than reported as a permanent failure.
  let fetchResult = await execGit(['fetch', 'origin'], dir, { ignoreExitCode: true });
  if (fetchResult.stderr?.includes('fatal') && clearStaleGitLock(fetchResult.stderr)) {
    fetchResult = await execGit(['fetch', 'origin'], dir, { ignoreExitCode: true });
  }
  if (fetchResult.stderr?.includes('fatal')) {
    return { success: false, branch: currentBranch, conflict: false, error: `fetch failed: ${fetchResult.stderr}` };
  }
  recordFetchSuccess(dir);

  // Check if remote tracking branch exists
  const remoteRef = await execGit(['rev-parse', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  if (remoteRef.stderr?.includes('unknown revision')) {
    return { success: true, branch: currentBranch, conflict: false, error: null, skipped: 'no-remote-tracking' };
  }

  // Check if already up to date
  const localHead = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
  const remoteHead = remoteRef.stdout.trim();
  if (localHead === remoteHead) {
    return { success: true, branch: currentBranch, conflict: false, error: null, upToDate: true };
  }

  // Skip pull if working tree is dirty — other agents may own those changes
  const status = await getStatus(dir).catch(() => ({ clean: true }));
  if (!status.clean) {
    return { success: true, branch: currentBranch, conflict: false, error: null, skipped: 'dirty-working-tree' };
  }

  // Try fast-forward merge first (safest — no rewrite)
  const mergeResult = await execGit(['merge', '--ff-only', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  if (await rebaseInProgress(dir) || mergeResult.terminated) {
    return { success: false, branch: currentBranch, conflict: true, error: `${summarizeRebaseConflict(mergeResult)} ${SHARED_REBASE_RECOVERY}` };
  }
  const mergeOk = mergeResult.exitCode === 0;

  if (mergeOk) {
    return { success: true, branch: currentBranch, conflict: false, error: null };
  }

  // A lock found here is cleared but NOT retried — a blind retry could race a
  // still-write-in-progress index. Surface it so the next explicit attempt
  // starts from a lock-free repo.
  const mergeLock = clearStaleGitLock(mergeResult.stderr);
  if (mergeLock) {
    return {
      success: false,
      branch: currentBranch,
      conflict: true,
      error: `Cleared an abandoned git lock (${mergeLock}) left by a killed git process. The fast-forward merge did not complete — retry now that the lock is clear.`
    };
  }

  // Fast-forward failed — local branch has diverged. Try rebase.
  const rebaseResult = await execGit(['rebase', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  const activeRebase = await rebaseInProgress(dir);
  if (rebaseResult.exitCode !== 0 || rebaseResult.terminated || activeRebase) {
    const rebaseLock = Number.isInteger(rebaseResult.exitCode) && !rebaseResult.terminated && !activeRebase
      && clearStaleGitLock(rebaseResult.stderr);
    return {
      success: false,
      branch: currentBranch,
      conflict: true,
      error: rebaseLock
        ? `Cleared an abandoned git lock (${rebaseLock}). The rebase did not complete; inspect the checkout before retrying. ${SHARED_REBASE_RECOVERY}`
        : `branch ${currentBranch} has diverged from origin and rebase did not complete: ${summarizeRebaseConflict(rebaseResult)} ${SHARED_REBASE_RECOVERY}`
    };
  }

  return { success: true, branch: currentBranch, conflict: false, error: null };
}

/**
 * Get remote branches with merge status relative to the default branch.
 * Returns branches that exist on origin, indicating whether each has been
 * fully merged into the default branch and whether a local copy exists.
 */
export async function getRemoteBranches(dir, { force = false } = {}) {
  // Fetch latest refs if forced or not fresh within window
  if (force || !isFetchFresh(dir)) {
    const { withCheckoutPublication } = await import('../lib/checkoutRetirementAdmission.js');
    const freshen = () => withCheckoutPublication(dir, async () => {
      if (activeFetches.has(dir)) {
        await activeFetches.get(dir);
      } else {
        const fetchPromise = execGit(['fetch', 'origin', '--prune'], dir, { ignoreExitCode: true })
          .then(res => {
            if (res.exitCode === 0 || isBenignConcurrentFetchRefRace(res.stderr || res.stdout || '')) {
              recordFetchSuccess(dir);
            }
            return res;
          })
          .finally(() => {
            activeFetches.delete(dir);
          });
        activeFetches.set(dir, fetchPromise);
        await fetchPromise;
      }
    });
    if (force) {
      await freshen();
    } else {
      await freshen().catch(error => {
        if (error?.code === 'CHECKOUT_RETIREMENT_RESERVED' || error?.message === 'checkout-retirement-reserved') return null;
        throw error;
      });
    }
  }

  // Detect default branch
  const { baseBranch } = await getRepoBranches(dir);
  const defaultBranch = baseBranch || 'main';

  // Get all remote branches
  const result = await execGit(
    ['branch', '-r', '--format=%(refname:short)|%(committerdate:iso8601)|%(authorname)'],
    dir,
    { ignoreExitCode: true }
  );

  // Get merged remote branches relative to default branch
  const mergedResult = await execGit(
    ['branch', '-r', '--merged', `origin/${defaultBranch}`, '--format=%(refname:short)'],
    dir,
    { ignoreExitCode: true }
  );
  const mergedSet = new Set(mergedResult.stdout.trim().split('\n').filter(Boolean));

  // Get local branches for cross-reference
  const localResult = await execGit(['branch', '--format=%(refname:short)'], dir, { ignoreExitCode: true });
  const localSet = new Set(localResult.stdout.trim().split('\n').filter(Boolean));

  const remoteBranches = result.stdout.trim().split('\n').filter(Boolean)
    .map(line => {
      const [fullRef, date, author] = line.split('|');
      // Only include refs from origin remote
      if (!fullRef.startsWith('origin/')) return null;
      // Strip "origin/" prefix
      const name = fullRef.replace(/^origin\//, '');
      // Skip HEAD pointer and refs without a branch name (bare remote name)
      if (name === 'HEAD' || fullRef.includes('HEAD') || !name) return null;
      return {
        name,
        fullRef,
        merged: mergedSet.has(fullRef),
        hasLocal: localSet.has(name),
        lastCommitDate: date?.trim() || null,
        author: author?.trim() || null,
        isDefault: name === defaultBranch
      };
    })
    .filter(Boolean);

  return { branches: remoteBranches, defaultBranch };
}

/**
 * Get branch names that are checked out in git worktrees.
 * Delegates to worktreeManager's listWorktrees to avoid duplicating porcelain parsing.
 * @param {string} dir - Working directory (main repo root)
 * @returns {Promise<Set<string>>} Set of branch names in active worktrees
 */
export async function getWorktreeBranches(dir) {
  const worktrees = await listWorktrees(dir).catch(() => []);
  return new Set(
    worktrees
      .filter(wt => wt.branch)
      .map(wt => wt.branch.replace(/^refs\/heads\//, ''))
  );
}

/**
 * Delete a branch locally, remotely, or both.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch name to delete
 * @param {object} options
 * @param {boolean} options.local - Delete local branch
 * @param {boolean} options.remote - Delete remote branch
 * @param {string} [options.expectedHead] - Exact caller-observed local ref (local-only operation)
 * @param {Set<string>} options.excludeBranches - Additional branches to protect (e.g., active agent branches)
 */
export async function deleteBranch(dir, branchName, options = {}) {
  return withCheckoutMutation(dir, () => deleteBranchAdmitted(dir, branchName, options));
}

async function deleteBranchAdmitted(dir, branchName, { local = false, remote = false, excludeBranches, expectedHead = null } = {}) {
  if (expectedHead && (!local || remote || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHead))) {
    throw new ServerError('Expected head requires a valid local-only deletion', { status: 400, code: 'INVALID_BRANCH_DELETION' });
  }
  const { baseBranch } = await getRepoBranches(dir);
  const protectedSet = new Set(PROTECTED_BRANCHES);
  if (baseBranch) protectedSet.add(baseBranch);
  if (protectedSet.has(branchName)) {
    throw new Error(`Cannot delete protected branch: ${branchName}`);
  }

  // Safety: don't delete the current branch
  const currentBranch = await getBranch(dir);
  if (currentBranch === branchName && local) {
    throw new Error(`Cannot delete the currently checked-out branch: ${branchName}`);
  }

  // Safety: don't delete branches checked out in worktrees (active agent workspaces)
  if (local) {
    const worktreeBranches = await getWorktreeBranches(dir);
    if (worktreeBranches.has(branchName)) {
      throw new Error(`Cannot delete branch checked out in a worktree: ${branchName}`);
    }
  }

  // Safety: don't delete branches explicitly excluded (e.g., active CoS agent branches)
  if (excludeBranches?.has(branchName)) {
    throw new Error(`Cannot delete branch in active use by an agent: ${branchName}`);
  }

  const opts = { ignoreExitCode: true };
  const localResult = local ? await deletePinnedLocalBranch(dir, branchName, expectedHead) : null;
  // A local owner/ref refusal retains the whole branch, including its remote.
  const localRefused = localResult && localResult.exitCode !== 0 && !localResult.notFound;
  const remoteResult = remote && !localRefused
    ? await execGitSafe(['push', 'origin', '--delete', branchName], dir, opts) : null;

  const results = {};
  if (localResult) {
    results.local = localResult.exitCode === 0
      ? 'deleted'
      : localResult.stderr?.includes('not found') ? 'not found' : `failed: ${localResult.stderr?.trim()}`;
  }
  if (remote && localRefused) results.remote = 'retained: local branch deletion refused';
  if (remoteResult) {
    results.remote = remoteResult.exitCode === 0
      ? 'deleted'
      : remoteResult.stderr?.includes('not found') || remoteResult.stderr?.includes('does not exist')
        ? 'not found'
        : `failed: ${remoteResult.stderr?.trim()}`;
  }

  return { branch: branchName, results };
}

/** Operator-selected ref removal shares the existing receiver's holder check and
 * exact-head transaction. It never certifies a merge or removes a checkout. */
async function deletePinnedLocalBranch(dir, branch, expectedHead) {
  const ref = `refs/heads/${branch}`;
  const observed = await execGitSafe(['rev-parse', '--verify', `${ref}^{commit}`], dir, { ignoreExitCode: true });
  const { withClaimOwnershipLock, readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
  const { claimCheckoutOwnerReason } = await import('../lib/claimContinuation.js');
  const assertNoOwner = async () => {
    const agents = await readClaimOwnershipAgents();
    const hold = claimCheckoutOwnerReason({ branchName: branch, holderPath: null, sourceWorkspace: dir, agents });
    if (hold) throw new ServerError(`Branch retained: ${hold}`, { status: 409, code: 'BRANCH_OWNER_HELD' });
  };
  if (observed.exitCode !== 0) {
    // Only a confirmed absent ref is compatible with continuing a combined
    // remote deletion. A broken symbolic ref or an unreadable ref is a refusal.
    const { readLocalBranchPresence } = await import('./repoCleanupObservation.js');
    const notFound = await readLocalBranchPresence(dir, branch) === false;
    if (notFound) await withClaimOwnershipLock(assertNoOwner);
    return { exitCode: 1, stderr: notFound ? 'branch not found' : 'unable to resolve branch head', notFound };
  }
  const head = observed.stdout.trim();
  if (expectedHead && expectedHead !== head) throw new ServerError('Branch head changed', { status: 409, code: 'BRANCH_HEAD_CHANGED' });
  const { deleteCompletedLocalBranch } = await import('./worktreeManager.js');
  return withClaimOwnershipLock(async () => {
    const beforeMutation = async () => {
      await assertNoOwner();
      // Preserve squash-only or explicitly discarded source using the existing
      // private completed-ref namespace, never a repository archive.
      const backup = `refs/portos/completed/${head}`;
      const existing = await execGitSafe(['show-ref', '--verify', '--hash', backup], dir, { ignoreExitCode: true });
      if (existing.exitCode === 0 && existing.stdout.trim() !== head) throw new Error('Branch source preservation changed');
      if (existing.exitCode !== 0) await execGit(['update-ref', backup, head, '0'.repeat(head.length)], dir);
    };
    const deleted = await deleteCompletedLocalBranch(dir, branch, head, { beforeMutation });
    return { exitCode: deleted ? 0 : 1, stderr: deleted ? '' : 'branch head or holder changed' };
  });
}

/**
 * Merge a branch into the current branch.
 * Uses --no-ff to always create a merge commit for traceability.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch to merge into current
 * @returns {Promise<{success: boolean, output: string}>}
 */
export async function mergeBranch(dir, branchName) {
  return withCheckoutMutation(dir, () => mergeBranchAdmitted(dir, branchName));
}

async function mergeBranchAdmitted(dir, branchName) {
  assertSafeRef(branchName);
  const result = await execGit(['merge', '--no-ff', branchName], dir);
  return { success: true, output: (result.stdout + result.stderr).trim() };
}

/**
 * True means the merge probes found evidence; false means they did not establish
 * it, including missing inputs, self-comparison, unresolved refs, and probe failures.
 *
 * - Normal / ff / no-ff merge: the branch tip becomes reachable from target, so
 *   `git merge-base --is-ancestor` settles it immediately.
 * - Rebase-and-merge replays the branch commits as new SHAs; the original tip is
 *   not an ancestor, so we ask `git cherry` whether each branch commit has a
 *   patch-equivalent commit in target. `git cherry` prints "- <sha>" when an
 *   equivalent exists upstream and "+ <sha>" when it does not, so an all-"-"
 *   result means the branch was replayed.
 * - Squash merge: the branch's commits are collapsed into a single NEW commit on
 *   target, so individual commits usually are not patch-equivalent. We synthesize
 *   a commit holding the branch's full tree on top of the merge-base and ask
 *   `git cherry` whether target already contains that combined patch.
 *
 * Fails CLOSED: any git error (or unresolvable ref) returns false, so a detection
 * failure can never authorize a delete. This is the gate the merged-worktree
 * reaper relies on — see reapMergedWorktrees in worktreeManager.js.
 *
 * @param {string} dir - Repo working directory
 * @param {string} branch - Branch whose work we're checking (local name or ref)
 * @param {string} target - Branch it should be merged into (e.g. 'main')
 * @returns {Promise<boolean>}
 */
export async function hasBranchMergeEvidence(dir, branch, target) {
  // Equal immutable commits prove inclusion; equal symbolic branch names do
  // not prove that a feature branch landed anywhere else.
  if (!branch || !target || (branch === target && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(branch))) return false;

  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
  // An inherited writer's quarantine/object override must not redirect a
  // repository inspection away from this checkout's own common object store.
  delete env.GIT_OBJECT_DIRECTORY;
  const readOptions = { ignoreExitCode: true, env };
  const resolve = (ref) => execGit(['rev-parse', '--verify', `${ref}^{commit}`], dir, readOptions)
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);

  const [branchSha, targetSha] = await Promise.all([resolve(branch), resolve(target)]);
  if (!branchSha || !targetSha) return false;

  // Fast path: branch tip already reachable from target (normal / ff / no-ff merge,
  // or the branch carries no unique commits).
  const ancestor = await execGit(['merge-base', '--is-ancestor', branchSha, targetSha], dir, readOptions)
    .then(r => r.exitCode === 0)
    .catch(() => false);
  if (ancestor) return true;

  // Rebase/cherry-pick path: does target contain every branch commit as an
  // individual patch-equivalent commit?
  const individualCherry = await execGit(['cherry', targetSha, branchSha], dir, readOptions)
    .then(r => r.exitCode === 0 ? r.stdout.trim() : null)
    .catch(() => null);
  if (individualCherry === null) return false;
  if (individualCherry !== '' && individualCherry.split('\n').every(line => line.startsWith('-'))) {
    return true;
  }

  // Squash path: does target already contain the branch's combined patch?
  const mergeBase = await execGit(['merge-base', targetSha, branchSha], dir, readOptions)
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (!mergeBase) return false;
  // No unique work beyond the merge base → nothing would be lost.
  if (mergeBase === branchSha) return true;

  const branchTree = await execGit(['rev-parse', `${branchSha}^{tree}`], dir, readOptions)
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (!branchTree) return false;

  // Polling must not add dangling synthetic commits to the shared object store:
  // that invalidates an otherwise stable preservation snapshot. Both commands
  // use a private object directory with the original store as a read alternate.
  return probeCombinedPatch(dir, branchTree, mergeBase, targetSha, readOptions).catch(() => false);
}

async function probeCombinedPatch(dir, branchTree, mergeBase, targetSha, readOptions) {
  const objects = await execGit(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], dir, readOptions);
  if (objects.exitCode !== 0 || !objects.stdout.trim()) return false;
  const scratch = await mkdtemp(join(tmpdir(), 'portos-merge-probe-'));
  try {
    const options = { ...readOptions, env: { ...readOptions.env,
      GIT_OBJECT_DIRECTORY: scratch,
      // Git accepts C-quoted entries, including paths containing the platform
      // list separator, quotes or backslashes. Existing alternates remain valid.
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [JSON.stringify(objects.stdout.trim()),
        readOptions.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter)
    } };
    // Preserve configured-identity behavior: an unavailable identity fails closed.
    const synthetic = await execGit(['commit-tree', branchTree, '-p', mergeBase, '-m', 'merged-check-probe'], dir, options);
    if (synthetic.exitCode !== 0 || !synthetic.stdout.trim()) return false;
    const result = await execGit(['cherry', targetSha, synthetic.stdout.trim()], dir, options);
    if (result.exitCode !== 0) return false;
    const lines = result.stdout.trim();
    return lines === '' || lines.split('\n').every(line => line.startsWith('-'));
  } finally {
    // Only this invocation's exclusively created scratch directory is removed.
    await rmGuarded(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

// Backward-compatible name for callers using the original evidence predicate.
export const isBranchMergedInto = hasBranchMergeEvidence;

/**
 * Checkout a remote branch that doesn't exist locally.
 * Creates a local tracking branch from the remote ref.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch name (without origin/ prefix)
 * @returns {Promise<{success: boolean, branch: string}>}
 */
export async function checkoutRemoteBranch(dir, branchName) {
  return withCheckoutMutation(dir, () => checkoutRemoteBranchAdmitted(dir, branchName));
}

async function checkoutRemoteBranchAdmitted(dir, branchName) {
  assertSafeRef(branchName);
  await execGit(['checkout', '-b', branchName, `origin/${branchName}`], dir);
  return { success: true, branch: branchName };
}

/**
 * How many entries in raw `git status --porcelain` output a hard reset would
 * actually destroy — i.e. everything except untracked (`??`) files, which
 * survive because nothing here runs `git clean`.
 * @param {string} porcelain - Raw `git status --porcelain` stdout
 * @returns {number}
 */
export function countDiscardable(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('??'))
    .length;
}

/**
 * Sequencer state files a forced checkout does NOT clear, mapped to the command
 * that drops each. `--quit` rather than `--abort`: abort rewinds to the
 * pre-operation HEAD, which is the very state a reset is discarding, while
 * `--quit` removes the bookkeeping and leaves the tree the checkout just
 * restored alone. (`MERGE_HEAD` is absent here on purpose — a plain conflicted
 * merge IS cleared by `checkout --force`.)
 */
const SEQUENCER_STATE = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert']
];

/**
 * Drop any half-finished rebase / cherry-pick / revert.
 *
 * Without this a checkout left mid-rebase still reports "You are currently
 * rebasing" after the reset, and every later `git rebase` in that repo dies on
 * "there is already a rebase-merge directory" until someone deletes it by hand
 * — so the reset would report success while leaving the repo in exactly the
 * stuck state it is advertised to fix.
 *
 * @param {string} dir - Repo root
 * @param {string} gitDirPath - Absolute path to the repo's git dir
 * @returns {Promise<string[]>} - The operations that were cleared
 */
async function clearSequencerState(dir, gitDirPath) {
  const stuck = [...new Set(
    SEQUENCER_STATE
      .filter(([marker]) => existsSync(join(gitDirPath, marker)))
      .map(([, command]) => command)
  )];
  for (const command of stuck) {
    await execGitSafe([command, '--quit'], dir);
  }
  return stuck;
}

/**
 * The id of a running CoS agent whose workspace IS `dir`, or null when none is.
 * Paths are compared after `resolve` so a trailing slash or a `..` segment on
 * either side doesn't let a live run slip past the check.
 *
 * Imported lazily: `services/git.js` is on the boot path and the agent
 * lifecycle module is not, so a static import would drag agent state into
 * every consumer of a git helper.
 * @param {string} dir - Repo root to check
 * @returns {Promise<string|null>} - Agent id, or null
 */
export async function findActiveAgentInWorkspace(dir, { includePaused = false, failClosed = false } = {}) {
  const { getAgents } = await import('./cosAgentLifecycle.js').catch((err) => {
    if (failClosed) throw err;
    return { getAgents: null };
  });
  if (!getAgents) {
    if (failClosed) throw new Error('could not load the CoS agent registry');
    return null;
  }
  const agents = await getAgents().catch((err) => {
    if (failClosed) throw err;
    return [];
  });
  const target = resolve(dir);
  const busy = agents.find(agent =>
    (agent.status === 'running' || (includePaused && agent.status === 'paused'))
    && agent.metadata?.workspacePath
    && resolve(agent.metadata.workspacePath) === target
  );
  return busy?.id || null;
}

/**
 * Throw away every local change and put the checkout back on origin's default
 * branch, exactly as the remote has it. The escape hatch for a checkout that
 * has drifted — a lockfile a local toolchain keeps rewriting, a half-finished
 * edit, a branch left behind by an interrupted operation.
 *
 * Deliberately narrower than "make it look like a fresh clone":
 *   - Tracked modifications and local commits on the default branch go away;
 *     `previousHead` comes back in the result so `git reset --hard <sha>`
 *     recovers them (the commits stay in the reflog for git's gc window).
 *   - Untracked files stay. There is no `git clean` here: a checkout's
 *     untracked set is where `.env` files, build output, and scratch work live,
 *     and losing those is not recoverable from a reflog. `discardedFiles`
 *     excludes them for the same reason — it counts what was destroyed, not
 *     what was merely dirty.
 *   - Other local branches are untouched — this moves the default branch only.
 *   - A half-finished rebase / cherry-pick / revert IS cleared (`clearedOperations`
 *     names which), because leaving one behind is the stuck state this exists
 *     to escape.
 *
 * A fetch failure is not fatal: the reset falls back to the cached
 * `origin/<default>` ref so an offline machine can still get back to a known
 * state, and `fetched: false` says the target may be behind the remote.
 *
 * @param {string} dir - Working directory (a repo root, not a linked worktree)
 * @returns {Promise<{success: boolean, branch: string, previousBranch: string|null,
 *   previousHead: string|null, discardedFiles: number, clearedOperations: string[],
 *   fetched: boolean}>}
 */
export async function resetToDefaultBranch(dir) {
  return withCheckoutMutation(dir, () => resetToDefaultBranchAdmitted(dir));
}

async function resetToDefaultBranchAdmitted(dir) {
  // A linked worktree cannot check out the default branch — the main checkout
  // already holds it — and hard-resetting one would discard an agent's
  // in-flight work on a branch that is not the default anyway. Fail with a
  // reason instead of surfacing git's "already checked out" further down. The
  // two dirs differ only in a linked worktree, and rev-parse answers both flags
  // in one spawn, one value per line.
  const dirs = await execGitSafe(['rev-parse', '--git-dir', '--git-common-dir'], dir);
  const [gitDir, commonDir] = dirs.stdout.trim().split('\n').map(line => line.trim());
  if (gitDir && commonDir && gitDir !== commonDir) {
    throw new ServerError('cannot reset a linked worktree — run this on the main checkout', {
      status: 400,
      code: 'WORKTREE_RESET_REFUSED'
    });
  }

  // A CoS agent without a worktree works directly in the checkout it was given
  // (agentWorkspacePrep only isolates when the task asks for it), so resetting
  // under a running one destroys tracked edits it is still producing and moves
  // HEAD beneath a live process. primaryCheckoutGuard.js already treats
  // `reset --hard` on the primary checkout as a decision a human makes
  // deliberately — this keeps that decision from landing on top of a run.
  const busyAgent = await findActiveAgentInWorkspace(dir);
  if (busyAgent) {
    throw new ServerError(
      `a CoS agent (${busyAgent}) is running in this checkout — stop it before resetting`,
      { status: 409, code: 'AGENT_RUNNING' }
    );
  }

  const fetched = await fetchOrigin(dir).then(() => true).catch(() => false);

  // A failed fetch already told us the remote is unreachable, so skip
  // getDefaultBranch's `remote set-head` probe rather than stall on its timeout.
  const branch = await getDefaultBranch(dir, { allowRemote: fetched });
  if (!branch) {
    throw new ServerError('could not determine the default branch', { status: 400, code: 'NO_DEFAULT_BRANCH' });
  }

  const target = `origin/${branch}`;
  const targetRef = await execGitSafe(['rev-parse', '--verify', `refs/remotes/${target}`], dir);
  if (targetRef.exitCode !== 0 || !targetRef.stdout.trim()) {
    throw new ServerError(`no ${target} ref to reset to`, { status: 400, code: 'NO_REMOTE_REF' });
  }

  // `rev-parse` takes both spellings of HEAD in one spawn: the sha, then the
  // branch name. `getStatusPorcelain` is the cheap half of `getStatus` — a
  // line count is all the caller needs, not a parsed per-file breakdown.
  const [headBefore, dirty] = await Promise.all([
    execGitSafe(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], dir),
    getStatusPorcelain(dir).catch(() => '')
  ]);
  // `|| null` rather than a destructuring default: on a repo with no commits
  // rev-parse prints nothing, `''.split('\n')` is `['']`, and a default only
  // fires on `undefined` — so the caller would get `''` where the contract (and
  // the client's `if (result.previousHead)` recovery hint) says null.
  const [head, branchName] = headBefore.stdout.trim().split('\n').map(line => line.trim());
  const previousHead = head || null;
  const previousBranch = branchName || null;

  // A half-finished rebase/cherry-pick survives the checkout below, so drop it
  // first — otherwise the reset "succeeds" into a repo that still refuses every
  // later rebase.
  const clearedOperations = await clearSequencerState(dir, resolve(dir, gitDir || '.git'));

  // `checkout --force -B` is the whole operation: `-B` repoints the local branch
  // at the remote ref and `--force` resets index AND working tree to it, so a
  // trailing `reset --hard` would re-walk every tracked file to change nothing.
  await execGit(['checkout', '--force', '-B', branch, target], dir);

  return {
    success: true,
    branch,
    previousBranch,
    previousHead,
    // Untracked files (`??`) are the ones this reset deliberately KEEPS, so
    // counting them would tell the user more was destroyed than actually was —
    // directly contradicting the "keeps untracked files" line the confirm
    // dialog shows two rows above this number.
    discardedFiles: countDiscardable(dirty),
    clearedOperations,
    fetched
  };
}

// Prose for each `reapMergedWorktrees` skip slug, so `skipped` says WHY a merged
// branch survived rather than only that it did. An unlisted slug falls back to
// the plain "it's in a worktree" phrasing.
const WORKTREE_HOLD_REASONS = {
  uncommitted: 'worktree has uncommitted changes',
  unmerged: 'worktree has unmerged commits',
  'status-failed': 'worktree status could not be read',
  'worktree-locked': 'worktree is locked',
  'worktree-active-agent': 'worktree is in use by a running agent',
  'worktree-agent-liveness-unknown': 'agent liveness unknown',
  'worktree-human-claim': 'worktree is a claimed session',
  'remove-failed': 'worktree removal failed and the checkout is still present'
};
const worktreeHoldReason = (reason) => WORKTREE_HOLD_REASONS[reason] || reason || 'checked out in a worktree';

async function prepareRemoteRetirement(dir, defaultBranch) {
  // A remote name resolves differently for fetch and push (and can change
  // while cleanup awaits). Require one identical endpoint and use its captured
  // URL for every read/write. Equivalent-looking aliases need explicit review.
  const [fetchUrls, pushUrls] = await Promise.all([
    execGitSafe(['remote', 'get-url', '--all', 'origin'], dir),
    execGitSafe(['remote', 'get-url', '--push', '--all', 'origin'], dir),
  ]);
  const fetchEndpoints = fetchUrls.stdout.trim().split(/\r?\n/).filter(Boolean);
  const pushEndpoints = pushUrls.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (fetchUrls.exitCode !== 0 || pushUrls.exitCode !== 0
      || fetchEndpoints.length !== 1 || pushEndpoints.length !== 1
      || fetchEndpoints[0] !== pushEndpoints[0]) {
    return { reason: 'fetch and push must identify one identical remote endpoint' };
  }
  const remoteUrl = fetchEndpoints[0];
  // origin/HEAD and a caller's remembered default can outlive a forge default
  // change. Establish the advertised default before any refresh or retirement.
  const advertised = await execGitSafe(['ls-remote', '--symref', '--', remoteUrl, 'HEAD'], dir);
  const symrefs = advertised.stdout.split(/\r?\n/).filter(line => line.startsWith('ref: '));
  const defaultMatch = symrefs.length === 1 ? /^ref: (refs\/heads\/.+)\tHEAD$/.exec(symrefs[0]) : null;
  if (advertised.exitCode !== 0 || !defaultMatch) return { reason: 'default-branch-unverified' };
  if (defaultMatch[1] !== `refs/heads/${defaultBranch}`) return { reason: 'default-branch-changed' };
  // A stale local default or an unsuccessful fetch never authorizes deletion.
  const fetched = await execGitSafe(['fetch', '--prune', '--', remoteUrl, '+refs/heads/*:refs/remotes/origin/*'], dir, { ignoreExitCode: true });
  if (fetched.exitCode !== 0) return { reason: 'remote default could not be refreshed' };
  const targetRef = `refs/heads/${defaultBranch}`;
  const targetHead = await execGitSafe(['ls-remote', '--heads', '--', remoteUrl, targetRef], dir);
  const targetMatch = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(targetHead.stdout.trim());
  const targetSha = targetMatch?.[1];
  if (targetHead.exitCode !== 0 || targetMatch?.[2] !== targetRef
      || (await execGitSafe(['rev-parse', '--verify', `${targetSha}^{commit}`], dir)).exitCode !== 0) {
    return { reason: 'remote default head unavailable' };
  }
  return { remoteUrl, targetSha, defaultBranch };
}

// Fresh local refs, upstream aliases and actual holders all retain the remote
// recovery ref. Re-read immediately before the leased push, inside the same
// ownership fence used to register managed claims.
async function remoteRetirementLocalHold(dir, name) {
  const [refs, trees] = await Promise.all([
    execGitSafe(['for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads/'], dir),
    listWorktrees(dir).catch(() => null),
  ]);
  if (refs.exitCode !== 0 || !Array.isArray(trees)) return 'local ownership unavailable';
  if (refs.stdout.split(/\r?\n/).some(line => {
    const [branch, upstream] = line.split('\t');
    return branch === name || upstream === `origin/${name}`;
  })) return 'local branch or upstream still exists';
  if (trees.some(tree => tree.branch === `refs/heads/${name}` || tree.branch === name)) return 'checked out in a worktree';
  return null;
}

async function retireMergedRemoteHead(dir, name, context, { excludeBranches } = {}) {
  const { withClaimOwnershipLock, readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
  const { claimCheckoutOwnerReason } = await import('../lib/claimContinuation.js');
  const { readBranchCompletionHold } = await import('./branchCompletionPolicy.js');
  if (PROTECTED_BRANCHES.includes(name) || name === context.defaultBranch || name === 'HEAD') return { reason: 'protected branch' };
  const ref = `refs/heads/${name}`;
  if ((await execGitSafe(['check-ref-format', ref], dir)).exitCode !== 0) return { reason: 'invalid branch name' };
  return withClaimOwnershipLock(async () => {
    const hold = async tip => {
      const exclusions = typeof excludeBranches === 'function' ? await excludeBranches() : excludeBranches;
      if (exclusions?.has(name)) return 'used by an active agent';
      const agents = await readClaimOwnershipAgents();
      const owner = claimCheckoutOwnerReason({ branchName: name, holderPath: null, sourceWorkspace: dir, agents });
      if (owner) return owner;
      if (tip) {
        const policy = await readBranchCompletionHold({ repoPath: dir, branch: name, tip, retirement: true });
        if (policy) return policy;
      }
      return remoteRetirementLocalHold(dir, name);
    };
    const initialHold = await hold();
    if (initialHold) return { reason: initialHold };
    const head = await execGitSafe(['ls-remote', '--heads', '--', context.remoteUrl, ref], dir);
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(head.stdout.trim());
    if (head.exitCode !== 0 || !match || match[2] !== ref) return { reason: 'head unavailable or already removed' };
    if (!await hasBranchMergeEvidence(dir, match[1], context.targetSha)) return { reason: 'current head is not merged' };
    const finalHold = await hold(match[1]);
    if (finalHold) return { reason: finalHold };
    const removed = await execGitSafe(['push', `--force-with-lease=${ref}:${match[1]}`, '--', context.remoteUrl, `:${ref}`], dir, { ignoreExitCode: true });
    return removed.exitCode === 0 ? { deleted: true } : { reason: 'head changed or deletion failed', failed: true };
  });
}

/** Retire only explicitly selected remote candidates, preserving any fresh local
 * ownership. The candidate scan grants no deletion authority: endpoint, default,
 * current head, merge proof and claim/completion gates are established here.
 */
export async function deleteMergedRemoteBranches(dir, names, { defaultBranch, excludeBranches } = {}) {
  const selected = [...new Set(names)];
  if (!selected.length) return { deleted: [], skipped: [] };
  const base = defaultBranch || (await getRepoBranches(dir)).baseBranch || 'main';
  const context = await prepareRemoteRetirement(dir, base);
  if (context.reason) return { deleted: [], skipped: selected.map(branch => ({ branch, reason: context.reason })) };
  const deleted = [];
  const skipped = [];
  for (const branch of selected) {
    const result = await retireMergedRemoteHead(dir, branch, context, { excludeBranches });
    if (result.deleted) deleted.push(branch);
    else skipped.push({ branch, reason: result.reason });
  }
  return { deleted, skipped };
}

/**
 * Delete all merged branches (local and remote) in one operation.
 * Skips the `PROTECTED_BRANCHES` set (see `../lib/gitArgs.js`), the current branch,
 * and any explicitly excluded branches.
 *
 * Shares the reconciler's fresh ownership, merge, archival and retirement gates.
 * Local and remote deletion are pinned to observed heads. Retained work is
 * returned with its specific reason; the UI's merged flag is never authority.
 *
 * @param {string} dir - Working directory
 * @param {object} options
 * @param {Set<string>} options.excludeBranches - Additional branches to protect (e.g., active agent branches)
 * @param {Set<string>} [options.activeAgentIds] - CoS agent ids whose worktrees must survive. Anything
 *   but a Set (the default) reads as "liveness unknown" and holds every `agent-*` worktree.
 * @param {Set<string>} [options.onlyBranches] Limit candidates without bypassing any retirement guard.
 * @returns {Promise<{deleted: Array<{name: string, local: string, remote: string, worktree?: string}>, skipped: string[], defaultBranch: string}>}
 */
export async function deleteMergedBranches(dir, { excludeBranches, activeAgentIds = null, onlyBranches } = {}) {
  if (onlyBranches !== undefined && !(onlyBranches instanceof Set)) throw new Error('Cleanup branch selector must be a Set');
  const { cleanupMerged } = await import('./branchReconcile.js');
  const { baseBranch } = await getRepoBranches(dir);
  const defaultBranch = baseBranch || 'main';
  const protectedSet = new Set([...PROTECTED_BRANCHES, defaultBranch]);
  const skipped = [];
  const records = new Map();
  const context = await prepareRemoteRetirement(dir, defaultBranch);
  if (context.reason) return { deleted: [], skipped: [`cleanup (${context.reason})`], defaultBranch };
  const { resolveRetirementApp } = await import('./retirementAppScope.js');
  const scope = await resolveRetirementApp(dir);
  if (!scope.app) return { deleted: [], skipped: [`cleanup (${scope.reason})`], defaultBranch };
  const { targetSha } = context;
  const branches = await execGitSafe(['branch', '--format=%(refname:short)'], dir, { ignoreExitCode: true });
  if (branches.exitCode !== 0) return { deleted: [], skipped: ['cleanup (local branches unavailable)'], defaultBranch };
  const local = new Set(branches.stdout.trim().split('\n').filter(Boolean));
  const remote = await execGitSafe(['branch', '-r', '--format=%(refname:short)'], dir, { ignoreExitCode: true });
  if (remote.exitCode !== 0) return { deleted: [], skipped: ['cleanup (remote merge evidence unavailable)'], defaultBranch };
  const remoteNames = remote.stdout.trim().split('\n').filter(ref => ref.startsWith('origin/')).map(ref => ref.slice(7));
  const names = new Set([...local, ...remoteNames]);
  for (const name of names) {
    if (onlyBranches && !onlyBranches.has(name)) continue;
    if (protectedSet.has(name) || name === 'HEAD') continue;
    const exclusions = typeof excludeBranches === 'function' ? await excludeBranches() : excludeBranches;
    if (exclusions?.has(name)) { skipped.push(`${name} (used by an active agent)`); continue; }
    const record = { name, local: null, remote: null };
    records.set(name, record);
    if (local.has(name)) {
      const retired = await cleanupMerged(scope.app.repoPath, targetSha, [{ branch: name }], {
        activeAgentIds, appId: scope.app.id, forgeAccount: scope.app.forgeAccount ?? null,
      });
      if (retired.cleaned.includes(name)) record.local = 'deleted';
      else {
        for (const hold of retired.skipped) skipped.push(`${name} (local: ${worktreeHoldReason(hold.reason)}${hold.detail ? `: ${hold.detail}` : ''})`);
        // Retention is a whole-branch outcome. In particular, archive failure
        // must leave both the checkout and its remote recovery ref intact.
        continue;
      }
    }
    if (!remoteNames.includes(name)) continue;
    const removed = await retireMergedRemoteHead(dir, name, context, { excludeBranches });
    if (removed.deleted) record.remote = 'deleted';
    else {
      if (removed.failed) record.remote = 'failed';
      skipped.push(`${name} (remote: ${removed.reason})`);
    }
  }
  return { deleted: [...records.values()].filter(row => row.local === 'deleted' || row.remote === 'deleted'), skipped, defaultBranch };
}

/**
 * Get comprehensive git info
 */
export async function getGitInfo(dir) {
  const [isGit, branch, status, commits, diffStats, remote, repoBranches] = await Promise.all([
    isRepo(dir),
    getBranch(dir).catch(() => null),
    getStatus(dir).catch(() => ({ clean: true, files: [] })),
    getCommits(dir, 5).catch(() => []),
    getDiffStats(dir).catch(() => ({ files: 0, insertions: 0, deletions: 0 })),
    getRemote(dir).catch(() => null),
    getRepoBranches(dir).catch(() => ({ baseBranch: null, devBranch: null }))
  ]);

  const originComparison = branch && branch !== 'HEAD'
    ? await execGit(['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${branch}`], dir)
      .then(({ stdout }) => {
        const [ahead, behind] = stdout.trim().split(/\s+/).map(Number);
        return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
      }).catch(() => null)
    : null;

  return {
    isRepo: isGit,
    branch,
    status,
    recentCommits: commits,
    diffStats,
    remote,
    originComparison,
    baseBranch: repoBranches.baseBranch,
    devBranch: repoBranches.devBranch,
    hasChangelog: hasChangelogDir(dir)
  };
}
