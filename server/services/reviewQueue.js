/**
 * Cross-domain Review Queue (M42 P5) — the "inbox zero" aggregator.
 *
 * Where review.js manages *stored* review items (todos/alerts/briefing/cos that
 * producers push in via cosEvents), this module *live-pulls* the things across
 * PortOS that are currently waiting on the user and normalizes them into one
 * list. It reads each producer's existing service on demand — nothing is
 * persisted here — so the queue always reflects live state.
 *
 * Each producer is gathered independently and defensively: a single producer
 * throwing (or its data file being absent) degrades that one source to an
 * unavailable projection rather than sinking the whole queue. Every row keeps
 * the legacy fields and adds a canonical action projection:
 *
 *   { id, source, sourceRef, actionKind, title, reason, nextAction,
 *     severity, priority, dueAt, revision, occurrence, operations }
 *
 * `drillTo` is a client route the UI deep-links to so "drill-down" works without
 * the queue needing to know how to render each domain.
 *
 * A producer may also declare an inline `action` (a verb label) + `resolve(rawId)`
 * primitive, in which case the row carries `action` and `resolveQueueItem()` can
 * accept/promote it in place without leaving the Review Hub (issue #709 follow-up
 * to the v1 read-only aggregator). Sources with no clean local resolve (health
 * alerts are live-computed and clear when the condition does; a failed backup
 * retries by re-running with settings) stay drill-down + session-dismiss only.
 */

import { randomUUID } from 'node:crypto';
import * as brain from './brain.js';
import * as askConversations from './askConversations.js';
import * as cosTaskStore from './cosTaskStore.js';
import * as messageDrafts from './messageDrafts.js';
import * as proactiveAlerts from './proactiveAlerts.js';
import * as backup from './backup.js';
import * as identity from './identity.js';
import * as reviewService from './review.js';
import * as notifications from './notifications.js';
import * as stackerNews from './stackerNews.js';
import * as x from './x.js';
import { promoteLatestAssistantTurn } from './askPromote.js';
import { adaptNotification, adaptStoredReviewItem } from './reviewActionAdapters.js';
import { ServerError } from '../lib/errorHandler.js';
import { safeJSONParse } from '../lib/fileUtils.js';

// Producers are read with a bounded upper limit. The queue reports a lower
// bound, rather than pretending that a full count is known, when a producer
// fills this window. Pagination then slices the normalized snapshot, not a
// fresh set of source reads, so adjacent pages cannot reorder underneath a
// caller.
export const REVIEW_QUEUE_SOURCE_READ_LIMIT = 100;
export const REVIEW_QUEUE_MAX_PAGE_SIZE = 100;
const REVIEW_QUEUE_SOURCE_PROBE_LIMIT = REVIEW_QUEUE_SOURCE_READ_LIMIT + 1;
const REVIEW_QUEUE_SNAPSHOT_TTL_MS = 30_000;
const REVIEW_QUEUE_MAX_SNAPSHOTS = 100;

const ACTION_KINDS = Object.freeze({
  brain: 'brain.classify',
  ask: 'ask.promote',
  cos: 'cos.approve',
  drafts: 'message.approve',
  stacker: 'stacker.review',
  x: 'x.review',
  health: 'health.investigate',
  backup: 'backup.retry',
  review: 'review.triage',
  notifications: 'notification.action',
});

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
});

const PRIORITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// generateAlerts() runs a full system-health sweep (CPU/disk/PM2/goals/usage),
// so cache it briefly — the Review Hub can be polled, and a stale-by-seconds
// alert list is fine here (the dedicated health views read it live).
const ALERTS_TTL_MS = 30_000;
let alertsCache = { data: null, timestamp: 0 };

async function getAlertsCached() {
  if (alertsCache.data && (Date.now() - alertsCache.timestamp) < ALERTS_TTL_MS) {
    return alertsCache.data;
  }
  const result = await proactiveAlerts.generateAlerts();
  alertsCache = { data: result, timestamp: Date.now() };
  return result;
}

// Test seam: drop the alerts cache so a suite can assert fresh per-case data.
export function __resetAlertsCache() {
  alertsCache = { data: null, timestamp: 0 };
}

// Active goals are fetched once per buildQueue() (not per Ask row) so the
// inline goal picker on Ask rows has targets to offer. getGoals() lazily
// migrates the store, so we read it once and reuse the result while gathering.
// A goal-store failure degrades to "no goal targets" rather than sinking Ask.
async function getActiveGoalOptions() {
  const data = await identity.getGoals().catch((err) => {
    console.error(`❌ Review queue: goal options failed: ${err.message}`);
    return null;
  });
  const goals = Array.isArray(data?.goals) ? data.goals : [];
  // Guard each entry — a malformed `null`/non-object goal would otherwise throw
  // on `g.status` here, and because this runs *before* the per-producer
  // Promise.all catch in buildQueue, that throw would sink the whole queue
  // rather than degrading goal targets to empty.
  return goals
    .filter((g) => g && typeof g === 'object' && g.status === 'active' && typeof g.id === 'string' && g.id)
    .map((g) => ({ id: g.id, title: typeof g.title === 'string' && g.title ? g.title : '(untitled goal)' }));
}

/**
 * Producer registry. Each entry knows how to gather its raw items and map one
 * into the normalized queue shape. `gather` returns the raw list (already
 * filtered to "needs attention"); `map` normalizes a single raw item.
 */
const PRODUCERS = [
  {
    source: 'brain',
    label: 'Brain inbox',
    drillTo: '/brain/inbox',
    // Marking the entry done clears it from the needs-review queue.
    actionLabel: 'Done',
    async resolve(id) {
      return brain.markInboxDone(id);
    },
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // Inbox entries the auto-classifier couldn't place — they need a human
      // to pick a destination.
      return brain.getInboxLog({ status: 'needs_review', limit });
    },
    map(entry) {
      const text = (entry.capturedText || '').trim();
      // Surface where the capture came from (brain_ui / voice / a managed app)
      // so the user can triage by origin. Absent on legacy entries — omit the
      // field entirely rather than fabricate one (absent vs empty).
      const captureSource = typeof entry.source === 'string' && entry.source.trim()
        ? entry.source.trim()
        : null;
      return {
        id: `brain:${entry.id}`,
        title: 'Inbox item needs classification',
        summary: text.slice(0, 200),
        timestamp: entry.capturedAt || entry.createdAt || null,
        severity: 'normal',
        drillTo: '/brain/inbox',
        ...(captureSource ? { meta: { captureSource } } : {})
      };
    }
  },
  {
    source: 'ask',
    label: 'Ask answers',
    drillTo: '/ask',
    // Ask carries no single `action`/`resolve` primitive (the row's
    // `setPromoted` only *pins* the conversation against expiry, which the Ask
    // UI labels "Pin", not promote-to-target). Promotion is instead offered
    // inline via `promoteTargets` + `goalOptions`: brain/task in one click and
    // goal via a picker (see map() below). Drilling into /ask still works for a
    // per-turn promote the queue's latest-turn shortcut doesn't cover.
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // Conversations with a promotable assistant answer that haven't been
      // promoted to brain/task/goal. Gate on assistantTurnCount, NOT turnCount:
      // an Ask conversation whose stream errored (or whose client disconnected)
      // before the assistant turn persisted still has the user turn (turnCount
      // > 0), but promoteLatestAssistantTurn would fail with NO_ASSISTANT_TURN —
      // so advertising a promote action on it would be a dead-end button.
      const convs = await askConversations.listConversations({ limit });
      return {
        items: (Array.isArray(convs) ? convs : []).filter(c => !c.promoted && (c.assistantTurnCount || 0) > 0),
        truncated: Array.isArray(convs) && convs.length >= limit,
      };
    },
    // Inline promote targets the UI can offer without a per-turn drill-down.
    // The queue picks the conversation's latest assistant turn server-side, so
    // brain/task need no extra choice. `goal` also promotes the latest turn but
    // needs a goalId, so the row additionally carries `goalOptions` and the UI
    // renders a goal picker; goal is only offered when at least one active goal
    // exists (gatherContext.goalOptions, populated once per buildQueue).
    promoteTargets: ['brain', 'task'],
    map(conv, index, ctx) {
      const turnCount = Number.isFinite(conv.turnCount) ? conv.turnCount : null;
      const goalOptions = Array.isArray(ctx?.goalOptions) ? ctx.goalOptions : [];
      return {
        id: `ask:${conv.id}`,
        title: 'Ask answer ready to promote',
        summary: conv.title || '(untitled conversation)',
        timestamp: conv.updatedAt || conv.createdAt || null,
        severity: 'normal',
        // Promotion is still available from Ask, but an optional answer is
        // not a required user action in the canonical queue.
        required: false,
        isRecommendation: true,
        drillTo: `/ask/${conv.id}`,
        // Only advertise the goal target (and its picker options) when there's
        // at least one active goal to promote into — an empty picker would be a
        // dead-end button.
        ...(goalOptions.length ? { promoteTargets: ['brain', 'task', 'goal'], goalOptions } : {}),
        ...(turnCount != null ? { meta: { turnCount } } : {})
      };
    }
  },
  {
    source: 'cos',
    label: 'CoS approvals',
    drillTo: '/cos/tasks',
    actionLabel: 'Approve',
    // approveTask resolves to an `{ error }` object (not a throw) when the task
    // can't be approved; surface that as a failed resolve.
    async resolve(id) {
      const result = await cosTaskStore.approveTask(id);
      if (result && result.error) throw new ServerError(result.error, { status: 409, code: 'CONFLICT' });
      return result;
    },
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // Internal CoS tasks parked awaiting the user's approval before they run.
      const { awaitingApproval = [] } = await cosTaskStore.getCosTasks();
      return (Array.isArray(awaitingApproval) ? awaitingApproval : []).slice(0, limit);
    },
    map(task) {
      // Surface the task priority as a triage badge. Only HIGH/MEDIUM/LOW are
      // meaningful — anything else (or absent) is omitted rather than guessed.
      const priority = ['HIGH', 'MEDIUM', 'LOW'].includes(task.priority) ? task.priority : null;
      return {
        id: `cos:${task.id}`,
        title: 'CoS task pending approval',
        summary: (task.description || '').slice(0, 200),
        timestamp: task.createdAt || null,
        severity: task.priority === 'HIGH' ? 'high' : 'normal',
        drillTo: '/cos/tasks',
        ...(priority ? { meta: { priority } } : {})
      };
    }
  },
  {
    source: 'drafts',
    label: 'Message drafts',
    drillTo: '/messages/drafts',
    // Approve (not send) — clears it from the awaiting-review queue without an
    // outward side effect; the user still triggers the actual send from /messages.
    actionLabel: 'Approve',
    actionFor: (draft) => draft.status === 'pending_review',
    async resolve(id) {
      return messageDrafts.approveDraft(id);
    },
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // Drafts the user (or an AI) prepared that haven't been sent yet. Today
      // messageDrafts only emits 'draft' (vs 'approved'); 'pending_review' is
      // matched ahead of the producer adding it. The multi-status filter is
      // pushed down to listDrafts so the whole store isn't loaded + filtered
      // in memory on every Review Hub load.
      const drafts = await messageDrafts.listDrafts({ status: ['draft', 'pending_review'] });
      return (Array.isArray(drafts) ? drafts : []).slice(0, limit);
    },
    map(draft) {
      // Show who/where the draft is headed so the user can triage without
      // opening it: the first recipient, plus the channel it'd send through.
      // Each is omitted when absent rather than rendered as an empty string.
      const recipient = Array.isArray(draft.to) && typeof draft.to[0] === 'string' && draft.to[0].trim()
        ? draft.to[0].trim()
        : null;
      const channel = typeof draft.sendVia === 'string' && draft.sendVia.trim()
        ? draft.sendVia.trim()
        : null;
      const meta = {};
      if (recipient) meta.recipient = recipient;
      if (channel) meta.channel = channel;
      return {
        // Prefix matches `source` ('drafts') so resolveQueueItem's
        // split-on-first-colon dispatch lands on this producer.
        id: `drafts:${draft.id}`,
        title: draft.status === 'pending_review' ? 'Draft awaiting review' : 'Unsent message draft',
        summary: draft.subject || (draft.body || '').slice(0, 120) || '(no subject)',
        timestamp: draft.updatedAt || draft.createdAt || null,
        severity: 'normal',
        required: draft.status === 'pending_review',
        isRecommendation: draft.status !== 'pending_review',
        drillTo: '/messages/drafts',
        nextAction: draft.status === 'pending_review' ? 'Approve' : 'Open draft',
        ...(Object.keys(meta).length ? { meta } : {})
      };
    }
  },
  {
    source: 'review',
    label: 'Stored review obligations',
    drillTo: '/review',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      const pendingItems = await reviewService.getItems({ status: 'pending' });
      const items = (Array.isArray(pendingItems) ? pendingItems : [])
        .map(adaptStoredReviewItem)
        .filter(Boolean);
      return {
        items,
        truncated: items.length > limit,
      };
    },
    map(item) {
      return item;
    },
  },
  {
    source: 'notifications',
    label: 'Actionable notifications',
    drillTo: '/review',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // Filter before applying the queue cap. A busy history stream must not
      // hide a source-owned approval that happens to be older than it.
      const unread = await notifications.getNotifications({ unreadOnly: true });
      const items = (Array.isArray(unread) ? unread : [])
        .map(adaptNotification)
        .filter(Boolean);
      return {
        items,
        truncated: items.length > limit,
      };
    },
    map(item) {
      return item;
    },
  },
  {
    source: 'stacker',
    label: 'Stacker News approvals',
    drillTo: '/stacker-news',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      return stackerNews.listPendingReviewActions({ limit });
    },
    map(action) {
      return {
        id: `stacker:${action.id}`,
        title: `${action.kind.replaceAll('_', ' ')} awaiting review`,
        summary: action.itemTitle || action.payload?.title || action.payload?.body?.slice(0, 200) || `Account: ${action.accountLabel}`,
        timestamp: action.createdAt || null,
        severity: 'normal',
        drillTo: `/stacker-news/${action.accountId}/review`,
        meta: { account: action.accountLabel },
      };
    },
  },
  {
    source: 'x',
    label: 'X drafts',
    drillTo: '/x',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      return x.listPendingReviewActions({ limit });
    },
    map(draft) {
      return {
        id: `x:${draft.id}`,
        title: 'X draft awaiting review',
        summary: draft.payload?.body?.slice(0, 200) || '(empty draft)',
        timestamp: draft.createdAt || null,
        severity: 'normal',
        drillTo: `/x/${draft.accountId}/drafts`,
        meta: { account: draft.accountLabel || `@${draft.username}` },
      };
    },
  },
  {
    source: 'health',
    label: 'Health anomalies',
    drillTo: '/system-resources/overview',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // System/health alerts; only surface the ones worth interrupting for.
      const { alerts = [] } = await getAlertsCached();
      const byId = new Map();
      for (const alert of alerts) {
        if (alert.severity !== 'critical' && alert.severity !== 'high') continue;
        if (typeof alert.id !== 'string' || !alert.id.trim()) {
          throw new Error('Health alert identity is unavailable');
        }
        // Deduplicate before the per-source cap/count. If two observations of
        // a condition disagree, retain its strongest severity.
        const previous = byId.get(alert.id);
        if (!previous || SEVERITY_ORDER[alert.severity] < SEVERITY_ORDER[previous.severity]) {
          byId.set(alert.id, alert);
        }
      }
      return [...byId.values()].slice(0, limit);
    },
    // The collector owns semantic identity; the queue only namespaces it.
    map(alert) {
      // Surface the alert category (system_resource / goal_stall / …) so the
      // user can tell at a glance what kind of anomaly it is. Absent → omitted.
      const alertType = typeof alert.type === 'string' && alert.type.trim()
        ? alert.type.trim()
        : null;
      return {
        id: `health:${alert.id}`,
        title: alert.title || `${alert.type || 'System'} alert`,
        summary: (alert.detail || alert.message || '').slice(0, 200),
        timestamp: alert.timestamp || null,
        severity: alert.severity === 'critical' ? 'critical' : 'high',
        drillTo: alert.type === 'system_resource'
          ? '/system-resources/overview'
          : alert.link || '/system-resources/overview',
        ...(alertType ? { meta: { alertType } } : {})
      };
    }
  },
  {
    source: 'backup',
    label: 'Failed backups',
    drillTo: '/settings/backup',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // A backup needing acknowledgement is either a full failure (status
      // 'error') or a degraded run (status 'degraded' — file rsync succeeded but
      // the DB dump failed; it also carries an `error` string). Both warrant a
      // queue item, but they map to different severities below.
      const state = await backup.getState();
      const needsAttention = state && (state.status === 'error' || state.status === 'degraded' || state.error);
      return needsAttention ? [state].slice(0, limit) : [];
    },
    map(state) {
      // Degraded = files saved, DB dump failed → a warning, not a full failure.
      const degraded = state.status === 'degraded';
      return {
        id: 'backup:last-run',
        title: degraded ? 'Backup degraded (DB dump failed)' : 'Backup failed',
        summary: (state.error || 'The most recent backup did not complete.').slice(0, 200),
        timestamp: state.lastRun || null,
        severity: degraded ? 'normal' : 'high',
        drillTo: '/settings/backup'
      };
    }
  }
];

const SEVERITY_ORDER = { critical: 0, high: 1, normal: 2 };

/**
 * Gather one producer into normalized, capped rows. Never throws — a failing
 * producer degrades to `{ items: [], total: 0, error }` so the aggregate still
 * returns the healthy sources.
 *
 * `ctx` carries cross-producer data computed once per buildQueue (e.g. the
 * active-goal options the Ask producer's goal picker offers), passed through to
 * `map`. A row's `map()` may also override `promoteTargets` (the Ask row adds
 * `goal` only when goals exist), so the map result is spread AFTER the
 * producer-level default.
 */
const canonicalPriority = (value) =>
  typeof value === 'string' && Object.hasOwn(PRIORITY_ORDER, value) ? value : null;

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
  const priority = canonicalPriority(raw?.priority);
  const required = typeof mapped.required === 'boolean'
    ? mapped.required
    : typeof raw?.required === 'boolean'
    ? raw.required
    : !(raw?.recommendation === true || raw?.isRecommendation === true || raw?.optional === true);
  const dueAt = firstText(raw?.dueAt, raw?.due, raw?.deadline, raw?.scheduledFor);
  const revision = firstScalar(raw?.revision, raw?.version, raw?.updatedAt, raw?.updated_at, raw?.capturedAt, raw?.createdAt);
  const occurrence = firstScalar(raw?.occurrence, raw?.occurrenceId);
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
 * Gather one producer into normalized rows. A producer may return either an
 * array or `{ items, truncated }` when it filtered a bounded upstream read.
 * Totals are nullable whenever the read filled its bound: the collected rows
 * are a lower bound, not evidence that the source is exhausted.
 */
async function gatherProducer(producer, ctx = {}) {
  const gathered = await producer.gather(REVIEW_QUEUE_SOURCE_PROBE_LIMIT);
  const descriptor = Array.isArray(gathered) ? { items: gathered } : gathered;
  const rawItems = Array.isArray(descriptor?.items) ? descriptor.items : [];
  const truncated = descriptor?.truncated === true || rawItems.length > REVIEW_QUEUE_SOURCE_READ_LIMIT;
  const list = rawItems.slice(0, REVIEW_QUEUE_SOURCE_READ_LIMIT);
  const items = list.map((item, index) => {
    const mapped = {
      source: producer.source,
      sourceLabel: producer.label,
      ...(Array.isArray(producer.promoteTargets) && producer.promoteTargets.length
        ? { promoteTargets: producer.promoteTargets }
        : {}),
      ...producer.map(item, index, ctx),
      ...(producer.actionLabel && producer.resolve
        && (!producer.actionFor || producer.actionFor(item))
        ? { action: producer.actionLabel }
        : {})
    };
    return normalizeQueueItem(producer, item, mapped);
  });
  return {
    items,
    total: truncated ? null : list.length,
    lowerBound: list.length,
    truncation: truncated,
  };
}

const PRODUCERS_BY_SOURCE = Object.fromEntries(PRODUCERS.map(p => [p.source, p]));

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

// Test seam: snapshots are intentionally process-local and short-lived.
export function __resetQueueSnapshots() {
  queueSnapshots.clear();
}

/**
 * Accept/promote a single queue row in place. `queueItemId` is the row's
 * normalized id (`<source>:<rawId>`); we split on the FIRST colon so raw ids
 * that themselves contain colons survive. Throws a 4xx ServerError when the
 * source is unknown, has no inline resolve, or the underlying primitive can't
 * find the record — so the route surfaces a clean status instead of a 500.
 */
async function resolveMemoryAction(id, operation) {
  const memory = await import('./memory.js');
  const result = await memory[operation === 'approve' ? 'approveMemory' : 'rejectMemory'](id);
  if (result?.success === false || result?.error) {
    const notFound = /not found/i.test(String(result.error || ''));
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

const SOURCE_ACTIONS = Object.freeze({
  memory: Object.freeze({
    approve: (id) => resolveMemoryAction(id, 'approve'),
    reject: (id) => resolveMemoryAction(id, 'reject'),
  }),
  cos: Object.freeze({
    approve: resolveCosApproval,
  }),
});

export async function resolveQueueItem(queueItemId, operation = 'resolve') {
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
    const result = await resolver(rawId);
    if (result == null) {
      throw new ServerError(`${source} item not found: ${rawId}`, { status: 404, code: 'NOT_FOUND' });
    }
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
  return { source, id: queueItemId, resolved: true };
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

  const result = await promoteLatestAssistantTurn({ conversationId, target, goalId });
  return { source, id: queueItemId, promoted: true, target: result.target, ref: result.ref };
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

function sourceShownCounts(items) {
  const shown = {};
  for (const item of items) shown[item.source] = (shown[item.source] || 0) + 1;
  return shown;
}

async function gatherFullQueue() {
  // Fetch active goals once (not per Ask row) so the goal picker on Ask rows
  // has targets. A failure here degrades to no goal targets, not a sunk queue.
  const goalOptions = await getActiveGoalOptions();
  const ctx = { goalOptions };

  const results = await Promise.all(PRODUCERS.map(async (producer) => {
    return gatherProducer(producer, ctx)
      .then((result) => ({ source: producer.source, label: producer.label, ...result, error: null }))
      .catch((err) => {
        const message = String(err?.message || err || 'Source read failed').slice(0, 300);
        console.error(`❌ Review queue: ${producer.source} source failed: ${message}`);
        return {
          source: producer.source,
          label: producer.label,
          items: [],
          total: null,
          lowerBound: 0,
          truncation: false,
          error: message,
        };
      });
  }));

  const items = deduplicateItems(results.flatMap((result) => result.items));
  items.sort((a, b) => compareQueueItems(a, b));
  const shownCounts = sourceShownCounts(items);
  const sources = {};
  const totalsBySource = {};

  for (const result of results) {
    const shown = shownCounts[result.source] || 0;
    const knownTotal = result.error === null && !result.truncation && Number.isSafeInteger(result.total)
      ? shown
      : null;
    totalsBySource[result.source] = knownTotal;
    sources[result.source] = {
      label: result.label,
      total: knownTotal,
      shown,
      error: result.error,
      availability: result.error ? 'unavailable' : 'available',
      available: !result.error,
      truncation: Boolean(result.truncation),
      lowerBound: result.error ? 0 : shown,
    };
  }

  const partial = results.some((result) => result.error || result.truncation);
  return {
    items,
    total: partial ? null : items.length,
    totalsBySource,
    sources,
    nextCursor: null,
    partial,
    counts: queueCounts(items),
    generatedAt: new Date().toISOString(),
  };
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

/**
 * Build the cross-domain review queue. A request without pagination parameters
 * retains the original full-list response. Passing `limit` opts into a
 * short-lived process-local snapshot with an opaque offset cursor.
 */
export async function buildQueue({ limit, cursor, query = {} } = {}) {
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

  const queue = await gatherFullQueue();
  if (requestedLimit === null) return queue;

  const snapshot = saveQueueSnapshot(queue, queryKey, requestedLimit);
  return pageFromSnapshot(snapshot, 0);
}
