/**
 * Normalize source-owned Review Queue obligations into a cross-domain projection.
 *
 * Producers read their live services independently, so one failed read leaves
 * other sources usable. Only presentation decisions are persisted by the queue.
 */

import { ServerError } from '../lib/errorHandler.js';
import * as reviewQueueTriageStore from './reviewQueueTriageStore.js';
import { isTerminalThreadStatus } from '../lib/brainThreads.js';
import { mutateQueueTriage, readQueueTriageForProjection } from './reviewQueueActions.js';
import { ACTION_KINDS, PRODUCERS_BY_SOURCE, SEVERITY_ORDER, gatherQueueSources } from './reviewQueueProducers.js';
import { readQueuePage, sourceShownCounts } from './reviewQueueSnapshots.js';

export { MAX_REVIEW_QUEUE_SNOOZE_MS, promoteAskQueueItem, resolveQueueItem } from './reviewQueueActions.js';
export { REVIEW_QUEUE_SOURCE_READ_LIMIT, __resetAlertsCache } from './reviewQueueProducers.js';
export { REVIEW_QUEUE_MAX_PAGE_SIZE, __resetQueueSnapshots } from './reviewQueueSnapshots.js';

const OPERATION_LABELS = Object.freeze({
  brain: 'Done',
  ask: 'Promote',
  cos: 'Approve',
  drafts: 'Approve',
  stacker: 'Review',
  x: 'Review',
  health: 'Investigate',
  backup: 'Retry',
  review: 'Review',
  notifications: 'Review',
  threads: 'Complete',
  todo: 'Complete',
  history: 'History',
  feedback: 'Rate',
  github: 'Review',
});

const PRIORITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const canonicalPriority = (value) => {
  if (typeof value !== 'string') return null;
  if (Object.hasOwn(PRIORITY_ORDER, value)) return value;
  const normalized = value.toLowerCase();
  if (normalized === 'urgent' || normalized === 'high') return 'HIGH';
  if (normalized === 'normal' || normalized === 'medium') return 'MEDIUM';
  if (normalized === 'low') return 'LOW';
  return null;
};

const firstText = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() || null;

const isCanonicalScalar = (value) => typeof value === 'string'
  || (typeof value === 'number' && Number.isFinite(value));

const firstScalar = (...values) => values.find(isCanonicalScalar) ?? null;

function semanticOperations(producer, mapped, raw) {
  if (Array.isArray(mapped.operations)) return mapped.operations;

  const canResolve = Boolean(
    producer.resolve
    && (!producer.actionFor || producer.actionFor(raw)),
  );
  const operationId = producer.source === 'ask'
    ? 'promote'
    : canResolve
      ? 'resolve'
      : producer.source === 'health'
        ? 'investigate'
        : producer.source === 'backup'
          ? 'retry'
          : 'review';
  const targets = Array.isArray(mapped.promoteTargets) ? mapped.promoteTargets : null;
  return [{
    id: operationId,
    label: OPERATION_LABELS[producer.source],
    available: operationId !== 'investigate' && operationId !== 'retry',
    ...(targets ? { targets } : {}),
  }];
}

function normalizeQueueItem(producer, raw, mapped) {
  const prefix = `${producer.source}:`;
  const sourceRef = firstText(
    mapped.sourceRef,
    raw?.id == null ? null : String(raw.id),
    typeof mapped.id === 'string' && mapped.id.startsWith(prefix) ? mapped.id.slice(prefix.length) : null,
  );
  const priority = canonicalPriority(raw?.priority ?? mapped.priority);
  const required = typeof mapped.required === 'boolean'
    ? mapped.required
    : typeof raw?.required === 'boolean'
    ? raw.required
    : !(raw?.recommendation === true || raw?.isRecommendation === true || raw?.optional === true);
  const dueAt = firstText(raw?.dueAt, raw?.due, raw?.deadline, raw?.scheduledFor, mapped.dueAt);
  const revision = firstScalar(
    raw?.revision,
    raw?.version,
    raw?.updatedAt,
    raw?.updated_at,
    raw?.capturedAt,
    raw?.createdAt,
    raw?.timestamp,
    mapped.revision,
    mapped.timestamp,
  );
  const occurrence = firstScalar(raw?.occurrence, raw?.occurrenceId, mapped.occurrence);
  const operations = semanticOperations(producer, mapped, raw);
  const availableOperation = operations.find((entry) => entry.available)?.label;

  return {
    ...mapped,
    sourceRef,
    actionKind: mapped.actionKind || ACTION_KINDS[producer.source],
    reason: firstText(raw?.reason, mapped.summary, mapped.title),
    nextAction: firstText(
      raw?.nextAction,
      mapped.nextAction,
      mapped.action,
      mapped.promoteTargets?.length ? 'Promote' : null,
      availableOperation,
      OPERATION_LABELS[producer.source],
    ),
    priority,
    dueAt,
    revision,
    occurrence,
    required,
    isRecommendation: typeof mapped.isRecommendation === 'boolean' ? mapped.isRecommendation : !required,
    operations,
    availability: mapped.availability || 'available',
    available: typeof mapped.available === 'boolean' ? mapped.available : true,
  };
}

/**
 * The queue row id is a projection identity. Triage needs the source's
 * canonical action kind/reference plus occurrence and revision so a later
 * occurrence of the same source record is not hidden by an older decision.
 */
export function queueActionIdentity(item) {
  const actionKind = firstText(item?.actionKind, item?.source) || 'review';
  const sourceRef = firstText(item?.sourceRef, item?.id) || '';
  return {
    actionKey: `${actionKind}:${sourceRef}`,
    occurrence: item?.occurrence ?? null,
    revision: item?.revision ?? null,
  };
}

const emptyTriageState = Object.freeze({
  snoozedUntil: null,
  dismissed: false,
  deliveryGeneration: 0,
});

function queueItemSupportsTriage(item) {
  if (!item || item.source === 'history' || item.availability === 'unavailable' || item.available === false) {
    return false;
  }
  if (item.source === 'threads' && isTerminalThreadStatus(item.meta?.localStatus)) return false;
  if (item.source === 'todo' && item.meta?.status && item.meta.status !== 'pending') return false;
  return true;
}

function triageOperationsFor(item, { snoozed = false } = {}) {
  if (!queueItemSupportsTriage(item)) return [];
  return [
    snoozed
      ? { id: 'unsnooze', label: 'Unsnooze', available: true }
      : { id: 'snooze', label: 'Snooze', available: true },
    ...(item.isRecommendation === true
      ? [{ id: 'dismiss', label: 'Dismiss', available: true }]
      : []),
  ];
}

/**
 * Apply durable presentation markers without changing the source-owned row.
 * This is exported as a pure boundary so expiry and occurrence rollover can
 * be tested with an injected clock.
 */
export function applyQueueTriage(items, entries = [], now = new Date(), { includeSnoozed = false } = {}) {
  const byIdentity = new Map(
    entries
      .map((entry) => {
        const normalized = reviewQueueTriageStore.normalizeReviewQueueTriage(entry);
        return normalized ? [reviewQueueTriageStore.triageIdentityKey(normalized), normalized] : null;
      })
      .filter(Boolean),
  );
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const currentTime = Number.isFinite(nowMs) ? nowMs : Date.now();

  return items.flatMap((item) => {
    const identity = queueActionIdentity(item);
    const state = byIdentity.get(reviewQueueTriageStore.triageIdentityKey(identity)) || emptyTriageState;
    const delivery = byIdentity.get(reviewQueueTriageStore.triageIdentityKey({
      actionKey: `delivery:${item.id}`, occurrence: item.occurrence, revision: '',
    }));
    const snoozedUntilMs = state.snoozedUntil ? Date.parse(state.snoozedUntil) : NaN;
    const snoozed = Number.isFinite(snoozedUntilMs) && snoozedUntilMs > currentTime;
    const dismissed = state.dismissed && item.isRecommendation === true;
    if (dismissed || (includeSnoozed ? !snoozed : snoozed)) return [];
    return [{
      ...item,
      triage: {
        snoozedUntil: state.snoozedUntil,
        dismissed: state.dismissed,
        deliveryGeneration: delivery?.deliveryGeneration ?? state.deliveryGeneration,
      },
      triageOperations: triageOperationsFor(item, { snoozed }),
    }];
  });
}

// These row prefixes are shared by the adapters for stored items and notifications.
const ADAPTED_TRIAGE_SOURCES = new Set(['cos', 'memory', 'goal-fidelity', 'plan', 'content', 'autopilot']);

function triageProducerSources(source) {
  const sources = Object.hasOwn(PRODUCERS_BY_SOURCE, source) ? [source] : [];
  if (ADAPTED_TRIAGE_SOURCES.has(source)) sources.push('review', 'notifications');
  return new Set(sources);
}

const validDateMs = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

function compareQueueItems(a, b, now = Date.now()) {
  const required = Number(Boolean(b.required)) - Number(Boolean(a.required));
  if (required !== 0) return required;

  const severity = (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2);
  if (severity !== 0) return severity;

  const dueA = validDateMs(a.dueAt);
  const dueB = validDateMs(b.dueAt);
  const dueBucket = (due) => due === null ? 2 : due < now ? 0 : 1;
  const dueClass = dueBucket(dueA) - dueBucket(dueB);
  if (dueClass !== 0) return dueClass;
  if (dueA !== null && dueB !== null && dueA !== dueB) return dueA - dueB;

  const priority = (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
  if (priority !== 0) return priority;

  return String(a.id || '').localeCompare(String(b.id || ''));
}

function deduplicateItems(items) {
  const byId = new Map();
  for (const item of items) {
    const previous = byId.get(item.id);
    if (!previous || compareQueueItems(item, previous) < 0) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function queueCounts(items) {
  const counts = { total: items.length, critical: 0, high: 0 };
  for (const item of items) {
    if (item.severity === 'critical') counts.critical++;
    else if (item.severity === 'high') counts.high++;
  }
  return counts;
}

async function gatherFullQueue(query = {}, { applyTriageState = true, now = new Date(), onlySources } = {}) {
  const view = typeof query.view === 'string' && query.view ? query.view : null;
  const { results, clock } = await gatherQueueSources({ view, now, onlySources }, normalizeQueueItem);

  let items = deduplicateItems(results.flatMap((result) => result.items));
  if (applyTriageState) {
    const sourceReadComplete = results.every((result) => result.error === null && !result.truncation);
    const preserveTriageActionKinds = results.flatMap((result) => [
      ...(result.preserveTriageActionKinds || []),
      ...(result.incomplete && ACTION_KINDS[result.source] ? [ACTION_KINDS[result.source]] : []),
    ]);
    const preserveTriageSources = results.filter((result) => result.incomplete).map((result) => result.source);
    const triageEntries = await readQueueTriageForProjection({
      now: clock,
      currentItems: items,
      queueActionIdentity,
      pruneOrphans: sourceReadComplete && (view === null || view === 'all'),
      preserveTriageActionKinds,
      preserveTriageSources,
    });
    items = applyQueueTriage(items, triageEntries, clock, { includeSnoozed: view === 'snoozed' });
  }
  items.sort((a, b) => compareQueueItems(a, b, clock.getTime()));
  const shownCounts = sourceShownCounts(items);
  const sources = {};
  const totalsBySource = {};

  for (const result of results) {
    const shown = shownCounts[result.source] || 0;
    const knownTotal = result.error === null && !result.truncation && !result.incomplete && Number.isSafeInteger(result.total)
      ? shown
      : null;
    totalsBySource[result.source] = knownTotal;
    sources[result.source] = {
      label: result.label,
      total: knownTotal,
      shown,
      error: result.error,
      availability: result.error ? 'unavailable' : result.incomplete ? 'partial' : 'available',
      available: !result.error,
      truncation: Boolean(result.truncation),
      incomplete: Boolean(result.incomplete),
      lowerBound: result.error ? 0 : shown,
    };
  }

  const partial = results.some((result) => result.error || result.truncation || result.incomplete);
  return {
    items,
    total: partial ? null : items.length,
    totalsBySource,
    sources,
    nextCursor: null,
    partial,
    counts: queueCounts(items),
    generatedAt: clock.toISOString(),
  };
}

async function readTriageTarget(queueItemId, source, now) {
  const producerSources = triageProducerSources(source);
  const queue = await gatherFullQueue({}, { applyTriageState: false, now, onlySources: producerSources });
  const item = queue.items.find((candidate) => candidate.id === queueItemId);
  if (!item) {
    if ([...producerSources].some((producerSource) => queue.sources[producerSource]?.error)) {
      throw new ServerError(`Cannot triage ${source} while a backing source is unavailable`, {
        status: 503,
        code: 'SOURCE_UNAVAILABLE',
      });
    }
    throw new ServerError(`Review queue item not found: ${queueItemId}`, { status: 404, code: 'NOT_FOUND' });
  }
  return { item, identity: queueActionIdentity(item) };
}

export async function triageQueueItem(queueItemId, operation, input = {}, { now } = {}) {
  return mutateQueueTriage(readTriageTarget, queueItemId, operation, input, now);
}

/**
 * Build the cross-domain review queue. A request without pagination parameters
 * retains the original full-list response. Passing `limit` opts into a
 * short-lived process-local snapshot with an opaque offset cursor.
 */
export async function buildQueue(options = {}) {
  return readQueuePage(options, gatherFullQueue);
}
