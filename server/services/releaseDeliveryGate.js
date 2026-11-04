/** A managed release must not finish after promotion without recording its
 * publication. Legacy receipts and unmanaged projects keep their own paths. */
import { realpath } from 'node:fs/promises';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { isHistoricalReleaseReceipt } from '../lib/releasePublication.js';
import { captureSeededCompletionCheckouts, hasReleaseCandidateBinding, releaseCandidateBranch } from './completedCheckoutEvidence.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { execGh } from './github.js';

const hold = reason => ({ verified: false, reason });

export async function verifyReleaseDelivery(agent, outcome) {
  const metadata = agent?.metadata;
  const publication = metadata?.releasePublication;
  if (publication?.synchronizationHandoffVersion === 2) {
    const { verifyInlineReleaseDelivery } = await import('./releaseSynchronization.js');
    return verifyInlineReleaseDelivery(agent);
  }
  // V1 and earlier receipts retain the historical continuation contract. A
  // project that does not use the candidate API is also outside this gate.
  if (isHistoricalReleaseReceipt(publication)) return null;
  if (publication && (hasReleaseCandidateBinding(metadata) || (metadata?.taskAnalysisType === 'do-release'
    && metadata.taskApp === PORTOS_APP_ID && metadata.releaseCandidateLifecycle?.version === 1))) {
    return hold('The release publication receipt is invalid or unsupported.');
  }
  if (publication) return null;
  if (!hasReleaseCandidateBinding(metadata)) {
    // New PortOS runs have a server-owned lifecycle from registration. Its
    // registered stage does not prove Git never created an unbound candidate.
    if (metadata?.taskAnalysisType === 'do-release' && metadata.taskApp === PORTOS_APP_ID
      && metadata.releaseCandidateLifecycle?.version === 1) return hold('The PortOS release candidate was not captured.');
    return null;
  }
  if (outcome?.status !== 'no-action-needed') return hold('The release candidate has no verified publication receipt.');
  try {
    const branch = releaseCandidateBranch(metadata);
    const seeds = (metadata.checkoutSeeds || []).filter(seed => seed.branch === branch
      && seed.agentId === agent.id && seed.startedAt === agent.startedAt);
    const rows = await captureSeededCompletionCheckouts(agent, { preterminal: true });
    const candidates = rows?.filter(row => row.branch === branch) || [];
    if (seeds.length !== 1 || candidates.length !== 1 || rows.length !== metadata.checkoutSeeds.length) {
      return hold('The no-release candidate checkout is unverified.');
    }
    const checkout = candidates[0];
    const source = agent.sourceWorkspace || metadata.sourceWorkspace || agent.workspacePath || metadata.workspacePath;
    if (!source || await realpath(source) !== checkout.repoPath) return hold('The no-release repository is unverified.');
    const origin = await getOriginInfo(checkout.repoPath);
    if (!origin.isGithub || origin.host !== 'github.com' || !origin.fullName) return hold('The no-release forge is unverified.');
    const forge = await resolveForgeExecOptions(checkout.repoPath);
    const owner = origin.fullName.split('/')[0];
    const path = `repos/${origin.fullName}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=release&per_page=100`;
    const prs = JSON.parse(await execGh(['api', '--hostname', origin.host, path], undefined, forge));
    // A prior PR, including a closed one, needs reconciliation; a full page is
    // ambiguous and cannot prove the absence of another promotion.
    if (!Array.isArray(prs) || prs.length >= 100) return hold('The no-release promotion history is unverified.');
    if (prs.length) return hold('The release candidate has a promotion PR but no verified publication receipt.');
    return { verified: true };
  } catch {
    return hold('The no-release candidate or promotion history is unavailable.');
  }
}
