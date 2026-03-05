import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { safeJSONParse } from '../lib/fileUtils.js';

/**
 * Execute a git command safely using spawn (prevents shell injection)
 * @param {string[]} args - Git command arguments
 * @param {string} cwd - Working directory
 * @param {object} options - Additional options
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
function execGit(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      shell: process.platform === 'win32',
      maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0 && !options.ignoreExitCode) {
        reject(new Error(stderr || `git exited with code ${code}`));
      } else {
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Get git status for a directory
 */
export async function getStatus(dir) {
  const result = await execGit(['status', '--porcelain'], dir);
  const lines = result.stdout.trim().split('\n').filter(Boolean);

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

function parseStatus(status) {
  const map = {
    '??': 'untracked',
    'A ': 'added',
    'M ': 'modified (staged)',
    ' M': 'modified',
    'MM': 'modified (partial)',
    'D ': 'deleted (staged)',
    ' D': 'deleted',
    'R ': 'renamed',
    'C ': 'copied',
    'AM': 'added (modified)',
    'AD': 'added (deleted)'
  };
  return map[status] || status.trim();
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
  const statsLine = result.stdout.trim().split('\n').pop() || '';

  const filesMatch = statsLine.match(/(\d+) files? changed/);
  const insertionsMatch = statsLine.match(/(\d+) insertions?/);
  const deletionsMatch = statsLine.match(/(\d+) deletions?/);

  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0
  };
}

/**
 * Validate file paths to prevent command injection and path traversal
 * @param {string[]} files - Array of file paths
 * @returns {string[]} - Sanitized file paths
 */
function validateFilePaths(files) {
  const fileList = Array.isArray(files) ? files : [files];
  return fileList.map(f => {
    // Reject paths with null bytes or command separators
    if (/[\0;|&`$]/.test(f)) {
      throw new Error(`Invalid character in file path: ${f}`);
    }
    // Reject absolute paths or parent directory traversal
    if (f.startsWith('/') || f.includes('..')) {
      throw new Error(`Invalid file path: ${f}`);
    }
    return f;
  });
}

/**
 * Stage files
 */
export async function stageFiles(dir, files) {
  const safePaths = validateFilePaths(files);
  await execGit(['add', '--', ...safePaths], dir);
  return true;
}

/**
 * Unstage files
 */
export async function unstageFiles(dir, files) {
  const safePaths = validateFilePaths(files);
  await execGit(['reset', 'HEAD', '--', ...safePaths], dir);
  return true;
}

/**
 * Create commit
 */
export async function commit(dir, message) {
  // Using spawn with -m argument passes message safely without shell interpretation
  const result = await execGit(['commit', '-m', message], dir);
  const hashMatch = result.stdout.match(/\[[\w-]+ ([a-f0-9]+)\]/);
  return {
    hash: hashMatch ? hashMatch[1] : null,
    message
  };
}

/**
 * Check if directory is a git repo
 */
export async function isRepo(dir) {
  const result = await execGit(['rev-parse', '--is-inside-work-tree'], dir, { ignoreExitCode: true }).catch(() => null);
  return result?.stdout.trim() === 'true';
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
export async function fetchOrigin(dir) {
  await execGit(['fetch', 'origin'], dir);
  return true;
}

/**
 * Update all local branches that have remote tracking branches.
 * Uses fetch refspecs for non-current branches to avoid checkout (which
 * would swap files on disk and trigger HMR/server restarts).
 */
export async function updateBranches(dir) {
  await fetchOrigin(dir);

  const status = await getStatus(dir);
  const currentBranch = await getBranch(dir);
  const allBranches = await getBranches(dir);
  const trackBranches = allBranches.filter(b => b.tracking).map(b => b.name);
  let stashed = false;
  let stashRestored = false;

  const results = { stashed, stashRestored: false, currentBranch };

  // Update non-current branches via fetch refspec (no checkout needed)
  for (const branch of trackBranches.filter(b => b !== currentBranch)) {
    const r = await execGit(['fetch', 'origin', `${branch}:${branch}`], dir, { ignoreExitCode: true });
    results[branch] = (r.stderr?.includes('fatal') || r.stderr?.includes('rejected')) ? 'failed' : 'updated';
  }

  // Update current branch if it's one of the tracked branches — requires merge
  if (trackBranches.includes(currentBranch)) {
    if (!status.clean) {
      await execGit(['stash', 'push', '-m', 'portos-auto-stash'], dir);
      stashed = true;
      results.stashed = true;
    }
    const r = await execGit(['merge', '--ff-only', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
    results[currentBranch] = r.stderr?.includes('fatal') ? 'failed' : 'updated';
  }

  if (stashed) {
    const popResult = await execGit(['stash', 'pop'], dir, { ignoreExitCode: true });
    stashRestored = !popResult.stderr?.includes('CONFLICT');
    results.stashRestored = stashRestored;
  }

  return results;
}

/**
 * Get branch comparison (how far ahead headBranch is from baseBranch)
 */
export async function getBranchComparison(dir, baseBranch = 'main', headBranch = 'dev') {
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
  const statsLine = statResult.stdout.trim().split('\n').pop() || '';
  const filesMatch = statsLine.match(/(\d+) files? changed/);
  const insertionsMatch = statsLine.match(/(\d+) insertions?/);
  const deletionsMatch = statsLine.match(/(\d+) deletions?/);

  return {
    ahead: commits.length,
    commits,
    stats: {
      files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      insertions: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
      deletions: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0
    }
  };
}

/**
 * Push to origin
 */
export async function push(dir, branch = null) {
  const args = branch ? ['push', 'origin', branch] : ['push'];
  const result = await execGit(args, dir);
  return { success: true, output: result.stdout + result.stderr };
}

/**
 * Push all local branches that are ahead of their remote tracking branch.
 * Never uses --force. Returns per-branch results.
 */
export async function pushAll(dir) {
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
  await execGit(['checkout', '-b', branchName], dir);
  return { success: true, branch: branchName };
}

/**
 * Switch to an existing branch
 */
export async function checkout(dir, branchName) {
  await execGit(['checkout', branchName], dir);
  return { success: true, branch: branchName };
}

/**
 * Create a pull request using the `gh` CLI.
 * Fails gracefully if `gh` is not installed.
 * @param {string} dir - Working directory (repo root)
 * @param {object} options - PR options
 * @param {string} options.title - PR title
 * @param {string} options.body - PR description
 * @param {string} options.base - Base branch (target)
 * @param {string} options.head - Head branch (source)
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export async function createPR(dir, { title, body, base, head }) {
  return new Promise((resolve) => {
    const args = ['pr', 'create', '--title', title, '--body', body || '', '--base', base, '--head', head];
    const child = spawn('gh', args, { cwd: dir, shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        const url = stdout.trim();
        resolve({ success: true, url });
      } else {
        resolve({ success: false, error: stderr || `gh exited with code ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: `gh not available: ${err.message}` });
    });
  });
}

/**
 * Detect base and dev branches from local branch list
 * @returns {{ baseBranch: string|null, devBranch: string|null }}
 */
export async function getRepoBranches(dir) {
  const result = await execGit(['branch', '--list'], dir, { ignoreExitCode: true });
  const branches = result.stdout.trim().split('\n').map(b => b.replace(/^\*?\s+/, ''));
  return {
    baseBranch: branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : null,
    devBranch: branches.includes('dev') ? 'dev' : branches.includes('develop') ? 'develop' : null
  };
}

/**
 * Get all local branches with tracking info
 * @returns {Promise<Array<{name: string, current: boolean, tracking: string|null, ahead: number, behind: number}>>}
 */
export async function getBranches(dir) {
  // Get branches with verbose info (includes tracking)
  const result = await execGit(
    ['branch', '-vv', '--format=%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)'],
    dir,
    { ignoreExitCode: true }
  );

  const branches = result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [head, name, upstream, track] = line.split('|');
    const aheadMatch = track?.match(/ahead (\d+)/);
    const behindMatch = track?.match(/behind (\d+)/);

    return {
      name,
      current: head === '*',
      tracking: upstream || null,
      ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
      behind: behindMatch ? parseInt(behindMatch[1], 10) : 0
    };
  });

  return branches;
}

/**
 * Pull changes from remote for current branch
 */
export async function pull(dir) {
  const result = await execGit(['pull', '--rebase', '--autostash'], dir);
  return { success: true, output: result.stdout + result.stderr };
}

/**
 * Sync branch - pull then push
 */
export async function syncBranch(dir, branch = null) {
  const currentBranch = branch || await getBranch(dir);

  // First pull with rebase
  const pullResult = await execGit(['pull', '--rebase', '--autostash', 'origin', currentBranch], dir, { ignoreExitCode: true });
  const pullSuccess = !pullResult.stderr?.includes('fatal') && !pullResult.stderr?.includes('CONFLICT');

  if (!pullSuccess) {
    return {
      success: false,
      error: pullResult.stderr || 'Pull failed',
      pulled: false,
      pushed: false
    };
  }

  // Then push
  const pushResult = await execGit(['push', 'origin', currentBranch], dir, { ignoreExitCode: true });
  const pushSuccess = !pushResult.stderr?.includes('rejected') && !pushResult.stderr?.includes('fatal');

  return {
    success: pushSuccess,
    pulled: true,
    pushed: pushSuccess,
    output: pullResult.stdout + pushResult.stdout,
    error: pushSuccess ? null : pushResult.stderr
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
 * If the working tree is dirty, stashes changes first and restores after.
 * Returns conflict info if the pull can't be completed cleanly.
 *
 * @param {string} dir - Git repository directory
 * @returns {{ success: boolean, branch: string, stashed: boolean, conflict: boolean, error: string|null }}
 */
export async function ensureLatest(dir) {
  const gitCheck = await isRepo(dir).catch(() => false);
  if (!gitCheck) return { success: true, branch: null, stashed: false, conflict: false, error: null, skipped: 'not-a-repo' };

  const currentBranch = await getBranch(dir).catch(() => null);
  if (!currentBranch) return { success: true, branch: null, stashed: false, conflict: false, error: null, skipped: 'no-branch' };

  // Check for remote — no remote means nothing to pull
  const remote = await getRemote(dir).catch(() => null);
  if (!remote?.origin) return { success: true, branch: currentBranch, stashed: false, conflict: false, error: null, skipped: 'no-remote' };

  // Fetch latest refs from origin
  const fetchResult = await execGit(['fetch', 'origin'], dir, { ignoreExitCode: true });
  if (fetchResult.stderr?.includes('fatal')) {
    return { success: false, branch: currentBranch, stashed: false, conflict: false, error: `fetch failed: ${fetchResult.stderr}` };
  }

  // Check if remote tracking branch exists
  const remoteRef = await execGit(['rev-parse', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  if (remoteRef.stderr?.includes('unknown revision')) {
    return { success: true, branch: currentBranch, stashed: false, conflict: false, error: null, skipped: 'no-remote-tracking' };
  }

  // Check if already up to date
  const localHead = (await execGit(['rev-parse', 'HEAD'], dir)).stdout.trim();
  const remoteHead = remoteRef.stdout.trim();
  if (localHead === remoteHead) {
    return { success: true, branch: currentBranch, stashed: false, conflict: false, error: null, upToDate: true };
  }

  // Stash dirty working tree if needed
  const status = await getStatus(dir).catch(() => ({ clean: true }));
  let stashed = false;
  if (!status.clean) {
    await execGit(['stash', 'push', '-m', 'cos-pre-task-autostash'], dir);
    stashed = true;
  }

  // Try fast-forward merge first (safest — no rewrite)
  const mergeResult = await execGit(['merge', '--ff-only', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  const mergeOk = !mergeResult.stderr?.includes('fatal') && !mergeResult.stderr?.includes('Not possible to fast-forward');

  if (mergeOk) {
    // Fast-forward succeeded
    if (stashed) {
      const popResult = await execGit(['stash', 'pop'], dir, { ignoreExitCode: true });
      const popOk = !popResult.stderr?.includes('CONFLICT');
      if (!popOk) {
        // Stash pop conflict — abort and report
        await execGit(['checkout', '--', '.'], dir, { ignoreExitCode: true });
        await execGit(['stash', 'drop'], dir, { ignoreExitCode: true });
        return { success: false, branch: currentBranch, stashed: true, conflict: true, error: `stash pop conflict after fast-forward: ${popResult.stderr}` };
      }
    }
    return { success: true, branch: currentBranch, stashed, conflict: false, error: null };
  }

  // Fast-forward failed — local branch has diverged. Try rebase.
  const rebaseResult = await execGit(['rebase', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  const rebaseOk = !rebaseResult.stderr?.includes('CONFLICT') && !rebaseResult.stderr?.includes('error:');

  if (!rebaseOk) {
    // Rebase failed — abort and report conflict
    await execGit(['rebase', '--abort'], dir, { ignoreExitCode: true });
    if (stashed) {
      await execGit(['stash', 'pop'], dir, { ignoreExitCode: true });
    }
    return {
      success: false,
      branch: currentBranch,
      stashed,
      conflict: true,
      error: `branch ${currentBranch} has diverged from origin and rebase has conflicts: ${rebaseResult.stderr}`
    };
  }

  // Rebase succeeded
  if (stashed) {
    const popResult = await execGit(['stash', 'pop'], dir, { ignoreExitCode: true });
    if (popResult.stderr?.includes('CONFLICT')) {
      await execGit(['checkout', '--', '.'], dir, { ignoreExitCode: true });
      await execGit(['stash', 'drop'], dir, { ignoreExitCode: true });
      return { success: false, branch: currentBranch, stashed: true, conflict: true, error: `stash pop conflict after rebase: ${popResult.stderr}` };
    }
  }

  return { success: true, branch: currentBranch, stashed, conflict: false, error: null };
}

/**
 * Get remote branches with merge status relative to the default branch.
 * Returns branches that exist on origin, indicating whether each has been
 * fully merged into the default branch and whether a local copy exists.
 */
export async function getRemoteBranches(dir) {
  // Fetch latest refs
  await execGit(['fetch', 'origin', '--prune'], dir, { ignoreExitCode: true });

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
      // Strip "origin/" prefix
      const name = fullRef.replace(/^origin\//, '');
      // Skip HEAD pointer and refs without a branch name (bare remote name)
      if (name === 'HEAD' || fullRef.includes('HEAD') || !fullRef.includes('/')) return null;
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
 * Delete a branch locally, remotely, or both.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch name to delete
 * @param {object} options
 * @param {boolean} options.local - Delete local branch
 * @param {boolean} options.remote - Delete remote branch
 */
export async function deleteBranch(dir, branchName, { local = false, remote = false } = {}) {
  // Safety: never delete default branches
  const { baseBranch } = await getRepoBranches(dir);
  const protectedBranches = ['main', 'master', 'dev', 'develop', 'release'];
  if (baseBranch) protectedBranches.push(baseBranch);
  if (protectedBranches.includes(branchName)) {
    throw new Error(`Cannot delete protected branch: ${branchName}`);
  }

  // Safety: don't delete the current branch
  const currentBranch = await getBranch(dir);
  if (currentBranch === branchName && local) {
    throw new Error(`Cannot delete the currently checked-out branch: ${branchName}`);
  }

  const results = {};

  if (local) {
    const localResult = await execGit(['branch', '-D', branchName], dir, { ignoreExitCode: true });
    results.local = localResult.exitCode === 0
      ? 'deleted'
      : localResult.stderr?.includes('not found') ? 'not found' : `failed: ${localResult.stderr?.trim()}`;
  }

  if (remote) {
    const remoteResult = await execGit(['push', 'origin', '--delete', branchName], dir, { ignoreExitCode: true });
    results.remote = remoteResult.exitCode === 0
      ? 'deleted'
      : remoteResult.stderr?.includes('not found') || remoteResult.stderr?.includes('does not exist')
        ? 'not found'
        : `failed: ${remoteResult.stderr?.trim()}`;
  }

  return { branch: branchName, results };
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

  return {
    isRepo: isGit,
    branch,
    status,
    recentCommits: commits,
    diffStats,
    remote,
    baseBranch: repoBranches.baseBranch,
    devBranch: repoBranches.devBranch,
    hasChangelog: hasChangelogDir(dir)
  };
}
