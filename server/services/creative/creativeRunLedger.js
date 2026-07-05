/**
 * Creative-orchestrator run ledger (#2183, CDO Phase 1).
 *
 * Every gated dispatch through `dispatchCreativeTool` appends a compact audit
 * entry — `{ tool, argsDigest, outcome, mode, costClass, timingMs, at }` — to the
 * calling project's run ledger. This is the observability trail for autonomous
 * creative work: what tool ran, against which project, whether it executed / was
 * planned (dry-run) / rejected (off or over-budget) / errored, and how long it
 * took. It intentionally stores a DIGEST of args, never the raw payload, so a
 * large prompt or image blob never bloats the ledger.
 *
 * Scope note: this is a Phase-1 stand-alone store keyed by projectId
 * (`data/creative/ledger/{projectId}.json`). Phase 2 formalizes the CD project
 * record (`projectsLogic.js#buildProjectRecord`) with its own migration +
 * schema-version gate; the dispatcher takes an injectable `ctx.appendLedger`
 * sink, so Phase 2 can route entries onto the project record without touching the
 * dispatcher. Tests inject a sink (or a `dir` override) and never hit real data.
 *
 * Storage is one small JSON array per project, capped so a long-running
 * orchestration can't grow it without bound; writes serialize on a per-project
 * tail (single-user install — this guards two writes to the SAME project file,
 * not competing actors).
 */

import { createHash } from 'crypto';
import { join } from 'path';
import { PATHS, ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { canonicalStringify } from '../../lib/objects.js';

// Keep the most recent N entries per project — matches the CD project record's
// MAX_PERSISTED_RUNS spirit (bounded audit log, newest kept).
export const MAX_LEDGER_ENTRIES = 500;

const DEFAULT_LEDGER_DIR = join(PATHS.data, 'creative', 'ledger');

// Per-project-file serialized write queue (self-pruning) so two appends to the
// same ledger can't read-modify-write-clobber each other while different
// projects still write concurrently.
const ledgerQueue = createKeyCachedQueue();

/**
 * Stable short digest of a tool's args — a sha256 hex prefix over a recursively
 * key-sorted serialization plus the sorted top-level key list, so the ledger
 * records the SHAPE and a deterministic fingerprint of the inputs (stable across
 * nested key ordering) without persisting the (possibly huge) values themselves.
 *
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

// Keep the on-disk filename to a safe slug — a projectId is normally a uuid, but
// a hand-passed value must never escape the ledger dir.
function sanitizeId(projectId) {
  return String(projectId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

/**
 * Append one ledger entry for a project. Trims to the most-recent
 * MAX_LEDGER_ENTRIES. `dir` overrides the storage root (tests point it at a
 * scratch dir). Returns the appended entry.
 *
 * @param {string} projectId
 * @param {{tool: string, outcome: string, [k: string]: unknown}} entry
 * @param {{dir?: string}} [opts]
 */
export async function appendCreativeLedgerEntry(projectId, entry, { dir } = {}) {
  const file = fileFor(projectId, dir);
  const record = { at: new Date().toISOString(), ...entry };
  await ledgerQueue(file, async () => {
    await ensureDir(dir || DEFAULT_LEDGER_DIR);
    const existing = await readJSONFile(file, [], { logError: false });
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
  const existing = await readJSONFile(fileFor(projectId, dir), [], { logError: false });
  return Array.isArray(existing) ? existing : [];
}
