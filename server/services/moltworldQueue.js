/**
 * Moltworld Action Queue Service
 *
 * In-memory queue per agentId for scheduling actions that the
 * explore script (or other consumers) can pick up and execute.
 *
 * Events emitted on queueEvents:
 *   added   - new item added to a queue
 *   updated - item status changed (executing, completed, failed)
 *   removed - item cancelled/removed
 */

import { randomUUID } from 'crypto';
import EventEmitter from 'events';

export const queueEvents = new EventEmitter();

// Map<agentId, QueueItem[]>
const queues = new Map();

const MAX_ITEMS_PER_AGENT = 100;

function getOrCreateQueue(agentId) {
  if (!queues.has(agentId)) {
    queues.set(agentId, []);
  }
  return queues.get(agentId);
}

function evictCompleted(queue) {
  if (queue.length <= MAX_ITEMS_PER_AGENT) return;
  // Remove oldest completed/failed items first
  const completedIndices = [];
  for (let i = 0; i < queue.length; i++) {
    if (queue[i].status === 'completed' || queue[i].status === 'failed') {
      completedIndices.push(i);
    }
  }
  while (queue.length > MAX_ITEMS_PER_AGENT && completedIndices.length > 0) {
    queue.splice(completedIndices.shift(), 1);
    // Adjust remaining indices
    for (let j = 0; j < completedIndices.length; j++) {
      completedIndices[j]--;
    }
  }
}

/**
 * Get non-completed items for an agent (pending + executing)
 */
export function getQueue(agentId) {
  const queue = queues.get(agentId) || [];
  return queue.filter(item => item.status === 'pending' || item.status === 'executing');
}

/**
 * Get all items for an agent (including completed/failed, for display)
 */
export function getFullQueue(agentId) {
  return queues.get(agentId) || [];
}

/**
 * Add an action to the queue
 */
export function addAction(agentId, actionType, params = {}, scheduledFor = null) {
  const queue = getOrCreateQueue(agentId);
  const item = {
    id: randomUUID(),
    agentId,
    actionType,
    params,
    status: 'pending',
    scheduledFor: scheduledFor || null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    error: null
  };
  queue.push(item);
  evictCompleted(queue);
  console.log(`📋 Queue: added ${actionType} for agent=${agentId} id=${item.id}`);
  queueEvents.emit('added', item);
  return item;
}

/**
 * Pop the next pending item (FIFO), mark it as executing
 */
export function popNext(agentId) {
  const queue = queues.get(agentId) || [];
  const now = new Date().toISOString();
  const idx = queue.findIndex(item =>
    item.status === 'pending' &&
    (!item.scheduledFor || item.scheduledFor <= now)
  );
  if (idx === -1) return null;

  queue[idx].status = 'executing';
  const item = queue[idx];
  console.log(`📋 Queue: executing ${item.actionType} id=${item.id}`);
  queueEvents.emit('updated', item);
  return item;
}

/**
 * Mark an item as completed
 */
export function markCompleted(itemId) {
  for (const queue of queues.values()) {
    const item = queue.find(i => i.id === itemId);
    if (item) {
      item.status = 'completed';
      item.completedAt = new Date().toISOString();
      console.log(`📋 Queue: completed ${item.actionType} id=${itemId}`);
      queueEvents.emit('updated', item);
      return item;
    }
  }
  return null;
}

/**
 * Mark an item as failed
 */
export function markFailed(itemId, error) {
  for (const queue of queues.values()) {
    const item = queue.find(i => i.id === itemId);
    if (item) {
      item.status = 'failed';
      item.completedAt = new Date().toISOString();
      item.error = error;
      console.log(`📋 Queue: failed ${item.actionType} id=${itemId} error=${error}`);
      queueEvents.emit('updated', item);
      return item;
    }
  }
  return null;
}

/**
 * Remove a pending item (cancel)
 */
export function removeAction(itemId) {
  for (const [agentId, queue] of queues.entries()) {
    const idx = queue.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      const [item] = queue.splice(idx, 1);
      if (item.status !== 'pending') {
        // Can only cancel pending items; put it back
        queue.splice(idx, 0, item);
        return null;
      }
      console.log(`📋 Queue: removed ${item.actionType} id=${itemId}`);
      queueEvents.emit('removed', { id: itemId, agentId });
      return item;
    }
  }
  return null;
}
