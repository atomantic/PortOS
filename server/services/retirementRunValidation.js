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
      matches.push({ id: agent.id, startedAt: agent.startedAt });
    }
  }
  const owners = [...new Map(matches.map(owner => [JSON.stringify(owner), owner])).values()];
  if (owners.length !== 1) return null; // Keep unbound diagnostics in their original checkout.
  const encodedBytes = files.reduce((sum, file) => sum + 4 * Math.ceil(file.bytes / 3), 0);
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes + Buffer.byteLength(JSON.stringify(files)) + 4096 > MAX_COMPLETION_DATA_BYTES) fail();
  return { owner: owners[0], files };
}

/** The caller supplies its no-follow, stable-identity bounded source reader.
 * Durable byte verification completes before any checkout removal is allowed. */
export async function retainRunValidationArtifacts(review, readSource, { store = storeCompletionData, read = readCompletionData } = {}) {
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
    prHead: review.forge.prHead, mergeCommit: review.forge.mergeCommit, files };
  const reference = await store(captured.owner, 'retirement-evidence', value);
  const verify = async () => {
    if (JSON.stringify(await read(captured.owner, reference)) !== JSON.stringify(value)) fail();
  };
  await verify();
  return { files, evidence: { owner: captured.owner, reference }, verify };
}
