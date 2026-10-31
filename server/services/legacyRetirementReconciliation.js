/** Retirement bookkeeping only: this module never removes a checkout/ref or asserts
 * an unrecorded deletion succeeded. Fresh local work always stays actionable. */
import { isAbsolute, resolve } from 'node:path';
import { devNull } from 'node:os';
import { execGit } from '../lib/execGit.js';
import { readGitCommonDirectory } from '../lib/gitRepositoryIdentity.js';
import { explicitPrCompletion, PR_COMPLETIONS } from '../lib/prDisposition.js';
import { legacyRetirementKey } from '../lib/legacyRetirementTransition.js';
import { retirementArchiveRecorded } from '../lib/reconcileRetirementEvidence.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const branches = agent => {
  const m = agent.metadata || {};
  return [m.worktreeBranch, m.claimBranch, m.jiraBranch, m.branchCompletionPolicy?.branch,
    ...(m.claimBranches || []), ...(m.claimReleasedBranches || [])];
};
async function protectedOwner(agents, row, repoPath, identities) {
  const identity = path => {
    if (!identities.has(path)) identities.set(path, readGitCommonDirectory(path));
    return identities.get(path);
  };
  for (const agent of agents) {
    const m = agent.metadata || {};
    // Missing branch names are not an ownership match. Match the concrete
    // branch/path before consulting that owner's optional completion policy.
    if (!((typeof row.branch === 'string' && row.branch && branches(agent).includes(row.branch))
      || samePath(m.workspacePath, row.path))) continue;
    const completion = (row.branch && m.branchCompletionPolicy?.branch === row.branch ? m.branchCompletionPolicy.completion : null)
      || m.prCompletionPolicy || explicitPrCompletion({ type: m.taskType, metadata: { ...m, analysisType: m.taskAnalysisType } });
    const handoff = completion && ![PR_COMPLETIONS.REVIEW_THEN_MERGE, PR_COMPLETIONS.MERGE_ON_GREEN].includes(completion);
    if (!(agent.status !== 'completed' || handoff)) continue;
    const source = m.sourceWorkspace || m.primaryCheckoutBaseline?.path;
    if (source && !samePath(source, repoPath)) {
      const [local, owner] = await Promise.all([identity(repoPath), identity(source)]);
      if (local && owner && local !== owner) continue;
    }
    return true;
  }
  return false;
}
const proofEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull });
const git = (repo, args) => execGit(['--no-replace-objects', '-c', 'core.commitGraph=false', ...args], repo,
  { env: proofEnv(), timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
const ancestor = (repo, a, b) => oid(a) && oid(b)
  ? git(repo, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false) : false;

async function absent(repoPath, row, trees, agents, identities = new Map()) {
  if ((!row.branch && !row.path) || await protectedOwner(agents, row, repoPath, identities)
    || trees.some(tree => tree.branch === `refs/heads/${row.branch}` || samePath(tree.path, row.path))) return false;
  if (row.path && await readCheckoutPathPresence(row.path) !== false) return false;
  return !row.branch || await readLocalBranchPresence(repoPath, row.branch) === false;
}

// Bind a stale observation only to an existing service receipt: an unscoped
// placeholder needs a unique receipt, while a moved observation needs the same
// captured physical generation. Neither path infers deletion from absence.
const receiptIdentity = row => JSON.stringify([row.branch, row.path, row.head, row.checkoutIdentity, row.retiredAt, row.archiveDir ?? null]);
// Failed rev-parse historically echoed the missing branch into head. This
// producer artifact identifies neither a commit nor a checkout generation.
const echoedRefPlaceholder = row => typeof row?.branch === 'string' && row.head === row.branch
  && typeof row.path === 'string' && isAbsolute(row.path) && row.checkoutIdentity == null;
const finalizedRefPlaceholder = (observation, receipt, observed) => observation.path == null && observation.head == null
  && observation.checkoutIdentity == null && ['deleted', 'observed-absent'].includes(receipt.branchFinalization?.kind)
  && Number.isFinite(Date.parse(receipt.branchFinalizedAt))
  && Date.parse(receipt.branchFinalizedAt) >= Date.parse(receipt.retiredAt)
  && Date.parse(receipt.branchFinalizedAt) >= observed
  && Date.parse(receipt.branchFinalizedAt) <= Date.now();
const staleObservation = row => ['retirement-receipt-unverified', 'retirement-provenance-unverified'].includes(row?.reason)
  && typeof row.branch === 'string' && row.branch && row.locked !== true && Number.isFinite(Date.parse(row.createdAt))
  && ((row.path == null && row.head == null && row.checkoutIdentity == null)
    || echoedRefPlaceholder(row)
    || (typeof row.path === 'string' && isAbsolute(row.path) && oid(row.head) && /^[a-f0-9]{64}$/.test(row.checkoutIdentity || '')));

/** Metadata repair only. Complete receipts and their original timestamps remain
 * immutable; optional receipt-local observations retain what was reconciled. */
export async function reconcileRecordedReceiptObservations(appId, outcome) {
  const rows = [...new Map([...(outcome?.retirementObligations || []), ...(outcome?.remaining || [])]
    .filter(staleObservation).map(row => [legacyRetirementKey(row), row])).values()];
  if (!rows.length) return outcome;
  const receipts = [...(outcome.retired || []), ...Object.values(outcome.retirementReceiptEvidence || {})];
  const bindings = rows.flatMap(observation => {
    const observed = Math.max(Date.parse(observation.createdAt), Date.parse(observation.observedAt || observation.createdAt));
    const echoed = echoedRefPlaceholder(observation);
    const candidates = [...new Map(receipts.filter(row => row.branch === observation.branch && row.branchDeleted === true
      && retirementArchiveRecorded(row)
      && (!observation.checkoutIdentity || observation.checkoutIdentity === row.checkoutIdentity)
      && typeof row.path === 'string' && isAbsolute(row.path) && oid(row.head) && /^[a-f0-9]{64}$/.test(row.checkoutIdentity || '')
      && (!echoed || samePath(observation.path, row.path))
      && Number.isFinite(Date.parse(row.retiredAt))
      // A branch and path can be reused. An echoed ref carries no generation,
      // so a receipt predating that observation cannot prove they are the same.
      && (finalizedRefPlaceholder(observation, row, observed) || Date.parse(row.retiredAt) >= observed) && Date.parse(row.retiredAt) <= Date.now())
      .map(row => [receiptIdentity(row), row])).values()];
    if (candidates.length !== 1) return [];
    const receipt = candidates[0];
    if ((receipt.settledObservations || []).length >= 1000
      && !receipt.settledObservations.some(row => legacyRetirementKey(row.observation) === legacyRetirementKey(observation))) return [];
    return [{ observation, receipt }];
  });
  if (!bindings.length) return outcome;
  const [{ getAppById }, { readClaimOwnershipAgents }, { listWorktrees }] = await Promise.all([
    import('./apps.js'), import('./cosClaimOwnership.js'), import('./worktreeManager.js'),
  ]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return outcome;
  const [agents, trees] = await Promise.all([readClaimOwnershipAgents(), listWorktrees(app.repoPath)]);
  if (!Array.isArray(agents) || !Array.isArray(trees)) return outcome;
  const accepted = [];
  const auditAdditions = new Map();
  const identities = new Map();
  for (const binding of bindings) {
    if (!await absent(app.repoPath, binding.receipt, trees, agents, identities)
      || !await absent(app.repoPath, binding.observation, trees, agents, identities)) continue;
    if (!echoedRefPlaceholder(binding.observation) && binding.observation.head && binding.observation.head !== binding.receipt.head
      && !await ancestor(app.repoPath, binding.observation.head, binding.receipt.head)) continue;
    const key = receiptIdentity(binding.receipt);
    const history = binding.receipt.settledObservations || [];
    const addsAudit = !history.some(row => legacyRetirementKey(row.observation) === legacyRetirementKey(binding.observation));
    if (addsAudit && history.length + (auditAdditions.get(key) || 0) >= 1000) continue;
    accepted.push(binding);
    if (addsAudit) auditAdditions.set(key, (auditAdditions.get(key) || 0) + 1);
  }
  if (!accepted.length) return outcome;
  const settledAt = new Date().toISOString();
  const keys = new Set(accepted.map(row => legacyRetirementKey(row.observation)));
  const annotate = receipt => {
    const matches = accepted.filter(row => receiptIdentity(row.receipt) === receiptIdentity(receipt));
    if (!matches.length) return receipt;
    const settledObservations = [...(receipt.settledObservations || [])];
    for (const { observation } of matches) if (!settledObservations.some(row => legacyRetirementKey(row.observation) === legacyRetirementKey(observation))) {
      settledObservations.push({ observation, settledAt });
    }
    return { ...receipt, settledObservations };
  };
  return { ...outcome, updatedAt: settledAt,
    remaining: outcome.remaining?.filter(row => !keys.has(legacyRetirementKey(row))),
    retirementObligations: outcome.retirementObligations?.filter(row => !keys.has(legacyRetirementKey(row))),
    retired: outcome.retired?.map(annotate),
    retirementReceiptEvidence: Object.fromEntries(Object.entries(outcome.retirementReceiptEvidence || {}).map(([key, receipt]) => [key, annotate(receipt)])) };
}

const UNVERIFIED_REASONS = ['retirement-receipt-unverified', 'retirement-provenance-unverified'];
// Refs PortOS itself writes to keep a checkout's commits reachable after the checkout is gone.
const PRESERVING_REF_NAMESPACES = ['refs/portos/retained-checkout-source', 'refs/portos/completed'];

function reconciliationCandidates(outcome) {
  const transition = outcome?.legacyRetirementTransition;
  if (transition?.version !== 1) return [];
  return [...new Map([...(outcome.retirementObligations || []), ...(outcome.remaining || [])]
    .filter(row => UNVERIFIED_REASONS.includes(row.reason))
    .map(row => [legacyRetirementKey(row), row])).values()];
}

async function defaultBranchRefs(repoPath) {
  const head = await git(repoPath, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then(r => r.stdout.trim(), () => '');
  return [head || 'refs/remotes/origin/main', 'refs/heads/main'];
}

/** The head is reachable from the default branch or a PortOS-written retained ref. */
async function headPreserved(repoPath, head) {
  if (!oid(head)) return false;
  const refs = [...await defaultBranchRefs(repoPath), ...PRESERVING_REF_NAMESPACES];
  const found = await git(repoPath, ['for-each-ref', '--count=1', '--format=%(refname)', '--contains', head, ...refs])
    .then(r => r.stdout.trim(), () => '');
  return found.length > 0;
}

const remoteBranchPresent = (repoPath, branch) => git(repoPath, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${branch}`])
  .then(r => r.stdout.trim().length > 0, () => true);

/** Absence of checkout, local ref and remote ref plus a preserved head settles the row
 * even when the vanished checkout was locked: a lock on nothing blocks nothing. */
async function absentHeadPreserved(repoPath, observation, outcome, trees, agents, identities) {
  if (!UNVERIFIED_REASONS.includes(observation.reason) || !oid(observation.head)
    || !await localCleanupAbsent(repoPath, observation, outcome, trees, agents, identities, true)
    || (observation.branch && await remoteBranchPresent(repoPath, observation.branch))) return false;
  return headPreserved(repoPath, observation.head);
}

async function localCleanupAbsent(repoPath, observation, outcome, trees, agents, identities = new Map(), allowLocked = false) {
  if ((observation.locked === true && !allowLocked) || !await absent(repoPath, observation, trees, agents, identities)) return false;
  // A branch-only placeholder can still refer to a surviving recorded path.
  const recordedPaths = [...(outcome.retired || []), ...Object.values(outcome.retirementReceiptEvidence || {})]
    .filter(row => row.branch === observation.branch && typeof row.path === 'string');
  return (await Promise.all(recordedPaths.map(row => readCheckoutPathPresence(row.path)))).every(value => value === false);
}

export async function _planLegacyRetirementReconciliation({ repoPath, outcome, agents, trees }) {
  if (!Array.isArray(agents) || !Array.isArray(trees)) return [];
  const resolutions = [];
  const identities = new Map();
  const transition = outcome?.legacyRetirementTransition;
  for (const observation of reconciliationCandidates(outcome)) {
    // This settles local cleanup only; retained history makes no delivery or
    // preservation claim and requires no second remote merge certificate.
    // Absence alone settles only frozen upgrade-era rows; any other unverified row needs a preserved head.
    const legacy = transition.observations.includes(legacyRetirementKey(observation))
      || observation.reason === 'retirement-provenance-unverified';
    if (!legacy || !await localCleanupAbsent(repoPath, observation, outcome, trees, agents, identities)) {
      if (await absentHeadPreserved(repoPath, observation, outcome, trees, agents, identities)) {
        resolutions.push({ key: legacyRetirementKey(observation), observation, target: observation,
          evidence: { kind: 'absent-head-preserved', deliveryVerified: false, preservationVerified: true },
          disposition: 'absent-head-preserved', removalVerified: false });
      }
      continue;
    }
    resolutions.push({ key: legacyRetirementKey(observation), observation,
      target: observation, evidence: { kind: 'current-local-absence', deliveryVerified: false, preservationVerified: false },
      disposition: 'local-cleanup-not-required', removalVerified: false });
  }
  return resolutions;
}

export async function reconcileLegacyRetirementRecords(appId, outcome) {
  if (!reconciliationCandidates(outcome).length) return outcome;
  const [{ getAppById }, { readClaimOwnershipAgents, withClaimOwnershipLock }, { listWorktrees },
    store] = await Promise.all([
    import('./apps.js'), import('./cosClaimOwnership.js'), import('./worktreeManager.js'), import('./branchReconcileOutcome.js'),
  ]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return outcome;
  const repoPath = app.repoPath;
  const [agents, trees] = await Promise.all([readClaimOwnershipAgents(), listWorktrees(repoPath)]);
  const resolutions = await _planLegacyRetirementReconciliation({ repoPath, outcome, agents, trees });
  if (!resolutions.length) return outcome;
  return withClaimOwnershipLock(async () => {
    const [currentAgents, currentTrees] = await Promise.all([readClaimOwnershipAgents(), listWorktrees(repoPath)]);
    if (!Array.isArray(currentAgents)) return outcome;
    return store.recordLegacyRetirementResolutions(appId, outcome, resolutions,
      async () => (await Promise.all(resolutions.map(row => row.disposition === 'absent-head-preserved'
        ? absentHeadPreserved(repoPath, row.target, outcome, currentTrees, currentAgents, new Map())
        : localCleanupAbsent(repoPath, row.target, outcome, currentTrees, currentAgents)))).every(Boolean));
  });
}
