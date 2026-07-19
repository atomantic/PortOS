/**
 * Brain → CoS Memory Bridge
 *
 * Mirrors brain records (projects, ideas, admin, memories/journal, digests, reviews, people)
 * into the CoS memory system so agents can semantically search user-captured thoughts.
 *
 * Brain JSON files remain the operational data store for the brain UI.
 * This bridge creates/updates corresponding entries in the memories table
 * tagged with sourceAppId='brain'.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { brainEvents } from './brainStorage.js';
import * as brainStorage from './brainStorage.js';
import * as memory from './memoryBackend.js';
import * as embeddings from './memoryEmbeddings.js';
import { atomicWrite, ensureDir, PATHS } from '../lib/fileUtils.js';
import { listJournals, getJournal } from './brainJournal.js';

const BRIDGE_MAP_PATH = join(PATHS.brain, 'memory-bridge-map.json');

// brainType → { memoryType, category }
const TYPE_MAP = {
  people:   { type: 'context',     category: 'people' },
  projects: { type: 'fact',        category: 'project' },
  ideas:    { type: 'observation', category: 'ideas' },
  admin:    { type: 'fact',        category: 'admin' },
  memories: { type: 'observation', category: 'personal' },
  digests:  { type: 'context',     category: 'digest' },
  reviews:  { type: 'context',     category: 'review' },
  journals: { type: 'observation', category: 'daily-log' }
};

// ─── Bridge Map ─────────────────────────────────────────────────────────────
// Maps "brainType:brainId" → memoryId so updates hit the same memory entry

let bridgeMap = null;

export async function loadBridgeMap() {
  if (bridgeMap) return bridgeMap;
  if (!existsSync(BRIDGE_MAP_PATH)) {
    bridgeMap = {};
    return bridgeMap;
  }
  const raw = await readFile(BRIDGE_MAP_PATH, 'utf-8');
  try {
    bridgeMap = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Corrupt bridge map, resetting: ${err.message}`);
    bridgeMap = {};
  }
  return bridgeMap;
}

async function saveBridgeMap() {
  const dir = dirname(BRIDGE_MAP_PATH);
  if (!existsSync(dir)) await ensureDir(dir);
  await atomicWrite(BRIDGE_MAP_PATH, bridgeMap);
}

export function bridgeKey(brainType, brainId) {
  return `${brainType}:${brainId}`;
}

// ─── Content Composers ─────────────────────────────────────────────────────
// Each brain type has different fields; compose a single content string for memory storage.

function composePeopleContent(r) {
  const parts = [`Person: ${r.name}`];
  if (r.context) parts.push(r.context);
  if (r.followUps?.length) parts.push(`Follow-ups: ${r.followUps.join('; ')}`);
  return parts.join('\n');
}

function composeProjectContent(r) {
  const parts = [`Project: ${r.name}`, `Status: ${r.status}`];
  if (r.nextAction) parts.push(`Next action: ${r.nextAction}`);
  if (r.notes) parts.push(r.notes);
  return parts.join('\n');
}

function composeIdeaContent(r) {
  const parts = [`Idea: ${r.title}`];
  if (r.oneLiner) parts.push(r.oneLiner);
  if (r.notes) parts.push(r.notes);
  return parts.join('\n');
}

function composeAdminContent(r) {
  const parts = [`Admin: ${r.title}`, `Status: ${r.status}`];
  if (r.dueDate) parts.push(`Due: ${r.dueDate}`);
  if (r.nextAction) parts.push(`Next action: ${r.nextAction}`);
  if (r.notes) parts.push(r.notes);
  return parts.join('\n');
}

function composeJournalContent(r) {
  const parts = [];
  if (r.title) parts.push(r.title);
  if (r.content) parts.push(r.content);
  if (r.mood) parts.push(`Mood: ${r.mood}`);
  return parts.join('\n');
}

function composeDigestContent(r) {
  const parts = [];
  if (r.digestText) parts.push(r.digestText);
  if (r.topActions?.length) parts.push(`Top actions: ${r.topActions.join('; ')}`);
  if (r.stuckThing) parts.push(`Stuck on: ${r.stuckThing}`);
  if (r.smallWin) parts.push(`Small win: ${r.smallWin}`);
  return parts.join('\n');
}

function composeReviewContent(r) {
  const parts = [];
  if (r.reviewText) parts.push(r.reviewText);
  if (r.whatHappened?.length) parts.push(`What happened: ${r.whatHappened.join('; ')}`);
  if (r.biggestOpenLoops?.length) parts.push(`Open loops: ${r.biggestOpenLoops.join('; ')}`);
  if (r.suggestedActionsNextWeek?.length) parts.push(`Suggested actions: ${r.suggestedActionsNextWeek.join('; ')}`);
  if (r.recurringTheme) parts.push(`Recurring theme: ${r.recurringTheme}`);
  return parts.join('\n');
}

function composeDailyLogContent(r) {
  const parts = [`Daily Log — ${r.date}`];
  if (r.content) parts.push(r.content);
  return parts.join('\n');
}

export const CONTENT_COMPOSERS = {
  people: composePeopleContent,
  projects: composeProjectContent,
  ideas: composeIdeaContent,
  admin: composeAdminContent,
  memories: composeJournalContent,
  digests: composeDigestContent,
  reviews: composeReviewContent,
  journals: composeDailyLogContent
};

// ─── Core Mapping ───────────────────────────────────────────────────────────

/**
 * Convert a brain record into a memory-create payload.
 */
export function brainRecordToMemory(brainType, record) {
  const mapping = TYPE_MAP[brainType];
  if (!mapping) return null;

  const composer = CONTENT_COMPOSERS[brainType];
  const content = composer(record);
  if (!content?.trim()) return null;

  const summary = content.length > 200 ? content.substring(0, 197) + '...' : content;
  const recordTags = record.tags || [];
  const tags = [...new Set([...recordTags, 'brain', brainType])];

  return {
    type: mapping.type,
    content,
    summary,
    category: mapping.category,
    tags,
    confidence: 1.0,
    importance: 0.6,
    sourceAppId: 'brain',
    sourceAgentId: 'brain-bridge'
  };
}

// ─── Sync ───────────────────────────────────────────────────────────────────

/**
 * Upsert a single brain record into the memory system.
 * Creates a new memory or updates the existing one based on the bridge map.
 */
export async function syncBrainRecord(brainType, record) {
  const memoryData = brainRecordToMemory(brainType, record);
  if (!memoryData) return null;

  const map = await loadBridgeMap();
  const key = bridgeKey(brainType, record.id);
  const existingMemoryId = map[key];

  // Generate embedding. Pass the source hints (NOT persisted on memoryData —
  // the memory schema has no such columns) so the embedder can summarize the
  // FULL archived transcript for an over-budget chatgpt-import record rather
  // than the already-capped content preview.
  const embedding = await embeddings
    .generateMemoryEmbedding(memoryData, { source: record.source, sourceRef: record.sourceRef })
    .catch(() => null);

  if (existingMemoryId) {
    // Update existing memory. Force status:'active' so a record that was
    // archived for a synced-in delete/archive and later came back live
    // (un-deleted on a peer, or un-archived) is searchable again — memory
    // search filters out archived rows, so without this the resurrected
    // record would stay invisible (issue #1080 review finding).
    const updated = await memory.updateMemory(existingMemoryId, { ...memoryData, status: 'active' });
    if (updated && embedding) {
      await memory.updateMemoryEmbedding(existingMemoryId, embedding);
    }
    console.log(`🧠🔗 Updated brain→memory: ${brainType}/${record.id} → ${existingMemoryId}`);
    return existingMemoryId;
  }

  // Create new memory
  const created = await memory.createMemory(memoryData, embedding);
  map[key] = created.id;
  await saveBridgeMap();
  console.log(`🧠🔗 Created brain→memory: ${brainType}/${record.id} → ${created.id}`);
  return created.id;
}

/**
 * Bulk sync all existing brain data into the memory system.
 * Used for initial migration and catch-up.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]  Report what would sync without writing.
 * @param {boolean} [opts.refresh=false] Re-embed records that ALREADY have a
 *   bridge-map entry instead of skipping them. This is the recovery path for
 *   records that diverged before the per-record sync:applied signal existed
 *   (issue #1080): a peer's edit/delete of an already-mapped record used to
 *   leave the local memory copy stale and searchable forever, and a normal
 *   bulk sync skipped it precisely because it was mapped. `refresh` forces a
 *   re-embed of every live record so a one-time catch-up heals the staleness.
 *   In refresh mode a reconcile pass also archives memory entries whose brain
 *   record was deleted/archived on a peer before this fix (orphaned map keys
 *   the live-record walks can't reach) — reported as `archived`.
 * @returns {Promise<{synced:number, skipped:number, errors:number, archived:number}>}
 */
// True when a record is already embedded: mapped AND its memory has a vector.
// Shared by the onlyMissing sync path and the read-only coverage tally.
const makeEmbeddedChecker = (map, missingMemIds) => (key) => {
  const memId = map[key];
  return !!memId && !missingMemIds.has(memId);
};

export async function syncAllBrainData({ dryRun = false, refresh = false, onlyMissing = false } = {}) {
  const map = await loadBridgeMap();
  const stats = { synced: 0, skipped: 0, errors: 0, archived: 0 };

  // `onlyMissing` is the cheap, targeted backfill: embed only records that lack
  // an embedding (unmapped, or mapped to a memory whose vector is NULL because
  // generation failed) and skip everything already embedded. Unlike `refresh`
  // it never re-embeds healthy records, so it's safe to run without a warning.
  const missingMemIds = onlyMissing
    ? await memory.getMemoryIdsMissingEmbedding().catch(() => new Set())
    : null;
  const isEmbedded = makeEmbeddedChecker(map, missingMemIds);

  // Entity stores (JSON-based)
  const entityTypes = ['people', 'projects', 'ideas', 'admin', 'memories'];
  for (const type of entityTypes) {
    const records = await brainStorage.getAll(type);
    for (const record of records) {
      // Skip archived records
      if (record.archived) {
        stats.skipped++;
        continue;
      }
      const key = bridgeKey(type, record.id);
      if (onlyMissing) {
        if (isEmbedded(key)) { stats.skipped++; continue; }
      } else if (map[key] && !dryRun && !refresh) {
        stats.skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`🧠🔗 [dry-run] Would sync ${type}/${record.id}: ${record.name || record.title || '(untitled)'}`);
        stats.synced++;
        continue;
      }
      const memoryId = await syncBrainRecord(type, record).catch(err => {
        console.error(`❌ Failed to sync ${type}/${record.id}: ${err.message}`);
        stats.errors++;
        return null;
      });
      if (memoryId) stats.synced++;
    }
  }

  // Daily log entries — one memory per day. Without `refresh`, already-mapped
  // days are skipped (initial/backfill import only) and content updates /
  // deletions flow through the 'journals:upserted' / 'journals:deleted' and
  // 'sync:applied' event handlers instead (see initBridge). With `refresh`,
  // already-mapped days are re-embedded to heal pre-#1080 staleness.
  {
    const { records: journals } = await listJournals({ limit: 10000, includeContent: true });
    for (const record of journals) {
      const key = bridgeKey('journals', record.id);
      // Already-mapped days are skipped in both real and dry-run modes so
      // dry-run stats match actual-run stats (rather than claiming to
      // re-sync every day every time) — unless refresh is forcing a re-embed.
      if (onlyMissing) {
        if (isEmbedded(key)) { stats.skipped += 1; continue; }
      } else if (map[key] && !refresh) {
        stats.skipped += 1;
        continue;
      }
      if (dryRun) {
        console.log(`🧠🔗 [dry-run] Would sync journals/${record.date}`);
        stats.synced += 1;
        continue;
      }
      const memoryId = await syncBrainRecord('journals', record).catch((err) => {
        console.error(`❌ Failed to sync journals/${record.date}: ${err.message}`);
        stats.errors += 1;
        return null;
      });
      if (memoryId) stats.synced += 1;
    }
  }

  // JSONL stores (digests, reviews)
  const jsonlTypes = ['digests', 'reviews'];
  for (const type of jsonlTypes) {
    const getter = type === 'digests' ? brainStorage.getDigests : brainStorage.getReviews;
    const records = await getter(1000); // get all
    for (const record of records) {
      const key = bridgeKey(type, record.id);
      if (onlyMissing) {
        if (isEmbedded(key)) { stats.skipped++; continue; }
      } else if (map[key] && !dryRun && !refresh) {
        stats.skipped++;
        continue;
      }
      if (dryRun) {
        console.log(`🧠🔗 [dry-run] Would sync ${type}/${record.id}`);
        stats.synced++;
        continue;
      }
      const memoryId = await syncBrainRecord(type, record).catch(err => {
        console.error(`❌ Failed to sync ${type}/${record.id}: ${err.message}`);
        stats.errors++;
        return null;
      });
      if (memoryId) stats.synced++;
    }
  }

  // Refresh-mode reconcile (issue #1080 recovery): the live-record walks above
  // re-embed edited records, but they iterate ONLY live records — getAll /
  // listJournals strip tombstones and archived entities are skipped — so a
  // record DELETED or ARCHIVED on a peer BEFORE this fix shipped leaves an
  // orphaned bridge-map entry whose memory copy stays active and searchable.
  // The going-forward sync:applied path archives those, but it can't reach the
  // pre-fix backlog. Walk the bridge map and archive any mapped entry whose
  // canonical record no longer resolves as live. Only for deletable, bridge-
  // mirrored stores: digests/reviews are append-only (never deleted) and
  // links/buckets/inbox aren't mirrored, so neither can orphan a memory entry.
  if (refresh && !dryRun) {
    const reconcilableTypes = new Set(['people', 'projects', 'ideas', 'admin', 'memories', 'journals']);
    for (const mapKey of Object.keys(map)) {
      const sep = mapKey.indexOf(':');
      if (sep === -1) continue;
      const type = mapKey.slice(0, sep);
      const id = mapKey.slice(sep + 1);
      if (!reconcilableTypes.has(type)) continue;
      const record = type === 'journals'
        ? await getJournal(id)
        : await brainStorage.getById(type, id);
      if (record && !record.archived) continue; // still live — already re-embedded above
      const archived = await archiveMappedMemory(type, id).catch(err => {
        console.error(`❌ Failed to archive stale ${type}/${id}: ${err.message}`);
        stats.errors++;
        return false;
      });
      if (archived) stats.archived++;
    }
  }

  return stats;
}

/**
 * Count how many active brain records lack an embedding — the headline number
 * for the "N memories missing embeddings · Embed missing" affordance on the
 * graph. A record is "missing" when it's unmapped OR its mapped memory has a
 * NULL embedding — scoped to ACTIVE memories, since getMemoryIdsMissingEmbedding
 * only reports active rows (an archived/non-active mapped memory is treated as
 * embedded and is not a backfill target). Read-only; walks the same stores as
 * the onlyMissing sync so the count matches what "Embed missing" would process.
 */
export async function getEmbeddingCoverage() {
  const map = await loadBridgeMap();
  const missingMemIds = await memory.getMemoryIdsMissingEmbedding().catch(() => new Set());
  const isEmbedded = makeEmbeddedChecker(map, missingMemIds);

  let total = 0;
  let missing = 0;
  const tally = (key) => { total += 1; if (!isEmbedded(key)) missing += 1; };

  for (const type of ['people', 'projects', 'ideas', 'admin', 'memories']) {
    const records = await brainStorage.getAll(type);
    for (const record of records) {
      if (record.archived) continue;
      tally(bridgeKey(type, record.id));
    }
  }

  const { records: journals } = await listJournals({ limit: 10000, includeContent: false });
  for (const record of journals) tally(bridgeKey('journals', record.id));

  for (const [type, getter] of [['digests', brainStorage.getDigests], ['reviews', brainStorage.getReviews]]) {
    const records = await getter(1000);
    for (const record of records) tally(bridgeKey(type, record.id));
  }

  return { total, missing };
}

// ─── Synced-in record resync (issue #1080) ──────────────────────────────────
// Peer-synced brain writes go through brainStorage.applyRemoteRecord, which is
// deliberately event-silent (no brainEvents) to prevent cross-peer echo loops
// (#1077). That silence means the per-record bridge listeners below never fire
// for synced-in records, so a record created/edited/deleted on peer A was never
// re-vectorized into peer B's memory index — it stayed stale and searchable
// until a full bulk resync (which itself SKIPPED already-mapped records). The
// sync apply paths now emit a LOCAL-ONLY 'sync:applied' signal (it never feeds
// the sync log, so no echo) carrying the {type, id} of every applied change;
// we re-read each record's canonical state and re-embed or archive accordingly.

const RESYNC_DEBOUNCE_MS = 250;
const pendingResync = new Map(); // bridgeKey → { type, id, hardDelete } (dedups repeated touches)
let resyncTimer = null;
let resyncFlushing = false; // single-flight guard so two flushes can't overlap

// Journals re-embed on a much longer window than the other brain types, per
// day. The daily-log editor autosaves while the user types, so 'journals:upserted'
// now fires every couple of seconds for the SAME day — where it used to fire
// once per explicit Save. Re-embedding per event would mean an embedding call
// per typing pause, and — once the day's entry outgrows the embedding char
// budget — a full LLM summarization per event too (see generateMemoryEmbedding's
// over-budget branch), which is exactly the kind of unannounced provider traffic
// the AI policy rules out. Coalescing per day collapses a whole writing session
// into one re-embed after the user settles; resyncBrainRecord re-reads the
// canonical entry at flush time, so the trailing flush always embeds the newest
// content — and embedding once the sentence is finished beats embedding it
// half-typed 100 times.
const JOURNAL_RESYNC_DEBOUNCE_MS = 30_000;
const journalResyncTimers = new Map(); // journal id (the ISO date) → timer

/**
 * Archive the memory entry mapped to a brain record (if any). Used when the
 * canonical record is gone (tombstoned), archived, or otherwise should no
 * longer be searchable.
 */
async function archiveMappedMemory(brainType, id) {
  const map = await loadBridgeMap();
  const memoryId = map[bridgeKey(brainType, id)];
  if (!memoryId) return false;
  await memory.updateMemory(memoryId, { status: 'archived' });
  console.log(`🧠🔗 Archived brain→memory: ${brainType}/${id} → ${memoryId}`);
  return true;
}

/**
 * Hard-delete the memory entry mapped to a brain record (issue #1318). Used for
 * a GENUINE local user delete: archiving the row would hide it from search but
 * leave the row + its 768-dim embedding in Postgres forever (e.g. ~1,482 dead
 * vectors after a cleared ChatGPT import). A hard delete drops the row and its
 * embedding and removes the bridge-map entry so a later create can't collide
 * with a stale mapping. NOT used for synced-in deletes — those stay soft-
 * archived (see resyncBrainRecord) so a peer un-delete can resurrect them.
 */
async function hardDeleteMappedMemory(brainType, id) {
  const map = await loadBridgeMap();
  const key = bridgeKey(brainType, id);
  const memoryId = map[key];
  if (!memoryId) return false;
  await memory.deleteMemory(memoryId, true); // hard: DELETE row + drop embedding
  delete map[key];
  await saveBridgeMap();
  console.log(`🧠🔗 Hard-deleted brain→memory: ${brainType}/${id} → ${memoryId}`);
  return true;
}

/**
 * Re-vectorize (or archive) a single brain record from its CANONICAL stored
 * state — used after a peer sync applies a change. Reading the store rather
 * than trusting an event payload makes this self-healing and order-independent:
 * whatever the final converged state is (live record, archived, or tombstoned),
 * the memory copy is brought into line.
 *   - record present & not archived → upsert + re-embed (syncBrainRecord)
 *   - record absent (tombstoned) → hard-delete on a genuine local delete
 *     (hardDelete), else archive the mapped memory entry (synced/recoverable)
 *   - record present but archived → archive (always soft — recoverable)
 *   - type not mirrored by the bridge (links/buckets/inbox) → no-op
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.hardDelete=false] The trigger was a real local user
 *   delete (a `{type}:deleted` event), so a tombstoned record should hard-prune
 *   the mapped memory row + embedding rather than soft-archive it (issue #1318).
 *   Synced-in deletes (sync:applied) pass false so they stay resurrectable.
 */
export async function resyncBrainRecord(brainType, id, { hardDelete = false } = {}) {
  if (!id || !TYPE_MAP[brainType]) return;
  // getById returns null for tombstones (deleted records), so a synced-in
  // delete naturally lands in the archive/hard-delete branch.
  const record = brainType === 'journals'
    ? await getJournal(id)
    : await brainStorage.getById(brainType, id);
  if (!record) {
    // Truly gone (tombstoned). A genuine local user delete hard-prunes the row;
    // a sync-driven delete stays soft so a peer un-delete can resurrect it.
    if (hardDelete) await hardDeleteMappedMemory(brainType, id);
    else await archiveMappedMemory(brainType, id);
    return;
  }
  if (record.archived) {
    // Present but archived (not deleted) — always soft, never hard-delete, even
    // if the queued trigger carried a hardDelete intent.
    await archiveMappedMemory(brainType, id);
    return;
  }
  await syncBrainRecord(brainType, record);
}

/**
 * Drain the pending resync queue sequentially. Single-flight + re-draining:
 * only one flush runs at a time (the `resyncFlushing` guard), and it loops
 * until the queue is empty so records enqueued mid-flush are still processed —
 * without a second flush running concurrently. Sequential (not parallel) so a
 * large catch-up sync doesn't fire hundreds of concurrent embedding calls and
 * saturate the embedding backend; single-flight also prevents two flushes from
 * both creating a memory for the same not-yet-mapped record (duplicate entries).
 * Exported for deterministic flushing in tests.
 */
export async function flushPendingResync() {
  if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
  if (resyncFlushing) return; // an in-flight flush will pick up newly-queued items
  resyncFlushing = true;
  try {
    // The queue only grows during an `await` below; the loop re-checks size at
    // the top of each pass, and the gap between the final size===0 check and
    // clearing `resyncFlushing` contains no await — so nothing can be stranded.
    while (pendingResync.size > 0) {
      const batch = [...pendingResync.values()];
      pendingResync.clear();
      for (const { type, id, hardDelete } of batch) {
        await resyncBrainRecord(type, id, { hardDelete }).catch((err) => {
          console.error(`❌ Brain bridge resync failed for ${type}/${id}: ${err.message}`);
        });
      }
    }
  } finally {
    resyncFlushing = false;
  }
}

/**
 * Queue applied-change records for a debounced resync. Records touching a type
 * the bridge doesn't mirror are dropped here so they never schedule a flush.
 * No timer is armed while a flush is in flight — that flush re-drains the queue
 * itself, so a second concurrent flush can never start.
 */
export function queueResync(records) {
  if (!Array.isArray(records)) return;
  for (const { type, id, hardDelete } of records) {
    if (!id || !TYPE_MAP[type]) continue;
    const key = bridgeKey(type, id);
    // Sticky hard-delete on coalesce: once a real local `{type}:deleted` marks a
    // key for a hard prune, a later touch for the same key before the flush — a
    // concurrent `sync:applied` carrying no flag, say — must NOT downgrade it to
    // a soft archive, or the dead embedding lingers. Safe to keep sticky because
    // resyncBrainRecord's record-present branch upserts a resurrected record
    // regardless of the flag, so a true intent can never hard-delete a live row.
    const prevHardDelete = pendingResync.get(key)?.hardDelete;
    pendingResync.set(key, { type, id, hardDelete: !!hardDelete || !!prevHardDelete });
  }
  if (pendingResync.size === 0 || resyncTimer || resyncFlushing) return;
  resyncTimer = setTimeout(() => {
    flushPendingResync().catch((err) => {
      console.error(`❌ Brain bridge resync flush failed: ${err.message}`);
    });
  }, RESYNC_DEBOUNCE_MS);
  // Don't keep the event loop alive just for a pending resync flush.
  if (typeof resyncTimer.unref === 'function') resyncTimer.unref();
}

// ─── Event Handlers ─────────────────────────────────────────────────────────
// Entity stores emit "{type}:upserted" / "{type}:deleted" with the single
// affected record. Both are routed through the debounced+sequential
// queueResync path (not handled inline) — see initBridge for why.
// JSONL stores still emit "{type}:added" with a single record.

function handleJsonlAdded(brainType, record) {
  if (!record?.id) return;
  syncBrainRecord(brainType, record).catch(err => {
    console.error(`❌ Brain bridge sync failed for ${brainType}/${record.id}: ${err.message}`);
  });
}

// ─── Init ───────────────────────────────────────────────────────────────────

/**
 * Initialize the brain→memory bridge.
 * Attaches event listeners to brainEvents so new/updated brain records
 * are automatically mirrored to the CoS memory system.
 */
export function initBridge() {
  // Entity store changes — route through the debounced + sequential queueResync
  // path rather than embedding inline per event. A single create/update already
  // emits one per-record event (not a store-wide fan-out), but a BULK producer —
  // e.g. the ChatGPT import creating ~1,400 conversations back-to-back — fires
  // that many `:upserted` events in a tight loop. Handling each inline would
  // launch ~1,400 concurrent embedding calls + Postgres writes, saturating the
  // embedding backend (most time out → records persist with a NULL embedding,
  // silently unsearchable) and exhausting the PG pool. queueResync coalesces the
  // burst (250ms debounce + dedup) and drains it sequentially — the same
  // protection the peer-sync `sync:applied` path already relies on. It also
  // re-reads each record's CANONICAL state (resyncBrainRecord), so the archived/
  // deleted/tombstoned branches are handled there uniformly and an event whose
  // payload is already stale by flush time still converges correctly.
  for (const type of ['people', 'projects', 'ideas', 'admin', 'memories']) {
    brainEvents.on(`${type}:upserted`, ({ id }) => queueResync([{ type, id }]));
    // A `:deleted` event is a genuine LOCAL user delete (remove() emits it;
    // applyRemoteRecord is event-silent), so hard-prune the mapped vector row
    // rather than soft-archive it forever (issue #1318).
    brainEvents.on(`${type}:deleted`, ({ id }) => queueResync([{ type, id, hardDelete: true }]));
  }

  // JSONL appends (digests, reviews)
  brainEvents.on('digests:added', (record) => handleJsonlAdded('digests', record));
  brainEvents.on('reviews:added', (record) => handleJsonlAdded('reviews', record));

  // Daily log — per-entry events so a single append doesn't re-embed every
  // day of the user's history. (An earlier version listened for the
  // store-wide 'journals:changed' event, which would trigger O(totalDays)
  // embedding calls per dictation segment and saturate the embedding
  // backend.) appendJournal/setJournalContent fire 'journals:upserted' with
  // the single affected entry; deleteJournal fires 'journals:deleted'.
  // Debounced per day because the editor autosaves — see queueJournalResync.
  brainEvents.on('journals:upserted', ({ entry }) => {
    if (entry?.id) queueJournalResync(entry.id);
  });
  // handleJournalDeleted is async and awaits loadBridgeMap(); wrap the call
  // in a .catch so a rejection becomes a logged error instead of an
  // unhandled-rejection warning (or a process crash under strict modes).
  brainEvents.on('journals:deleted', ({ entry }) => {
    // Drop any debounced re-embed for the day first — the hard-delete below
    // prunes the mapped memory, and a later flush would only re-read a tombstone.
    if (entry?.id) cancelPendingJournalResync(entry.id);
    handleJournalDeleted(entry).catch((err) => {
      console.error(`❌ Brain bridge delete sync failed for journals/${entry?.id}: ${err.message}`);
    });
  });

  // Peer-synced records (issue #1080) — applyRemoteRecord is event-silent to
  // prevent echo loops, so the per-record listeners above never fire for
  // synced-in changes. The sync apply paths emit this local-only signal with
  // the touched {type, id}s; we re-read each from the store and re-embed or
  // archive. Debounced + sequential so a large catch-up doesn't saturate the
  // embedding backend.
  brainEvents.on('sync:applied', ({ records } = {}) => queueResync(records));

  console.log('🧠🔗 Brain→Memory bridge initialized');
}

/**
 * Coalesce repeated saves of one day into a single re-embed, then hand off to
 * the shared queueResync path (dedup + sequential drain + canonical re-read).
 * Trailing-edge per day: each save pushes the flush out, so a writing session
 * costs one re-embed once the user stops. See JOURNAL_RESYNC_DEBOUNCE_MS.
 */
function queueJournalResync(id) {
  clearTimeout(journalResyncTimers.get(id));
  const timer = setTimeout(() => {
    journalResyncTimers.delete(id);
    queueResync([{ type: 'journals', id }]);
  }, JOURNAL_RESYNC_DEBOUNCE_MS);
  // Don't hold the event loop open for a pending journal re-embed.
  if (typeof timer.unref === 'function') timer.unref();
  journalResyncTimers.set(id, timer);
}

/**
 * Drop a day's pending re-embed. Called when the day is deleted: the delete
 * path prunes the mapped memory immediately, so letting the debounce fire
 * afterwards would just re-read a tombstone. Also exported for tests.
 */
export function cancelPendingJournalResync(id) {
  clearTimeout(journalResyncTimers.get(id));
  journalResyncTimers.delete(id);
}

async function handleJournalDeleted(entry) {
  if (!entry?.id) return;
  // deleteJournal (the local user action) is the only emitter of
  // 'journals:deleted'; synced-in journal deletes flow through sync:applied →
  // resyncBrainRecord and stay soft-archived. So a local journal delete hard-
  // prunes the mapped memory row + embedding (issue #1318).
  await hardDeleteMappedMemory('journals', entry.id);
}
