/** Large replay inputs stay in the private run directory, never hot agent JSON. */
import { constants } from 'node:fs';
import { mkdir, lstat, open, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../lib/fileCore.js';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';

const MAX_BYTES = 64 * 1024 * 1024;
const kinds = new Set(['replay', 'sentinel']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lease = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const validRun = agent => /^[A-Za-z0-9_-]+$/.test(agent?.id || '') && Number.isFinite(Date.parse(agent.startedAt));
async function directory(agent) {
  if (!validRun(agent)) throw new Error('completion-data-run-unverified');
  const { getAgentDir } = await import('./cosAgentIndex.js');
  return join(getAgentDir(agent.id), 'completion');
}

export async function storeCompletionData(agent, kind, value) {
  if (!validRun(agent)) throw new Error('completion-data-run-unverified');
  if (!kinds.has(kind)) throw new Error('completion-data-kind-invalid');
  const bytes = Buffer.from(JSON.stringify({ version: 1, agentId: agent.id, startedAt: agent.startedAt, kind, value }));
  if (bytes.length > MAX_BYTES) throw new Error('completion-data-too-large');
  const dir = await directory(agent);
  assertNotRealDataWrite(dir, 'completion replay data');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('completion-data-directory-unverified');
  await chmod(dir, 0o700);
  const reference = { version: 1, kind, bytes: bytes.length, sha256: hash(bytes) };
  const path = join(dir, `${kind}-${reference.sha256}.json`);
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) await readCompletionData(agent, reference);
  else {
    // The enclosing private directory protects bytes while atomicWrite fsyncs
    // and publishes them; its usual new-file mode is narrowed afterward too.
    await atomicWrite(path, bytes);
    await chmod(path, 0o600);
    await readCompletionData(agent, reference);
  }
  return reference;
}

export async function readCompletionData(agent, reference) {
  if (reference?.version !== 1 || !kinds.has(reference.kind) || !/^[a-f0-9]{64}$/.test(reference.sha256 || '')
    || !Number.isInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > MAX_BYTES) throw new Error('completion-data-reference-invalid');
  const path = join(await directory(agent), `${reference.kind}-${reference.sha256}.json`);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(reference.bytes)) throw new Error('completion-data-size-changed');
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (lease(before) !== lease(after) || lease(before) !== lease(current) || hash(bytes) !== reference.sha256) throw new Error('completion-data-changed');
    const parsed = JSON.parse(bytes);
    if (parsed.version !== 1 || parsed.agentId !== agent.id || parsed.startedAt !== agent.startedAt || parsed.kind !== reference.kind) throw new Error('completion-data-run-changed');
    return parsed.value;
  } finally { await file.close(); }
}

/** Preserve arbitrary pipeline/reviewer metadata in the run artifact, but omit
 * unrelated task-level prompt/output/history fields from the replay input. */
export const completionReplayInput = ({ task, effectiveSuccess, prOwnership, prClaimVerified, branchProvenEmpty, outputBuffer }) => ({
  task: { id: task?.id, taskType: task?.taskType, description: task?.description, priority: task?.priority, metadata: task?.metadata },
  effectiveSuccess, prOwnership, prClaimVerified, branchProvenEmpty, outputBuffer,
});
