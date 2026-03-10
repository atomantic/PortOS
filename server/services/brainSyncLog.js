/**
 * Brain Sync Log
 *
 * Append-only JSONL log tracking all brain mutations with monotonic sequence numbers.
 * Used for peer-to-peer brain sync protocol.
 */

import { readFile, writeFile, appendFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createMutex } from '../lib/asyncMutex.js';
import { safeJSONParse } from '../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/brain');
const SYNC_LOG_FILE = join(DATA_DIR, 'sync_log.jsonl');

const withLock = createMutex();
let currentSeq = 0;

async function ensureDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

/**
 * Load the last sequence number from the JSONL file at startup
 */
export async function initSyncLog() {
  await ensureDir();
  if (!existsSync(SYNC_LOG_FILE)) {
    currentSeq = 0;
    console.log(`🔄 Sync log initialized at seq 0`);
    return;
  }

  const content = await readFile(SYNC_LOG_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    currentSeq = 0;
    console.log(`🔄 Sync log initialized at seq 0`);
    return;
  }

  const lastEntry = safeJSONParse(lines[lines.length - 1], null);
  currentSeq = lastEntry?.seq ?? 0;
  console.log(`🔄 Sync log initialized at seq ${currentSeq} (${lines.length} entries)`);
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
    await ensureDir();
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
    await appendFile(SYNC_LOG_FILE, JSON.stringify(entry) + '\n');
    return entry;
  });
}

/**
 * Append multiple change entries in a single mutex-guarded batch (reduces lock contention)
 */
export async function appendChanges(entries) {
  if (!entries.length) return [];
  return withLock(async () => {
    await ensureDir();
    const results = [];
    const lines = [];
    for (const { op, type, id, record, originInstanceId } of entries) {
      currentSeq++;
      const entry = { seq: currentSeq, op, type, id, record, originInstanceId, ts: new Date().toISOString() };
      lines.push(JSON.stringify(entry));
      results.push(entry);
    }
    await appendFile(SYNC_LOG_FILE, lines.join('\n') + '\n');
    return results;
  });
}

/**
 * Get changes since a given sequence number
 */
// Mutex-guarded to prevent reading a partially-written file during compaction.
// Bounded by periodic compactLog() in syncOrchestrator.
export async function getChangesSince(sinceSeq, limit = 100) {
  return withLock(async () => {
    await ensureDir();
    if (!existsSync(SYNC_LOG_FILE)) {
      return { changes: [], maxSeq: currentSeq, hasMore: false };
    }

    const content = await readFile(SYNC_LOG_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const changes = [];

    for (const line of lines) {
      const entry = safeJSONParse(line, null);
      if (!entry || entry.seq <= sinceSeq) continue;
      changes.push(entry);
      if (changes.length >= limit) break;
    }

    const maxSeq = changes.length > 0 ? changes[changes.length - 1].seq : sinceSeq;
    const lastLineEntry = lines.length > 0 ? safeJSONParse(lines[lines.length - 1], null) : null;
    const hasMore = lastLineEntry ? maxSeq < lastLineEntry.seq : false;

    return { changes, maxSeq, hasMore };
  });
}

/**
 * Compact the log by dropping entries below minSeq
 */
export async function compactLog(minSeq) {
  return withLock(async () => {
    await ensureDir();
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
      kept.push(line);
    }

    const newContent = kept.length > 0 ? kept.join('\n') + '\n' : '';
    const tmp = `${SYNC_LOG_FILE}.tmp`;
    await writeFile(tmp, newContent);
    await rename(tmp, SYNC_LOG_FILE);
    console.log(`🔄 Compacted sync log: dropped ${dropped}, kept ${kept.length}`);
    return dropped;
  });
}
