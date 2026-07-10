import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { listWorktrees } from './worktreeManager.js';
import { execGit } from '../lib/execGit.js';
import {
  parseStatus,
  parseDiffStat,
  parseBranchVerboseLine,
  parseSubmoduleStatusLine,
  extractAgentSummary
} from '../lib/gitOutputParsers.js';
import {
  parseGitRemote,
  parseGitHubOwnerFromRemote,
  pickGhAccountForOwner,
  detectForgeCli,
  parsePullRequestUrl
} from '../lib/gitForge.js';
import { PROTECTED_BRANCHES, validateFilePaths, toLiteralPathspec } from '../lib/gitArgs.js';

// Re-export so callers that used to import from services/git.js keep working.
export { execGit };
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

// Like execGit but catches rejections (e.g. timeout) into a failed-result shape
const execGitSafe = (args, cwd, options) =>
  execGit(args, cwd, options).catch(err => ({ exitCode: 1, stdout: '', stderr: err.message }));

/**
 * Get git status for a directory
 */
export async function getStatus(dir) {
  const result = await execGit(['status', '--porcelain'], dir);
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
  const safePaths = validateFilePaths(files).map(toLiteralPathspec);
  await execGit(['add', '--', ...safePaths], dir);
  return true;
}

/**
 * Unstage files (same literal-pathspec handling as stageFiles).
 */
export async function unstageFiles(dir, files) {
  const safePaths = validateFilePaths(files).map(toLiteralPathspec);
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

function spawnCli(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', () => resolve({ code: -1, stdout: '', stderr: '' }));
  });
}

async function listGhAccounts() {
  const { stdout, stderr } = await spawnCli('gh', ['auth', 'status', '-h', 'github.com']);
  // gh writes status to stderr in older versions, stdout in newer — search both.
  const text = `${stdout}\n${stderr}`;
  const accounts = [];
  const re = /Logged in to github\.com account (\S+)/g;
  let m;
  while ((m = re.exec(text))) accounts.push(m[1]);
  return accounts;
}

async function getGhTokenForAccount(login) {
  const { code, stdout } = await spawnCli('gh', ['auth', 'token', '-u', login, '-h', 'github.com']);
  return code === 0 ? stdout.trim() : null;
}

/**
 * Resolve the forge CLI + auth env for a given repo directory.
 * - For GitHub repos: auto-pins `GH_TOKEN` to the logged-in gh account whose login
 *   matches the repo owner, so PR creation doesn't depend on `hosts.yml`'s mutable
 *   `user:` field (avoids the multi-account "must be a collaborator" failure mode).
 * - For GitLab repos: uses glab as-is. glab is single-user-per-host, so its keyring
 *   already disambiguates by host without the mutable-active-user pitfall.
 * Falls back to ambient env when no match is possible.
 */
export async function resolveForgeForRepo(dir) {
  const remote = await execGitSafe(['remote', 'get-url', 'origin'], dir);
  const parsed = parseGitRemote(remote.stdout?.trim());
  if (!parsed) {
    return { cli: 'gh', env: process.env, host: null, owner: null, account: null };
  }

  const cli = detectForgeCli(parsed.host);

  if (cli !== 'gh') {
    return { cli, env: process.env, host: parsed.host, owner: parsed.owner, account: null };
  }

  const accounts = await listGhAccounts();
  const account = pickGhAccountForOwner(parsed.owner, accounts);
  if (!account) return { cli, env: process.env, host: parsed.host, owner: parsed.owner, account: null };

  const token = await getGhTokenForAccount(account);
  if (!token) return { cli, env: process.env, host: parsed.host, owner: parsed.owner, account };

  return { cli, env: { ...process.env, GH_TOKEN: token }, host: parsed.host, owner: parsed.owner, account };
}

/**
 * Resolve just the GitHub-token env overlay for a repo directory, so a spawned
 * child that runs its own `gh pr create` — a CoS agent, most notably codex,
 * which is otherwise blind to PortOS's account-pinning — authenticates as the
 * gh account whose login matches the repo owner (the same pinning
 * `resolveForgeForRepo` gives PortOS's own `createPR`). Two reasons a plain
 * env inherit isn't enough: (1) TUI agents run under `buildSafeEnv`, which
 * strips `GH_TOKEN` entirely, so the child would fall back to gh's mutable
 * `hosts.yml` active user; (2) even when inherited, the ambient token can be
 * the wrong account in a multi-login setup ("must be a collaborator").
 *
 * Returns `{ GH_TOKEN }` only when a repo-owner-matched account and token were
 * found; otherwise `{}` so the child keeps whatever gh auth it would have used.
 * Best-effort: never throws, so a spawn is never blocked by remote/auth probes.
 * @param {string} dir - Repo (or worktree) root
 * @returns {Promise<{ GH_TOKEN?: string }>}
 */
export async function resolveForgeTokenEnv(dir) {
  const resolved = await resolveForgeForRepo(dir).catch(() => null);
  // resolveForgeForRepo returns a NEW env object (`{ ...process.env, GH_TOKEN }`)
  // ONLY when it successfully minted an owner-matched token; every other branch
  // (unparseable remote, glab, no account match, token fetch failed) returns the
  // ambient `process.env` by reference. So an identity check on the env object is
  // the precise "a pinned token was minted" signal — keying on `account` alone
  // would wrongly re-emit the ambient GH_TOKEN when the account matched but the
  // token fetch failed (that branch keeps `account` set but env === process.env).
  const token = resolved && resolved.env !== process.env ? resolved.env.GH_TOKEN : null;
  return token ? { GH_TOKEN: token } : {};
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
export async function createPR(dir, { title, body, base, head }) {
  const { cli, env, host, owner, account } = await resolveForgeForRepo(dir);

  const args = cli === 'glab'
    ? ['mr', 'create', '--title', title, '--description', body || '', '--target-branch', base, '--source-branch', head]
    : ['pr', 'create', '--title', title, '--body', body || '', '--base', base, '--head', head];

  const meta = { cli, account, owner, host };

  return new Promise((resolve) => {
    const child = spawn(cli, args, { cwd: dir, env, shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        // Both gh and glab print the resulting URL on stdout (gh: just the URL;
        // glab: a couple lines ending in the URL — extract the last http(s)-looking line).
        const urlMatch = stdout.trim().match(/(https?:\/\/\S+)\s*$/);
        const url = urlMatch ? urlMatch[1] : stdout.trim();
        resolve({ success: true, url, ...meta });
      } else {
        resolve({ success: false, error: stderr || `${cli} exited with code ${code}`, ...meta });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: `${cli} not available: ${err.message}`, ...meta });
    });
  });
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

  return new Promise((resolve) => {
    const child = spawn(cli, args, { cwd: dir, env, shell: false, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: stderr.trim() || `gh exited with code ${code}` });
    });
    child.on('error', (err) => {
      resolve({ success: false, error: `gh not available: ${err.message}` });
    });
  });
}

/**
 * Generate a rich PR description from the agent's output summary.
 * Extracts the implementation summary from the tail of the agent output,
 * stripping tool-call artifacts and keeping only the meaningful explanation
 * of what was implemented (new APIs, UI elements, behaviors, etc.).
 * Falls back to commit messages when no agent output is available.
 * @param {string} dir - Working directory (repo root)
 * @param {string} baseBranch - Base branch (e.g., 'main')
 * @param {string} headBranch - Head branch (agent's branch)
 * @param {string} agentOutput - Raw agent output text
 * @returns {Promise<string>} Formatted PR body
 */
export async function generatePRDescription(dir, baseBranch, headBranch, agentOutput) {
  const summary = extractAgentSummary(agentOutput);

  if (summary) {
    return `Automated PR created by PortOS Chief of Staff.\n\n## Summary\n\n${summary}`;
  }

  // Fallback: build from commit messages when no usable agent output
  const comparison = await getBranchComparison(dir, baseBranch, headBranch).catch(() => null);
  if (comparison?.commits?.length) {
    const commitLines = comparison.commits.map(c => `- ${c.message}`).join('\n');
    return `Automated PR created by PortOS Chief of Staff.\n\n## Changes\n\n${commitLines}`;
  }

  return 'Automated PR created by PortOS Chief of Staff.';
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
  const comparison = await getBranchComparison(dir, baseBranch, headBranch).catch(() => null);
  if (comparison?.commits?.length) {
    const oldest = comparison.commits[comparison.commits.length - 1];
    const subject = oldest?.message?.trim();
    if (subject) return subject.substring(0, 100);
  }
  const firstLine = (fallbackText || '').split(/[\r\n]/).find(l => l.trim()) || '';
  return firstLine.trim().substring(0, 100) || 'CoS automated task';
}

export async function getDefaultBranch(dir, { allowRemote = true } = {}) {
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
 * @returns {Promise<Array<{name: string, current: boolean, tracking: string|null, ahead: number, behind: number, isDefault: boolean, merged: boolean}>>}
 */
export async function getBranches(dir) {
  // Get branches with verbose info (includes tracking)
  const [result, { baseBranch }] = await Promise.all([
    execGit(
      ['branch', '-vv', '--format=%(HEAD)|%(refname:short)|%(upstream:short)|%(upstream:track)'],
      dir,
      { ignoreExitCode: true }
    ),
    getRepoBranches(dir)
  ]);

  const defaultBranch = baseBranch || 'main';
  const protectedSet = new Set(PROTECTED_BRANCHES);
  protectedSet.add(defaultBranch);

  const mergedSet = await getLocalMergedBranchNames(dir, defaultBranch);

  return result.stdout.trim().split('\n').filter(Boolean)
    .map(parseBranchVerboseLine)
    .map(b => ({
      ...b,
      isDefault: b.name === defaultBranch,
      merged: !b.current && !protectedSet.has(b.name) && mergedSet.has(b.name)
    }));
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
 * If the working tree is dirty, skips the pull — other agents may own those
 * uncommitted changes and stashing could interfere with their work.
 *
 * @param {string} dir - Git repository directory
 * @returns {{ success: boolean, branch: string, conflict: boolean, error: string|null }}
 */

export async function ensureLatest(dir) {
  const gitCheck = await isRepo(dir).catch(() => false);
  if (!gitCheck) return { success: true, branch: null, conflict: false, error: null, skipped: 'not-a-repo' };

  const currentBranch = await getBranch(dir).catch(() => null);
  if (!currentBranch) return { success: true, branch: null, conflict: false, error: null, skipped: 'no-branch' };

  // Check for remote — no remote means nothing to pull
  const remote = await getRemote(dir).catch(() => null);
  if (!remote?.origin) return { success: true, branch: currentBranch, conflict: false, error: null, skipped: 'no-remote' };

  // Fetch latest refs from origin
  const fetchResult = await execGit(['fetch', 'origin'], dir, { ignoreExitCode: true });
  if (fetchResult.stderr?.includes('fatal')) {
    return { success: false, branch: currentBranch, conflict: false, error: `fetch failed: ${fetchResult.stderr}` };
  }

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
  const mergeOk = !mergeResult.stderr?.includes('fatal') && !mergeResult.stderr?.includes('Not possible to fast-forward');

  if (mergeOk) {
    return { success: true, branch: currentBranch, conflict: false, error: null };
  }

  // Fast-forward failed — local branch has diverged. Try rebase.
  const rebaseResult = await execGit(['rebase', `origin/${currentBranch}`], dir, { ignoreExitCode: true });
  const rebaseOk = !rebaseResult.stderr?.includes('CONFLICT') && !rebaseResult.stderr?.includes('error:');

  if (!rebaseOk) {
    // Rebase failed — abort and report conflict
    await execGit(['rebase', '--abort'], dir, { ignoreExitCode: true });
    return {
      success: false,
      branch: currentBranch,
      conflict: true,
      error: `branch ${currentBranch} has diverged from origin and rebase has conflicts: ${rebaseResult.stderr}`
    };
  }

  return { success: true, branch: currentBranch, conflict: false, error: null };
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
 * @param {Set<string>} options.excludeBranches - Additional branches to protect (e.g., active agent branches)
 */
export async function deleteBranch(dir, branchName, { local = false, remote = false, excludeBranches } = {}) {
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
  const [localResult, remoteResult] = await Promise.all([
    local ? execGitSafe(['branch', '-D', branchName], dir, opts) : null,
    remote ? execGitSafe(['push', 'origin', '--delete', branchName], dir, opts) : null
  ]);

  const results = {};
  if (localResult) {
    results.local = localResult.exitCode === 0
      ? 'deleted'
      : localResult.stderr?.includes('not found') ? 'not found' : `failed: ${localResult.stderr?.trim()}`;
  }
  if (remoteResult) {
    results.remote = remoteResult.exitCode === 0
      ? 'deleted'
      : remoteResult.stderr?.includes('not found') || remoteResult.stderr?.includes('does not exist')
        ? 'not found'
        : `failed: ${remoteResult.stderr?.trim()}`;
  }

  return { branch: branchName, results };
}

/**
 * Merge a branch into the current branch.
 * Uses --no-ff to always create a merge commit for traceability.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch to merge into current
 * @returns {Promise<{success: boolean, output: string}>}
 */
export async function mergeBranch(dir, branchName) {
  const result = await execGit(['merge', '--no-ff', branchName], dir);
  return { success: true, output: (result.stdout + result.stderr).trim() };
}

/**
 * Determine whether a branch's work is fully present in `target` (e.g. main),
 * covering BOTH a normal/fast-forward/no-ff merge AND a squash (or rebase) merge.
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
export async function isBranchMergedInto(dir, branch, target) {
  if (!branch || !target || branch === target) return false;

  const resolve = (ref) => execGit(['rev-parse', '--verify', `${ref}^{commit}`], dir, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);

  const [branchSha, targetSha] = await Promise.all([resolve(branch), resolve(target)]);
  if (!branchSha || !targetSha) return false;

  // Fast path: branch tip already reachable from target (normal / ff / no-ff merge,
  // or the branch carries no unique commits).
  const ancestor = await execGit(['merge-base', '--is-ancestor', branchSha, targetSha], dir, { ignoreExitCode: true })
    .then(r => r.exitCode === 0)
    .catch(() => false);
  if (ancestor) return true;

  // Rebase/cherry-pick path: does target contain every branch commit as an
  // individual patch-equivalent commit?
  const individualCherry = await execGit(['cherry', targetSha, branchSha], dir, { ignoreExitCode: true })
    .then(r => r.stdout.trim())
    .catch(() => null);
  if (individualCherry === null) return false;
  if (individualCherry !== '' && individualCherry.split('\n').every(line => line.startsWith('-'))) {
    return true;
  }

  // Squash path: does target already contain the branch's combined patch?
  const mergeBase = await execGit(['merge-base', targetSha, branchSha], dir, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (!mergeBase) return false;
  // No unique work beyond the merge base → nothing would be lost.
  if (mergeBase === branchSha) return true;

  const branchTree = await execGit(['rev-parse', `${branchSha}^{tree}`], dir, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (!branchTree) return false;

  // Synthesize a single commit with the branch's full tree atop the merge base.
  // commit-tree uses the repo's configured identity; if that's unset it fails and
  // we fall through to "not merged" (safe — the worktree is just preserved).
  const synthesized = await execGit(['commit-tree', branchTree, '-p', mergeBase, '-m', 'merged-check-probe'], dir, { ignoreExitCode: true })
    .then(r => (r.exitCode === 0 ? r.stdout.trim() : null))
    .catch(() => null);
  if (!synthesized) return false;

  const combinedCherry = await execGit(['cherry', targetSha, synthesized], dir, { ignoreExitCode: true })
    .then(r => r.stdout.trim())
    .catch(() => null);
  if (combinedCherry === null) return false;
  if (combinedCherry === '') return true; // empty patch (tree already matches) ⇒ merged
  return combinedCherry.split('\n').every(line => line.startsWith('-'));
}

/**
 * Checkout a remote branch that doesn't exist locally.
 * Creates a local tracking branch from the remote ref.
 * @param {string} dir - Working directory
 * @param {string} branchName - Branch name (without origin/ prefix)
 * @returns {Promise<{success: boolean, branch: string}>}
 */
export async function checkoutRemoteBranch(dir, branchName) {
  await execGit(['checkout', '-b', branchName, `origin/${branchName}`], dir);
  return { success: true, branch: branchName };
}

/**
 * Delete all merged branches (local and remote) in one operation.
 * Skips protected branches (main, master, dev, develop, release), the current branch,
 * branches checked out in worktrees, and any explicitly excluded branches.
 * @param {string} dir - Working directory
 * @param {object} options
 * @param {Set<string>} options.excludeBranches - Additional branches to protect (e.g., active agent branches)
 * @returns {Promise<{deleted: Array<{name: string, local: string, remote: string}>, skipped: string[], defaultBranch: string}>}
 */
export async function deleteMergedBranches(dir, { excludeBranches } = {}) {
  const [{ baseBranch }, currentBranch, worktreeBranches] = await Promise.all([
    getRepoBranches(dir),
    getBranch(dir),
    getWorktreeBranches(dir)
  ]);
  const defaultBranch = baseBranch || 'main';
  const protectedSet = new Set(PROTECTED_BRANCHES);
  if (baseBranch) protectedSet.add(baseBranch);

  // Worktree and agent branches are only protected from local deletion
  const localOnlyProtected = new Set([...worktreeBranches]);
  if (excludeBranches) {
    for (const b of excludeBranches) localOnlyProtected.add(b);
  }

  await execGitSafe(['fetch', 'origin', '--prune'], dir, { ignoreExitCode: true });

  const [localMergedNames, remoteMerged] = await Promise.all([
    getLocalMergedBranchNames(dir, defaultBranch),
    execGit(['branch', '-r', '--merged', `origin/${defaultBranch}`, '--format=%(refname:short)'], dir, { ignoreExitCode: true })
  ]);

  const mergedLocalNames = [...localMergedNames]
    .filter(name => !protectedSet.has(name) && !localOnlyProtected.has(name) && name !== currentBranch);

  const mergedRemoteNames = remoteMerged.stdout.trim().split('\n').filter(Boolean)
    .filter(ref => ref.startsWith('origin/'))
    .map(ref => ref.replace(/^origin\//, ''))
    .filter(name => !protectedSet.has(name) && name !== 'HEAD');

  const allMerged = [...new Set([...mergedLocalNames, ...mergedRemoteNames])];
  const localSet = new Set(mergedLocalNames);
  const remoteSet = new Set(mergedRemoteNames);

  const deleted = [];
  const skipped = [];
  const opts = { ignoreExitCode: true };

  for (const name of allMerged) {
    const hasLocal = localSet.has(name);
    const hasRemote = remoteSet.has(name);
    const result = { name, local: null, remote: null };

    if (hasLocal) {
      const r = await execGitSafe(['branch', '-d', name], dir, opts);
      result.local = r.exitCode === 0 ? 'deleted' : 'failed';
      if (r.exitCode !== 0) skipped.push(`${name} (local: ${r.stderr?.trim()})`);
    }

    if (hasRemote) {
      const r = await execGitSafe(['push', 'origin', '--delete', name], dir, opts);
      result.remote = r.exitCode === 0 ? 'deleted' : 'failed';
      if (r.exitCode !== 0) skipped.push(`${name} (remote: ${r.stderr?.trim()})`);
    }

    if (result.local === 'deleted' || result.remote === 'deleted') {
      deleted.push(result);
    }
  }

  return { deleted, skipped, defaultBranch };
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

/**
 * Get submodule status for the PortOS repo
 */
export async function getSubmodules() {
  const root = PATHS.root;
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
 * Get known submodule paths
 */
export async function getSubmodulePaths() {
  const root = PATHS.root;
  const result = await execGit(['submodule', 'status'], root);
  return result.stdout.split('\n').filter(l => l.trimEnd())
    .map(parseSubmoduleStatusLine).filter(Boolean).map(s => s.path);
}

/**
 * Update a specific submodule to the latest remote version
 */
export async function updateSubmodule(subPath) {
  const root = PATHS.root;
  // Validate subPath is a known submodule
  const knownPaths = await getSubmodulePaths();
  if (!knownPaths.includes(subPath)) {
    throw new Error(`Unknown submodule path: ${subPath}`);
  }
  console.log(`📦 Updating submodule ${subPath}...`);
  await execGit(['submodule', 'update', '--init', '--recursive', '--remote', subPath], root, { timeout: 60000 });
  console.log(`✅ Submodule ${subPath} updated`);
  const statusResult = await execGit(['submodule', 'status', subPath], root);
  const parsed = parseSubmoduleStatusLine(statusResult.stdout);
  return parsed ? parsed.commit.substring(0, 7) : null;
}
