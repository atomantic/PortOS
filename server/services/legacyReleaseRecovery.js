/** Read-only observations of existing legacy publisher evidence. No seed or
 * preservation archive is created here; ordinary retirement retains its gates.
 */
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { claimCheckoutOwner } from '../lib/claimContinuation.js';
import { checkoutSeedSchema } from '../lib/checkoutSeed.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { matchingRetirementReceipts } from '../lib/reconcileRetirementEvidence.js';
import { completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { legacyRecoveryDigest, legacyPublisherRecovery } from '../lib/releaseSynchronization.js';

const hold = reason => { throw Object.assign(new Error(reason), { code: reason }); };
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** The source capture is historical server data. A later physical observation
 * is never substituted for it. Ambiguous captures are held. */
export function legacyPublisherCapture(entry, publisher) {
  if (!publisher || publisher.id !== entry.owner.agentId || publisher.taskId !== entry.owner.taskId
    || publisher.startedAt !== entry.owner.startedAt || publisher.status !== 'completed'
    || !isDeepStrictEqual(publisher.metadata?.releasePublication, entry.publication)
    || !isAbsolute(entry.owner.workspace || '')) return null;
  if (!Array.isArray(publisher.metadata?.completedCheckouts)) return null;
  const captures = publisher.metadata.completedCheckouts.filter(row => row.version === 1
    && completedCheckoutReceiptValid(publisher, row) && row.agentId === publisher.id
    && row.head === entry.publication.candidateHead && typeof row.branch === 'string' && row.branch
    && (!entry.publication.candidateBranch || row.branch === entry.publication.candidateBranch)
    && isAbsolute(row.repoPath || '') && isAbsolute(row.path || '') && !samePath(row.repoPath, row.path)
    && samePath(row.repoPath, entry.owner.workspace)
    && checkoutSeedSchema.shape.incarnation.safeParse(row.incarnation).success
    && isAbsolute(row.incarnation.gitdir.path) && retirementCheckoutIdentityFromPointer(row.incarnation.pointer));
  return captures.length === 1 ? captures[0] : null;
}

export async function inspectLegacyPublisher(entry, agents, { unlocked = false, archiveProof = null } = {}) {
  const publisher = agents.find(agent => agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt);
  const capture = legacyPublisherCapture(entry, publisher);
  if (!capture) hold('legacy-publisher-generation-unverified');
  const [{ getAppById }, { getBranchReconcileOutcome }, { readAgentsStateForSafetyCheck }, { inspectLegacyReleaseArchive },
    { readRetirementForgeEvidence }, { readCheckoutPathPresence, readLocalBranchPresence }, { listWorktrees }, { listRemoteHeads }, { execGit }, { readCompletedCheckoutIdentity }] = await Promise.all([
    import('./apps.js'), import('./taskSchedule.js'), import('./cosState.js'), import('./heldCheckoutRecovery.js'),
    import('./heldCheckoutReview.js'), import('./repoCleanupObservation.js'), import('./worktreeManager.js'), import('./branchReconcile.js'), import('../lib/execGit.js'), import('./completedCheckoutEvidence.js'),
  ]);
  const app = await getAppById(entry.task.metadata.app);
  if (!app?.repoPath || await realpath(app.repoPath).catch(() => null) !== await realpath(capture.repoPath).catch(() => null)
    || !await realpath(capture.repoPath).catch(() => null)) hold('legacy-repository-unverified');
  const live = await readAgentsStateForSafetyCheck();
  if (!live.trusted || !live.agents || Array.isArray(live.agents)) hold('checkout-ownership-unreadable');
  if (claimCheckoutOwner({ branchName: capture.branch, holderPath: capture.path, sourceWorkspace: capture.repoPath,
    agents: Object.values(live.agents) })) hold('checkout-conflicting-live-owner');
  const release = { path: capture.path, branch: capture.branch, head: capture.head, locked: false, lockReason: null,
    checkoutIdentity: retirementCheckoutIdentityFromPointer(capture.incarnation.pointer), createdAt: capture.capturedAt };
  const outcome = await getBranchReconcileOutcome(app.id);
  const [pathPresent, branchPresent, trees, remote] = await Promise.all([
    readCheckoutPathPresence(capture.path), readLocalBranchPresence(capture.repoPath, capture.branch),
    listWorktrees(capture.repoPath), listRemoteHeads(capture.repoPath),
  ]);
  if (!Array.isArray(trees) || !trees.length || !(remote instanceof Map) || pathPresent === null || branchPresent === null) hold('legacy-retirement-inventory-unverified');
  const saved = legacyPublisherRecovery(entry)?.evidence;
  let preservation = null, retirement = null, archiveDir, mode;
  if (pathPresent === true && branchPresent === true) {
    const rows = (outcome?.remaining || []).filter(row => row.path === capture.path && row.branch === capture.branch
      && row.head === capture.head && row.checkoutIdentity === release.checkoutIdentity);
    const obligations = (outcome?.retirementObligations || []).filter(row => row.path === capture.path && row.branch === capture.branch
      && row.head === capture.head && row.checkoutIdentity === release.checkoutIdentity && isDeepStrictEqual(row.checkoutIncarnation, capture.incarnation)
      && row.preservationReceipt?.status === 'preserved' && isDeepStrictEqual(row.preservationReceipt.incarnation, capture.incarnation)
      && isAbsolute(row.preservationReceipt.archiveDir || ''));
    if (rows.length !== 1 || obligations.length !== 1) hold('legacy-preservation-unverified');
    const row = rows[0], held = trees.filter(tree => tree.path === capture.path || tree.branch?.replace(/^refs\/heads\//, '') === capture.branch);
    if (held.length !== 1 || held[0].path !== capture.path || held[0].head !== capture.head
      || held[0].branch?.replace(/^refs\/heads\//, '') !== capture.branch
      || (unlocked ? held[0].locked === true : Boolean(held[0].locked) !== Boolean(row.locked))
      || (!unlocked && (held[0].lockReason ?? null) !== (row.lockReason ?? null))) hold('legacy-checkout-generation-changed');
    const current = await readCompletedCheckoutIdentity({ repoPath: capture.repoPath, ...release, allowLocked: true }).catch(() => null);
    if (!current || !isDeepStrictEqual(current.incarnation, capture.incarnation)) hold('legacy-checkout-generation-changed');
    preservation = { createdAt: obligations[0].createdAt, receipt: obligations[0].preservationReceipt,
      lock: { locked: Boolean(row.locked), lockReason: row.lockReason ?? null } };
    archiveDir = preservation.receipt.archiveDir;
    mode = 'present';
  } else if (pathPresent === false && branchPresent === false) {
    if (remote.has(capture.branch) || trees.some(tree => tree.path === capture.path || tree.branch?.replace(/^refs\/heads\//, '') === capture.branch)) hold('legacy-retirement-inventory-unverified');
    const receipts = matchingRetirementReceipts(outcome, release).filter(row => row.checkoutIdentity === release.checkoutIdentity
      && Date.parse(row.retiredAt) >= Date.parse(capture.capturedAt) && Date.parse(row.retiredAt) <= Date.now()
      && (saved?.mode === 'present' ? row.archiveDir == null || row.archiveDir === saved.archive.archiveDir
        : typeof row.archiveDir === 'string' && isAbsolute(row.archiveDir)));
    const unique = [...new Map(receipts.map(row => [JSON.stringify(row), row])).values()];
    if (unique.length !== 1) hold('legacy-retirement-preservation-unverified');
    if (saved?.mode === 'present') {
      mode = 'present'; preservation = saved.preservation; archiveDir = saved.archive.archiveDir;
      retirement = unique[0];
    } else { mode = 'retired'; retirement = unique[0]; archiveDir = retirement.archiveDir; }
  } else hold('legacy-retirement-inventory-unverified');
  const prUrl = `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`;
  const forge = await readRetirementForgeEvidence(capture.repoPath, capture.branch, prUrl,
    { forgeAccount: app.forgeAccount, exactDeliveredHead: capture.head });
  if (forge.repository !== `github.com/${entry.publication.repository}` || forge.prUrl !== prUrl || forge.prHead !== capture.head
    || forge.mergeCommit !== entry.publication.promotionMerge || (forge.targetBranch || forge.defaultBranch) !== 'release' || forge.scopeProof !== 'exact-delivered-head') hold('legacy-promotion-pr-mismatch');
  if (archiveProof && archiveProof.archiveDir !== archiveDir) hold('legacy-preservation-changed');
  const archived = archiveProof || await inspectLegacyReleaseArchive(capture.repoPath, release, archiveDir, { requireCurrent: pathPresent === true });
  if (archiveProof === archived && pathPresent === true) await archived.recheckCurrent();
  const review = archived.lifecycle;
  const origin = (await execGit(['remote', 'get-url', 'origin'], capture.repoPath)).stdout.trim();
  if (review?.version !== 1 || review.branch !== capture.branch || review.origin !== origin || review.base !== 'release'
    || review.prUrl !== prUrl || !/^[a-f0-9]{40}$/.test(review.reviewedHead || '') || !['clean', 'partial'].includes(review.status)) hold('legacy-review-lifecycle-unverified');
  if (!await archived.recheck()) hold('legacy-archive-changed');
  const evidence = { identity: entry.identity, owner: entry.owner, capture, prUrl,
    forge: { repository: forge.repository, prUrl, prHead: forge.prHead, mergeCommit: forge.mergeCommit },
    review: { version: review.version, branch: review.branch, base: review.base, prUrl: review.prUrl,
      status: review.status, reviewedHead: review.reviewedHead }, candidateInspection: 'unverified',
    archive: { archiveDir: archived.archiveDir, archivedAt: archived.archivedAt, evidenceDigest: archived.evidenceDigest }, mode,
    ...(mode === 'present' ? { preservation } : { retirement }) };
  return { evidence, digest: legacyRecoveryDigest(evidence), recheck: archived.recheck, retirement, archiveProof: archived };
}

/** Fresh process settlement at the destructive boundary; a completion record
 * or an earlier sync inspection does not prove the process is still gone. */
export async function legacyProcessesSettled(entry, agents, path) {
  const owners = agents.filter(agent => agent.id === entry.owner.agentId || agent.taskId === entry.task.id);
  if (!owners.some(agent => agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt)
    || owners.some(agent => agent.status !== 'completed' || !Number.isFinite(Date.parse(agent.completedAt))
      || Date.parse(agent.completedAt) < Date.parse(agent.startedAt) || Date.parse(agent.completedAt) > Date.now())) return false;
  const [{ getActiveAgentIds }, { listAllSessions }, { hasProcessCwdInside }] = await Promise.all([
    import('./agentState.js'), import('./shell.js'), import('../lib/processCwdProbe.js'),
  ]);
  const active = new Set(getActiveAgentIds());
  const sessions = listAllSessions();
  if (owners.some(agent => active.has(agent.id) || sessions.some(session => session.agentId === agent.id))) return false;
  if (owners.some(agent => agent.metadata?.useRunner === true || agent.metadata?.useRunner === 'true')) {
    const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
    const running = await getActiveAgentsFromRunner();
    if (!Array.isArray(running) || running.some(row => !row || typeof row.id !== 'string')
      || running.some(row => owners.some(agent => agent.id === row.id))) return false;
  }
  if (process.platform === 'win32') {
    const { readWindowsAgentSettlement } = await import('../lib/windowsAgentProcess.js');
    for (const owner of owners) await readWindowsAgentSettlement(owner);
    return true;
  } else for (const owner of owners.filter(agent => Number.isSafeInteger(agent.pid) && agent.pid > 0)) {
    try { process.kill(owner.pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
  }
  return !await hasProcessCwdInside(path);
}
