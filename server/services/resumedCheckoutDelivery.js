/** Proof for rewritten commits in one explicitly resumed physical checkout.
 * A bounded private ref retains a dropped captured root; this never releases
 * ownership, changes execution results, or authorizes retirement.
 */
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { execGit } from '../lib/execGit.js';
import { completedCheckoutReceiptValid, sameTaskRetirementBinding } from './completedCheckoutEvidence.js';
import { reviewedRetirementPolicy } from './branchCompletionPolicy.js';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));
const LIMIT = 64;

function sourceProofReader(repoPath, deadline) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: devNull };
  const git = async args => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('resumed-delivery-proof-budget');
    return (await execGit(['--no-replace-objects', '-c', 'core.commitGraph=false', ...args], repoPath,
      { env, timeout: Math.min(remaining, 2000), maxBuffer: 16384 })).stdout.trim();
  };
  return { git, env };
}

/** Retain exact small local source objects under a private, non-branch ref.
 * Callers separately prove ownership/release and the actual merged target. */
export async function retainCheckoutSourceProof({ repoPath, sourceHead: head, comparisonHead: tip,
  targetHead: target, retainMissingSource = false, allowIntegratedSource = false, maxDeltaBytes = 64 * 1024,
  deadline = performance.now() + 10000 }) {
  if (!oid(head) || !oid(tip) || !oid(target) || !Number.isInteger(maxDeltaBytes) || maxDeltaBytes < 0 || maxDeltaBytes > 64 * 1024) return null;
  const { git, env } = sourceProofReader(repoPath, deadline);
  if (await git(['cat-file', '-t', head]) !== 'commit') return null;
  const bases = (await git(['merge-base', '--all', head, tip])).split('\n');
  if (bases.length !== 1 || !oid(bases[0])) return null;
  const base = bases[0];
  await git(['merge-base', '--is-ancestor', base, target]);
  const rows = (await git(['rev-list', '--parents', `--max-count=${LIMIT + 1}`, `${base}..${head}`])).split('\n').filter(Boolean);
  if ((!rows.length && !(allowIntegratedSource && base === head)) || rows.length > LIMIT || rows.some(row => row.split(' ').length !== 2)) return null;
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return null;
  const delta = (await execGit(['--no-replace-objects', '-c', 'core.commitGraph=false', 'diff',
    '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', base, head], repoPath,
  { env, timeout: Math.min(remaining, 2000), maxBuffer: maxDeltaBytes + 1, bufferOutput: true })).stdout;
  if (!Buffer.isBuffer(delta) || delta.length > maxDeltaBytes) return null;
  // The OID in this private namespace names exact source objects, not an
  // integration claim or branch. CAS never replaces unrelated retained work.
  const retainedRef = `refs/portos/retained-checkout-source/${head}`;
  if (await git(['symbolic-ref', '--quiet', retainedRef]).then(() => true, () => false)) return null;
  const read = () => git(['for-each-ref', '--count=2', '--format=%(objectname) %(symref)', retainedRef]).catch(() => null);
  let retainedHead = await read();
  if (retainedHead && retainedHead !== head) return null;
  if (!retainedHead && !retainMissingSource) return null;
  if (!retainedHead) {
    await git(['update-ref', '--no-deref', retainedRef, head, '0'.repeat(head.length)]).catch(() => {});
    retainedHead = await read();
  }
  if (retainedHead !== head) return null;
  return { sourceHead: head, base, sourceCommits: rows.length, deltaBytes: delta.length,
    deltaSha256: createHash('sha256').update(delta).digest('hex'), targetHead: target, retainedRef, retainedHead };
}

export async function readResumedCheckoutDeliveries(input, agents, { retainMissingSource = false } = {}) {
  const { repoPath, branch, tip, prUrl, checkoutIncarnation, retirementForge: forge } = input;
  const target = forge?.targetHead ?? forge?.defaultHead;
  if (!Array.isArray(agents) || !checkoutIncarnation?.pointer || !checkoutIncarnation.gitdir
    || input.verifiedPrHead !== tip || !oid(tip) || forge?.prHead !== tip || forge.prUrl !== prUrl
    || !oid(forge.mergeCommit) || !oid(target)) return [];
  const deadline = performance.now() + 10000;
  const { git } = sourceProofReader(repoPath, deadline);
  const receipt = agent => {
    const meta = agent?.metadata;
    const policy = meta?.branchCompletionPolicy;
    if (agent?.status !== 'completed' || !agent.taskId || agent.result?.validationPassed === false
      || !samePath(meta?.sourceWorkspace, repoPath) || meta.prCompletionPolicy !== 'review-then-merge'
      || meta.reviewLoopMergeTarget?.url !== prUrl || meta.reviewLoopMergeTarget.branch !== branch
      || (policy && (policy.prUrl !== prUrl || policy.branch !== branch || policy.completion !== 'review-then-merge'))) return null;
    const rows = (Array.isArray(meta.completedCheckouts) ? meta.completedCheckouts : []).filter(row => completedCheckoutReceiptValid(agent, row)
      && samePath(row.repoPath, repoPath) && samePath(row.path, meta.workspacePath) && row.branch === branch
      && oid(row.head) && (!policy?.tip || policy.tip === row.head) && isDeepStrictEqual(row.incarnation, checkoutIncarnation));
    return rows?.length === 1 ? rows[0] : null;
  };
  // The archive can contain many unrelated executions. Bound this branch's
  // captured history, rather than refusing because other projects ran tasks.
  const scoped = agents.filter(agent => [agent?.metadata?.completedCheckouts, agent?.metadata?.checkoutSeeds]
    .some(rows => Array.isArray(rows) && rows.some(row => samePath(row?.repoPath, repoPath) && row.branch === branch)));
  if (scoped.length > 25) return [];
  const byId = new Map(scoped.map(agent => [agent.id, agent]));
  if (byId.size !== scoped.length) return [];
  const evidence = [];
  let reads = 0;
  const rewritten = async head => {
    if (++reads > 25) return false;
    const range = `${head}...${tip}`;
    // Bound the graph before asking Git to compare patches. Merge commits have
    // ambiguous per-parent patches and therefore cannot establish this proof.
    const rows = (await git(['rev-list', '--left-right', '--parents', `--max-count=${LIMIT + 1}`, range])).split('\n').filter(Boolean);
    if (!rows.length || rows.length > LIMIT || rows.some(row => row.split(' ').length !== 2)) return false;
    const older = rows.filter(row => row.startsWith('<')).map(row => row.slice(1).split(' ')[0]);
    if (!older.length || (await git(['merge-base', '--all', head, tip])).split('\n').length !== 1) return false;
    const marked = (await git(['log', '--no-ext-diff', '--no-textconv', '--no-renames', '--left-right', '--cherry-mark', '--format=%m %H', range])).split('\n');
    return older.every(commit => marked.includes(`= ${commit}`));
  };
  return (async () => {
    await git(['merge-base', '--is-ancestor', forge.mergeCommit, target]);
    for (const successor of scoped) {
      const captured = receipt(successor);
      if (!captured || captured.head !== tip || !samePath(captured.path, input.checkoutPath)
        || successor.result?.cleanupPending !== true || successor.result.taskOutcome?.recovery?.mode !== 'cleanup'
        || reviewedRetirementPolicy({ ...input, agents: [successor] }).reason) continue;
      for (const parent of scoped) {
        const binding = sameTaskRetirementBinding(parent, successor, input);
        if (!binding) continue;
        const known = binding.sourceCapture?.head || parent.metadata?.branchCompletionPolicy?.tip;
        if (known && (!oid(known) || !await git(['merge-base', '--is-ancestor', known, tip]).then(() => true, () => false))) continue;
        evidence.push({ kind: 'same-task-generation', agentId: parent.id, successorAgentId: successor.id, taskId: parent.taskId,
          capturedHead: binding.sourceCapture?.head ?? null, capturedAt: binding.sourceCapture?.capturedAt ?? null,
          sourceSeededAt: binding.sourceSeed?.seededAt ?? null, successorCapturedAt: binding.successorCapture.capturedAt,
          originalPolicyTip: parent.metadata?.branchCompletionPolicy?.tip ?? null, prUrl, tip, checkoutIncarnation });
      }
      const seen = new Set([successor.id]);
      let child = successor;
      while (child.metadata?.resumedFromAgentId) {
        const parent = byId.get(child.metadata.resumedFromAgentId);
        const row = receipt(parent);
        if (!row || seen.has(parent.id) || parent.taskId !== successor.taskId
          || !(Date.parse(parent.completedAt) <= Date.parse(child.startedAt))) break;
        seen.add(parent.id);
        if (row.head !== tip && !evidence.some(proof => proof.kind === 'same-task-generation'
          && proof.agentId === parent.id && proof.successorAgentId === successor.id)) {
          const equivalent = await rewritten(row.head);
          const binding = !equivalent && sameTaskRetirementBinding(parent, successor, input);
          const sourcePreservation = binding?.sourceCapture?.head === row.head ? await retainCheckoutSourceProof({ repoPath, sourceHead: row.head, comparisonHead: tip,
            targetHead: target, retainMissingSource, deadline }) : null;
          if (!equivalent && !sourcePreservation) break;
          evidence.push({ agentId: parent.id, successorAgentId: successor.id, taskId: parent.taskId,
            capturedHead: row.head, capturedAt: row.capturedAt, prUrl, tip, checkoutIncarnation,
            ...(sourcePreservation && { kind: 'preserved-resumed-source', sourcePreservation }) });
        }
        child = parent;
      }
    }
    return evidence;
  })().catch(() => []);
}
