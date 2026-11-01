/** Recover only an existing physical candidate, under ownership/state and
 * retirement admission. All evidence comes from service records, Git or the
 * forge; the request supplies only the documented predecessor's run ID. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { execGit } from '../lib/execGit.js';
import { withCheckoutPublication } from '../lib/checkoutRetirementAdmission.js';
import { claimCheckoutOwnerReason } from '../lib/claimContinuation.js';
import { releaseCandidateTransferSchema } from '../lib/releasePublication.js';
import { localReviewReceiptEvidence } from '../lib/localReviewLifecycle.js';
import { ownershipTransaction, checkoutRetirementFenceReason } from './cosClaimOwnership.js';
import { captureCheckoutSeeds, captureSeededCompletionCheckouts, completedCheckoutReceiptValid, readCompletedCheckoutIdentity,
  releaseCandidateBranch } from './completedCheckoutEvidence.js';
import { readReleaseCandidate } from './releaseCandidateEvidence.js';
import { readReleaseCandidateSettlement } from './releaseCandidateSettlement.js';

const refuse = reason => { throw Object.assign(new Error(reason), { recoveryReason: reason }); };
const digest = value => createHash('sha256').update(value).digest('hex');
const run = agent => ({ agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt });
const releaseRun = agent => agent?.metadata?.taskAnalysisType === 'do-release' && agent.metadata.isWorktree === false;
const repository = agent => agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
const nextStep = 'Preserve the original checkout and private review files; resolve the recorded lineage or process hold, then retry recovery. Do not reserve another candidate.';

async function sourceCheckout(source) {
  if (source.metadata.checkoutSeeds?.length) {
    const rows = await captureSeededCompletionCheckouts(source);
    const branch = releaseCandidateBranch(source.metadata);
    const candidates = rows?.filter(row => row.branch === branch) || [];
    const seeds = source.metadata.checkoutSeeds.filter(seed => seed.branch === branch);
    if (candidates.length !== 1 || seeds.length !== 1 || rows.length !== source.metadata.checkoutSeeds.length) refuse('candidate-terminal-receipt-unverified');
    const { capturedAt: _observedAt, ...receipt } = candidates[0];
    return { kind: 'seeded', receipt, seed: seeds[0] };
  }
  // This independently captured, preterminal v1 receipt is the only unseeded
  // lineage currently supported. Its private Git pointer and administration
  // identities predate interruption. Never manufacture an earlier seed.
  const rows = source.metadata.completedCheckouts;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].version !== 1
    || !completedCheckoutReceiptValid(source, rows[0])) refuse('candidate-contemporaneous-lineage-missing');
  const receipt = rows[0];
  const current = await readCompletedCheckoutIdentity({ ...receipt, allowLocked: true });
  if (!current || !equal(current, { repoPath: receipt.repoPath, branch: receipt.branch,
    path: receipt.path, head: receipt.head, incarnation: receipt.incarnation })) refuse('candidate-generation-changed');
  return { kind: 'contemporaneous-receipt', receipt };
}

async function reviewSnapshot(checkout, pr, origin) {
  const directory = checkout.incarnation.gitdir.path;
  const files = (await readdir(directory)).filter(name => /^portos-(?:local-review|review)/.test(name)).sort();
  const evidence = [];
  let total = 0;
  for (const name of files) {
    const path = join(directory, name);
    const stat = await lstat(path);
    total += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || total > 1024 * 1024) refuse('candidate-review-evidence-unreadable');
    const bytes = await readFile(path);
    evidence.push({ name, bytes: bytes.length, sha256: digest(bytes) });
    if (name === 'portos-local-review-lifecycle') {
      const receipt = JSON.parse(bytes.toString('utf8'));
      let inspection;
      try { inspection = localReviewReceiptEvidence(receipt); }
      catch { refuse('candidate-review-identity-conflict'); }
      if (receipt.branch !== checkout.branch || receipt.origin !== origin
        || (receipt.prUrl && receipt.prUrl !== pr?.url)) refuse('candidate-review-identity-conflict');
      // V1's historical completion SHA is not proof of inspection. V2 keeps
      // the actual inspection and later remediated completion distinct.
      const heads = [inspection.reviewedHead, inspection.completedHead, checkout.head].filter(Boolean);
      for (let index = 1; index < heads.length; index++) {
        const ancestry = await execGit(['merge-base', '--is-ancestor', heads[index - 1], heads[index]], checkout.path, { ignoreExitCode: true });
        if (ancestry.exitCode !== 0) refuse('candidate-reviewed-head-conflict');
      }
    }
  }
  return { files: evidence, legacyPublished: Boolean(pr && !files.includes('portos-local-review-lifecycle')) };
}

async function publicationSnapshot(checkout, candidate) {
  const [{ getOriginInfo }, { resolveForgeExecOptions }, { execGh }] = await Promise.all([
    import('../lib/gitRemote.js'), import('./forgeExecOptions.js'), import('./github.js'),
  ]);
  const origin = await getOriginInfo(checkout.repoPath);
  if (!origin.isGithub || origin.host !== 'github.com' || !origin.fullName) refuse('candidate-forge-unavailable');
  const options = await resolveForgeExecOptions(checkout.repoPath);
  const api = async path => JSON.parse(await execGh(['api', '--hostname', origin.host, `repos/${origin.fullName}/${path}`], undefined, options));
  const rows = await api(`pulls?state=all&head=${encodeURIComponent(`${origin.fullName.split('/')[0]}:${checkout.branch}`)}&per_page=100`);
  if (!Array.isArray(rows) || rows.length > 1) refuse('candidate-publication-ambiguous');
  if (!rows.length) {
    const base = await api('git/ref/heads/release');
    if (base.ref !== 'refs/heads/release' || base.object?.type !== 'commit' || base.object.sha !== candidate.releaseBase) refuse('candidate-release-base-changed');
    return null;
  }
  const pr = rows[0];
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0 || pr.base?.ref !== 'release'
    || pr.base.repo?.full_name !== origin.fullName || pr.head?.repo?.full_name !== origin.fullName
    || pr.head.ref !== checkout.branch || pr.head.sha !== checkout.head
    || pr.html_url !== `https://github.com/${origin.fullName}/pull/${pr.number}`) refuse('candidate-publication-conflict');
  const detail = await api(`pulls/${pr.number}`);
  if (typeof detail.merged !== 'boolean' || detail.number !== pr.number || detail.html_url !== pr.html_url
    || detail.head?.sha !== checkout.head || detail.head.ref !== checkout.branch
    || detail.head.repo?.full_name !== origin.fullName || detail.base?.ref !== 'release'
    || detail.base.repo?.full_name !== origin.fullName) refuse('candidate-publication-changed');
  if (detail.merged === true) {
    if (!/^[a-f0-9]{40}$/.test(detail.merge_commit_sha || '')) refuse('candidate-promotion-unverified');
    const promotion = await api(`git/commits/${detail.merge_commit_sha}`);
    if (promotion.tree?.sha !== candidate.tree || promotion.parents?.length !== 2
      || promotion.parents[0].sha !== candidate.releaseBase || promotion.parents[1].sha !== checkout.head) refuse('candidate-promotion-conflict');
  } else if (detail.state !== 'open' || detail.base?.sha !== candidate.releaseBase) refuse('candidate-release-base-changed');
  return { number: pr.number, url: pr.html_url, head: checkout.head, merged: detail.merged === true,
    merge: detail.merged === true ? detail.merge_commit_sha : null };
}

async function inspectCandidate(source) {
  const lineage = await sourceCheckout(source);
  const checkout = lineage.receipt;
  if (await realpath(repository(source)) !== checkout.repoPath) refuse('candidate-repository-conflict');
  const candidate = await readReleaseCandidate(checkout.head, checkout.path);
  if (!/^\d+\.\d+\.\d+$/.test(candidate.version || '')
    || JSON.parse(await readFile(join(checkout.path, 'package.json'), 'utf8')).version !== candidate.version) refuse('candidate-prepared-version-conflict');
  const publication = await publicationSnapshot(checkout, candidate);
  const origin = (await execGit(['remote', 'get-url', 'origin'], checkout.path)).stdout.trim();
  const review = await reviewSnapshot(checkout, publication, origin);
  return { lineage, candidate, publication, review };
}

export async function recoverReleaseCandidate(successorAgentId, predecessorAgentId) {
  const result = await ownershipTransaction('release-recover', 'recovered', async (state, save) => {
    const successor = state.agents[successorAgentId];
    const source = state.agents[predecessorAgentId];
    if (!releaseRun(successor) || successor.status !== 'running' || successor.id === predecessorAgentId) {
      return { recovered: false, reason: 'candidate-successor-unverified', nextStep };
    }
    const previous = successor.metadata.releaseCandidateRecovery;
    const hold = async reason => {
      // A failed retry must never revoke a completed transfer's reservation.
      if (previous?.status !== 'transferred') {
        state.agents[successor.id] = { ...successor, metadata: { ...successor.metadata,
          releaseCandidateRecovery: { version: 1, status: 'held', predecessorAgentId, reason, nextStep } } };
        await save();
        const { cosEvents } = await import('./cosEvents.js');
        cosEvents.emit('agent:updated', state.agents[successor.id]);
      }
      return { recovered: false, reason, nextStep };
    };
    let persisting = false;
    try {
      const resumed = source?.result?.resumed === true && source.result.resumedTaskId === successor.taskId;
      const retriedInline = source?.metadata?.releasePublication?.synchronizationHandoffVersion === 2
        && source.result?.deliveryRecoveryOwned === true && ['blocked', 'incomplete'].includes(source.result?.taskOutcome?.status);
      if (!releaseRun(source) || source.status !== 'completed'
        || !(Date.parse(source.completedAt) >= Date.parse(source.startedAt)) || Date.parse(source.completedAt) > Date.now()
        || !(Date.parse(successor.startedAt) >= Date.parse(source.completedAt)) || !source.taskId
        || source.taskId !== successor.taskId || (!resumed && !retriedInline)
        || successor.metadata.resumedFromAgentId !== source.id || !source.metadata.instanceId
        || source.metadata.instanceId === 'unknown' || source.metadata.instanceId !== successor.metadata.instanceId) refuse('candidate-successor-lineage-unverified');
      const { getTaskById } = await import('./cosTaskStore.js');
      const task = await getTaskById(successor.taskId);
      if (task?.metadata?.resumedFromAgentId !== source.id) refuse('candidate-task-lineage-unverified');
      const publication = source.metadata.releasePublication;
      if ((publication && publication.synchronizationHandoffVersion !== 2)
        || (successor.metadata.releasePublication && (!publication || previous?.status !== 'transferred'
          || !equal(successor.metadata.releasePublication, publication)))) refuse('candidate-already-published');
      if (successor.metadata.releaseCandidate || (previous?.status === 'transferred' && previous.predecessorAgentId !== source.id)
        || (source.metadata.releaseCandidateSuccessor && source.metadata.releaseCandidateSuccessor.successor.agentId !== successor.id)) refuse('candidate-successor-conflict');
      const repoPath = await realpath(repository(source));
      if (repoPath !== await realpath(repository(successor))) refuse('candidate-repository-conflict');
      return await withCheckoutPublication(repoPath, async () => {
        const evidence = await inspectCandidate(source);
        const target = evidence.lineage.receipt;
        if (publication && (publication.status !== 'verified' || publication.candidateHead !== target.head
          || evidence.publication?.number !== publication.promotionPrNumber || evidence.publication?.merged !== true
          || evidence.publication?.merge !== publication.promotionMerge)) refuse('candidate-publication-conflict');
        const sync = source.metadata.releaseSynchronizationCheckout;
        const sourceSync = sync && source.metadata.checkoutSeeds?.find(seed => seed.branch === sync.branch);
        if (sync && (!publication || sync.identity !== publication.identity || !sourceSync)) refuse('candidate-synchronization-checkout-unverified');
        if (sourceSync && checkoutRetirementFenceReason({ repoPath, branch: sourceSync.branch, path: sourceSync.path })) refuse('checkout-retirement-reserved');
        if (sourceSync && claimCheckoutOwnerReason({ branchName: sourceSync.branch, holderPath: sourceSync.path,
          sourceWorkspace: repoPath, agents: Object.values(state.agents), ignoreIds: [source.id, successor.id] })) refuse('candidate-owner-ambiguous');
        const fenced = checkoutRetirementFenceReason({ repoPath, branch: target.branch, path: target.path });
        if (fenced) refuse(fenced);
        const other = claimCheckoutOwnerReason({ branchName: target.branch, holderPath: target.path,
          sourceWorkspace: repoPath, agents: Object.values(state.agents), ignoreIds: [source.id, successor.id] });
        if (other) refuse(other);
        for (const agent of Object.values(state.agents)) {
          if (agent.id === source.id || agent.id === successor.id || !releaseRun(agent) || agent.status === 'completed') continue;
          if (await realpath(repository(agent)) === repoPath) refuse('candidate-owner-ambiguous');
        }
        const settlement = await readReleaseCandidateSettlement(source);
        // Recheck physical generation, immutable head, forge and private review
        // bytes after the process/forge reads, before the single state commit.
        if (!equal(evidence, await inspectCandidate(source))) refuse('candidate-evidence-changed');
        if ((await getTaskById(successor.taskId))?.metadata?.resumedFromAgentId !== source.id) refuse('candidate-task-lineage-unverified');
        if (previous?.status === 'transferred') {
          if (!equal(previous.transfer, source.metadata.releaseCandidateSuccessor)) refuse('candidate-transfer-receipt-conflict');
          return { recovered: true, branch: target.branch, path: target.path,
            ...(sourceSync && { synchronization: { branch: sourceSync.branch, path: sourceSync.path } }), transfer: previous.transfer };
        }
        const transfer = { version: 1, source: run(source), successor: run(successor),
          origin: source.metadata.releaseCandidateRecovery?.transfer?.origin || run(source),
          transferredAt: new Date().toISOString(), branch: target.branch, path: target.path,
          ...evidence, settlement };
        if (!releaseCandidateTransferSchema.safeParse(transfer).success) refuse('candidate-transfer-receipt-unavailable');
        const updated = { ...successor, metadata: { ...successor.metadata,
          releaseCandidateRecovery: { version: 1, status: 'transferred', predecessorAgentId, transfer },
          ...(publication && { releasePublication: publication }),
          ...(sync && { releaseSynchronizationCheckout: { ...sync, startedAt: successor.startedAt, reservedAt: new Date().toISOString() } }) } };
        // A new, honestly timestamped seed for the current owner. The original
        // seed/receipt and private review files are never rewritten or copied.
        updated.metadata.checkoutSeeds = await captureCheckoutSeeds(updated, { allowUncreated: false });
        const candidateSeed = updated.metadata.checkoutSeeds.find(seed => seed.branch === target.branch);
        const syncSeed = sourceSync && updated.metadata.checkoutSeeds.find(seed => seed.branch === sourceSync.branch);
        if (!candidateSeed || !equal(candidateSeed.incarnation, target.incarnation)
          || (sourceSync && (!syncSeed || !equal(syncSeed.incarnation, sourceSync.incarnation)))) refuse('candidate-generation-changed');
        state.agents[source.id] = { ...source, metadata: { ...source.metadata, releaseCandidateSuccessor: transfer } };
        state.agents[successor.id] = updated;
        persisting = true;
        await save();
        const { cosEvents } = await import('./cosEvents.js');
        cosEvents.emit('agent:updated', updated);
        cosEvents.emit('agent:updated', state.agents[source.id]);
        return { recovered: true, branch: target.branch, path: target.path,
          ...(sourceSync && { synchronization: { branch: sourceSync.branch, path: sourceSync.path } }), transfer };
      });
    } catch (error) {
      if (persisting) throw error;
      if (error.code === 'CHECKOUT_RETIREMENT_RESERVED') return hold('checkout-retirement-reserved');
      return hold(error.recoveryReason || (/^candidate-[a-z-]+$/.test(error.message) ? error.message : 'candidate-evidence-unavailable'));
    }
  });
  return result.recovered ? result : { ...result, nextStep };
}
