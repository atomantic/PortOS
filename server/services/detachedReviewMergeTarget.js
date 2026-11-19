/** Admission for a review checkout PortOS detached to preserve an occupied branch. */
import { execGit } from '../lib/execGit.js';
import { detectForgeCli, parsePullRequestUrl } from '../lib/gitForge.js';
import { readPullRequest, isOpenSameRepoPr } from './prProbe.js';

/** The launch head is immutable: a moved PR needs a freshly provisioned follow-up. */
export async function verifyDetachedReviewMergeTarget({ target, workspacePath, sourceWorkspace }) {
  if (target.detached?.version !== 1 || !/^[a-f0-9]{40}$/i.test(target.detached.headSha || '')
    || target.workspacePath !== workspacePath || !sourceWorkspace || sourceWorkspace === workspacePath) return null;
  const pr = parsePullRequestUrl(target.url);
  if (!pr || detectForgeCli(pr.host) !== 'gh') return null;
  const [symbolic, head] = await Promise.all([
    execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], workspacePath, { ignoreExitCode: true, timeout: 10000 }).catch(() => null),
    execGit(['rev-parse', '--verify', 'HEAD'], workspacePath, { timeout: 10000 }).catch(() => null),
  ]);
  if (symbolic?.exitCode !== 1 || head?.stdout?.trim() !== target.detached.headSha) return null;
  const live = await readPullRequest(pr.number, 'url,number,state,headRefName,headRefOid,isCrossRepository',
    { repoPath: sourceWorkspace, repoSpec: `${pr.host}/${pr.owner}/${pr.repo}`, timeoutMs: 10000 });
  const actual = parsePullRequestUrl(live?.url);
  // `isDraft` is not fetched here: a draft review checkout was never refused by this admission.
  if (!actual || actual.host !== pr.host || actual.owner !== pr.owner || actual.repo !== pr.repo || actual.number !== pr.number
    || live.number !== pr.number
    || !isOpenSameRepoPr(live, { branch: target.branch, head: target.detached.headSha, allowDraft: true })) return null;
  return target.detached.headSha;
}
