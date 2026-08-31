/**
 * Brain Sync Log
 *
 * Append-only JSONL log tracking all brain mutations with monotonic sequence numbers.
 * Used for peer-to-peer brain sync protocol.
 *
 * A `seq → byte offset` index is kept in module state so a peer pull reads only
 * the window it asked for. Without it, every `GET /api/brain/sync?since=N` read
 * and JSON-parsed the whole file — under the same mutex that guards every brain
 * write — so one lagging peer stalled local writes once per sync cycle (#5441).
 */

import { readFile, appendFile, stat } from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { join } from 'path';
import { createMutex } from '../lib/asyncMutex.js';
import { ensureDir, safeJSONParse, PATHS, atomicWrite } from '../lib/fileUtils.js';

const DATA_DIR = PATHS.brain;
const SYNC_LOG_FILE = join(DATA_DIR, 'sync_log.jsonl');

const NEWLINE = 0x0a;

const withLock = createMutex();
let currentSeq = 0;
// Ascending `{ seq, offset }` for every indexed entry. `offset` is the byte
// position of that entry's line within SYNC_LOG_FILE.
let offsets = [];
// Byte length of the file as this module last observed it — the offset the next
// appended line will land at.
let fileSize = 0;
// The file ends mid-line (a crash during a previous append). The next append
// must terminate that fragment first, or it would swallow the new entry.
let pendingNewline = false;
let indexLoaded = false;

async function ensureBrainDir() {
  await ensureDir(DATA_DIR);
}

/**
 * Yield every newline-terminated line of `path` starting at byte `start`, with
 * the byte offset and byte length of each. Operates on raw buffers so multi-byte
 * UTF-8 split across chunk boundaries can't corrupt the offset arithmetic, and
 * so the offsets are real file positions rather than character counts.
 *
 * A trailing line with no newline (a crash mid-append) is not yielded — it is
 * not a complete entry.
 */
async function* streamLines(path, start = 0) {
  const stream = createReadStream(path, { start });
  let pending = null;
  let offset = start;
  for await (const chunk of stream) {
    pending = pending ? Buffer.concat([pending, chunk]) : chunk;
    let nl = pending.indexOf(NEWLINE);
    while (nl !== -1) {
      const byteLength = nl + 1;
      yield { text: pending.subarray(0, nl).toString('utf8'), offset, byteLength };
      offset += byteLength;
      pending = pending.subarray(byteLength);
      nl = pending.indexOf(NEWLINE);
    }
  }
}

/**
 * Rebuild `offsets` / `fileSize` / `currentSeq` by streaming the log once.
 * Streaming rather than `readFile` keeps boot off a 2-3x file-size string.
 */
async function loadIndex() {
  offsets = [];
  fileSize = 0;
  currentSeq = 0;
  pendingNewline = false;
  indexLoaded = true;
  if (!existsSync(SYNC_LOG_FILE)) return;

  let terminatedBytes = 0;
  for await (const { text, offset, byteLength } of streamLines(SYNC_LOG_FILE)) {
    terminatedBytes = offset + byteLength;
    const entry = safeJSONParse(text, null);
    if (typeof entry?.seq !== 'number') continue;
    offsets.push({ seq: entry.seq, offset });
    currentSeq = entry.seq;
  }
  // Real byte size, not the offset past the last complete line: an unterminated
  // tail still occupies bytes, so the next append lands after it.
  fileSize = (await stat(SYNC_LOG_FILE)).size;
  pendingNewline = fileSize > terminatedBytes;
}

async function ensureIndex() {
  if (!indexLoaded) await loadIndex();
}

/**
 * Write `lines` to the log and index them at the offsets they landed on.
 *
 * A crash fragment left by a previous append is terminated first, so the new
 * entries stay on lines of their own — otherwise the fragment would swallow the
 * first one and a later boot would re-mint its seq for a different record.
 *
 * On a failed (possibly partial) write the index is marked stale rather than
 * advanced: `fileSize` can no longer be trusted, so the next call rescans.
 */
async function writeIndexedLines(lines) {
  const payload = (pendingNewline ? '\n' : '') + lines.map(({ text }) => text).join('\n') + '\n';
  await appendFile(SYNC_LOG_FILE, payload).catch((err) => {
    indexLoaded = false;
    throw err;
  });
  if (pendingNewline) {
    fileSize += 1;
    pendingNewline = false;
  }
  for (const { seq, text } of lines) {
    offsets.push({ seq, offset: fileSize });
    fileSize += Buffer.byteLength(text, 'utf8') + 1;
  }
}

/**
 * Index of the first entry with `seq > sinceSeq`, or -1 when none qualifies.
 * `offsets` is ascending by construction (seq is monotonic and append-only).
 */
function firstIndexAfter(sinceSeq) {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid].seq > sinceSeq) hi = mid;
    else lo = mid + 1;
  }
  return lo < offsets.length ? lo : -1;
}

/**
 * Load the last sequence number from the JSONL file at startup
 */
export async function initSyncLog() {
  await ensureBrainDir();
  indexLoaded = false;
  await loadIndex();
  console.log(`🔄 Sync log initialized at seq ${currentSeq} (${offsets.length} entries)`);
}

/**
 * Get the current sequence number
 */
export function getCurrentSeq() {
  return currentSeq;
}

/**
 * Append a change entry to the sync log (mutex-guarded)
 */
export async function appendChange(op, type, id, record, originInstanceId) {
  return withLock(async () => {
    await ensureBrainDir();
    await ensureIndex();
    currentSeq++;
    const entry = {
      seq: currentSeq,
      op,
      type,
      id,
      record,
      originInstanceId,
      ts: new Date().toISOString()
    };
    await writeIndexedLines([{ seq: entry.seq, text: JSON.stringify(entry) }]);
    return entry;
  });
}

/**
 * Append multiple change entries in a single mutex-guarded batch (reduces lock contention)
 */
export async function appendChanges(entries) {
  if (!entries?.length) return [];
  return withLock(async () => {
    await ensureBrainDir();
    await ensureIndex();
    const startSeq = currentSeq;
    const results = [];
    const lines = [];
    let nextSeq = startSeq;
    for (const { op, type, id, record, originInstanceId } of entries) {
      nextSeq++;
      const entry = { seq: nextSeq, op, type, id, record, originInstanceId, ts: new Date().toISOString() };
      lines.push({ seq: nextSeq, text: JSON.stringify(entry) });
      results.push(entry);
    }
    // Reserve sequence numbers before write to avoid reuse on partial failure
    // (matches appendChange semantics where currentSeq advances pre-write)
    currentSeq = nextSeq;
    await writeIndexedLines(lines);
    return results;
  });
}

/**
 * Get changes since a given sequence number
 */
// Mutex-guarded so a concurrent compactLog() can't move offsets under the read.
// Bounded by periodic compactLog() in syncOrchestrator.
export async function getChangesSince(sinceSeq, limit = 100) {
  return withLock(async () => {
    await ensureBrainDir();
    await ensureIndex();
    if (!existsSync(SYNC_LOG_FILE)) {
      return { changes: [], maxSeq: currentSeq, hasMore: false };
    }

    const start = firstIndexAfter(sinceSeq);
    const lastIndexedSeq = offsets.length > 0 ? offsets[offsets.length - 1].seq : null;
    if (start === -1) {
      return { changes: [], maxSeq: sinceSeq, hasMore: false };
    }

    const changes = [];
    for await (const { text } of streamLines(SYNC_LOG_FILE, offsets[start].offset)) {
      const entry = safeJSONParse(text, null);
      // A line without a numeric seq is unsequenceable — shipping it would set
      // the peer's cursor to undefined on the next maxSeq.
      if (typeof entry?.seq !== 'number' || entry.seq <= sinceSeq) continue;
      changes.push(entry);
      if (changes.length >= limit) break;
    }

    const maxSeq = changes.length > 0 ? changes[changes.length - 1].seq : sinceSeq;
    const hasMore = lastIndexedSeq !== null ? maxSeq < lastIndexedSeq : false;

    return { changes, maxSeq, hasMore };
  });
}

/**
 * Replay entries for a single (type, id) according to runtime LWW rules,
 * returning the surviving terminal entry.
 *
 * Incumbent wins ties (same timestamp) matching applyRemoteRecord.
 * Entries missing updatedAt are skipped.
 */
function replayTerminal(entries) {
  let accepted = null;
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    const ts = e?.record?.updatedAt;
    if (ts == null) continue;
    if (accepted == null || ts > accepted.record.updatedAt) accepted = e;
  }
  return accepted;
}

/**
 * Compact the sync log using a compatibility-preserving compaction representation.
 *
 * Deltas at or above `minSeq` (unconsumed by at least one active peer) are
 * preserved verbatim in sequence order.
 *
 * For history below `minSeq` (or all entries when minSeq is 0, e.g. on installs
 * with no brain-sync peers), redundant intermediate updates are pruned by
 * retaining only the surviving terminal LWW entry per (type, id).
 *
 * The durable sequence counter (maxSeq) is always determined from disk state
 * under the log mutex, preventing index skew after a failed append, and is
 * preserved so initSyncLog recovers the monotonic sequence counter across
 * restarts.
 */
export async function compactLog(minSeq = 0) {
  return withLock(async () => {
    await ensureBrainDir();
    // Load first: the rebuild below marks the index loaded, so skipping this
    // would strand currentSeq at 0 on an install that compacted before booting.
    await ensureIndex();
    if (!existsSync(SYNC_LOG_FILE)) return 0;

    const content = await readFile(SYNC_LOG_FILE, 'utf-8');
    const rawLines = content.trim().split('\n').filter(l => l.trim());
    if (rawLines.length === 0) return 0;

    const parsedLines = [];
    let maxDurableSeq = 0;
    let maxSeqEntry = null;

    for (const rawLine of rawLines) {
      const entry = safeJSONParse(rawLine, null);
      if (entry && typeof entry.seq === 'number') {
        if (entry.seq > maxDurableSeq) {
          maxDurableSeq = entry.seq;
          maxSeqEntry = entry;
        }
        parsedLines.push({ rawLine, entry, seq: entry.seq });
      } else {
        // Line without numeric seq (e.g. malformed or unindexed note)
        parsedLines.push({ rawLine, entry: null, seq: null });
      }
    }

    const floor = typeof minSeq === 'number' && Number.isFinite(minSeq)
      ? Math.max(0, Math.min(minSeq, maxDurableSeq))
      : 0;

    const preservedTail = [];
    const tailEntriesByKey = new Map();
    const olderEntriesByKey = new Map();
    const unindexedOrUntypedOlder = [];

    for (const item of parsedLines) {
      const { entry, seq } = item;
      if (seq !== null && floor > 0 && seq >= floor) {
        preservedTail.push(item);
        if (entry?.type && entry?.id) {
          const key = `${entry.type}/${entry.id}`;
          if (!tailEntriesByKey.has(key)) tailEntriesByKey.set(key, []);
          tailEntriesByKey.get(key).push(item);
        }
      } else if (entry?.type && entry?.id) {
        const key = `${entry.type}/${entry.id}`;
        if (!olderEntriesByKey.has(key)) olderEntriesByKey.set(key, []);
        olderEntriesByKey.get(key).push(item);
      } else {
        if (floor === 0 || seq === null) {
          unindexedOrUntypedOlder.push(item);
        }
      }
    }

    // Replay terminal winning state for older keys
    const keptOlder = [];
    const olderWinnersByKey = new Map();
    for (const [key, items] of olderEntriesByKey) {
      const entries = items.map(i => i.entry);
      const olderWinner = replayTerminal(entries);
      if (!olderWinner) continue;

      // If this key also appears in the preserved tail, check whether any tail
      // operation strictly supersedes the pre-floor LWW winner (updatedAt > olderWinner.updatedAt).
      // If the tail carries ONLY stale/losing operations (e.g. olderWinner is a Jan-02 delete
      // and tail has an echoed Jan-01 create), we MUST retain olderWinner before the verbatim
      // tail so fresh / delta-only peers do not accept the stale create and resurrect the record.
      const tailItems = tailEntriesByKey.get(key);
      if (tailItems) {
        const supersededByTail = tailItems.some(i => {
          const tailTs = i.entry?.record?.updatedAt;
          return tailTs != null && olderWinner.record?.updatedAt != null && tailTs > olderWinner.record.updatedAt;
        });
        if (supersededByTail) {
          continue;
        }
      }

      const matchingItem = items.find(i => i.entry === olderWinner)
        || { rawLine: JSON.stringify(olderWinner), entry: olderWinner, seq: olderWinner.seq };
      keptOlder.push(matchingItem);
      olderWinnersByKey.set(key, matchingItem);
    }

    const kept = [...unindexedOrUntypedOlder, ...keptOlder, ...preservedTail];

    // Ensure the durable max sequence is preserved so restart recovery and cursors hold
    if (maxSeqEntry && !kept.some(i => i.seq === maxSeqEntry.seq)) {
      if (!maxSeqEntry.type || !maxSeqEntry.id) {
        kept.push({ rawLine: JSON.stringify(maxSeqEntry), entry: maxSeqEntry, seq: maxSeqEntry.seq });
      } else {
        const key = `${maxSeqEntry.type}/${maxSeqEntry.id}`;
        const winner = olderWinnersByKey.get(key);
        if (winner && winner.entry) {
          winner.entry.seq = maxSeqEntry.seq;
          winner.seq = maxSeqEntry.seq;
          winner.rawLine = JSON.stringify(winner.entry);
        } else {
          kept.push({ rawLine: JSON.stringify(maxSeqEntry), entry: maxSeqEntry, seq: maxSeqEntry.seq });
        }
      }
    }

    // Sort kept entries: items with numeric seq sorted by seq
    kept.sort((a, b) => {
      if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
      return 0;
    });

    const dropped = rawLines.length - kept.length;
    if (dropped <= 0) return 0;

    const newContent = kept.map(i => i.rawLine).join('\n') + '\n';
    await atomicWrite(SYNC_LOG_FILE, newContent);

    // Rebuild index offsets from what was written
    offsets = [];
    let offset = 0;
    for (const { rawLine, seq } of kept) {
      if (typeof seq === 'number') {
        offsets.push({ seq, offset });
      }
      offset += Buffer.byteLength(rawLine, 'utf8') + 1;
    }
    fileSize = offset;
    currentSeq = maxDurableSeq;
    pendingNewline = false;
    indexLoaded = true;

    console.log(`🔄 Compacted sync log: dropped ${dropped}, kept ${kept.length}`);
    return dropped;
  });
}
