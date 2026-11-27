/** Serve cursor pages from bounded Review Queue snapshots and signal clock-driven queue changes. */

import { randomUUID } from 'node:crypto';
import * as reviewService from './review.js';
import { ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';

export const REVIEW_QUEUE_MAX_PAGE_SIZE = 100;
const REVIEW_QUEUE_SNAPSHOT_TTL_MS = 30_000;
const REVIEW_QUEUE_MAX_SNAPSHOTS = 100;

// One process-wide deadline replaces browser polling for clock-only changes.
// Queue reads and snooze mutations can arm it with their next known deadline.
let clockInvalidation = null;
let clockInvalidationAt = Infinity;
export function scheduleQueueClockInvalidation(at) {
  const delay = at - Date.now();
  if (!Number.isFinite(at) || delay <= 0 || at >= clockInvalidationAt) return;
  clearTimeout(clockInvalidation);
  clockInvalidationAt = at;
  clockInvalidation = setTimeout(() => {
    clockInvalidation = null;
    clockInvalidationAt = Infinity;
    if (Date.now() < at) scheduleQueueClockInvalidation(at);
    else reviewService.reviewEvents.emit('queue:changed');
  }, Math.min(delay, 2_147_483_647));
  clockInvalidation.unref?.();
}

const queueSnapshots = new Map();

const stableQueryValue = (value) => {
  if (Array.isArray(value)) return value.map(stableQueryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stableQueryValue(child)]));
  }
  return value;
};

const queryKeyFor = (query = {}) => JSON.stringify(stableQueryValue(query));

const invalidCursor = (message = 'Invalid review queue cursor') => {
  throw new ServerError(message, { status: 400, code: 'INVALID_CURSOR' });
};

function encodeQueueCursor(snapshotId, offset) {
  return Buffer.from(JSON.stringify({ v: 1, snapshotId, offset }), 'utf8').toString('base64url');
}

function decodeQueueCursor(cursor) {
  const decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
  const payload = safeJSONParse(decoded, null, { allowArray: false });
  if (!payload || payload.v !== 1 || typeof payload.snapshotId !== 'string' || !payload.snapshotId
    || !Number.isSafeInteger(payload.offset) || payload.offset < 0) {
    invalidCursor();
  }
  return payload;
}

function pruneQueueSnapshots(now = Date.now()) {
  for (const [id, snapshot] of queueSnapshots) {
    if (snapshot.expiresAt <= now) queueSnapshots.delete(id);
  }
}

export function invalidateQueueSnapshots() {
  queueSnapshots.clear();
}

// Test seam: snapshots are intentionally process-local and short-lived.
export function __resetQueueSnapshots() {
  invalidateQueueSnapshots();
  clearTimeout(clockInvalidation);
  clockInvalidation = null;
  clockInvalidationAt = Infinity;
}

export function sourceShownCounts(items) {
  const shown = {};
  for (const item of items) shown[item.source] = (shown[item.source] || 0) + 1;
  return shown;
}

function pageSources(sources, pageItems) {
  const shown = sourceShownCounts(pageItems);
  return Object.fromEntries(Object.entries(sources).map(([source, descriptor]) => [source, {
    ...descriptor,
    shown: shown[source] || 0,
  }]));
}

function pageFromSnapshot(snapshot, offset) {
  if (offset > snapshot.items.length) invalidCursor('Review queue cursor offset is outside the snapshot');
  const items = snapshot.items.slice(offset, offset + snapshot.pageSize);
  const nextOffset = offset + items.length;
  return {
    items,
    total: snapshot.total,
    totalsBySource: snapshot.totalsBySource,
    sources: pageSources(snapshot.sources, items),
    nextCursor: nextOffset < snapshot.items.length ? encodeQueueCursor(snapshot.id, nextOffset) : null,
    partial: snapshot.partial,
    counts: snapshot.counts,
    generatedAt: snapshot.generatedAt,
  };
}

function validatePageSize(limit) {
  if (limit === undefined || limit === null) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > REVIEW_QUEUE_MAX_PAGE_SIZE) {
    throw new ServerError(`Review queue limit must be an integer from 1 to ${REVIEW_QUEUE_MAX_PAGE_SIZE}`, {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  return limit;
}

function saveQueueSnapshot(queue, queryKey, pageSize) {
  const now = Date.now();
  pruneQueueSnapshots(now);
  while (queueSnapshots.size >= REVIEW_QUEUE_MAX_SNAPSHOTS) {
    queueSnapshots.delete(queueSnapshots.keys().next().value);
  }
  const id = randomUUID();
  queueSnapshots.set(id, {
    id,
    ...queue,
    pageSize,
    queryKey,
    expiresAt: now + REVIEW_QUEUE_SNAPSHOT_TTL_MS,
  });
  return queueSnapshots.get(id);
}

// Paginated requests reuse the same normalized rows, so pages cannot reorder between reads.
export async function readQueuePage({ limit, cursor, query = {}, now }, gatherQueue) {
  const requestedLimit = validatePageSize(limit);
  const queryKey = queryKeyFor(query);

  if (cursor !== undefined && cursor !== null) {
    const payload = decodeQueueCursor(cursor);
    pruneQueueSnapshots();
    const snapshot = queueSnapshots.get(payload.snapshotId);
    if (!snapshot || snapshot.expiresAt <= Date.now()) {
      queueSnapshots.delete(payload.snapshotId);
      throw new ServerError('Review queue snapshot expired; restart pagination', {
        status: 409,
        code: 'CURSOR_EXPIRED',
      });
    }
    if (snapshot.queryKey !== queryKey) {
      throw new ServerError('Review queue query changed; restart pagination', {
        status: 400,
        code: 'CURSOR_QUERY_MISMATCH',
      });
    }
    if (requestedLimit !== null && requestedLimit !== snapshot.pageSize) {
      throw new ServerError('Review queue page size changed; restart pagination', {
        status: 400,
        code: 'CURSOR_QUERY_MISMATCH',
      });
    }
    return pageFromSnapshot(snapshot, payload.offset);
  }

  const queue = await gatherQueue(query, { now });
  if (requestedLimit === null) return queue;

  const snapshot = saveQueueSnapshot(queue, queryKey, requestedLimit);
  return pageFromSnapshot(snapshot, 0);
}
