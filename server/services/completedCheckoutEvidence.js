import { isDeepStrictEqual } from 'node:util';
/** Server-observed checkout identity captured before a claim run completes.
 * A branch name/path/head can all be reused; private Git filesystem identity
 * distinguishes the completed checkout from a later manual checkout.
 */
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { isTruthyMeta } from '../lib/metadataFlags.js';
import { checkoutSeedSchema } from '../lib/checkoutSeed.js';

export { checkoutSeedSchema } from '../lib/checkoutSeed.js';

const shortBranch = branch => branch?.replace(/^refs\/heads\//, '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const hasClaimCheckoutBindings = meta => meta?.isWorktree !== true
  && (isTruthyMeta(meta?.claimPicksOwnBranch) || Array.isArray(meta?.claimBranches));
export const releaseCandidateBranch = meta => meta?.releaseCandidateRecovery?.status === 'transferred'
  ? meta.releaseCandidateRecovery.transfer.branch : meta?.releaseCandidate?.branch;
export const hasReleaseCandidateBinding = meta => meta?.isWorktree !== true && meta?.taskAnalysisType === 'do-release'
  && ((meta.releaseCandidate?.version === 1 && typeof meta.releaseCandidate.branch === 'string')
    || (meta.releaseCandidateRecovery?.status === 'transferred' && typeof releaseCandidateBranch(meta) === 'string'));
export const boundCheckoutBranches = meta => hasClaimCheckoutBindings(meta) ? meta.claimBranches
  : hasReleaseCandidateBinding(meta) ? [releaseCandidateBranch(meta)] : [meta?.worktreeBranch];

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

/** Invoked only at server-controlled registration/binding while the owner is
 * active. Bind before creation reserves the branch; binding again afterward
 * records its physical generation before work starts. A changed seed refuses.
 */
export async function captureCheckoutSeeds(agent, { allowUncreated = true } = {}) {
  const prior = agent.metadata?.checkoutSeeds || [];
  const rows = await captureCompletedCheckouts(agent, { success: true, strict: true, allowUncreated });
  const seeds = [...prior];
  for (const row of rows) {
    const seed = checkoutSeedSchema.parse({ version: 1, agentId: agent.id, startedAt: agent.startedAt,
      seededAt: new Date().toISOString(), repoPath: row.repoPath, branch: row.branch, path: row.path,
      repository: await filesystemIdentity(row.repoPath, 'directory'), checkout: await filesystemIdentity(row.path, 'directory'),
      incarnation: row.incarnation });
    const existing = prior.find(value => value.branch === seed.branch);
    if (existing) {
      if (!same({ ...existing, seededAt: seed.seededAt }, seed)) throw new Error('checkout-seed-generation-changed');
    } else seeds.push(seed);
  }
  return seeds;
}

/** A late capture has an actual late timestamp and a separately bound early
 * physical generation; legacy v1 evidence retains its original time contract.
 */
export function completedCheckoutReceiptValid(agent, receipt) {
  if (!receipt || receipt.agentId !== agent.id || receipt.startedAt !== agent.startedAt
    || !Number.isFinite(Date.parse(receipt.capturedAt)) || Date.parse(receipt.capturedAt) < Date.parse(agent.startedAt)) return false;
  if (receipt.version === 1) return Date.parse(receipt.capturedAt) <= Date.parse(agent.completedAt);
  if (receipt.version !== 2 || Date.parse(receipt.capturedAt) > Date.now()) return false;
  return agent.metadata?.checkoutSeeds?.some(seed => checkoutSeedSchema.safeParse(seed).success
    && seed.agentId === agent.id && seed.startedAt === agent.startedAt && seed.seededAt === receipt.seededAt
    && Date.parse(seed.seededAt) >= Date.parse(agent.startedAt) && Date.parse(seed.seededAt) <= Date.parse(agent.completedAt) && seed.repoPath === receipt.repoPath
    && seed.branch === receipt.branch && seed.path === receipt.path && same(seed.incarnation, receipt.incarnation)) === true;
}

/** One completed review task can retain its original physical generation even
 * when a retry lost its terminal capture or explicit resume link. This proves
 * only retirement by its later completed owner, never that the older run passed.
 */
export function sameTaskRetirementBinding(agent, successor, input) {
  const a = agent?.metadata, b = successor?.metadata;
  const eligible = item => item?.status === 'completed' && item.result?.executionSuccess === true
    && item.result.validationPassed !== false && !item.result.executionInterruption
    && !item.metadata?.executionInterruption && !item.metadata?.blocker
    && item.result.taskOutcome?.recovery?.mode !== 'approval'
    && item.metadata?.isWorktree === true && item.metadata.prCompletionPolicy === 'review-then-merge'
    && !isTruthyMeta(item.metadata.reviewLoopLeaveOpen)
    && item.metadata.reviewLoopMergeTarget?.url === input.prUrl
    && item.metadata.reviewLoopMergeTarget.branch === input.branch
    && resolve(item.metadata.sourceWorkspace || '') === resolve(input.repoPath)
    && (!item.metadata.branchCompletionPolicy || (item.metadata.branchCompletionPolicy.prUrl === input.prUrl
      && item.metadata.branchCompletionPolicy.branch === input.branch && item.metadata.branchCompletionPolicy.completion === 'review-then-merge'));
  if (!eligible(agent) || !eligible(successor) || agent.id === successor.id || !agent.taskId || agent.taskId !== successor.taskId
    || !a.instanceId || a.instanceId === 'unknown' || a.instanceId !== b.instanceId
    || !(Date.parse(agent.completedAt) >= Date.parse(agent.startedAt))
    || !(Date.parse(agent.completedAt) <= Date.parse(successor.startedAt))) return null;
  const capture = owner => (Array.isArray(owner.metadata.completedCheckouts) ? owner.metadata.completedCheckouts : []).filter(row =>
    completedCheckoutReceiptValid(owner, row) && checkoutSeedSchema.shape.incarnation.safeParse(row.incarnation).success
    && resolve(row.repoPath || '') === resolve(input.repoPath) && row.branch === input.branch
    && resolve(row.path || '') === resolve(owner.metadata.workspacePath || '')
    && isDeepStrictEqual(row.incarnation, input.checkoutIncarnation));
  const current = capture(successor);
  if (current.length !== 1 || current[0].head !== input.tip || resolve(current[0].path) !== resolve(input.checkoutPath)) return null;
  const source = capture(agent);
  if (source.length === 1) return { sourceCapture: source[0], successorCapture: current[0] };
  if (!Array.isArray(a.completedCheckouts) || a.completedCheckouts.length !== 0
    || a.checkoutCapture?.status !== 'pending' || a.checkoutCapture.unknown !== true
    || !Array.isArray(a.checkoutCapture.targets) || a.checkoutCapture.targets.length !== 0 || current[0].version !== 2) return null;
  const seed = owner => (Array.isArray(owner.metadata.checkoutSeeds) ? owner.metadata.checkoutSeeds : []).filter(row =>
    checkoutSeedSchema.safeParse(row).success && row.agentId === owner.id && row.startedAt === owner.startedAt
    && Date.parse(row.seededAt) >= Date.parse(owner.startedAt) && Date.parse(row.seededAt) <= Date.parse(owner.completedAt)
    && resolve(row.repoPath) === resolve(input.repoPath) && row.branch === input.branch
    && resolve(row.path) === resolve(owner.metadata.workspacePath) && isDeepStrictEqual(row.incarnation, input.checkoutIncarnation));
  const older = seed(agent), newer = seed(successor);
  if (older.length !== 1 || newer.length !== 1 || newer[0].seededAt !== current[0].seededAt
    || !isDeepStrictEqual(older[0].checkout, newer[0].checkout) || !isDeepStrictEqual(older[0].repository, newer[0].repository)) return null;
  const dispatch = owner => {
    const d = owner.metadata.completionTaskDispatch;
    if (d?.taskId !== owner.taskId || !Array.isArray(d.expected) || d.expected.length !== 4
      || d.expected.some(row => !Array.isArray(row) || row.length !== 2)) return null;
    const m = new Map(d.expected), count = m.get('totalSpawnCount');
    if (m.size !== 4 || m.get('claimedBy') !== owner.metadata.instanceId
      || m.get('claimedAt') !== m.get('lastSpawnedAt')
      || !(Date.parse(m.get('claimedAt')) >= Date.parse(owner.startedAt))
      || !(Date.parse(m.get('claimedAt')) <= Date.parse(owner.completedAt))
      || !((typeof count === 'number' || (typeof count === 'string' && /^\d+$/.test(count))) && Number.isSafeInteger(Number(count)) && Number(count) > 0)) return null;
    return { type: d.taskType, count: Number(count), claimedAt: Date.parse(m.get('claimedAt')) };
  };
  const first = dispatch(agent), last = dispatch(successor);
  if (!first || !last || first.type !== last.type || first.count > last.count || first.claimedAt >= last.claimedAt) return null;
  return { sourceSeed: older[0], successorCapture: current[0] };
}

/** Read the final head only inside the pre-existing physical binding. No fetch
 * or branch-name discovery is allowed after terminal ingestion.
 */
export async function captureSeededCompletionCheckouts(agent, { preterminal = false, retirement = null } = {}) {
  if (preterminal && !['running', 'paused'].includes(agent.status)) return null;
  const terminalAt = preterminal ? Date.now() : Date.parse(agent.completedAt);
  const bound = boundCheckoutBranches(agent.metadata);
  const seeds = agent.metadata?.checkoutSeeds?.filter(seed => Array.isArray(bound) && bound.includes(seed.branch));
  if (!Array.isArray(seeds) || !seeds.length) return null;
  const receipts = [];
  for (const seed of seeds) {
    if (!checkoutSeedSchema.safeParse(seed).success || seed.agentId !== agent.id || seed.startedAt !== agent.startedAt
      || Date.parse(seed.seededAt) < Date.parse(agent.startedAt) || Date.parse(seed.seededAt) > terminalAt
      || !same(seed.repository, await filesystemIdentity(seed.repoPath, 'directory'))
      || !same(seed.checkout, await filesystemIdentity(seed.path, 'directory'))) return null;
    const head = (await execGit(['rev-parse', '--verify', 'HEAD^{commit}'], seed.path, {
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }, timeout: 5000,
    })).stdout.trim();
    // Normal replay requires the head observed during execution. Explicit
    // retirement review can instead bind a currently merged head to the exact
    // original seed; this is a current observation, never a backdated capture.
    const terminal = agent.metadata?.checkoutCapture?.targets?.find(row => row.agentId === agent.id
      && row.startedAt === agent.startedAt && row.repoPath === seed.repoPath && row.branch === seed.branch
      && row.path === seed.path && same(row.incarnation, seed.incarnation)
      && Number.isFinite(Date.parse(row.capturedAt)) && Date.parse(row.capturedAt) >= Date.parse(agent.startedAt)
      && Date.parse(row.capturedAt) <= terminalAt);
    const reviewedCurrentHead = !terminal && retirement?.verifiedMergedHead === head
      && retirement.head === head && retirement.repoPath === seed.repoPath
      && retirement.branch === seed.branch && retirement.path === seed.path;
    if (!preterminal && ((!terminal && !reviewedCurrentHead) || (terminal && terminal.head !== head))) return null;
    const target = { repoPath: seed.repoPath, branch: seed.branch, path: seed.path, head };
    const current = await readCompletedCheckoutIdentity({ ...target, allowLocked: hasReleaseCandidateBinding(agent.metadata) });
    if (!current || !same(current.incarnation, seed.incarnation)) return null;
    receipts.push({ version: 2, agentId: agent.id, startedAt: agent.startedAt, seededAt: seed.seededAt,
      capturedAt: new Date().toISOString(), ...current });
  }
  return receipts;
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
    // The original preterminal generation is retained even if the independent
    // final read fails. Replay may compare this exact target, never infer one.
    const snapshot = { version: 1, agentId: agent.id, startedAt: agent.startedAt, capturedAt: new Date().toISOString(), ...first };
    targets.push(snapshot);
    if (!same(first, await readCompletedCheckoutIdentity(target).catch(() => null))) { incomplete = true; continue; }
    receipts.push(snapshot);
  }
  if (strict && incomplete) throw Object.assign(new Error('checkout-incarnation-unverified'), { checkoutCapture: { targets, unknown } });
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
      && same(current, { repoPath: receipt.repoPath, branch: receipt.branch, path: receipt.path, head: receipt.head, incarnation: receipt.incarnation })));
}

/** A manual /claim session records no receipt (#12849). Its proof is the forge:
 * a PR merged into the default branch whose head is exactly this checkout's head.
 * Returns that PR and its merge time, or null — any read failure grants nothing.
 */
export async function readMergedClaimEvidence({ repoPath, branch, head, forgeAccount = null }) {
  const { findMergedPullRequest, readRetirementForgeEvidence } = await import('./heldCheckoutReview.js');
  const pr = await findMergedPullRequest(repoPath, branch, head, { forgeAccount }).catch(() => null);
  if (!pr || !Number.isFinite(Date.parse(pr.mergedAt))) return null;
  const forge = await readRetirementForgeEvidence(repoPath, branch, pr.url, { forgeAccount }).catch(() => null);
  return forge?.prHead === head ? { prUrl: pr.url, mergedAt: pr.mergedAt } : null;
}
