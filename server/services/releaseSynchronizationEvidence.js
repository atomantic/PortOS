/** Read-only synchronization verifier. The outbox owns obligations, never a
 * merger, task retry budget, checkout, or authority to retire another owner.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { claimCheckoutOwner } from '../lib/claimContinuation.js';
import { hasProcessCwdInside } from '../lib/processCwdProbe.js';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { matchingRetirementReceipts } from '../lib/reconcileRetirementEvidence.js';
import { RELEASE_SYNC_FROZEN_METADATA_KEYS, RELEASE_SYNC_OBLIGATIONS, publisherCandidateTarget } from '../lib/releaseSynchronization.js';
import { completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { getTaskById } from './cosTaskStore.js';
import { getAppById } from './apps.js';
import { getBranchReconcileOutcome } from './branchReconcileOutcome.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';
import { buildQualitySnapshot } from './appQualityFederation.js';
import { classifyQualitySnapshot, serializeQualitySnapshot } from './appQualitySnapshotFormat.js';
import { getActiveAgentIds } from './agentState.js';
import { readAgentsStateForSafetyCheck } from './cosState.js';

const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const time = value => Number.isFinite(Date.parse(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hold = reason => { throw Object.assign(new Error(reason), { code: reason }); };
const wait = reason => { throw Object.assign(new Error(reason), { code: reason, pending: true }); };
const ownersOf = (entry, agents) => agents.filter(agent => agent.taskId === entry.task.id);

async function readSynchronizationForge(origin, forgeExec, path, paginate = false) {
  const args = ['api', '--hostname', origin.host, ...(paginate ? ['--paginate', '--slurp'] : []),
    `repos/${origin.fullName}${path ? `/${path}` : ''}`];
  return JSON.parse(await execGh(args, undefined, forgeExec));
}

async function checkoutTargets(entry, agents, liveAgents) {
  const targets = [];
  for (const agent of agents.filter(value => value.taskId === entry.task.id
    || (value.id === entry.owner.agentId && value.startedAt === entry.owner.startedAt))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))) {
    for (const seed of agent.metadata?.checkoutSeeds || []) {
      if (seed.agentId !== agent.id || seed.startedAt !== agent.startedAt) hold('checkout-owner-unverified');
      const captured = agent.metadata?.completedCheckouts?.find(row => row.branch === seed.branch
        && row.path === seed.path && completedCheckoutReceiptValid(agent, row));
      let head = captured?.head;
      if (!head && agent.status !== 'completed') head = (await execGit(['rev-parse', '--verify', 'HEAD'], seed.path)).stdout.trim();
      const previous = entry.obligations.retirement.evidence?.checkouts?.find(row => row.path === seed.path
        && row.checkoutIdentity === retirementCheckoutIdentityFromPointer(seed.incarnation?.pointer));
      head ||= previous?.head;
      if (!sha(head)) hold('checkout-final-head-unverified');
      const target = { repoPath: seed.repoPath, branch: seed.branch, path: seed.path, head,
        checkoutIdentity: retirementCheckoutIdentityFromPointer(seed.incarnation?.pointer), createdAt: seed.seededAt, agentId: agent.id };
      if (!target.checkoutIdentity || !time(target.createdAt)) hold('checkout-generation-unverified');
      if (claimCheckoutOwner({ branchName: target.branch, holderPath: target.path, sourceWorkspace: target.repoPath,
        agents: liveAgents, ignoreIds: agents.filter(value => value.taskId === entry.task.id || value.id === entry.owner.agentId).map(value => value.id) })) hold('checkout-conflicting-live-owner');
      const previousIndex = targets.findIndex(row => row.path === target.path && row.checkoutIdentity === target.checkoutIdentity);
      if (previousIndex < 0) targets.push(target);
      else {
        const predecessor = agents.find(value => value.id === targets[previousIndex].agentId);
        if (predecessor?.id !== agent.id && (!time(predecessor?.completedAt)
          || Date.parse(predecessor.completedAt) > Date.parse(agent.startedAt))) hold('checkout-owner-overlap');
        targets[previousIndex] = target;
      }
    }
  }
  // Never lose a retained physical generation when an agent leaves the working
  // set or later attempts acquire a different checkout.
  for (const row of entry.obligations.retirement.evidence?.checkouts || []) {
    if (!targets.some(target => target.path === row.path && target.checkoutIdentity === row.checkoutIdentity)) targets.push(row);
  }
  return targets;
}

async function context(entry, agents) {
  const publisher = agents.find(agent => agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt);
  const candidateTarget = publisherCandidateTarget(entry);
  if (!candidateTarget) hold('publisher-candidate-checkout-unverified');
  if (!publisher || entry.checkouts.some(seed => !publisher.metadata?.checkoutSeeds?.some(current => isDeepStrictEqual(current, seed)))) hold('publisher-checkout-evidence-unavailable');
  if (ownersOf(entry, agents).filter(agent => agent.status !== 'completed').length > 1) hold('continuation-conflicting-live-owners');
  const task = await getTaskById(entry.task.id);
  const expected = { ...entry.task.metadata, idempotencyKey: digest([entry.identity, entry.owner]) };
  if (!task || task.taskType !== 'internal' || RELEASE_SYNC_FROZEN_METADATA_KEYS.some(key => !isDeepStrictEqual(task.metadata?.[key], expected[key]))) hold('continuation-owner-conflict');
  const app = await getAppById(task.metadata.app);
  const cwd = app?.repoPath;
  if (!cwd) hold('synchronization-repository-unavailable');
  const origin = await getOriginInfo(cwd);
  if (origin.host !== 'github.com' || origin.fullName !== entry.publication.repository) hold('synchronization-repository-changed');
  const forgeExec = await resolveForgeExecOptions(cwd, { forgeAccount: app.forgeAccount });
  const api = path => readSynchronizationForge(origin, forgeExec, path);
  const pages = async path => {
    const result = await readSynchronizationForge(origin, forgeExec, path, true);
    if (!Array.isArray(result) || result.some(page => !Array.isArray(page))) hold('synchronization-forge-unreadable');
    return result.flat();
  };
  const repository = await api('');
  if (repository.full_name !== origin.fullName || typeof repository.default_branch !== 'string') hold('synchronization-default-unreadable');
  const development = await api(`git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
  if (development.object?.type !== 'commit' || !sha(development.object.sha)) hold('synchronization-default-unreadable');
  // Archived completion records establish delivery history, not current
  // checkout occupancy. Compact legacy records need not have a live status.
  const live = await readAgentsStateForSafetyCheck();
  if (!live.trusted || !live.agents || Array.isArray(live.agents)) hold('checkout-ownership-unreadable');
  const checkouts = await checkoutTargets(entry, agents, Object.values(live.agents));
  if (!checkouts.some(row => isDeepStrictEqual(row, candidateTarget))) hold('publisher-candidate-head-unverified');
  const syncCheckouts = checkouts.filter(row => ownersOf(entry, agents).some(agent => agent.id === row.agentId));
  if (!syncCheckouts.length) hold('continuation-checkout-unverified');
  const saved = entry.obligations.synchronizationPr.evidence;
  let number = saved?.number;
  if (!number) {
    const matches = [];
    for (const branch of new Set(syncCheckouts.map(row => row.branch))) {
      const prs = await pages(`pulls?state=all&head=${encodeURIComponent(`${repository.owner.login}:${branch}`)}&per_page=100`);
      matches.push(...prs.filter(pr => syncCheckouts.some(row => row.branch === pr.head?.ref && row.head === pr.head?.sha)));
    }
    const unique = [...new Set(matches.map(pr => pr.number))];
    if (unique.length !== 1) hold(unique.length ? 'synchronization-pr-conflict' : 'synchronization-pr-pending');
    [number] = unique;
  }
  if (!Number.isSafeInteger(number) || number < 1) hold('synchronization-pr-unverified');
  const pr = await api(`pulls/${number}`);
  if (pr.number !== number || pr.base?.repo?.full_name !== origin.fullName || pr.head?.repo?.full_name !== origin.fullName
    || pr.base.ref !== repository.default_branch || !sha(pr.head?.sha)
    || !syncCheckouts.some(row => row.branch === pr.head.ref && row.head === pr.head.sha)) hold('synchronization-pr-identity-changed');
  const target = { number, prUrl: `https://github.com/${origin.fullName}/pull/${number}`, headSha: pr.head.sha,
    branch: pr.head.ref, base: repository.default_branch, developmentHead: development.object.sha, mergeSha: pr.merge_commit_sha };
  const ancestor = async (base, head) => {
    if (!sha(base) || !sha(head)) return false;
    const comparison = await api(`compare/${base}...${head}`);
    return ['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === base;
  };
  return { task, app, cwd, origin, forgeExec, api, pages, checkouts, pr, target, ancestor };
}

/** Every accepted result has inspected source evidence and a revision binding.
 * A transport error retains prior successful proof for the SAME PR/head only.
 */
export async function inspectReleaseSynchronization(entry, agents) {
  const obligations = structuredClone(entry.obligations);
  let ctx;
  try { ctx = await context(entry, agents); }
  catch (error) {
    const blocker = error.code || 'synchronization-evidence-unavailable';
    return { status: blocker === 'synchronization-pr-pending' && ownersOf(entry, agents).some(agent => agent.status === 'running') ? 'running' : 'blocked', blocker, obligations };
  }
  const { pr, target, checkouts } = ctx;
  const sameDelivery = entry.obligations.localReview.evidence?.prUrl === target.prUrl
    && entry.obligations.localReview.evidence.base === target.base;
  const sameTarget = entry.obligations.synchronizationPr.evidence?.headSha === target.headSha
    && entry.obligations.synchronizationPr.evidence?.prUrl === target.prUrl;
  if (!sameTarget) for (const key of RELEASE_SYNC_OBLIGATIONS) {
    if (key !== 'localReview' || !sameDelivery) obligations[key] = { status: 'pending' };
  }
  const binding = { prUrl: target.prUrl, headSha: target.headSha };
  const check = async (name, inspect) => {
    try {
      const evidence = await inspect();
      obligations[name] = { status: 'verified', verifiedAt: obligations[name].verifiedAt || new Date().toISOString(), evidence: { ...binding, ...evidence } };
    } catch (error) {
      // A negative observation revokes proof; an unreadable source retains the
      // original proof without inventing a fresh inspection timestamp.
      if (!error.code && obligations[name].status === 'verified') return;
      obligations[name] = { status: error.pending ? 'pending' : 'blocked', blocker: error.code || 'evidence-unavailable',
        ...(obligations[name].evidence && { evidence: obligations[name].evidence }) };
    }
  };
  await check('synchronizationPr', async () => {
    if (pr.merged !== true) wait('synchronization-pr-not-merged');
    if (!time(pr.merged_at) || !sha(pr.merge_commit_sha)) hold('synchronization-merge-unreadable');
    if (!await ctx.ancestor(pr.merge_commit_sha, target.developmentHead)) hold('synchronization-merge-not-on-development');
    if (!await ctx.ancestor(target.headSha, target.developmentHead)) hold('synchronization-head-not-on-development');
    return target;
  });
  await check('candidateFixes', async () => {
    if (!await ctx.ancestor(entry.publication.candidateHead, target.headSha)) hold('candidate-fixes-not-preserved');
    if (!pr.merged) wait('candidate-fixes-awaits-sync');
    if (!await ctx.ancestor(entry.publication.candidateHead, target.developmentHead)) hold('candidate-fixes-not-on-development');
    return { candidateHead: entry.publication.candidateHead };
  });
  await check('releaseAncestry', async () => {
    if (!await ctx.ancestor(entry.publication.promotionMerge, target.headSha)) hold('published-ancestry-not-preserved');
    if (!await ctx.ancestor(entry.publication.promotionMerge, target.developmentHead)) {
      if (!pr.merged) wait('published-ancestry-awaits-sync');
      hold('published-ancestry-not-preserved');
    }
    return { promotionMerge: entry.publication.promotionMerge, developmentHead: target.developmentHead };
  });
  // These legacy obligation names remain readable across upgrades. A confirmed
  // provider merge already applied repository review/CI rules; no local replay
  // of review marks, check timestamps or admission leases can overturn it.
  for (const name of ['localReview', 'hostedReview', 'requiredCi', 'mergeAdmission']) {
    await check(name, async () => {
      if (pr?.merged !== true) wait('hosting-provider-merge-pending');
      return { authority: 'hosting-provider', prUrl: target.prUrl, headSha: target.headSha, mergedAt: pr.merged_at };
    });
  }
  await check('qualitySnapshot', async () => {
    if (obligations.synchronizationPr.status !== 'verified') wait('quality-awaits-development-sync');
    const snapshot = await buildQualitySnapshot(ctx.app);
    if (!snapshot || !Array.isArray(snapshot.measurements)) throw new Error('quality-evidence-unavailable');
    if (!snapshot.measurements.length) return { kind: 'no-local-evidence', developmentHead: target.developmentHead };
    const file = await ctx.api(`contents/.quality.json?ref=${target.developmentHead}`);
    if (file.encoding !== 'base64' || !sha(file.sha) || typeof file.content !== 'string') hold('development-quality-unreadable');
    const published = classifyQualitySnapshot(Buffer.from(file.content, 'base64').toString('utf8'));
    if (published.status !== 'v2' || published.repository !== snapshot.repository) hold('development-quality-invalid');
    const fresh = snapshot.measurements.map(({ measurementId, assessedAt, report }) => ({ ...report, measurementId, assessedAt }));
    const canonical = serializeQualitySnapshot(snapshot.repository, [...published.records, ...fresh]);
    if (!canonical || canonical !== published.canonical) hold('development-quality-snapshot-pending');
    return { blob: file.sha, developmentHead: target.developmentHead, measurementDigest: digest(fresh) };
  });
  // Retain exact final heads even while retirement remains blocked. A receipt
  // for the same pathname from an older physical generation cannot settle it.
  if (!isDeepStrictEqual(entry.obligations.retirement.evidence?.checkouts, checkouts)) {
    obligations.retirement = { status: 'pending' };
    obligations.processSettlement = { status: 'pending' };
  }
  obligations.retirement.evidence = { ...obligations.retirement.evidence, ...binding, checkouts,
    ...(entry.obligations.retirement.evidence?.publisherReview && { publisherReview: entry.obligations.retirement.evidence.publisherReview }) };
  await check('processSettlement', async () => {
    const owners = [...ownersOf(entry, agents), ...agents.filter(agent => agent.id === entry.owner.agentId && agent.startedAt === entry.owner.startedAt)];
    if (!owners.length || owners.some(agent => agent.status !== 'completed')) wait('release-owner-still-active');
    if (owners.some(agent => !time(agent.completedAt) || Date.parse(agent.completedAt) < Date.parse(agent.startedAt)
      || Date.parse(agent.completedAt) > Date.now())) hold('release-owner-completion-unverified');
    const runtimeIds = new Set(getActiveAgentIds());
    const { listAllSessions } = await import('./shell.js');
    const sessions = listAllSessions();
    if (owners.some(agent => runtimeIds.has(agent.id) || sessions.some(session => session.agentId === agent.id))) hold('release-runtime-still-active');
    if (owners.some(agent => agent.metadata?.useRunner === true || agent.metadata?.useRunner === 'true')) {
      const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js');
      const running = await getActiveAgentsFromRunner();
      if (!Array.isArray(running) || running.some(row => !row || typeof row.id !== 'string')) hold('release-runner-unreadable');
      if (running.some(row => owners.some(agent => agent.id === row.id))) hold('release-runtime-still-active');
    }
    if (process.platform === 'win32') {
      const { readWindowsAgentSettlement } = await import('../lib/windowsAgentProcess.js');
      const receipts = [];
      for (const agent of owners) {
        const receipt = await readWindowsAgentSettlement(agent);
        receipts.push(receipt);
      }
      // checkoutTargets already validated the exact server-captured generations.
      // Every retained generation must belong to one of these supervised runs.
      if (checkouts.some(row => !owners.some(agent => agent.id === row.agentId
        && agent.metadata?.checkoutSeeds?.some(seed => seed.path === row.path
          && seed.startedAt === agent.startedAt
          && retirementCheckoutIdentityFromPointer(seed.incarnation?.pointer) === row.checkoutIdentity)))) hold('checkout-process-owner-unverified');
      return { owners: owners.map(agent => ({ id: agent.id, startedAt: agent.startedAt, completedAt: agent.completedAt })), checkouts, receipts };
    }
    for (const agent of owners.filter(value => Number.isSafeInteger(value.pid) && value.pid > 0)) {
      const gone = (() => { try { process.kill(agent.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } })();
      if (!gone) hold('release-process-exit-unverified');
    }
    for (const row of checkouts) if (await hasProcessCwdInside(row.path)) hold('checkout-processes-unsettled');
    return { owners: owners.map(agent => ({ id: agent.id, startedAt: agent.startedAt, completedAt: agent.completedAt })), checkouts };
  });
  await check('retirement', async () => {
    if (obligations.processSettlement.status !== 'verified') wait('retirement-awaits-process-settlement');
    const publisherCheckout = publisherCandidateTarget(entry);
    const review = obligations.retirement.evidence?.publisherReview;
    const publisherPrUrl = `https://github.com/${entry.publication.repository}/pull/${entry.publication.promotionPrNumber}`;
    if (!checkouts.some(row => isDeepStrictEqual(row, publisherCheckout))) hold('publisher-candidate-head-unverified');
    if (!review || review.branch !== publisherCheckout.branch || review.path !== publisherCheckout.path
      || review.head !== publisherCheckout.head || review.checkoutIdentity !== publisherCheckout.checkoutIdentity
      || review.prUrl !== publisherPrUrl || !Array.isArray(review.models)
      || (review.receipt !== null && (!review.receipt || review.receipt.prUrl !== publisherPrUrl))) hold('publisher-private-review-unretained');
    const outcome = await getBranchReconcileOutcome(ctx.app.id);
    const receipts = checkouts.map(row => matchingRetirementReceipts(outcome, row).find(receipt =>
      receipt.archiveDir === null && receipt.checkoutIdentity === row.checkoutIdentity && Date.parse(receipt.retiredAt) >= Date.parse(row.createdAt)
      && Date.parse(receipt.retiredAt) <= Date.now()));
    if (!receipts.length || receipts.some(receipt => !receipt)) hold('exact-retirement-receipt-unverified');
    for (const row of checkouts) {
      const [pathPresent, branchPresent] = await Promise.all([readCheckoutPathPresence(row.path), readLocalBranchPresence(row.repoPath, row.branch)]);
      if (pathPresent === null || branchPresent === null) throw new Error('retirement-inventory-unreadable');
      if (pathPresent !== false || branchPresent !== false) hold('retired-checkout-or-ref-present');
    }
    const [{ listWorktrees }, { listRemoteHeads }] = await Promise.all([import('./worktreeManager.js'), import('./branchReconcile.js')]);
    const [trees, remote] = await Promise.all([listWorktrees(ctx.cwd), listRemoteHeads(ctx.cwd)]);
    if (!Array.isArray(trees) || !trees.length || !(remote instanceof Map)) throw new Error('retirement-inventory-unreadable');
    if (checkouts.some(row => remote.has(row.branch) || trees.some(tree => tree.path === row.path
      || tree.branch?.replace(/^refs\/heads\//, '') === row.branch))) hold('retired-checkout-or-ref-present');
    return { checkouts, receipts, publisherReview: review };
  });
  const verified = RELEASE_SYNC_OBLIGATIONS.every(key => obligations[key]?.status === 'verified');
  const blocked = RELEASE_SYNC_OBLIGATIONS.find(key => obligations[key]?.status === 'blocked');
  return { obligations, status: verified ? 'verified' : blocked ? 'blocked' : 'running',
    blocker: blocked ? `${blocked}:${obligations[blocked].blocker}` : null };
}
