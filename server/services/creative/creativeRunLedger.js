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
import { BUDGETED_COST_CLASSES } from '../../lib/creativeDirectorPresets.js';

// Bounded audit log, newest kept (cf. the CD project record's MAX_PERSISTED_RUNS).
export const MAX_LEDGER_ENTRIES = 500;

// Per-project-file serialized queue so two appends can't read-modify-write-clobber each other.
const ledgerQueue = createKeyCachedQueue();

/**
 * Resolve a Date or timestamp to a UTC calendar day key (`YYYY-MM-DD`), or null if invalid.
 *
 * @param {string|number|Date} [value]
 * @returns {string|null}
 */
export function utcDayKey(value = new Date()) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

/**
 * Count same-UTC-day executed budgeted (llm/render) ledger entries, excluding
 * self-budgeted tools (which account for their own steps) and non-executed outcomes.
 *
 * @param {Array<object>} entries
 * @param {{dayKey?: string|null, isSelfBudgeted?: (toolName: string) => boolean, resolveCostClass?: (toolName: string) => string|null}} [opts]
 * @returns {number}
 */
export function countDailyBudgetedEntries(entries, {
  dayKey = utcDayKey(),
  isSelfBudgeted,
  resolveCostClass,
} = {}) {
  if (!Array.isArray(entries) || !dayKey) return 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry || entry.outcome !== 'executed') continue;
    const costClass = entry.costClass ?? (typeof resolveCostClass === 'function' ? resolveCostClass(entry.tool) : null);
    if (!BUDGETED_COST_CLASSES.has(costClass)) continue;
    if (typeof isSelfBudgeted === 'function' && isSelfBudgeted(entry.tool)) continue;
    if (utcDayKey(entry.at) !== dayKey) continue;
    count += 1;
  }
  return count;
}

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

function resolveLedgerDir(dir) {
  return dir || join(PATHS.data, 'creative', 'ledger');
}

function fileFor(projectId, dir) {
  return join(resolveLedgerDir(dir), `${sanitizeId(projectId)}.json`);
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
  const targetDir = resolveLedgerDir(dir);
  const file = fileFor(projectId, targetDir);
  const record = { at: new Date().toISOString(), ...entry };
  await ledgerQueue(file, async () => {
    await ensureDir(targetDir);
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
