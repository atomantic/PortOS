/**
 * Peer sync cursor store: the per-peer read positions behind `syncOrchestrator.js`, and the rewind a database restore needs.
 *
 * A leaf, so the restore path can rewind cursors without the orchestrator's
 * peer-sync graph. Sole writer of `data/instances_sync_cursors.json`.
 */
import { readJSONFile, ensureDir, PATHS, dataPath, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { isPlainObject } from '../lib/objects.js';

const CURSORS_FILE = dataPath('instances_sync_cursors.json');
const withLock = createMutex();

// The seven INDEPENDENT feed-position cursors the catalog sync envelope tracks.
// Each table is its own commit-ordered feed stream (#8315), so the receiver
// carries seven cursors (not one) — see catalogSync.js for the protocol
// rationale. A pre-#8315 cursor (a write-time sync_sequence) is below every
// feed position, so the first pull after a peer upgrades replays each stream
// once; a cursor above a downgraded peer's maximum rewinds via the reset check.
export const CATALOG_CURSOR_KINDS = ['scraps', 'ingredients', 'sources', 'refs', 'relations', 'tags', 'media'];

export async function loadCursors() {
  return await readJSONFile(CURSORS_FILE, {}, { strict: true });
}

async function saveCursors(cursors) {
  await ensureDir(PATHS.data);
  await atomicWrite(CURSORS_FILE, cursors);
}

export async function readCursors(fn) {
  return withLock(async () => {
    const cursors = await loadCursors();
    return fn(cursors);
  });
}

export async function withCursors(fn) {
  return withLock(async () => {
    const cursors = await loadCursors();
    const result = await fn(cursors);
    await saveCursors(cursors);
    return result;
  });
}

// Bumped by every rewind. A sync cycle that read its cursors under an older
// generation pulled against the pre-restore database, so its advanced
// memory/Catalog cursors must not overwrite the rewind.
let postgresCursorGeneration = 0;

export const getPostgresCursorGeneration = () => postgresCursorGeneration;

/**
 * Rewind every peer's PostgreSQL delta cursors (memory + Catalog) to the start
 * after a database restore discarded rows those cursors had already passed
 * (#8710). The next sync replays each peer's streams through the idempotent
 * LWW / ON CONFLICT apply paths. Only these two streams have no reconcile
 * to fall back on; brain cursors and snapshot checksums are left alone.
 * @returns {Promise<number>} peers rewound
 */
export async function rewindPostgresSyncCursors() {
  return withCursors((cursors) => {
    postgresCursorGeneration += 1;
    const peers = Object.values(cursors).filter(isPlainObject);
    for (const cursor of peers) {
      cursor.memorySeq = '0';
      cursor.catalogSeqs = Object.fromEntries(CATALOG_CURSOR_KINDS.map((kind) => [kind, '0']));
    }
    return peers.length;
  });
}
