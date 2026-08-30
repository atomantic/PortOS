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
  indexLoaded = true;
  if (!existsSync(SYNC_LOG_FILE)) return;

  for await (const { text, offset } of streamLines(SYNC_LOG_FILE)) {
    const entry = safeJSONParse(text, null);
    if (typeof entry?.seq !== 'number') continue;
    offsets.push({ seq: entry.seq, offset });
    currentSeq = entry.seq;
  }
  // Real byte size, not the offset past the last complete line: an unterminated
  // tail still occupies bytes, so the next append lands after it.
  fileSize = (await stat(SYNC_LOG_FILE)).size;
}

async function ensureIndex() {
  if (!indexLoaded) await loadIndex();
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
    const line = JSON.stringify(entry) + '\n';
    await appendFile(SYNC_LOG_FILE, line);
    // Index after the write so a failed append can't skew every later offset.
    offsets.push({ seq: entry.seq, offset: fileSize });
    fileSize += Buffer.byteLength(line, 'utf8');
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
      lines.push(JSON.stringify(entry));
      results.push(entry);
    }
    // Reserve sequence numbers before write to avoid reuse on partial failure
    // (matches appendChange semantics where currentSeq advances pre-write)
    currentSeq = nextSeq;
    await appendFile(SYNC_LOG_FILE, lines.join('\n') + '\n');
    for (const [i, line] of lines.entries()) {
      offsets.push({ seq: results[i].seq, offset: fileSize });
      fileSize += Buffer.byteLength(line, 'utf8') + 1;
    }
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
      if (!entry || entry.seq <= sinceSeq) continue;
      changes.push(entry);
      if (changes.length >= limit) break;
    }

    const maxSeq = changes.length > 0 ? changes[changes.length - 1].seq : sinceSeq;
    const hasMore = lastIndexedSeq !== null ? maxSeq < lastIndexedSeq : false;

    return { changes, maxSeq, hasMore };
  });
}

/**
 * Compact the log by dropping entries below minSeq
 */
export async function compactLog(minSeq) {
  return withLock(async () => {
    await ensureBrainDir();
    // Load first: the rebuild below marks the index loaded, so skipping this
    // would strand currentSeq at 0 on an install that compacted before booting.
    await ensureIndex();
    if (!existsSync(SYNC_LOG_FILE)) return 0;

    const content = await readFile(SYNC_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const kept = [];
    let dropped = 0;

    for (const line of lines) {
      const entry = safeJSONParse(line, null);
      if (!entry || entry.seq < minSeq) {
        dropped++;
        continue;
      }
      kept.push({ line, seq: entry.seq });
    }

    const newContent = kept.length > 0 ? kept.map(k => k.line).join('\n') + '\n' : '';
    await atomicWrite(SYNC_LOG_FILE, newContent);

    // Rebuild the index from what we just wrote — the offsets all moved.
    offsets = [];
    let offset = 0;
    for (const { line, seq } of kept) {
      offsets.push({ seq, offset });
      offset += Buffer.byteLength(line, 'utf8') + 1;
    }
    fileSize = offset;
    indexLoaded = true;

    console.log(`🔄 Compacted sync log: dropped ${dropped}, kept ${kept.length}`);
    return dropped;
  });
}
