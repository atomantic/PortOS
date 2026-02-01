/**
 * Brain Storage Service
 *
 * Handles file-based persistence for the Brain feature.
 * - JSON for entity stores (people, projects, ideas, admin)
 * - JSONL for append-heavy logs (inbox_log, digests, reviews)
 * - In-memory caching with TTL for performance
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';
import { readJSONFile, safeJSONParse } from '../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/brain');

// File paths
const FILES = {
  meta: join(DATA_DIR, 'meta.json'),
  inboxLog: join(DATA_DIR, 'inbox_log.jsonl'),
  people: join(DATA_DIR, 'people.json'),
  projects: join(DATA_DIR, 'projects.json'),
  ideas: join(DATA_DIR, 'ideas.json'),
  admin: join(DATA_DIR, 'admin.json'),
  digests: join(DATA_DIR, 'digests.jsonl'),
  reviews: join(DATA_DIR, 'reviews.jsonl')
};

// Event emitter for brain data changes
export const brainEvents = new EventEmitter();

// In-memory caches
const caches = {
  meta: { data: null, timestamp: 0 },
  people: { data: null, timestamp: 0 },
  projects: { data: null, timestamp: 0 },
  ideas: { data: null, timestamp: 0 },
  admin: { data: null, timestamp: 0 },
  inboxLog: { data: null, timestamp: 0 },
  digests: { data: null, timestamp: 0 },
  reviews: { data: null, timestamp: 0 }
};

const CACHE_TTL_MS = 2000;

// Default settings
const DEFAULT_META = {
  version: 1,
  confidenceThreshold: 0.6,
  dailyDigestTime: '09:00',
  weeklyReviewTime: '16:00',
  weeklyReviewDay: 'sunday',
  defaultProvider: 'lmstudio',
  defaultModel: 'gptoss-20b',
  lastDailyDigest: null,
  lastWeeklyReview: null
};

/**
 * Ensure brain data directory exists
 */
export async function ensureBrainDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
    console.log(`🧠 Created brain data directory: ${DATA_DIR}`);
  }
}

/**
 * Generate a new UUID
 */
export function generateId() {
  return uuidv4();
}

/**
 * Get current ISO timestamp
 */
export function now() {
  return new Date().toISOString();
}

// =============================================================================
// META / SETTINGS
// =============================================================================

/**
 * Load brain settings
 */
export async function loadMeta() {
  const cache = caches.meta;
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();

  const loaded = await readJSONFile(FILES.meta, null);
  cache.data = loaded ? { ...DEFAULT_META, ...loaded } : { ...DEFAULT_META };
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Save brain settings
 */
export async function saveMeta(meta) {
  await ensureBrainDir();
  await writeFile(FILES.meta, JSON.stringify(meta, null, 2));
  caches.meta.data = meta;
  caches.meta.timestamp = Date.now();
  brainEvents.emit('meta:changed', meta);
}

/**
 * Update brain settings (partial update)
 */
export async function updateMeta(updates) {
  const meta = await loadMeta();
  const updated = { ...meta, ...updates };
  await saveMeta(updated);
  return updated;
}

// =============================================================================
// JSON ENTITY STORES (people, projects, ideas, admin)
// =============================================================================

/**
 * Load a JSON entity store
 */
async function loadJsonStore(type) {
  const cache = caches[type];
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();
  const filePath = FILES[type];

  cache.data = await readJSONFile(filePath, { records: {} });
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Save a JSON entity store
 */
async function saveJsonStore(type, data) {
  await ensureBrainDir();
  await writeFile(FILES[type], JSON.stringify(data, null, 2));
  caches[type].data = data;
  caches[type].timestamp = Date.now();
  brainEvents.emit(`${type}:changed`, data);
}

/**
 * Get all records from a JSON store
 */
export async function getAll(type) {
  const data = await loadJsonStore(type);
  return Object.entries(data.records).map(([id, record]) => ({ id, ...record }));
}

/**
 * Get a record by ID
 */
export async function getById(type, id) {
  const data = await loadJsonStore(type);
  const record = data.records[id];
  return record ? { id, ...record } : null;
}

/**
 * Create a new record
 */
export async function create(type, recordData) {
  const data = await loadJsonStore(type);
  const id = generateId();
  const timestamp = now();

  const record = {
    ...recordData,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  data.records[id] = record;
  await saveJsonStore(type, data);

  console.log(`🧠 Created ${type} record: ${id}`);
  return { id, ...record };
}

/**
 * Update a record
 */
export async function update(type, id, updates) {
  const data = await loadJsonStore(type);

  if (!data.records[id]) {
    return null;
  }

  const record = {
    ...data.records[id],
    ...updates,
    createdAt: data.records[id].createdAt,
    updatedAt: now()
  };

  data.records[id] = record;
  await saveJsonStore(type, data);

  console.log(`🧠 Updated ${type} record: ${id}`);
  return { id, ...record };
}

/**
 * Delete a record
 */
export async function remove(type, id) {
  const data = await loadJsonStore(type);

  if (!data.records[id]) {
    return false;
  }

  delete data.records[id];
  await saveJsonStore(type, data);

  console.log(`🧠 Deleted ${type} record: ${id}`);
  return true;
}

/**
 * Query records with filters
 */
export async function query(type, filters = {}) {
  const records = await getAll(type);

  return records.filter(record => {
    for (const [key, value] of Object.entries(filters)) {
      if (record[key] !== value) return false;
    }
    return true;
  });
}

// =============================================================================
// JSONL APPEND LOGS (inbox_log, digests, reviews)
// =============================================================================

/**
 * Load all records from a JSONL file
 */
async function loadJsonlStore(type) {
  const cache = caches[type];
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();
  const filePath = FILES[type];

  if (!existsSync(filePath)) {
    cache.data = [];
    cache.timestamp = Date.now();
    return cache.data;
  }

  const content = await readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  cache.data = lines.map(line => safeJSONParse(line, null)).filter(item => item !== null);
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Append a record to a JSONL file
 */
async function appendJsonl(type, record) {
  await ensureBrainDir();
  const line = JSON.stringify(record) + '\n';
  await appendFile(FILES[type], line);

  // Invalidate cache so next read gets fresh data
  caches[type].data = null;
  caches[type].timestamp = 0;

  brainEvents.emit(`${type}:added`, record);
}

/**
 * Rewrite entire JSONL file (for updates/deletes)
 */
async function rewriteJsonl(type, records) {
  await ensureBrainDir();
  const content = records.map(r => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
  await writeFile(FILES[type], content);

  caches[type].data = records;
  caches[type].timestamp = Date.now();

  brainEvents.emit(`${type}:changed`, records);
}

// =============================================================================
// INBOX LOG OPERATIONS
// =============================================================================

/**
 * Get all inbox log entries
 */
export async function getInboxLog(options = {}) {
  const { status, limit = 50, offset = 0 } = options;
  let records = await loadJsonlStore('inboxLog');

  // Sort by capturedAt descending (newest first)
  records = records.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));

  // Filter by status if provided
  if (status) {
    records = records.filter(r => r.status === status);
  }

  // Apply pagination
  return records.slice(offset, offset + limit);
}

/**
 * Get inbox log entry by ID
 */
export async function getInboxLogById(id) {
  const records = await loadJsonlStore('inboxLog');
  return records.find(r => r.id === id) || null;
}

/**
 * Create inbox log entry
 */
export async function createInboxLog(entry) {
  const record = {
    id: generateId(),
    ...entry,
    capturedAt: entry.capturedAt || now()
  };

  await appendJsonl('inboxLog', record);
  console.log(`🧠 Created inbox log: ${record.id}`);
  return record;
}

/**
 * Update inbox log entry
 */
export async function updateInboxLog(id, updates) {
  const records = await loadJsonlStore('inboxLog');
  const index = records.findIndex(r => r.id === id);

  if (index === -1) {
    return null;
  }

  records[index] = { ...records[index], ...updates };
  await rewriteJsonl('inboxLog', records);

  console.log(`🧠 Updated inbox log: ${id}`);
  return records[index];
}

/**
 * Delete inbox log entry
 */
export async function deleteInboxLog(id) {
  const records = await loadJsonlStore('inboxLog');
  const index = records.findIndex(r => r.id === id);

  if (index === -1) {
    return false;
  }

  records.splice(index, 1);
  await rewriteJsonl('inboxLog', records);

  console.log(`🧠 Deleted inbox log: ${id}`);
  return true;
}

/**
 * Get inbox log count by status
 */
export async function getInboxLogCounts() {
  const records = await loadJsonlStore('inboxLog');

  const counts = {
    total: records.length,
    filed: 0,
    needs_review: 0,
    corrected: 0,
    error: 0
  };

  for (const record of records) {
    if (counts[record.status] !== undefined) {
      counts[record.status]++;
    }
  }

  return counts;
}

// =============================================================================
// DIGEST OPERATIONS
// =============================================================================

/**
 * Get all digests
 */
export async function getDigests(limit = 10) {
  let records = await loadJsonlStore('digests');
  records = records.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  return records.slice(0, limit);
}

/**
 * Get latest digest
 */
export async function getLatestDigest() {
  const digests = await getDigests(1);
  return digests[0] || null;
}

/**
 * Create digest entry
 */
export async function createDigest(digest) {
  const record = {
    id: generateId(),
    ...digest,
    generatedAt: now()
  };

  await appendJsonl('digests', record);

  // Update meta with last digest time
  await updateMeta({ lastDailyDigest: record.generatedAt });

  console.log(`🧠 Created daily digest: ${record.id}`);
  return record;
}

// =============================================================================
// REVIEW OPERATIONS
// =============================================================================

/**
 * Get all reviews
 */
export async function getReviews(limit = 10) {
  let records = await loadJsonlStore('reviews');
  records = records.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  return records.slice(0, limit);
}

/**
 * Get latest review
 */
export async function getLatestReview() {
  const reviews = await getReviews(1);
  return reviews[0] || null;
}

/**
 * Create review entry
 */
export async function createReview(review) {
  const record = {
    id: generateId(),
    ...review,
    generatedAt: now()
  };

  await appendJsonl('reviews', record);

  // Update meta with last review time
  await updateMeta({ lastWeeklyReview: record.generatedAt });

  console.log(`🧠 Created weekly review: ${record.id}`);
  return record;
}

// =============================================================================
// CONVENIENCE EXPORTS FOR ENTITY TYPES
// =============================================================================

// People
export const getPeople = (filters) => filters ? query('people', filters) : getAll('people');
export const getPersonById = (id) => getById('people', id);
export const createPerson = (data) => create('people', data);
export const updatePerson = (id, data) => update('people', id, data);
export const deletePerson = (id) => remove('people', id);

// Projects
export const getProjects = (filters) => filters ? query('projects', filters) : getAll('projects');
export const getProjectById = (id) => getById('projects', id);
export const createProject = (data) => create('projects', data);
export const updateProject = (id, data) => update('projects', id, data);
export const deleteProject = (id) => remove('projects', id);

// Ideas
export const getIdeas = (filters) => filters ? query('ideas', filters) : getAll('ideas');
export const getIdeaById = (id) => getById('ideas', id);
export const createIdea = (data) => create('ideas', data);
export const updateIdea = (id, data) => update('ideas', id, data);
export const deleteIdea = (id) => remove('ideas', id);

// Admin
export const getAdminItems = (filters) => filters ? query('admin', filters) : getAll('admin');
export const getAdminById = (id) => getById('admin', id);
export const createAdminItem = (data) => create('admin', data);
export const updateAdminItem = (id, data) => update('admin', id, data);
export const deleteAdminItem = (id) => remove('admin', id);

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Invalidate all caches
 */
export function invalidateAllCaches() {
  for (const key of Object.keys(caches)) {
    caches[key].data = null;
    caches[key].timestamp = 0;
  }
}

/**
 * Get brain data summary (for dashboard)
 */
export async function getSummary() {
  const [people, projects, ideas, adminItems, inboxCounts, meta] = await Promise.all([
    getAll('people'),
    getAll('projects'),
    getAll('ideas'),
    getAll('admin'),
    getInboxLogCounts(),
    loadMeta()
  ]);

  return {
    counts: {
      people: people.length,
      projects: projects.length,
      ideas: ideas.length,
      admin: adminItems.length,
      inbox: inboxCounts
    },
    activeProjects: projects.filter(p => p.status === 'active').length,
    openAdmin: adminItems.filter(a => a.status === 'open').length,
    needsReview: inboxCounts.needs_review,
    lastDailyDigest: meta.lastDailyDigest,
    lastWeeklyReview: meta.lastWeeklyReview
  };
}
