/** Exact, run-scoped completion acknowledgement; never an age-based deletion. */
import { constants } from 'node:fs';
import { open, lstat, rename, link, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { doneSentinelName, doneSentinelPath, DONE_SENTINEL_NAME } from '../lib/agentSentinel.js';

const identity = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Any newer/unknown signal still occupying the canonical name keeps its
 * checkout out of teardown, even after the captured generation was consumed. */
export async function completionSentinelPresent(agentId, workspace) {
  if (!workspace || doneSentinelName(agentId) === DONE_SENTINEL_NAME) return false;
  return lstat(doneSentinelPath(workspace, agentId)).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function readCompletionSentinel(agentId, workspace) {
  if (!workspace || doneSentinelName(agentId) === DONE_SENTINEL_NAME) return null;
  const path = doneSentinelPath(workspace, agentId);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) return null;
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > 8n * 1024n * 1024n) throw new Error('completion-sentinel-unverified');
    const contents = await file.readFile();
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!same(identity(before), identity(after)) || !same(identity(before), identity(current))) throw new Error('completion-sentinel-changed');
    return { contents: contents.toString('utf8'), receipt: { version: 1, agentId, path,
      identity: identity(before), sha256: createHash('sha256').update(contents).digest('hex') } };
  } finally { await file.close(); }
}

/** The receipt was persisted with ingestion BEFORE terminal completion. A rename
 * quarantines the actual file before the final byte check, so a replacement is
 * restored/retained rather than deleted. The deterministic quarantine also lets
 * a replay finish an acknowledgement interrupted after rename.
 */
export async function acknowledgeCompletionSentinel({ agentId, workspace, receipt }) {
  if (!receipt || receipt.version !== 1 || receipt.agentId !== agentId
    || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '') || !Array.isArray(receipt.identity) || receipt.identity.length !== 5
    || receipt.path !== doneSentinelPath(workspace, agentId) || doneSentinelName(agentId) === DONE_SENTINEL_NAME) {
    throw new Error('completion-sentinel-ingestion-unverified');
  }
  const original = receipt.path;
  const held = `${original}.ack-${receipt.sha256}`;
  const readHeld = async () => {
    const file = await open(held, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!file) return null;
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.size > 8n * 1024n * 1024n) return false;
      const contents = await file.readFile();
      // Rename changes ctime; dev/inode/size/mtime still identify the captured file.
      return same(identity(stat).slice(0, 4), receipt.identity.slice(0, 4))
        && createHash('sha256').update(contents).digest('hex') === receipt.sha256;
    } finally { await file.close(); }
  };
  let matches = await readHeld();
  if (matches === null) {
    const current = await readCompletionSentinel(agentId, workspace);
    if (!current) return;
    if (!same(current.receipt, receipt)) throw new Error('completion-sentinel-generation-changed');
    await rename(original, held);
    matches = await readHeld();
  }
  if (matches !== true) {
    // Never overwrite a newer canonical marker. A failed restoration retains
    // the quarantined bytes and the failed durable stage for manual recovery.
    await link(held, original).then(() => unlink(held)).catch(() => {});
    throw new Error('completion-sentinel-generation-changed');
  }
  await unlink(held);
}
