/**
 * Creative-orchestrator run ledger (#2183, CDO Phase 1).
 *
 * Every gated dispatch through `dispatchCreativeTool` appends a compact audit entry
 * (`{ tool, argsDigest, outcome, mode, costClass, timingMs, at }`) to the project's ledger. It stores a
 * DIGEST of args, never the raw payload, so large prompts or blobs don't bloat it.
 *
 * Stand-alone store keyed by projectId (`data/creative/ledger/{projectId}.json`); the dispatcher takes an
 * injectable `ctx.appendLedger` sink so Phase 2 can route entries onto the CD project record. Tests inject a
 * sink or a `dir` override. One capped JSON array per project; writes serialize per project file.
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { PATHS, ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { canonicalStringify } from '../../lib/objects.js';

// Bounded audit log, newest kept (cf. the CD project record's MAX_PERSISTED_RUNS).
export const MAX_LEDGER_ENTRIES = 500;

const DEFAULT_LEDGER_DIR = join(PATHS.data, 'creative', 'ledger');

// Per-project-file serialized queue so two appends can't read-modify-write-clobber each other.
const ledgerQueue = createKeyCachedQueue();

/**
 * Stable short digest of a tool's args: a sha256 hex prefix over a recursively key-sorted serialization plus
 * the sorted top-level keys, recording the SHAPE and a fingerprint without persisting the values.
 * @param {unknown} args
 * @returns {string}
 */
export function argsDigest(args) {
  if (args == null || typeof args !== 'object') return 'none';
  const keys = Object.keys(args).sort();
  const hash = createHash('sha256').update(canonicalStringify(args) ?? '').digest('hex').slice(0, 12);
  return keys.length ? `${keys.join(',')}#${hash}` : `#${hash}`;
}

function fileFor(projectId, dir) {
  return join(dir || DEFAULT_LEDGER_DIR, `${sanitizeId(projectId)}.json`);
}

// A projectId is normally a uuid, but a hand-passed value must never escape the ledger dir.
function sanitizeId(projectId) {
  return String(projectId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

/**
 * Append one ledger entry, trimmed to the most-recent MAX_LEDGER_ENTRIES. `dir` overrides the storage root (tests).
 * @param {string} projectId
 * @param {{tool: string, outcome: string, [k: string]: unknown}} entry
 * @param {{dir?: string}} [opts]
 */
export async function appendCreativeLedgerEntry(projectId, entry, { dir } = {}) {
  const file = fileFor(projectId, dir);
  const record = { at: new Date().toISOString(), ...entry };
  await ledgerQueue(file, async () => {
    await ensureDir(dir || DEFAULT_LEDGER_DIR);
    const existing = await readJSONFile(file, [], { logError: false, strict: true });
    const list = Array.isArray(existing) ? existing : [];
    list.push(record);
    const trimmed = list.length > MAX_LEDGER_ENTRIES ? list.slice(-MAX_LEDGER_ENTRIES) : list;
    await atomicWrite(file, trimmed);
  });
  return record;
}

/**
 * Read a project's run ledger (chronological). Empty array when absent.
 *
 * @param {string} projectId
 * @param {{dir?: string}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function readCreativeLedger(projectId, { dir } = {}) {
  const existing = await readJSONFile(fileFor(projectId, dir), [], { logError: false, strict: true });
  return Array.isArray(existing) ? existing : [];
}
