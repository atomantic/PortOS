/** Server-observed checkout identity captured before a claim run completes.
 * A branch name/path/head can all be reused; private Git filesystem identity
 * distinguishes the completed checkout from a later manual checkout.
 */
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';

const shortBranch = branch => branch?.replace(/^refs\/heads\//, '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function filesystemIdentity(path, type) {
  const stat = await lstat(path, { bigint: true });
  if (!(type === 'file' ? stat.isFile() : stat.isDirectory()) || typeof stat.dev !== 'bigint'
    || typeof stat.ino !== 'bigint' || stat.ino <= 0n || typeof stat.birthtimeNs !== 'bigint' || stat.birthtimeNs <= 0n) {
    throw new Error('checkout-incarnation-unavailable');
  }
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

export async function readCompletedCheckoutIdentity({ repoPath, branch, path, head }) {
  const { listWorktrees } = await import('./worktreeManager.js');
  const repository = await realpath(repoPath);
  const checkout = await realpath(path);
  if (checkout === repository || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head || '')) return null;
  const holders = (await listWorktrees(repository)).filter(tree => shortBranch(tree.branch) === branch);
  if (holders.length !== 1 || await realpath(holders[0].path) !== checkout || holders[0].head !== head) return null;
  const pointer = await filesystemIdentity(join(checkout, '.git'), 'file');
  const gitdir = await realpath((await execGit(['rev-parse', '--absolute-git-dir'], checkout)).stdout.trim());
  const administration = await filesystemIdentity(gitdir, 'directory');
  const [currentHead, currentBranch, common] = await Promise.all([
    execGit(['rev-parse', '--verify', 'HEAD^{commit}'], checkout),
    execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], checkout),
    execGit(['rev-parse', '--git-common-dir'], checkout),
  ]);
  const repoCommon = await execGit(['rev-parse', '--git-common-dir'], repository);
  if (currentHead.stdout.trim() !== head || currentBranch.stdout.trim() !== branch
    || await realpath(resolve(checkout, common.stdout.trim())) !== await realpath(resolve(repository, repoCommon.stdout.trim()))) return null;
  if (!same(pointer, await filesystemIdentity(join(checkout, '.git'), 'file'))
    || !same(administration, await filesystemIdentity(gitdir, 'directory'))) return null;
  return { repoPath: repository, branch, path: checkout, head, incarnation: { pointer, gitdir: { path: gitdir, ...administration } } };
}

/** Called under the agent-state lock while the successful run still owns its
 * current claim bindings. Never manufacture evidence for historical releases.
 * Capture errors withhold cleanup authority without breaking completion.
 */
export async function captureCompletedCheckouts(agent, { success } = {}) {
  const meta = agent?.metadata;
  if (success !== true || !['running', 'paused'].includes(agent?.status) || !agent.id
    || !Number.isFinite(Date.parse(agent.startedAt)) || typeof meta?.sourceWorkspace !== 'string') return [];
  const claim = isTruthyMeta(meta.claimPicksOwnBranch);
  const branches = claim ? meta.claimBranches : meta.isWorktree === true && meta.worktreeBranch ? [meta.worktreeBranch] : null;
  if (!Array.isArray(branches)) return [];
  const { listWorktrees } = await import('./worktreeManager.js');
  const trees = await listWorktrees(meta.sourceWorkspace).catch(() => null);
  if (!trees) return [];
  const receipts = [];
  for (const branch of new Set(branches)) {
    if (typeof branch !== 'string' || !branch) continue;
    const holders = trees.filter(tree => shortBranch(tree.branch) === branch);
    if (holders.length !== 1) continue;
    if (!claim) {
      const recordedPath = typeof meta.workspacePath === 'string' ? await realpath(meta.workspacePath).catch(() => null) : null;
      if (!recordedPath || await realpath(holders[0].path).catch(() => null) !== recordedPath) continue;
    }
    const target = { repoPath: meta.sourceWorkspace, branch, path: holders[0].path, head: holders[0].head };
    const first = await readCompletedCheckoutIdentity(target).catch(() => null);
    if (!first || !same(first, await readCompletedCheckoutIdentity(target).catch(() => null))) continue;
    receipts.push({ version: 1, agentId: agent.id, startedAt: agent.startedAt, capturedAt: new Date().toISOString(), ...first });
  }
  return receipts;
}

/** Revalidate immediately before retirement as well as before archival. Older
 * completed records, failures and reused checkout incarnations grant nothing.
 */
export async function hasCompletedCheckoutEvidence(records, target) {
  if (!Array.isArray(records)) return false;
  const current = await readCompletedCheckoutIdentity(target).catch(() => null);
  if (!current) return false;
  const scoped = (await Promise.all(records.map(async agent => {
    const meta = agent?.metadata;
    const branches = [meta?.worktreeBranch,
      ...(Array.isArray(meta?.claimBranches) ? meta.claimBranches : []),
      ...(Array.isArray(meta?.claimReleasedBranches) ? meta.claimReleasedBranches : [])];
    if (!branches.includes(current.branch) || typeof meta?.sourceWorkspace !== 'string') return null;
    return await realpath(meta.sourceWorkspace).catch(() => null) === current.repoPath ? agent : null;
  }))).filter(Boolean);
  return scoped.some(agent => agent?.status === 'completed' && agent.result?.success === true
    // A later run can reuse an existing checkout without changing its inode or
    // head. Its failure/missing receipt supersedes the older success. Unknown
    // ordering is also a hold; only an unambiguous newest owner can grant this.
    && scoped.every(other => other === agent || Date.parse(other.startedAt) < Date.parse(agent.startedAt))
    && isTruthyMeta(agent.metadata?.claimPicksOwnBranch) && Array.isArray(agent.metadata?.completedCheckouts)
    && agent.metadata.completedCheckouts.some(receipt => receipt?.version === 1
      && receipt.agentId === (agent.id || agent.agentId) && receipt.startedAt === agent.startedAt
      && Number.isFinite(Date.parse(receipt.capturedAt)) && Date.parse(receipt.capturedAt) >= Date.parse(agent.startedAt)
      && Date.parse(receipt.capturedAt) <= Date.parse(agent.completedAt)
      && same(current, { repoPath: receipt.repoPath, branch: receipt.branch, path: receipt.path, head: receipt.head, incarnation: receipt.incarnation })));
}
