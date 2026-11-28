/** Resolve, promote, and triage Review Queue rows using their live source records. */

import * as brainStorage from './brainStorage.js';
import * as cosTaskStore from './cos/cosTaskStore.js';
import { HEALTH_RESOLUTION_PREFIX } from './healthAlertResolutions.js';
import { resolveHealthAlert } from './proactiveAlertSources.js';
import * as reviewService from './review.js';
import * as notifications from './notifications.js';
import { NOTIFICATION_ACTION_POLICY } from '../lib/notificationTypes.js';
import { ServerError } from '../lib/errorHandler.js';
import * as reviewQueueTriageStore from './reviewQueueTriageStore.js';
import { isTerminalThreadStatus } from '../lib/brainThreads.js';
import { ACTION_KINDS, PRODUCERS_BY_SOURCE, __resetAlertsCache } from './reviewQueueProducers.js';
import { invalidateQueueSnapshots, scheduleQueueClockInvalidation } from './reviewQueueSnapshots.js';
import { MAX_REVIEW_QUEUE_SNOOZE_MS } from '../lib/reviewQueueLimits.js';
export { MAX_REVIEW_QUEUE_SNOOZE_MS } from '../lib/reviewQueueLimits.js';

async function resolveMemoryAction(id, operation) {
  const memory = await import('./memory.js');
  const result = await memory[operation === 'approve' ? 'approveMemory' : 'rejectMemory'](id);
  if (result?.success === false || result?.error) {
    const notFound = /not found/i.test(String(result.error || ''));
    if (notFound) {
      // The memory is already gone, so its queue projections are stale either way.
      await reviewService.dismissByReferenceId(id).catch((err) => {
        console.error(`⚠️ Review queue: stale memory projection cleanup failed: ${err.message}`);
      });
      await notifications.removeByMetadata('memoryId', id).catch(() => {});
      // Rejecting a deleted memory is the desired end state; approving one is not.
      if (operation === 'reject') return { success: true, alreadyResolved: true };
    }
    throw new ServerError(result.error || `Memory ${operation} failed`, {
      status: notFound ? 404 : 409,
      code: notFound ? 'NOT_FOUND' : 'CONFLICT',
    });
  }
  return result;
}

async function resolveCosApproval(id) {
  const result = await cosTaskStore.approveTask(id);
  if (result && result.error) throw new ServerError(result.error, { status: 409, code: 'CONFLICT' });
  // Older installs may still have a stored CoS approval row from the former
  // task:ready bridge. The owning approval succeeded, so retire that legacy
  // projection by reference without allowing generic Review completion to
  // mutate the obligation directly.
  await reviewService.dismissByReferenceId(id).catch((err) => {
    console.error(`⚠️ Review queue: legacy CoS projection cleanup failed: ${err.message}`);
  });
  return result;
}

async function resolveThreadAction(id, status) {
  const result = await brainStorage.updateWith('threads', id, (fresh) => {
    const terminal = isTerminalThreadStatus(status);
    return {
      status,
      // Keep Brain's closedAt contract when an Actions button changes only the
      // local thread state. Refs and externalState are deliberately untouched.
      closedAt: terminal
        ? (isTerminalThreadStatus(fresh.status) && fresh.closedAt
          ? fresh.closedAt
          : new Date().toISOString())
        : null,
    };
  });
  return result;
}

/**
 * A required action item may reach the queue as either a stored Review item
 * (`review.createItem`, category-based) or a notification (type-based, see
 * `NOTIFICATION_ACTION_POLICY`) — both are keyed under the same `actionSource`
 * vocabulary, and a queue row never records which origin produced it. Resolve
 * both projections so "Mark resolved" retires the hold regardless of which
 * producer raised it.
 */
async function resolveNotificationHold(actionSource, sourceRef) {
  if (!sourceRef) return [];
  const { notificationReference } = await import('./reviewActionAdapters.js');
  const records = await notifications.getNotifications({ includeHidden: true });
  const matches = (Array.isArray(records) ? records : []).filter((notification) => {
    const policy = NOTIFICATION_ACTION_POLICY[notification.type];
    return policy?.actionSource === actionSource && notificationReference(notification, policy) === sourceRef;
  });
  await Promise.all(matches.map((notification) => notifications.removeNotification(notification.id)));
  return matches;
}

/**
 * Owning primitive for the sourceRef-keyed required holds that have no
 * domain-specific resolution of their own (goal-fidelity, plan questions,
 * content reviews, paused autopilot) — a permanent acknowledge/dismiss, not a
 * change to what the underlying condition means (#8007).
 */
async function resolveSourceOwnedHold(actionSource, sourceRef) {
  const [reviewItems, notificationMatches] = await Promise.all([
    reviewService.dismissByReferenceId(sourceRef),
    resolveNotificationHold(actionSource, sourceRef),
  ]);
  const resolvedCount = (reviewItems?.length || 0) + notificationMatches.length;
  return resolvedCount > 0 ? { resolved: resolvedCount } : null;
}

const SOURCE_ACTIONS = Object.freeze({
  memory: Object.freeze({
    approve: (id) => resolveMemoryAction(id, 'approve'),
    reject: (id) => resolveMemoryAction(id, 'reject'),
  }),
  cos: Object.freeze({
    approve: resolveCosApproval,
  }),
  threads: Object.freeze({
    complete: (id) => resolveThreadAction(id, 'done'),
    reopen: (id) => resolveThreadAction(id, 'open'),
  }),
  todo: Object.freeze({
    complete: (id) => reviewService.completeItem(id),
    reopen: (id) => reviewService.reopenItem(id),
  }),
  health: Object.freeze({
    complete: async (id) => {
      const result = await resolveHealthAlert(id);
      if (result) __resetAlertsCache();
      return result;
    },
  }),
  feedback: Object.freeze({
    rate: async (id, input) => {
      const { submitAgentFeedback } = await import('./cos/cosAgentFeedback.js');
      return submitAgentFeedback(id, input);
    },
  }),
  'goal-fidelity': Object.freeze({
    complete: (id) => resolveSourceOwnedHold('goal-fidelity', id),
  }),
  plan: Object.freeze({
    complete: (id) => resolveSourceOwnedHold('plan', id),
  }),
  content: Object.freeze({
    complete: (id) => resolveSourceOwnedHold('content', id),
  }),
  autopilot: Object.freeze({
    complete: (id) => resolveSourceOwnedHold('autopilot', id),
  }),
  review: Object.freeze({
    complete: (id) => reviewService.dismissItem(id),
  }),
});

/**
 * Accept/promote a single queue row in place. `queueItemId` is the row's
 * normalized id (`<source>:<rawId>`); we split on the FIRST colon so raw ids
 * that themselves contain colons survive. Throws a 4xx ServerError when the
 * source is unknown, has no inline resolve, or the underlying primitive can't
 * find the record — so the route surfaces a clean status instead of a 500.
 */
export async function resolveQueueItem(queueItemId, operation = 'resolve', input = {}) {
  const sep = String(queueItemId).indexOf(':');
  const source = sep === -1 ? queueItemId : queueItemId.slice(0, sep);
  const rawId = sep === -1 ? '' : queueItemId.slice(sep + 1);

  if (operation !== 'resolve') {
    const resolver = SOURCE_ACTIONS[source]?.[operation];
    if (!resolver) {
      throw new ServerError(`No ${operation} action for source "${source}"`, {
        status: 400,
        code: 'BAD_REQUEST',
      });
    }
    const result = await resolver(rawId, input);
    if (result == null) {
      throw new ServerError(`${source} item not found: ${rawId}`, { status: 404, code: 'NOT_FOUND' });
    }
    await clearQueueTriageMarkersForItem(queueItemId).finally(invalidateQueueSnapshots);
    return { source, id: queueItemId, operation, resolved: true };
  }

  const producer = PRODUCERS_BY_SOURCE[source];
  if (!producer || !producer.resolve) {
    throw new ServerError(`No inline action for source "${source}"`, { status: 400, code: 'BAD_REQUEST' });
  }

  const result = await producer.resolve(rawId);
  // Most resolve primitives return null when the record is already gone.
  if (result == null) {
    throw new ServerError(`${producer.label} item not found: ${rawId}`, { status: 404, code: 'NOT_FOUND' });
  }
  await clearQueueTriageMarkersForItem(queueItemId).finally(invalidateQueueSnapshots);
  return { source, id: queueItemId, resolved: true };
}

const REVIEW_QUEUE_TRIAGE_OPERATIONS = new Set(['snooze', 'unsnooze', 'dismiss']);

function queueSourceAndRawId(queueItemId) {
  const value = String(queueItemId || '');
  const sep = value.indexOf(':');
  return {
    source: sep === -1 ? value : value.slice(0, sep),
    rawId: sep === -1 ? '' : value.slice(sep + 1),
  };
}

const TRIAGE_ACTION_KINDS_BY_SOURCE = Object.freeze({
  ...ACTION_KINDS,
  cos: ['cos.approve', 'task.approval'],
  memory: 'memory.approval',
  'goal-fidelity': 'goal-fidelity.review',
  plan: 'plan.question',
  autopilot: 'autopilot.resume',
  content: 'content.review',
});

async function clearQueueTriageMarkersForItem(queueItemId) {
  const { source, rawId } = queueSourceAndRawId(queueItemId);
  const configuredKinds = TRIAGE_ACTION_KINDS_BY_SOURCE[source];
  if (!configuredKinds || !rawId) return;
  const actionKinds = Array.isArray(configuredKinds) ? configuredKinds : [configuredKinds];
  const actionKeys = new Set(actionKinds.map((actionKind) => `${actionKind}:${rawId}`));
  const entries = await reviewQueueTriageStore.listReviewQueueTriage();
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (actionKeys.has(entry.actionKey)) await reviewQueueTriageStore.removeReviewQueueTriage(entry);
  }
}

/**
 * Apply a presentation-only queue decision after re-reading the live source.
 * The mutation never accepts source identity, occurrence, or capability from
 * the client; those values come from the fresh normalized queue row.
 */
export async function mutateQueueTriage(readTriageTarget, queueItemId, operation, input, injectedNow) {
  if (!REVIEW_QUEUE_TRIAGE_OPERATIONS.has(operation)) {
    throw new ServerError(`Unsupported review queue triage operation "${operation}"`, {
      status: 400,
      code: 'BAD_REQUEST',
    });
  }

  const now = injectedNow instanceof Date && Number.isFinite(injectedNow.getTime())
    ? injectedNow
    : new Date();
  let snoozedUntil = null;
  if (operation === 'snooze') {
    const parsed = new Date(input?.snoozedUntil || '');
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
      throw new ServerError('snoozedUntil must be a future ISO timestamp', {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    if (parsed.getTime() - now.getTime() > MAX_REVIEW_QUEUE_SNOOZE_MS) {
      throw new ServerError('snoozedUntil cannot be more than 30 days in the future', {
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    snoozedUntil = parsed.toISOString();
  } else if (input?.snoozedUntil !== undefined) {
    throw new ServerError('snoozedUntil is only valid for the snooze operation', {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const { source } = queueSourceAndRawId(queueItemId);
  const { item, identity } = await readTriageTarget(queueItemId, source, now);
  if (operation === 'dismiss' && item.isRecommendation !== true) {
    throw new ServerError('Only optional recommendations can be dismissed from the queue', {
      status: 400,
      code: 'CAPABILITY_UNAVAILABLE',
    });
  }

  const existingEntries = await reviewQueueTriageStore.listReviewQueueTriage();
  const identityKey = reviewQueueTriageStore.triageIdentityKey(identity);
  const existing = existingEntries.find((entry) => (
    reviewQueueTriageStore.triageIdentityKey(entry) === identityKey
  ));
  const next = {
    ...identity,
    snoozedUntil: existing?.snoozedUntil || null,
    dismissed: existing?.dismissed === true,
    deliveryGeneration: existing?.deliveryGeneration || 0,
  };

  if (operation === 'snooze') next.snoozedUntil = snoozedUntil;
  if (operation === 'unsnooze') next.snoozedUntil = null;
  if (operation === 'dismiss') next.dismissed = true;

  if (!next.snoozedUntil && !next.dismissed && next.deliveryGeneration === 0) {
    await reviewQueueTriageStore.removeReviewQueueTriage(next);
  } else {
    await reviewQueueTriageStore.upsertReviewQueueTriage(next);
  }
  invalidateQueueSnapshots();
  if (operation === 'snooze' && !next.dismissed) scheduleQueueClockInvalidation(Date.parse(next.snoozedUntil));

  return {
    id: queueItemId,
    operation,
    triaged: true,
    triage: {
      snoozedUntil: next.snoozedUntil,
      dismissed: next.dismissed,
      deliveryGeneration: next.deliveryGeneration,
    },
  };
}

// Targets the queue can promote an Ask answer into directly. brain/task pick
// the latest assistant turn with no extra input; goal additionally needs a
// goalId (the row carries `goalOptions` so the UI can supply it). Goal is in
// the allow-list even though the row only advertises it when active goals
// exist — a request with a stale goalId still validates here and 404s in the
// orchestration if the goal is gone.
const ASK_PROMOTE_TARGETS = ['brain', 'task', 'goal'];

/**
 * Promote an Ask queue row's latest assistant answer into a chosen target
 * (brain/task/goal). `queueItemId` is the row id (`ask:<conversationId>`);
 * `target` must be one of `ASK_PROMOTE_TARGETS`. For the `goal` target,
 * `goalId` is required (validated, then resolved against the goal store).
 * The service picks the conversation's latest assistant turn so the client
 * doesn't carry turn ids — a conversation with no assistant answer 404s.
 * Reuses the same promote orchestration the per-turn Ask route uses.
 */
export async function promoteAskQueueItem(queueItemId, target, goalId) {
  const sep = String(queueItemId).indexOf(':');
  const source = sep === -1 ? queueItemId : queueItemId.slice(0, sep);
  const conversationId = sep === -1 ? '' : queueItemId.slice(sep + 1);

  if (source !== 'ask') {
    throw new ServerError(`Promote is only supported for Ask rows, got "${source}"`, { status: 400, code: 'BAD_REQUEST' });
  }
  if (!ASK_PROMOTE_TARGETS.includes(target)) {
    throw new ServerError(`Unsupported promote target "${target}" for Ask`, { status: 400, code: 'BAD_REQUEST' });
  }
  if (target === 'goal' && !goalId) {
    throw new ServerError('goalId is required to promote into a goal', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const { promoteLatestAssistantTurn } = await import('./askPromote.js');
  const result = await promoteLatestAssistantTurn({ conversationId, target, goalId });
  await clearQueueTriageMarkersForItem(queueItemId).finally(invalidateQueueSnapshots);
  return { source, id: queueItemId, promoted: true, target: result.target, ref: result.ref };
}

export async function readQueueTriageForProjection({
  now = new Date(),
  currentItems = [],
  queueActionIdentity,
  pruneOrphans = false,
  preserveTriageActionKinds = [],
  preserveTriageSources = [],
} = {}) {
  const entries = await reviewQueueTriageStore.listReviewQueueTriage();
  if (!Array.isArray(entries)) return [];

  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  for (const entry of entries) {
    if (!entry.dismissed) scheduleQueueClockInvalidation(Date.parse(entry.snoozedUntil));
  }
  const preservedKinds = new Set(preserveTriageActionKinds);
  const preservedSources = new Set(preserveTriageSources);
  const currentKeys = pruneOrphans
    ? new Set(currentItems.map((item) => reviewQueueTriageStore.triageIdentityKey(queueActionIdentity(item))))
    : null;
  const currentDeliveryIds = pruneOrphans
    ? new Set(currentItems.map((item) => String(item.id)))
    : null;
  const removableKeys = new Set();
  for (const entry of entries) {
    // Acknowledgement baselines must survive the disappearance of their alert.
    if (entry.actionKey.startsWith(HEALTH_RESOLUTION_PREFIX)) continue;
    const key = reviewQueueTriageStore.triageIdentityKey(entry);
    const expired = entry.snoozedUntil && Date.parse(entry.snoozedUntil) <= nowMs;
    const unused = expired && entry.dismissed !== true && entry.deliveryGeneration === 0;
    const actionKind = typeof entry.actionKey === 'string' ? entry.actionKey.split(':')[0] : null;
    const deliveryId = entry.delivery && typeof entry.actionKey === 'string'
      ? entry.actionKey.startsWith('delivery:') ? entry.actionKey.slice('delivery:'.length) : null
      : null;
    const orphaned = currentKeys && (
      (entry.delivery && deliveryId && !currentDeliveryIds.has(deliveryId) && !preservedSources.has(deliveryId.split(':')[0]))
      || (!entry.delivery && !currentKeys.has(key) && !preservedKinds.has(actionKind))
    );
    if (unused || orphaned) removableKeys.add(key);
  }
  for (const entry of entries) {
    if (removableKeys.has(reviewQueueTriageStore.triageIdentityKey(entry))) {
      await reviewQueueTriageStore.removeReviewQueueTriage(entry);
    }
  }
  return entries.filter((entry) => !removableKeys.has(reviewQueueTriageStore.triageIdentityKey(entry)));
}
