/** Keep completed-run validation outputs in the existing private run store.
 * These bytes are retained, never classified as disposable cache. */
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { retirementCheckoutIdentityFromPointer } from '../lib/retirementCheckoutObservation.js';
import { completedCheckoutReceiptValid } from './completedCheckoutEvidence.js';
import { MAX_COMPLETION_DATA_BYTES, readCompletionData, storeCompletionData } from './agentCompletionData.js';

const fail = () => { throw new Error('retirement-validation-preservation-unavailable'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifact = path => /^\.cache\/[^/]+\.(?:log|md|json)$/.test(path)
  || /^\.cache\/test-process-diagnostics\/[0-9a-f-]{36}\.json$/.test(path)
  // Compiled validation output is preserved as opaque bytes, never executed
  // or accepted as disposable merely because its filename resembles a cache.
  || /^scripts\/__pycache__\/[A-Za-z0-9_]+\.cpython-\d+(?:\.opt-\d+)?\.pyc$/.test(path)
  || /^\.cache\/animatic-artifact-check\/animatic-capture\/case-\d+\/(?:frame\.json|displayed\.png|saved\.png)$/.test(path);

/** Source hashes already belong to the complete reviewed content fingerprint.
 * Require a real completed run's captured physical generation before attaching
 * its diagnostics. A path, branch or merged PR alone is not run provenance. */
export async function captureRunValidationArtifacts(repoPath, release, content, { readPolicies } = {}) {
  const files = content.files.filter(file => !file.disposableCache && artifact(file.path))
    .map(({ path, bytes, sha256 }) => ({ scope: 'content', path, bytes, sha256 }));
  if (!files.length) return null;
  const policies = await (readPolicies || (async () => {
    const { readBranchCompletionPolicies } = await import('./branchCompletionPolicy.js');
    return readBranchCompletionPolicies({ repairIndex: false });
  }))();
  const repository = await realpath(repoPath);
  const checkout = await realpath(release.path);
  const matches = [];
  for (const agent of policies) {
    if (agent.status !== 'completed') continue;
    for (const row of agent.metadata?.completedCheckouts || []) {
      if (!completedCheckoutReceiptValid(agent, row) || row.head !== release.head || row.branch !== release.branch
        || retirementCheckoutIdentityFromPointer(row.incarnation?.pointer) !== release.checkoutIdentity) continue;
      if (await realpath(row.repoPath).catch(() => null) !== repository || await realpath(row.path).catch(() => null) !== checkout) continue;
      matches.push({ id: agent.id, startedAt: agent.startedAt, completedAt: agent.completedAt,
        parentId: agent.metadata?.resumedFromAgentId ?? null, instanceId: agent.metadata?.instanceId ?? null });
    }
  }
  const owners = [...new Map(matches.map(owner => [JSON.stringify(owner), owner])).values()];
  // Terminal agents outside CoS have no captured run identity. Preserve their
  // bounded validation bytes against the reviewed checkout instead of inventing
  // a run owner. Each existing private proof remains below its own byte limit.
  if (!owners.length) {
    const claimedGeneration = policies.some(agent => agent.metadata?.completedCheckouts?.some(row =>
      row.head === release.head && row.branch === release.branch));
    const encodedBytes = files.reduce((sum, file) => sum + 4 * Math.ceil(file.bytes / 3), 0);
    return !claimedGeneration && files.every(file => Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 64 * 1024)
      && encodedBytes + Buffer.byteLength(JSON.stringify(files)) + 4096 <= MAX_COMPLETION_DATA_BYTES
      ? { scope: 'checkout', files } : null;
  }
  let lineage;
  let selected = owners[0];
  if (owners.length > 1) {
    // A resumed execution can capture the same physical checkout and head as
    // its predecessor. Only one complete, nonoverlapping continuation chain
    // can select the terminal run; unrelated/forked ownership stays held.
    const byId = new Map(owners.map(owner => [owner.id, owner]));
    if (byId.size !== owners.length) return null;
    const parents = new Set(owners.map(owner => owner.parentId).filter(id => byId.has(id)));
    const leaves = owners.filter(owner => !parents.has(owner.id));
    if (leaves.length !== 1) return null;
    selected = leaves[0];
    const seen = new Set();
    lineage = [];
    for (let current = selected; current; current = byId.get(current.parentId)) {
      if (seen.has(current.id)) return null;
      seen.add(current.id);
      lineage.push(current);
      const parent = byId.get(current.parentId);
      if (parent && (typeof current.instanceId !== 'string' || !current.instanceId || current.instanceId !== parent.instanceId
        || Date.parse(current.startedAt) < Date.parse(parent.completedAt))) return null;
    }
    if (lineage.length !== owners.length) return null;
    lineage.reverse();
  }
  const encodedBytes = files.reduce((sum, file) => sum + 4 * Math.ceil(file.bytes / 3), 0);
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes + Buffer.byteLength(JSON.stringify({ files, lineage })) + 4096 > MAX_COMPLETION_DATA_BYTES) fail();
  return { owner: { id: selected.id, startedAt: selected.startedAt }, files, ...(lineage && { lineage }) };
}

/** The caller supplies its no-follow, stable-identity bounded source reader.
 * Durable byte verification completes before any checkout removal is allowed. */
export async function retainRunValidationArtifacts(review, readSource, { store = storeCompletionData, read = readCompletionData, retainCheckoutProof } = {}) {
  const captured = review.validationArtifacts;
  if (!captured) return null;
  if (review.kind || review.comparison.disposition !== 'integrated' || review.release.head !== review.forge.prHead) fail();
  const files = [];
  for (const file of captured.files) {
    const bytes = await readSource(file);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail();
    files.push({ scope: file.scope, path: file.path, sha256: file.sha256, data: bytes.toString('base64') });
  }
  const value = { version: 1, release: review.release, prUrl: review.forge.prUrl,
    prHead: review.forge.prHead, mergeCommit: review.forge.mergeCommit, files, ...(captured.lineage && { lineage: captured.lineage }) };
  if (captured.scope === 'checkout') {
    if (!retainCheckoutProof || captured.owner || files.some(file => Buffer.from(file.data, 'base64').length > 64 * 1024)) fail();
    const proofs = files.map(file => ({ version: 1, release: value.release, prUrl: value.prUrl,
      prHead: value.prHead, mergeCommit: value.mergeCommit, file }));
    const references = [];
    for (const proof of proofs) references.push(await retainCheckoutProof(proof));
    const verify = async () => {
      for (const proof of proofs) await retainCheckoutProof(proof, true);
    };
    await verify();
    return { files, evidence: { scope: 'checkout', references }, verify };
  }
  const reference = await store(captured.owner, 'retirement-evidence', value);
  const verify = async () => {
    if (JSON.stringify(await read(captured.owner, reference)) !== JSON.stringify(value)) fail();
  };
  await verify();
  return { files, evidence: { owner: captured.owner, reference }, verify };
}
