import { existsSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { join } from 'path';
import { execGit, execGitSafe } from '../../lib/execGit.js';
import { readRepoBranchSnapshot } from '../repoBranchSnapshot.js';
import { parseStatus, parseDiffStat } from '../../lib/gitOutputParsers.js';
import { PROTECTED_BRANCHES, validateFilePaths, toLiteralPathspec, assertSafeRef } from '../../lib/gitArgs.js';
import { withCheckoutMutation } from './checkoutMutation.js';

// Unit-separated, not JSON: git does not escape a quote or backslash in a subject or author name.
const COMMIT_LOG_FORMAT = '--format=%h%x1f%s%x1f%an%x1f%cI';
const parseCommitLog = (stdout) => stdout.split('\n').filter(Boolean).map((line) => {
  const [hash, message, author, date] = line.split('\x1f');
  return { hash, message, author, date };
});

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
    ['status', '--porcelain', '-z', ...(paths.length ? ['--', ...paths] : [])],
    dir,
    { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
  );

  // -z: without it git quotes a path holding a space or special character and
  // writes a rename as `old -> new`, and neither is a path git accepts back.
  const entries = result.stdout.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const status = entries[i].substring(0, 2);
    const path = entries[i].substring(3);
    const renamed = /[RC]/.test(status);
    if (renamed) i += 1; // the next entry is this one's original path
    files.push({
      path,
      ...(renamed ? { origPath: entries[i] } : {}),
      status: parseStatus(status),
      staged: status[0] !== ' ' && status[0] !== '?',
      modified: status[1] === 'M',
      added: status[0] === 'A' || status === '??',
      deleted: status[0] === 'D' || status[1] === 'D'
    });
  }

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
  const result = await execGit(['log', COMMIT_LOG_FORMAT, '-n', String(safeLimit)], dir);
  return parseCommitLog(result.stdout);
}

/**
 * Get diff for unstaged changes, or for the index when `staged`
 */
export async function getDiff(dir, staged = false) {
  const args = staged ? ['diff', '--cached'] : ['diff'];
  const result = await execGit(args, dir, { maxBuffer: 10 * 1024 * 1024 });
  return result.stdout;
}

/**
 * Get diff stats for every tracked change, staged or not
 */
export async function getDiffStats(dir) {
  const result = await execGit(['diff', '--stat', 'HEAD'], dir);
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
 * Get branch comparison (how far ahead headBranch is from baseBranch)
 */
export async function getBranchComparison(dir, baseBranch = 'main', headBranch = 'dev') {
  assertSafeRef(baseBranch);
  assertSafeRef(headBranch);
  const logResult = await execGit(
    ['log', COMMIT_LOG_FORMAT, `${baseBranch}..${headBranch}`], dir, { ignoreExitCode: true }
  );
  const commits = parseCommitLog(logResult.stdout);

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
 * Check if a .changelog/ directory exists in the repo
 */
export function hasChangelogDir(dir) {
  return existsSync(join(dir, '.changelog'));
}

async function getLocalBranchNames(dir) {
  // Read branch refs directly so worktree markers and ambiguous short refs cannot change their names.
  const { stdout } = await execGitSafe(['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'], dir);
  return stdout?.split(/\r?\n/).filter(Boolean) ?? [];
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
  const branches = await getLocalBranchNames(dir);
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
export async function getRepoBranches(dir, knownBranches) {
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
  const branches = knownBranches ?? await getLocalBranchNames(dir);

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

/** Local branches enriched for display and reconciliation. A sweep can supply
 * the same ref and worktree inventory it uses for the rest of its observations. */
export async function getBranches(dir, { strict = false, snapshot } = {}) {
  const { branches, worktrees } = await (snapshot ?? readRepoBranchSnapshot(dir, { strict }));
  const { baseBranch } = await getRepoBranches(dir, branches.map(branch => branch.name));
  const worktreeBranches = new Set(worktrees.map(wt => wt.branch?.replace(/^refs\/heads\//, '')));

  const defaultBranch = baseBranch || 'main';
  const protectedSet = new Set(PROTECTED_BRANCHES);
  protectedSet.add(defaultBranch);

  const mergedSet = await getLocalMergedBranchNames(dir, defaultBranch);

  return branches.map(b => ({
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
