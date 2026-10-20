/** Fork review authority is captured from the forge, then rechecked at admission. */
import { getOriginInfo, parseGitRemoteUrl } from '../lib/gitRemote.js';
import { detectForgeCli, parsePullRequestUrl } from '../lib/gitForge.js';
import { forkHeadFromGithubPr, forkRemoteName, normalizeForkHead, forkLocalBranch } from '../lib/forkHead.js';
import { execGit } from '../lib/execGit.js';
import { readBranchUpstream } from '../lib/branchUpstreamGuard.js';
import { safeJSONParse } from '../lib/jsonIo.js';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const repoKey = ({ host, owner, repo }) => `${host.replace(/^ssh\.github\.com$/i, 'github.com')}/${owner}/${repo}`.toLowerCase();
const remoteKey = value => {
  if (typeof value !== 'string' || !/^(https?:\/\/|ssh:\/\/|[\w.-]+@)/.test(value)) return null;
  const parsed = parseGitRemoteUrl(value);
  return parsed ? repoKey(parsed) : null;
};
const coordinatesMatch = (left, right) => {
  const a = normalizeForkHead(left), b = normalizeForkHead(right);
  return !!a && !!b && !!remoteKey(a.remoteUrl) && remoteKey(a.remoteUrl) === remoteKey(b.remoteUrl)
    && a.ownerLogin.toLowerCase() === b.ownerLogin.toLowerCase();
};

async function readTarget(url, sourceWorkspace) {
  const pr = parsePullRequestUrl(url);
  if (!pr || detectForgeCli(pr.host) !== 'gh' || typeof sourceWorkspace !== 'string' || !sourceWorkspace) return null;
  const origin = await getOriginInfo(sourceWorkspace).catch(() => null);
  if (!origin?.host || `${origin.host.replace(/^ssh\.github\.com$/i, 'github.com')}/${origin.fullName}`.toLowerCase() !== repoKey(pr)) return null;
  const [{ execGh }, { resolveForgeExecOptions }] = await Promise.all([
    import('./github.js'), import('./forgeExecOptions.js'),
  ]);
  const options = await resolveForgeExecOptions(sourceWorkspace);
  const raw = await execGh(['pr', 'view', String(pr.number), '--repo', `${pr.host}/${pr.owner}/${pr.repo}`,
    '--json', 'url,number,state,headRefName,headRefOid,baseRefName,isCrossRepository,headRepository,headRepositoryOwner'], 10000, options).catch(() => null);
  const row = safeJSONParse(raw, null);
  const actual = parsePullRequestUrl(row?.url);
  const forkHead = forkHeadFromGithubPr(row);
  const fork = parseGitRemoteUrl(forkHead?.remoteUrl);
  if (!actual || repoKey(actual) !== repoKey(pr) || actual.number !== pr.number || row.number !== pr.number
    || row.state !== 'OPEN' || !fork || fork.host !== pr.host || repoKey(fork) === repoKey(pr)
    || fork.owner.toLowerCase() !== forkHead.ownerLogin.toLowerCase()
    || typeof row.headRepository?.id !== 'string' || !row.headRepository.id
    || !sha(row.headRefOid) || typeof row.headRefName !== 'string' || !row.headRefName
    || typeof row.baseRefName !== 'string' || !row.baseRefName) return null;
  return { version: 1, url, branch: row.headRefName, baseBranch: row.baseRefName,
    forkHead, headRepositoryId: row.headRepository.id, headSha: row.headRefOid };
}

/** Only fresh supported follow-ups receive this server-read target; never retrofit old runs. */
export async function captureForkReviewMergeTarget({ prUrl, prBranch, forkHead, sourceWorkspace }) {
  const target = await readTarget(prUrl, sourceWorkspace);
  if (!target || target.branch !== prBranch || !coordinatesMatch(target.forkHead, forkHead)) {
    throw new Error('Fork review merge target could not be verified against the base repository and live PR. Leave the PR/worktree intact and create a fresh follow-up after correcting its fork coordinates.');
  }
  // The head may advance during remediation. Admission re-reads it; only the
  // repository, base branch and fork identity remain fixed for this follow-up.
  const { headSha, ...binding } = target;
  return binding;
}

/** Returns the live exact head only when task, registration, checkout and forge agree. */
export async function verifyForkReviewMergeTarget({ target, taskTarget, forkHead, sourceWorkspace, workspacePath, branch, localBranch = forkLocalBranch(branch, forkHead) }) {
  if (!target || target.version !== 1 || JSON.stringify(target) !== JSON.stringify(taskTarget)
    || target.branch !== branch || !coordinatesMatch(target.forkHead, forkHead)) return null;
  const live = await readTarget(target.url, sourceWorkspace);
  if (!live || live.branch !== branch || live.baseBranch !== target.baseBranch
    || live.headRepositoryId !== target.headRepositoryId || !coordinatesMatch(live.forkHead, target.forkHead)) return null;
  const upstream = await readBranchUpstream(workspacePath, localBranch);
  const remote = forkRemoteName(target.forkHead.ownerLogin);
  if (!remote || upstream.remote !== remote || upstream.merge !== `refs/heads/${branch}`) return null;
  const read = args => execGit(args, workspacePath, { timeout: 10000 }).then(r => r.stdout.trim()).catch(() => null);
  const [fetchUrl, pushUrl, head] = await Promise.all([
    read(['remote', 'get-url', '--all', remote]), read(['remote', 'get-url', '--push', '--all', remote]),
    read(['rev-parse', '--verify', 'HEAD']),
  ]);
  // Multiple URLs are ambiguous; each resolved fetch/push remote must name the
  // registered fork. Never repair config or fetch inside the admission lease.
  if (fetchUrl?.includes('\n') || pushUrl?.includes('\n')
    || remoteKey(fetchUrl) !== remoteKey(target.forkHead.remoteUrl)
    || remoteKey(pushUrl) !== remoteKey(target.forkHead.remoteUrl) || head !== live.headSha) return null;
  return head;
}
