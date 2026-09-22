/**
 * CoS Agent Completion-Order Index
 *
 * The on-disk home and in-process cache for the archive's completion-order
 * projection (`data/cos/agents/index.order.json`). The wire format, the
 * projection rule, and what "still needs feedback" means live in the pure
 * `lib/cosAgentCompletionOrder.js` so the one-shot backfill migration cannot
 * drift from the runtime.
 *
 * Why a sidecar rather than a new shape for `index.json`: an older install, a
 * rollback, and the federation import path all keep reading the legacy id→date
 * map unchanged and simply find this file absent. It is DERIVED state, so a
 * missing or unreadable file is never an error — `getCompletedAgentPage` falls
 * back to reading the day and backfills what it learns.
 *
 * The keyspace is a subset of the legacy index's: `saveAgentIndex()` prunes every
 * id the index no longer owns, so deletion, retention pruning, and the
 * clear-completed sweep need no call site of their own.
 */

import { join } from 'node:path';
import { AGENTS_DIR } from './cosState.js';
import { atomicWrite, ensureDir, safeJSONParse, tryReadFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import {
  decodeCompletionOrder,
  encodeCompletionOrder,
  sameCompletionProjection,
} from '../lib/cosAgentCompletionOrder.js';

export { COMPLETION_ORDER_VERSION, projectArchivedAgent } from '../lib/cosAgentCompletionOrder.js';

/** Relative to `data/cos/agents/`; also the path the backfill migration writes. */
export const COMPLETION_ORDER_FILENAME = 'index.order.json';

const orderFilePath = () => join(AGENTS_DIR, COMPLETION_ORDER_FILENAME);
const queueWrite = createFileWriteQueue();

let orderIndex = null;
let orderIndexPromise = null;

// Derived state: a failed write costs the next reader one day-read, never the
// caller's operation, so the error is reported here and swallowed.
function flush() {
  return queueWrite(async () => {
    if (!orderIndex) return;
    await ensureDir(AGENTS_DIR);
    await atomicWrite(orderFilePath(), encodeCompletionOrder(orderIndex));
  }).catch((err) => {
    console.error(`❌ Failed to save agent completion-order index: ${err.message}`);
  });
}

/** Lazily read the projection. Absent / corrupt / future-version all read as empty. */
export async function loadCompletionOrderIndex() {
  if (orderIndex) return orderIndex;
  if (orderIndexPromise) return orderIndexPromise;

  orderIndexPromise = (async () => {
    const content = await tryReadFile(orderFilePath());
    orderIndex = decodeCompletionOrder(safeJSONParse(content ?? 'null', null));
    return orderIndex;
  })().catch((err) => {
    orderIndexPromise = null;
    throw err;
  });

  return orderIndexPromise;
}

/**
 * Upsert projections for archived runs. Takes `[agentId, projection]` pairs so a
 * batch — an archive sweep, or a day backfilled after a federation import —
 * costs one write. Returns how many entries actually changed.
 */
export async function recordArchivedCompletions(pairs) {
  if (!pairs || pairs.length === 0) return 0;
  const index = await loadCompletionOrderIndex();
  let changed = 0;
  for (const [agentId, entry] of pairs) {
    if (typeof agentId !== 'string' || !agentId || !entry) continue;
    if (sameCompletionProjection(index.get(agentId), entry)) continue;
    index.set(agentId, entry);
    changed += 1;
  }
  if (changed > 0) await flush();
  return changed;
}

/** Clear the eligibility bit once a run has been rated. No-op for an unknown id. */
export async function markCompletionFeedbackResolved(agentId) {
  const index = await loadCompletionOrderIndex();
  const entry = index.get(agentId);
  if (!entry?.feedbackEligible) return false;
  index.set(agentId, { ...entry, feedbackEligible: false });
  await flush();
  return true;
}

/**
 * Drop every projection the legacy index no longer owns. Called from
 * `saveAgentIndex()`, which every delete / retention-prune / clear-completed
 * path already goes through.
 */
export async function pruneCompletionOrderIndex(validIds) {
  const index = await loadCompletionOrderIndex();
  let pruned = 0;
  for (const agentId of index.keys()) {
    if (validIds.has(agentId)) continue;
    index.delete(agentId);
    pruned += 1;
  }
  if (pruned > 0) await flush();
  return pruned;
}

/** Test seam for suites that swap AGENTS_DIR between cases. */
export function resetCompletionOrderIndex() {
  orderIndex = null;
  orderIndexPromise = null;
}
