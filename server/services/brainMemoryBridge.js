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

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { brainEvents } from './brainStorage.js';
import * as brainStorage from './brainStorage.js';
import * as memory from './memoryBackend.js';
import * as embeddings from './memoryEmbeddings.js';
import { ensureDir, PATHS } from '../lib/fileUtils.js';
import { listJournals } from './brainJournal.js';

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
  await writeFile(BRIDGE_MAP_PATH, JSON.stringify(bridgeMap, null, 2));
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

  // Generate embedding
  const embedding = await embeddings.generateMemoryEmbedding(memoryData).catch(() => null);

  if (existingMemoryId) {
    // Update existing memory
    const updated = await memory.updateMemory(existingMemoryId, memoryData);
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
 * Returns { synced, skipped, errors }.
 */
export async function syncAllBrainData({ dryRun = false } = {}) {
  const map = await loadBridgeMap();
  const stats = { synced: 0, skipped: 0, errors: 0 };

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
      if (map[key] && !dryRun) {
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

  // Daily log entries — one memory per day, initial/backfill import only;
  // already-mapped records are skipped by this bulk sync. Content updates
  // flow through the 'journals:changed' event handler instead.
  {
    const { records: journals } = await listJournals({ limit: 10000 });
    for (const record of journals) {
      const key = bridgeKey('journals', record.id);
      if (map[key] && !dryRun) {
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
      if (map[key] && !dryRun) {
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

  return stats;
}

// ─── Event Handlers ─────────────────────────────────────────────────────────
// Entity stores emit "{type}:changed" with the full store data object { records: { id: {...} } }
// JSONL stores emit "{type}:added" with a single record

async function handleEntityChanged(brainType, storeData) {
  if (!storeData?.records) return;
  const map = await loadBridgeMap();
  for (const [id, record] of Object.entries(storeData.records)) {
    if (record.archived) {
      // Archive the mapped CoS memory if one exists
      const key = bridgeKey(brainType, id);
      const memoryId = map[key];
      if (memoryId) {
        memory.updateMemory(memoryId, { status: 'archived' }).catch(err => {
          console.error(`❌ Brain bridge archive failed for ${brainType}/${id}: ${err.message}`);
        });
      }
      continue;
    }
    syncBrainRecord(brainType, { id, ...record }).catch(err => {
      console.error(`❌ Brain bridge sync failed for ${brainType}/${id}: ${err.message}`);
    });
  }
}

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
  // Entity store changes
  for (const type of ['people', 'projects', 'ideas', 'admin', 'memories']) {
    brainEvents.on(`${type}:changed`, (data) => handleEntityChanged(type, data));
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
  brainEvents.on('journals:upserted', ({ entry }) => handleJournalUpserted(entry));
  brainEvents.on('journals:deleted', ({ entry }) => handleJournalDeleted(entry));

  console.log('🧠🔗 Brain→Memory bridge initialized');
}

function handleJournalUpserted(entry) {
  if (!entry?.id) return;
  syncBrainRecord('journals', entry).catch((err) => {
    console.error(`❌ Brain bridge sync failed for journals/${entry.id}: ${err.message}`);
  });
}

async function handleJournalDeleted(entry) {
  if (!entry?.id) return;
  const map = await loadBridgeMap();
  const key = bridgeKey('journals', entry.id);
  const memoryId = map[key];
  if (!memoryId) return;
  memory.updateMemory(memoryId, { status: 'archived' }).catch((err) => {
    console.error(`❌ Brain bridge archive failed for journals/${entry.id}: ${err.message}`);
  });
}
