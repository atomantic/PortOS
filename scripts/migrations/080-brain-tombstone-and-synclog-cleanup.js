/**
 * Migration 080 — brain tombstone backfill + sync-log cleanup.
 *
 * Fixes the federated brain-sync resurrection/amplification loop. Brain entity
 * deletes used to be HARD deletes with no tombstone, so a stale `create`
 * echoed from a peer found `existing === undefined`, skipped the last-writer-
 * wins guard, and RESURRECTED the record; the newer `delete` re-killed it; both
 * ops relayed to every peer forever. Installs that ran the looping code carry:
 *   - "ghost" records: live entries that actually have a NEWER matching delete
 *     in the sync log (the resurrected half of a ping-pong pair).
 *   - a bloated `sync_log.jsonl`: tens of thousands of churn entries, with the
 *     monotonic seq counter far above the surviving line count.
 *
 * This migration (idempotent, safe across independently-upgrading peers):
 *   1. Builds, from the sync log, the newest `delete` updatedAt per (type, id).
 *   2. For each entity store, converts any live record that has a newer matching
 *      delete into a tombstone (neutralizes ghosts in place). The new tombstone
 *      code then rejects future stale creates.
 *   3. COMPACTS the sync log to the last entry per (type, id) — WITHOUT
 *      renumbering. Max seq is preserved so peer `brainSeq` cursors stay valid
 *      (resetting to 0 would strand every peer cursor and break convergence).
 *
 * Runs in the boot-time migration runner, which fires BEFORE initSyncLog() — so
 * rewriting sync_log.jsonl here is safe (currentSeq hasn't been read yet).
 *
 * Wire format is unchanged (deletes still ship `{ updatedAt }`), so no
 * schemaVersion bump and older peers are unaffected.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// Deliberately a standalone copy of brainStorage.BRAIN_ENTITY_TYPES: migrations
// run in the boot-time runner BEFORE the service layer is wired up, so this file
// must not import from server/services. Keep in sync with that canonical list.
const ENTITY_TYPES = ['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets'];

function parseLog(content) {
  const entries = [];
  for (const line of content.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip a corrupt/half-written line rather than aborting the whole migration.
    }
  }
  return entries;
}

// Replay one (type, id)'s log entries the way applyRemoteRecord would on a
// fresh peer, and return the surviving terminal entry. The runtime processes
// entries in SEQ ORDER and accepts an incoming op only when it is STRICTLY
// newer than the currently-stored copy (the guard rejects on
// `existing.updatedAt >= record.updatedAt`, for both create/update AND delete).
// So the rule is order-dependent and the incumbent wins ties — a `create@T`
// followed by a `delete@T` leaves the record LIVE (the delete is rejected),
// and the terminal entry must be that create, not the delete. A hand-rolled
// "delete beats create on equal timestamp" tie-break gets this case wrong and
// would make the compacted log advertise a delete the runtime never applies,
// causing fresh/reset peers to tombstone a live record. Simulating the replay
// guarantees the compacted single entry produces the identical net state.
// An entry with no updatedAt is never accepted (mirrors missing_timestamp).
function replayTerminal(entries) {
  let accepted = null; // the last accepted entry (the survivor)
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const ts = e?.record?.updatedAt;
    if (ts == null) continue; // no LWW clock → rejected
    if (accepted == null || ts > accepted.record.updatedAt) accepted = e;
  }
  return accepted;
}

/**
 * Core transform, exported for unit tests. Pure over its inputs:
 *   - logEntries: array of parsed sync-log entries (in seq order).
 *   - stores: { [type]: { records: { [id]: record } } } loaded entity stores.
 * Returns { stores, compactedLines, ghostsTombstoned } with mutated stores and
 * the compacted JSONL line array (seq numbers preserved).
 */
export function computeBrainCleanup(logEntries, stores) {
  // Newest delete updatedAt per (type/id), for ghost detection.
  const newestDelete = new Map();
  for (const e of logEntries) {
    if (e?.op !== 'delete' || !e.type || !e.id || !e.record?.updatedAt) continue;
    const key = `${e.type}/${e.id}`;
    const prev = newestDelete.get(key);
    if (!prev || e.record.updatedAt > prev.updatedAt) {
      newestDelete.set(key, { updatedAt: e.record.updatedAt, originInstanceId: e.originInstanceId });
    }
  }

  // 1. Tombstone any live record that has a newer matching delete (the ghost).
  let ghostsTombstoned = 0;
  for (const type of ENTITY_TYPES) {
    const store = stores[type];
    if (!store?.records) continue;
    for (const [id, record] of Object.entries(store.records)) {
      if (record?._deleted) continue; // already a tombstone
      const del = newestDelete.get(`${type}/${id}`);
      if (del && record?.updatedAt != null && del.updatedAt > record.updatedAt) {
        store.records[id] = {
          _deleted: true,
          updatedAt: del.updatedAt,
          originInstanceId: record.originInstanceId ?? del.originInstanceId ?? 'unknown',
          // Match the runtime tombstone invariant (makeTombstone: deletedAt ===
          // updatedAt at birth) rather than this migration's own run time, so
          // two peers that run the cleanup independently produce identical
          // tombstones. (The reconcile checksum also excludes deletedAt, so this
          // is belt-and-suspenders for any code that DOES compare the field.)
          deletedAt: del.updatedAt,
        };
        ghostsTombstoned++;
      }
    }
  }

  // 2. Compact the log to the entry that SURVIVES a faithful runtime replay per
  //    (type, id) — NOT the highest-seq entry. The ping-pong appends
  //    create→delete repeatedly with FIXED updatedAt values (create's always
  //    older than delete's), each cycle getting a fresh seq. So the highest-SEQ
  //    entry for a deleted record can be a stale `create` whose updatedAt LOSES
  //    to an earlier `delete`. Keeping it would let a fresh/lagging peer pull a
  //    create with no delete to supersede it and resurrect the record. Replaying
  //    each key (see replayTerminal) makes the compacted log's net effect on any
  //    peer identical to the full log's.
  const byKey = new Map(); // key -> entries[]
  let maxSeqEntry = null; // the single highest-seq entry, type/id or not
  for (const e of logEntries) {
    if (e?.seq == null) continue;
    if (!maxSeqEntry || e.seq > maxSeqEntry.seq) maxSeqEntry = e;
    if (!e.type || !e.id) continue;
    const key = `${e.type}/${e.id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }
  const winners = new Map(); // key -> surviving terminal entry
  for (const [key, entries] of byKey) {
    const terminal = replayTerminal(entries);
    if (terminal) winners.set(key, terminal);
  }
  const kept = [...winners.values()];
  // Preserve the global max seq so peer brainSeq cursors stay valid (dropping it
  // makes our currentSeq fall below a peer's cursor and forces a full re-sync) —
  // but NEVER by re-introducing a replay-losing entry. If the max-seq entry is
  // inert (no type/id) keep it verbatim; if it belongs to a kept key, stamp that
  // key's surviving entry with the max seq instead of resurrecting the raw line.
  if (maxSeqEntry && !kept.some((e) => e.seq === maxSeqEntry.seq)) {
    if (!maxSeqEntry.type || !maxSeqEntry.id) {
      kept.push(maxSeqEntry);
    } else {
      const winner = winners.get(`${maxSeqEntry.type}/${maxSeqEntry.id}`);
      if (winner) winner.seq = maxSeqEntry.seq;
      else kept.push(maxSeqEntry);
    }
  }
  const compactedLines = kept
    .sort((a, b) => a.seq - b.seq)
    .map((e) => JSON.stringify(e));

  return { stores, compactedLines, ghostsTombstoned };
}

export async function up({ rootDir }) {
  const brainDir = join(rootDir, 'data', 'brain');
  const logPath = join(brainDir, 'sync_log.jsonl');

  if (!existsSync(logPath)) {
    console.log('🧹 brain-cleanup: no sync log present, nothing to do');
    return;
  }

  const logContent = await readFile(logPath, 'utf-8');
  const logEntries = parseLog(logContent);

  // Load the entity stores that exist on disk.
  const stores = {};
  for (const type of ENTITY_TYPES) {
    const file = join(brainDir, `${type}.json`);
    if (!existsSync(file)) continue;
    const raw = await readFile(file, 'utf-8').catch(() => null);
    if (raw == null) continue;
    try {
      const parsed = JSON.parse(raw);
      // Preserve any other top-level keys the store may carry — only normalize
      // the `records` map. (Brain stores hold only `records` today, but dropping
      // unknown keys would be a latent data-loss path if the shape ever grows.)
      stores[type] = parsed && typeof parsed === 'object'
        ? { ...parsed, records: parsed.records ?? {} }
        : { records: {} };
    } catch {
      // Skip an unparseable store rather than abort — the migration is idempotent.
    }
  }

  const { compactedLines, ghostsTombstoned } = computeBrainCleanup(logEntries, stores);

  // Persist tombstoned stores (only those we loaded; only when changed is fine
  // to skip — rewriting an unchanged store is harmless and keeps the code simple).
  for (const type of ENTITY_TYPES) {
    if (!stores[type]) continue;
    await writeFile(join(brainDir, `${type}.json`), JSON.stringify(stores[type], null, 2));
  }

  // Rewrite the compacted log. Preserve trailing newline convention.
  const newContent = compactedLines.length > 0 ? compactedLines.join('\n') + '\n' : '';
  await writeFile(logPath, newContent);

  console.log(
    `🧹 brain-cleanup: tombstoned ${ghostsTombstoned} ghost record(s), compacted sync log ${logEntries.length} → ${compactedLines.length} entries`
  );
}

export default { up };
