/** Read-only proof for an outside operator's linked checkout and reviewed PR. */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parsePullRequestUrl, detectForgeCli } from '../lib/gitForge.js';
import { safeJSONParse } from '../lib/jsonIo.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { readReviewEvidence } from './mergeReviewEvidence.js';

const refused = reason => ({ reason });
const canonical = path => typeof path === 'string' && isAbsolute(path) ? realpath(path).catch(() => null) : null;
const gitValue = async (path, args) => (await execGit(args, path, { timeout: 10000 }).catch(() => null))?.stdout?.trim();
const EXTERNAL_MERGE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$baseRef:String!){
  repository(owner:$owner,name:$name){
    nameWithOwner
    pullRequest(number:$number){url number state isDraft isCrossRepository headRefName headRefOid baseRefName}
    ref(qualifiedName:$baseRef){prefix name target{__typename oid}}
  }
}`;

export async function inspectExternalMergeCheckout(input, agents) {
  const [{ getAppById }, { repositoryKey }] = await Promise.all([import('./apps.js'), import('./mergeHandoffOwner.js')]);
  const app = await getAppById(input.appId).catch(() => null);
  const [repoPath, worktreePath] = await Promise.all([canonical(app?.repoPath), canonical(input.worktreePath)]);
  if (app?.id !== input.appId || !repoPath || !worktreePath || repoPath === worktreePath) return refused('external-checkout-unverified');
  const pr = parsePullRequestUrl(input.prUrl);
  if (!pr || detectForgeCli(pr.host) !== 'gh') return refused('external-forge-unsupported');
  const repository = repositoryKey({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` });
  const [sourceOrigin, checkoutOrigin, top, sourceCommon, checkoutCommon, directory, branch, head] = await Promise.all([
    getOriginInfo(repoPath).catch(() => null), getOriginInfo(worktreePath).catch(() => null),
    gitValue(worktreePath, ['rev-parse', '--show-toplevel']),
    gitValue(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitValue(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    gitValue(worktreePath, ['rev-parse', '--absolute-git-dir']),
    gitValue(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitValue(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}']),
  ]);
  if (!repository || repositoryKey(sourceOrigin) !== repository || repositoryKey(checkoutOrigin) !== repository) {
    return refused('external-repository-changed');
  }
  const [commonDir, otherCommon, gitDir, root] = await Promise.all([
    canonical(sourceCommon), canonical(checkoutCommon), canonical(directory), canonical(top),
  ]);
  if (!commonDir || commonDir !== otherCommon || !gitDir || gitDir === commonDir || root !== worktreePath
    || !branch || head !== input.headSha) return refused('external-checkout-unverified');
  // The Git registration must point back to this checkout, not a copied .git
  // file borrowing another worktree's private evidence. Relative worktree
  // registrations resolve their backlink from the private Git directory.
  const backlink = await readFile(join(gitDir, 'gitdir'), 'utf8').catch(() => null);
  const [pointer, registeredPointer] = await Promise.all([canonical(join(worktreePath, '.git')),
    backlink?.trim() ? canonical(resolve(gitDir, backlink.trim())) : null]);
  if (!pointer || pointer !== registeredPointer) return refused('external-checkout-unverified');
  const identity = await stat(gitDir).catch(() => null);
  const locked = await stat(join(gitDir, 'locked')).then(() => true, error => error.code !== 'ENOENT');
  if (!identity?.isDirectory() || locked) return refused('external-checkout-unverified');
  // CoS registrations may retain a symlink spelling (for example a platform's
  // temp-directory alias); compare their actual paths with this actual checkout.
  const owners = await Promise.all(agents.map(async agent => {
    if (!agent || !['running', 'paused'].includes(agent.status)) return agent;
    const workspace = agent.workspacePath || agent.metadata?.workspacePath;
    const source = agent.sourceWorkspace || agent.metadata?.sourceWorkspace;
    return { ...agent, workspacePath: await canonical(workspace) || workspace,
      sourceWorkspace: await canonical(source) || source };
  }));
  const ownerReason = claimCheckoutOwnerReason({ branchName: branch, holderPath: worktreePath, sourceWorkspace: repoPath, agents: owners });
  if (ownerReason) return refused(ownerReason);
  const { checkoutRetirementFenceReason } = await import('./cosClaimOwnershipState.js');
  const retirement = checkoutRetirementFenceReason({ repoPath: app.repoPath, branch, path: input.worktreePath })
    || checkoutRetirementFenceReason({ repoPath, branch, path: worktreePath });
  if (retirement) return refused(retirement);

  const review = await readReviewEvidence(worktreePath);
  // The outside operator's worktree-private receipt is local workflow evidence,
  // never a PR comment. Optional-inconclusive records an attempted head, not a
  // successful review; the operator still owns its configured review policy.
  if (review.head !== head || !['clean', 'optional-inconclusive'].includes(review.status)) {
    return refused('review-evidence-incomplete');
  }
  return { repository, target: { appId: app.id, repoPath, worktreePath, gitDir, commonDir,
    checkoutIdentity: `${identity.dev}:${identity.ino}`, branch, prUrl: input.prUrl,
    headSha: head, baseSha: input.baseSha, baseBranch: input.baseBranch } };
}

// Network and credential probes must never occupy the shared CoS state queue.
export async function inspectExternalMergeTarget(input, agents) {
  const proof = await inspectExternalMergeCheckout(input, agents);
  if (proof.reason) return proof;
  const { repository, target } = proof;
  const { repoPath, branch, headSha: head } = target;
  const [{ getAppById }, { repositoryKey }] = await Promise.all([import('./apps.js'), import('./mergeHandoffOwner.js')]);
  const app = await getAppById(input.appId);
  const pr = parsePullRequestUrl(input.prUrl);
  const [{ execGh }, { resolveForgeExecOptions }] = await Promise.all([import('./github.js'), import('./forgeExecOptions.js')]);
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount: app.forgeAccount });
  // baseRefOid is the PR's historical base, not the branch guards checked.
  // Read the exact base ref alongside the PR identity on every acquire/check.
  const raw = await execGh(['api', 'graphql', '--hostname', pr.host,
    '-f', `query=${EXTERNAL_MERGE_QUERY}`, '-f', `owner=${pr.owner}`, '-f', `name=${pr.repo}`,
    '-F', `number=${pr.number}`, '-f', `baseRef=refs/heads/${input.baseBranch}`],
  10000, options).catch(() => null);
  const response = safeJSONParse(raw, null);
  const repo = response?.data?.repository;
  const live = repo?.pullRequest;
  const base = repo?.ref;
  const actual = parsePullRequestUrl(live?.url);
  if (response?.errors?.length || !actual
    || repositoryKey({ host: pr.host, fullName: repo?.nameWithOwner }) !== repository
    || repositoryKey({ host: actual.host, fullName: `${actual.owner}/${actual.repo}` }) !== repository
    || actual.number !== pr.number || live.number !== pr.number || live.state !== 'OPEN'
    || live.isDraft !== false || live.isCrossRepository !== false || live.headRefName !== branch
    || live.headRefOid !== head || live.baseRefName !== input.baseBranch || live.baseRefName === branch
    || base?.prefix !== 'refs/heads/' || base.name !== live.baseRefName
    || base.target?.__typename !== 'Commit' || base.target.oid !== input.baseSha) {
    return refused('external-pr-changed');
  }
  return { repository, target: { ...target, prUrl: live.url } };
}
