/**
 * Review Hub Service
 *
 * Manages review items: todos, alerts, briefing notes, and CoS action requests.
 * Aggregates items requiring user attention into a single hub.
 */

import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { EventEmitter } from 'events';
import { ensureDir, PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { cosEvents } from './cosEvents.js';

const DATA_DIR = join(PATHS.data, 'review');
const ITEMS_FILE = join(DATA_DIR, 'items.json');

export const reviewEvents = new EventEmitter();

// Valid item types and statuses
const ITEM_TYPES = ['alert', 'todo', 'briefing', 'cos'];
const ITEM_STATUSES = ['pending', 'completed', 'dismissed'];

/**
 * Load all review items from file
 */
async function loadItems() {
  return readJSONFile(ITEMS_FILE, []);
}

/**
 * Save items to file atomically
 */
async function saveItems(items) {
  await ensureDir(DATA_DIR);
  await atomicWrite(ITEMS_FILE, items);
}

/**
 * Get all review items, sorted by type then creation date (newest first)
 */
export async function getItems({ status, type } = {}) {
  let items = await loadItems();
  if (status) items = items.filter(i => i.status === status);
  if (type) items = items.filter(i => i.type === type);
  return items.sort((a, b) => {
    const typeOrder = ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type);
    if (typeOrder !== 0) return typeOrder;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

/**
 * Get count of pending items by type
 */
export async function getPendingCounts() {
  const items = await loadItems();
  return items.reduce((acc, i) => {
    if (i.status !== 'pending') return acc;
    acc.total++;
    acc[i.type] = (acc[i.type] || 0) + 1;
    return acc;
  }, { total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 });
}

/**
 * Create a new review item
 */
export async function createItem({ type, title, description = '', metadata = {} }) {
  if (!ITEM_TYPES.includes(type)) {
    const err = new Error(`Invalid item type: ${type}`);
    err.status = 400;
    throw err;
  }

  const items = await loadItems();

  // Prevent duplicate alerts for same reference within 24 hours
  if (type === 'alert' && metadata?.referenceId) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const duplicate = items.find(i =>
      i.type === 'alert' &&
      i.metadata?.referenceId === metadata.referenceId &&
      new Date(i.createdAt).getTime() > oneDayAgo
    );
    if (duplicate) return duplicate;
  }

  const item = {
    id: uuidv4(),
    type,
    title,
    description,
    status: 'pending',
    metadata,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  items.push(item);
  await saveItems(items);
  console.log(`📋 Review item created: ${type} — ${title}`);
  reviewEvents.emit('item:created', item);
  return item;
}

/**
 * Update an item's status
 */
async function updateItemStatus(id, status) {
  if (!ITEM_STATUSES.includes(status)) {
    const err = new Error(`Invalid status: ${status}`);
    err.status = 400;
    throw err;
  }

  const items = await loadItems();
  const item = items.find(i => i.id === id);
  if (!item) {
    const err = new Error(`Review item not found: ${id}`);
    err.status = 404;
    throw err;
  }

  item.status = status;
  item.updatedAt = new Date().toISOString();
  await saveItems(items);
  console.log(`📋 Review item ${status}: ${item.type} — ${item.title}`);
  reviewEvents.emit('item:updated', item);
  return item;
}

/**
 * Mark an item as completed
 */
export async function completeItem(id) {
  return updateItemStatus(id, 'completed');
}

/**
 * Dismiss an item
 */
export async function dismissItem(id) {
  return updateItemStatus(id, 'dismissed');
}

/**
 * Bulk-update many items to the same status in a single read-modify-write.
 * Concurrent per-item POSTs race on saveItems and silently drop updates;
 * this endpoint handles the "Complete All" / "Dismiss All" cases atomically.
 * Pass `ids` to target specific items, or omit to target every pending item.
 */
export async function bulkUpdateStatus({ ids, status }) {
  if (!ITEM_STATUSES.includes(status)) {
    const err = new Error(`Invalid status: ${status}`);
    err.status = 400;
    throw err;
  }

  const items = await loadItems();
  const idSet = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  const updated = [];
  const now = new Date().toISOString();
  for (const item of items) {
    if (item.status !== 'pending') continue;
    if (idSet && !idSet.has(item.id)) continue;
    item.status = status;
    item.updatedAt = now;
    updated.push(item);
  }

  if (updated.length === 0) return [];

  await saveItems(items);
  console.log(`📋 Review items bulk-${status}: ${updated.length}`);
  for (const item of updated) reviewEvents.emit('item:updated', item);
  return updated;
}

/**
 * Update an item's title and/or description
 */
export async function updateItem(id, { title, description }) {
  const items = await loadItems();
  const item = items.find(i => i.id === id);
  if (!item) {
    const err = new Error(`Review item not found: ${id}`);
    err.status = 404;
    throw err;
  }

  if (title !== undefined) item.title = title;
  if (description !== undefined) item.description = description;
  item.updatedAt = new Date().toISOString();
  await saveItems(items);
  reviewEvents.emit('item:updated', item);
  return item;
}

/**
 * Delete a review item
 */
export async function deleteItem(id) {
  const items = await loadItems();
  const index = items.findIndex(i => i.id === id);
  if (index === -1) {
    const err = new Error(`Review item not found: ${id}`);
    err.status = 404;
    throw err;
  }

  const [removed] = items.splice(index, 1);
  await saveItems(items);
  console.log(`📋 Review item deleted: ${removed.type} — ${removed.title}`);
  reviewEvents.emit('item:deleted', removed);
  return removed;
}

/**
 * Get latest daily briefing content from the CoS reports directory
 */
export async function getBriefing() {
  const reportsDir = PATHS.reports;

  let files = [];
  try {
    files = await readdir(reportsDir);
  } catch {
    return {
      source: 'none',
      content: 'No CoS daily briefing found yet.',
      generatedAt: new Date().toISOString()
    };
  }

  const latestBriefingFile = files
    .filter(file => file.endsWith('-briefing.md'))
    .sort()
    .reverse()[0];

  if (!latestBriefingFile) {
    return {
      source: 'none',
      content: 'No CoS daily briefing found yet.',
      generatedAt: new Date().toISOString()
    };
  }

  const content = await readFile(join(reportsDir, latestBriefingFile), 'utf-8');
  const date = latestBriefingFile.replace('-briefing.md', '');

  return {
    source: 'cos',
    content,
    generatedAt: date
  };
}

/**
 * Bridge CoS events into review items
 */
cosEvents.on('memory:approval-needed', (data) => {
  const memories = data?.memories ?? [];
  for (const mem of memories) {
    createItem({
      type: 'alert',
      title: `Memory approval: ${mem.content?.slice(0, 80) || 'New memory entry'}`,
      description: `Type: ${mem.type ?? 'unknown'} | Confidence: ${mem.confidence ?? 'N/A'}`,
      metadata: { referenceId: mem.id, category: 'memory-approval', agentId: data?.agentId, taskId: data?.taskId }
    }).catch(err => console.error(`❌ Failed to create review alert: ${err.message}`));
  }
});

async function updateStatusByReferenceId(referenceId, status) {
  if (!ITEM_STATUSES.includes(status)) {
    const err = new Error(`Invalid status: ${status}`);
    err.status = 400;
    throw err;
  }

  const items = await loadItems();
  const matching = items.filter(i => i.metadata?.referenceId === referenceId && i.status === 'pending');
  if (matching.length === 0) return;
  const now = new Date().toISOString();
  for (const item of matching) {
    item.status = status;
    item.updatedAt = now;
  }
  await saveItems(items);
  for (const item of matching) reviewEvents.emit('item:updated', item);
}

const dismissByReferenceId = (referenceId) => updateStatusByReferenceId(referenceId, 'dismissed');
const completeByReferenceId = (referenceId) => updateStatusByReferenceId(referenceId, 'completed');

cosEvents.on('memory:approved', (data) => {
  if (data?.id) dismissByReferenceId(data.id).catch(err => console.error(`❌ Failed to dismiss approved memory review item: ${err.message}`));
});

cosEvents.on('memory:rejected', (data) => {
  if (data?.id) dismissByReferenceId(data.id).catch(err => console.error(`❌ Failed to dismiss rejected memory review item: ${err.message}`));
});

cosEvents.on('task:ready', (data) => {
  createItem({
    type: 'cos',
    title: data?.title ?? data?.description ?? 'CoS action requires review',
    description: data?.description ?? '',
    metadata: { taskId: data?.id, referenceId: data?.id }
  }).catch(err => console.error(`❌ Failed to create review item: ${err.message}`));
});

// When a CoS agent finishes a task, auto-resolve the matching review item so
// the user isn't asked to manually mark something complete that an agent
// already handled. Success → complete; failure stays pending so the user can
// see and act on it.
cosEvents.on('agent:completed', (agent) => {
  const taskId = agent?.taskId;
  if (!taskId) return;
  if (agent.result?.success) {
    completeByReferenceId(taskId).catch(err =>
      console.error(`❌ Failed to auto-complete review item for task ${taskId}: ${err.message}`)
    );
  }
});
