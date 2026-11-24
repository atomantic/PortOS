import { safeJSONParse } from '../../lib/fileUtils.js';
import { execGitSafe } from '../../lib/execGit.js';
import { resolveForgeForRepo } from '../forgeAuth.js';
import { extractAgentSummary } from '../../lib/gitOutputParsers.js';
import { detectForgeCli, parsePullRequestUrl } from '../../lib/gitForge.js';
import { PROTECTED_BRANCHES, assertSafeRef } from '../../lib/gitArgs.js';
import { securityScanPRDisclosure } from '../../lib/securityScanEvidence.js';
import { parseGitRemoteUrl } from '../../lib/gitRemote.js';
import { getBranchComparison } from './status.js';

async function execForgeCli(cli, args, dir, env) {
  if (cli === 'glab') {
    const { execGlab } = await import('../gitlab.js');
    return execGlab(args, dir, undefined, { env, rejectOnError: true });
  }
  const { execGh } = await import('../github.js');
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

  const { runForgeMerge } = await import('../appPullRequestMerge.js');
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
  const { readPullRequest } = await import('../prView.js');
  const merged = await readPullRequest(prNumber,
    'state,url,headRefName,headRefOid,baseRefName,isCrossRepository,headRepository', { cwd: dir, env });
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
  const { execGh } = await import('../github.js');
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
  // the review request needs to go. Non-GitHub PR URLs short-circuit as a successful
  // skip so cleanupAgentWorktree doesn't emit a warning for every GitLab MR.
  if (detectForgeCli(parsed.host) !== 'gh') return { success: true, skipped: true };

  const { cli, env } = await resolveForgeForRepo(dir);
  if (cli !== 'gh') return { success: true, skipped: true };

  // Target the same GitHub instance the PR lives on. github.com is gh's implicit
  // default so we only need to set --hostname explicitly for non-default hosts.
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
