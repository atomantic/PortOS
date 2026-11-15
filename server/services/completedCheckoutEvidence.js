/** Server-observed checkout snapshots captured before a claim run completes.
 * Legacy filesystem identity helpers remain until the schema retirement slice. */
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';

export { checkoutSeedSchema } from '../lib/checkoutSeed.js';

const shortBranch = branch => branch?.replace(/^refs\/heads\//, '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const hasClaimCheckoutBindings = meta => meta?.isWorktree !== true
  && (isTruthyMeta(meta?.claimPicksOwnBranch) || Array.isArray(meta?.claimBranches));
export const releaseCandidateBranch = meta => meta?.releaseCandidateRecovery?.status === 'transferred'
  ? meta.releaseCandidateRecovery.transfer.branch : meta?.releaseCandidate?.branch;
export const hasReleaseCandidateBinding = meta => meta?.isWorktree !== true && meta?.taskAnalysisType === 'do-release'
  && ((meta.releaseCandidate?.version === 1 && typeof meta.releaseCandidate.branch === 'string')
    || (meta.releaseSynchronizationCheckout?.version === 1 && meta.releasePublication?.status === 'verified')
    || (meta.releaseCandidateRecovery?.status === 'transferred' && typeof releaseCandidateBranch(meta) === 'string'));
export const boundCheckoutBranches = meta => hasClaimCheckoutBindings(meta) ? meta.claimBranches
  : hasReleaseCandidateBinding(meta) ? [releaseCandidateBranch(meta), meta.releaseSynchronizationCheckout?.branch].filter(Boolean) : [meta?.worktreeBranch];

const repoCommonByRepo = new Map();
async function resolveRepoCommon(repository) {
  let cached = repoCommonByRepo.get(repository);
  if (!cached) {
    cached = execGit(['rev-parse', '--git-common-dir'], repository)
      .then(r => r.stdout.trim())
      .catch(() => null);
    repoCommonByRepo.set(repository, cached);
  }
  return cached;
}

async function filesystemIdentity(path, type) {
  const stat = await lstat(path, { bigint: true });
  if (!(type === 'file' ? stat.isFile() : stat.isDirectory()) || typeof stat.dev !== 'bigint'
    || typeof stat.ino !== 'bigint' || stat.ino <= 0n || typeof stat.birthtimeNs !== 'bigint' || stat.birthtimeNs <= 0n) {
    throw new Error('checkout-incarnation-unavailable');
  }
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

export async function readCompletedCheckoutIdentity({ repoPath, branch, path, head, worktrees = null, repoCommon = null, allowLocked = false }) {
  const { listWorktrees } = await import('./worktreeManager.js');
  const repository = await realpath(repoPath);
  const checkout = await realpath(path);
  if (checkout === repository || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head || '')) return null;
  const trees = worktrees || await listWorktrees(repository);
  const holders = trees.filter(tree => shortBranch(tree.branch) === branch);
  if (holders.length !== 1 || (!allowLocked && holders[0].locked === true) || await realpath(holders[0].path) !== checkout || holders[0].head !== head) return null;
  const pointer = await filesystemIdentity(join(checkout, '.git'), 'file');
  const gitdir = await realpath((await execGit(['rev-parse', '--absolute-git-dir'], checkout)).stdout.trim());
  const administration = await filesystemIdentity(gitdir, 'directory');
  const [currentHead, currentBranch, common, resolvedRepoCommon] = await Promise.all([
    execGit(['rev-parse', '--verify', 'HEAD^{commit}'], checkout),
    execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkout),
    execGit(['rev-parse', '--git-common-dir'], checkout),
    repoCommon ?? resolveRepoCommon(repository),
  ]);
  if (!resolvedRepoCommon) return null;
  if (currentHead.stdout.trim() !== head || currentBranch.stdout.trim() !== branch
    || await realpath(resolve(checkout, common.stdout.trim())) !== await realpath(resolve(repository, resolvedRepoCommon))) return null;
  if (!same(pointer, await filesystemIdentity(join(checkout, '.git'), 'file'))
    || !same(administration, await filesystemIdentity(gitdir, 'directory'))) return null;
  return { repoPath: repository, branch, path: checkout, head, incarnation: { pointer, gitdir: { path: gitdir, ...administration } } };
}

/** The repository a run's checkouts belong to. A claim run that picks its own
 * branch runs in the source checkout itself, so its workspace is the
 * repository and it records no separate sourceWorkspace.
 */
function runRepository(meta) {
  if (typeof meta?.sourceWorkspace === 'string' && meta.sourceWorkspace) return meta.sourceWorkspace;
  return (hasClaimCheckoutBindings(meta) || hasReleaseCandidateBinding(meta)) && meta.isWorktree !== true
    && typeof meta.workspacePath === 'string' && meta.workspacePath ? meta.workspacePath : null;
}

/** Validate the run and capture time, ignoring legacy seed/incarnation fields.
 * Older v2 captures were recorded after completion; retain that time contract. */
export function completedCheckoutReceiptValid(agent, receipt) {
  if (!receipt || receipt.agentId !== agent.id || receipt.startedAt !== agent.startedAt
    || !Number.isFinite(Date.parse(receipt.capturedAt)) || Date.parse(receipt.capturedAt) < Date.parse(agent.startedAt)) return false;
  if (receipt.version === 1) return Date.parse(receipt.capturedAt) <= Date.parse(agent.completedAt);
  return receipt.version === 2 && Date.parse(receipt.capturedAt) <= Date.now();
}

/** Called under the agent-state lock while the run still owns its current
 * bindings. The caller's success flag enables identity capture, as at initial
 * registration; it never changes the provider's execution/delivery verdict.
 * Never manufacture evidence for historical releases.
 * Capture errors withhold cleanup authority without breaking completion.
 */
export async function captureCompletedCheckouts(agent, { success, strict = false, allowUncreated = false } = {}) {
  const meta = agent?.metadata;
  if (success !== true || !['running', 'paused'].includes(agent?.status) || !agent.id
    || !Number.isFinite(Date.parse(agent.startedAt))) return [];
  const repoPath = runRepository(meta);
  if (!repoPath) return [];
  const claim = hasClaimCheckoutBindings(meta);
  const releaseCandidate = hasReleaseCandidateBinding(meta);
  const branches = claim || releaseCandidate ? boundCheckoutBranches(meta) : meta.isWorktree === true && meta.worktreeBranch ? [meta.worktreeBranch] : null;
  if (!Array.isArray(branches)) return [];
  const { listWorktrees } = await import('./worktreeManager.js');
  const trees = await listWorktrees(repoPath).catch(error => {
    if (strict) throw Object.assign(error, { checkoutCapture: { targets: [], unknown: true } });
    return null;
  });
  if (!trees) return [];
  const receipts = [];
  const targets = [];
  let incomplete = false;
  let unknown = false;
  for (const branch of new Set(branches)) {
    if (typeof branch !== 'string' || !branch) continue;
    const holders = trees.filter(tree => shortBranch(tree.branch) === branch);
    if (holders.length !== 1) {
      // A claimed or worktree branch with no checkout (retired, or never created) has
      // nothing to preserve; only ambiguous holders make the capture unknown.
      if (holders.length === 0 && (claim || meta.isWorktree === true)) continue;
      if (!allowUncreated || holders.length > 1) { incomplete = true; unknown = true; }
      continue;
    }
    if (!claim && !releaseCandidate) {
      const recordedPath = typeof meta.workspacePath === 'string' ? await realpath(meta.workspacePath).catch(() => null) : null;
      if (!recordedPath || await realpath(holders[0].path).catch(() => null) !== recordedPath) { incomplete = true; unknown = true; continue; }
    }
    const target = { repoPath, branch, path: holders[0].path, head: holders[0].head, worktrees: trees, allowLocked: releaseCandidate };
    const first = await readCompletedCheckoutIdentity(target).catch(() => null);
    if (!first) { incomplete = true; unknown = true; continue; }
    // Record one server-observed snapshot; legacy filesystem identities are ignored.
    const snapshot = { version: 1, agentId: agent.id, startedAt: agent.startedAt, capturedAt: new Date().toISOString(), repoPath: first.repoPath, branch: first.branch, path: first.path, head: first.head };
    targets.push(snapshot);
    receipts.push(snapshot);
  }
  if (strict && incomplete) throw Object.assign(new Error('checkout-incarnation-unverified'), { checkoutCapture: { targets, unknown } });
  return receipts;
}

/** Revalidate the recorded checkout scope and newest owner before retirement. */
export async function hasCompletedCheckoutEvidence(records, target) {
  if (!Array.isArray(records)) return false;
  const current = await readCompletedCheckoutIdentity(target).catch(() => null);
  if (!current) return false;
  const scoped = (await Promise.all(records.map(async agent => {
    const meta = agent?.metadata;
    const branches = [meta?.worktreeBranch,
      ...(Array.isArray(meta?.claimBranches) ? meta.claimBranches : []),
      ...(Array.isArray(meta?.claimReleasedBranches) ? meta.claimReleasedBranches : [])];
    const repoPath = runRepository(meta);
    if (!branches.includes(current.branch) || !repoPath) return null;
    return await realpath(repoPath).catch(() => null) === current.repoPath ? agent : null;
  }))).filter(Boolean);
  return scoped.some(agent => agent?.status === 'completed' && agent.result?.success === true
    // A later run can reuse an existing checkout without changing its inode or
    // head. Its failure/missing receipt supersedes the older success. Unknown
    // ordering is also a hold; only an unambiguous newest owner can grant this.
    && scoped.every(other => other === agent || Date.parse(other.startedAt) < Date.parse(agent.startedAt))
    && hasClaimCheckoutBindings(agent.metadata) && Array.isArray(agent.metadata?.completedCheckouts)
    && agent.metadata.completedCheckouts.some(receipt => completedCheckoutReceiptValid(agent, receipt)
      && same({ repoPath: current.repoPath, branch: current.branch, path: current.path, head: current.head },
        { repoPath: receipt.repoPath, branch: receipt.branch, path: receipt.path, head: receipt.head })));
}

/** A manual /claim session records no receipt (#12849). Its proof is the forge:
 * a PR merged into the default branch whose head is exactly this checkout's head.
 * Returns that PR and its merge time, or null — any read failure grants nothing.
 */
export async function readMergedClaimEvidence({ repoPath, branch, head, forgeAccount = null }) {
  const { findMergedPullRequest, readMergedPrDelivery } = await import('./mergedPrEvidence.js');
  const pr = await findMergedPullRequest(repoPath, branch, head, { forgeAccount }).catch(() => null);
  if (!pr || !Number.isFinite(Date.parse(pr.mergedAt))) return null;
  const forge = await readMergedPrDelivery(repoPath, branch, pr.url, { forgeAccount, exactDeliveredHead: head }).catch(() => null);
  return forge?.prHead === head ? { prUrl: pr.url, mergedAt: pr.mergedAt } : null;
}
