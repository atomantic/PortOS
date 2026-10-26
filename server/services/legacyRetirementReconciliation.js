/** Retirement bookkeeping only: this module never removes a checkout/ref or asserts
 * an unrecorded deletion succeeded. Fresh local work always stays actionable. */
import { devNull } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { execGit } from '../lib/execGit.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { readGitCommonDirectory } from '../lib/gitRepositoryIdentity.js';
import { explicitPrCompletion, PR_COMPLETIONS } from '../lib/prDisposition.js';
import { legacyRetirementKey } from '../lib/legacyRetirementTransition.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';
import { completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';

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
    const completion = (m.branchCompletionPolicy?.branch === row.branch ? m.branchCompletionPolicy.completion : null)
      || m.prCompletionPolicy || explicitPrCompletion({ type: m.taskType, metadata: { ...m, analysisType: m.taskAnalysisType } });
    const handoff = completion && ![PR_COMPLETIONS.REVIEW_THEN_MERGE, PR_COMPLETIONS.MERGE_ON_GREEN].includes(completion);
    if (!(branches(agent).includes(row.branch) || samePath(m.workspacePath, row.path))
      || !(agent.status !== 'completed' || handoff)) continue;
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

/** Stable patch identity handles a reviewed squash without requiring its old SHAs on main. */
async function patchId(repo, from, to) {
  const patch = (await git(repo, ['diff', '--binary', '--no-ext-diff', '--no-textconv', from, to])).stdout;
  if (!patch) return null;
  return new Promise((done, reject) => {
    const child = spawn('git', ['patch-id', '--stable'], { cwd: repo, env: withSpawnCwdEnv(proofEnv(), repo), shell: false });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 4096) child.kill('SIGTERM'); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); done(code === 0 && /^[a-f0-9]{40,64} /.test(output) ? output.split(' ')[0] : null); });
    child.stdin.end(patch);
  });
}

async function absent(repoPath, row, trees, agents, identities = new Map()) {
  if (!row.branch || await protectedOwner(agents, row, repoPath, identities)
    || trees.some(tree => tree.branch === `refs/heads/${row.branch}` || samePath(tree.path, row.path))) return false;
  if (row.path && await readCheckoutPathPresence(row.path) !== false) return false;
  return await readLocalBranchPresence(repoPath, row.branch) === false;
}

function targetFor(outcome, row, repoPath, agents) {
  const knownReceipts = [...(outcome.retired || []), ...Object.values(outcome.retirementReceiptEvidence || {})];
  const receipts = knownReceipts
    .filter(receipt => receipt.branchDeleted === true && receipt.branch === row.branch && oid(receipt.head)
      && receipt.path && Number.isFinite(Date.parse(receipt.retiredAt))
      && (!row.path || samePath(row.path, receipt.path))
      && (!oid(row.head) || row.head === receipt.head || (row.checkoutIdentity && row.checkoutIdentity === receipt.checkoutIdentity
        && Number.isFinite(Date.parse(row.observedAt || row.createdAt))
        && Date.parse(receipt.retiredAt) >= Date.parse(row.observedAt || row.createdAt)))
      && (!row.checkoutIdentity || row.checkoutIdentity === receipt.checkoutIdentity));
  const unique = [...new Map(receipts.map(receipt => [JSON.stringify([receipt.path, receipt.head, receipt.checkoutIdentity]), receipt])).values()];
  if (unique.length === 1) return { target: { ...row, ...unique[0] }, receipt: unique[0] };
  if (unique.length > 1) return null;
  if (row.checkoutIdentity && knownReceipts.some(receipt => receipt.branch === row.branch
    && samePath(receipt.path, row.path) && receipt.checkoutIdentity && receipt.checkoutIdentity !== row.checkoutIdentity)) return null;
  if (oid(row.head) && row.path) return { target: row };
  const captures = agents.flatMap(agent => (agent.metadata?.completedCheckouts || [])
    .filter(capture => samePath(capture.repoPath, repoPath) && capture.branch === row.branch
      && (!row.path || samePath(row.path, capture.path)) && (!oid(row.head) || row.head === capture.head)
      && !row.checkoutIdentity && completedCheckoutReceiptValid(agent, capture)));
  return captures.length === 1 ? { target: { ...row, ...captures[0] } } : null;
}

// Bind a stale observation only to an existing service receipt: an unscoped
// placeholder needs a unique receipt, while a moved observation needs the same
// captured physical generation. Neither path infers deletion from absence.
const receiptIdentity = row => JSON.stringify([row.branch, row.path, row.head, row.checkoutIdentity, row.retiredAt, row.archiveDir ?? null]);
const staleObservation = row => ['retirement-receipt-unverified', 'retirement-provenance-unverified'].includes(row?.reason)
  && typeof row.branch === 'string' && row.branch && row.locked !== true && Number.isFinite(Date.parse(row.createdAt))
  && ((row.path == null && row.head == null && row.checkoutIdentity == null)
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
    const candidates = [...new Map(receipts.filter(row => row.branch === observation.branch && row.branchDeleted === true
      && (row.archiveDir == null || (typeof row.archiveDir === 'string' && row.archiveDir.length > 0))
      && (!observation.checkoutIdentity || observation.checkoutIdentity === row.checkoutIdentity)
      && typeof row.path === 'string' && isAbsolute(row.path) && oid(row.head) && /^[a-f0-9]{64}$/.test(row.checkoutIdentity || '')
      && Number.isFinite(Date.parse(row.retiredAt)) && Date.parse(row.retiredAt) >= observed && Date.parse(row.retiredAt) <= Date.now())
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
    if (binding.observation.head && binding.observation.head !== binding.receipt.head
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

export async function _planLegacyRetirementReconciliation({ repoPath, outcome, agents, trees, defaultHead }, options = {}) {
  const transition = outcome?.legacyRetirementTransition;
  if (transition?.version !== 1 || !Array.isArray(agents) || !Array.isArray(trees) || !oid(defaultHead)) return [];
  const rows = [...new Map([...(outcome.retirementObligations || []), ...(outcome.remaining || [])]
    .filter(row => transition.observations.includes(legacyRetirementKey(row)))
    .map(row => [legacyRetirementKey(row), row])).values()];
  const resolutions = [];
  const identities = new Map();
  let forgeReads = 0;
  for (const observation of rows) {
    const bound = targetFor(outcome, observation, repoPath, agents);
    if (!bound || !await absent(repoPath, bound.target, trees, agents, identities)) continue;
    const { target, receipt } = bound;
    let evidence = receipt ? { kind: 'existing-service-receipt', receipt } : null;
    if (!evidence && await ancestor(repoPath, target.head, defaultHead)) evidence = { kind: 'merged-ancestry', head: target.head, defaultHead };
    if (!evidence && forgeReads < 8 && options.readMergedDelivery) {
      forgeReads++;
      const forge = await options.readMergedDelivery(target).catch(() => null);
      if (forge?.prHead && forge.publishedBranch === target.branch && await ancestor(repoPath, forge.mergeCommit, defaultHead)) {
        if (await ancestor(repoPath, target.head, forge.prHead)) evidence = { kind: 'reviewed-merged-continuation', head: target.head, prHead: forge.prHead, mergeCommit: forge.mergeCommit, prUrl: forge.prUrl };
        else {
          const base = await git(repoPath, ['merge-base', target.head, `${forge.mergeCommit}^`]).then(r => r.stdout.trim(), () => null);
          if (oid(base)) {
            const [source, delivered] = await Promise.all([patchId(repoPath, base, target.head), patchId(repoPath, `${forge.mergeCommit}^`, forge.mergeCommit)]).catch(() => []);
            if (source && source === delivered) evidence = { kind: 'merged-patch-equivalence', head: target.head, mergeCommit: forge.mergeCommit, prUrl: forge.prUrl, patchId: source };
          }
        }
      }
    }
    if (evidence) resolutions.push({ key: legacyRetirementKey(observation), observation, target, evidence,
      disposition: 'legacy-bookkeeping-resolved', removalVerified: Boolean(receipt) });
  }
  return resolutions;
}

export async function reconcileLegacyRetirementRecords(appId, outcome) {
  if (outcome?.legacyRetirementTransition?.version !== 1 || !outcome.legacyRetirementTransition.observations?.length) return outcome;
  const [{ getAppById }, { readClaimOwnershipAgents, withClaimOwnershipLock }, { listWorktrees },
    { getDefaultBranch }, { findMergedPullRequest, readRetirementForgeEvidence }, store] = await Promise.all([
    import('./apps.js'), import('./cosClaimOwnership.js'), import('./worktreeManager.js'), import('./git.js'),
    import('./heldCheckoutReview.js'), import('./taskSchedule.js'),
  ]);
  const app = await getAppById(appId);
  if (!app?.repoPath) return outcome;
  const repoPath = app.repoPath;
  const [agents, trees, branch] = await Promise.all([readClaimOwnershipAgents(), listWorktrees(repoPath), getDefaultBranch(repoPath, { allowRemote: false, strict: true })]);
  const defaultHead = (await git(repoPath, ['rev-parse', `refs/remotes/origin/${branch}^{commit}`])).stdout.trim();
  const resolutions = await _planLegacyRetirementReconciliation({ repoPath, outcome, agents, trees, defaultHead }, {
    readMergedDelivery: async target => {
      const selected = await findMergedPullRequest(repoPath, target.branch, target.head, { forgeAccount: app.forgeAccount });
      const facts = await readRetirementForgeEvidence(repoPath, target.branch, selected.url, { forgeAccount: app.forgeAccount });
      return { ...facts, publishedBranch: facts.publishedBranch ?? target.branch };
    },
  });
  if (!resolutions.length) return outcome;
  return withClaimOwnershipLock(async () => {
    const [currentAgents, currentTrees] = await Promise.all([readClaimOwnershipAgents(), listWorktrees(repoPath)]);
    if (!Array.isArray(currentAgents)) return outcome;
    return store.recordLegacyRetirementResolutions(appId, outcome, resolutions,
      async () => (await Promise.all(resolutions.map(row => absent(repoPath, row.target, currentTrees, currentAgents)))).every(Boolean));
  });
}
