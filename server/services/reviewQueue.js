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
 * throwing (or its data file being absent) degrades that one source to empty
 * rather than sinking the whole queue. Every row is normalized to:
 *
 *   { id, source, sourceLabel, title, summary, timestamp, severity, drillTo }
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

import * as brain from './brain.js';
import * as askConversations from './askConversations.js';
import * as cosTaskStore from './cosTaskStore.js';
import * as messageDrafts from './messageDrafts.js';
import * as proactiveAlerts from './proactiveAlerts.js';
import * as backup from './backup.js';
import * as identity from './identity.js';
import { promoteLatestAssistantTurn } from './askPromote.js';
import { ServerError } from '../lib/errorHandler.js';

// Per-source cap so one noisy producer can't flood the queue; the UI shows a
// "+N more in <domain>" affordance via the per-source `total` vs `items.length`.
const PER_SOURCE_LIMIT = 25;

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
    action: 'Done',
    async resolve(id) {
      return brain.markInboxDone(id);
    },
    async gather() {
      // Inbox entries the auto-classifier couldn't place — they need a human
      // to pick a destination.
      return brain.getInboxLog({ status: 'needs_review', limit: PER_SOURCE_LIMIT * 2 });
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
    async gather() {
      // Conversations with a promotable assistant answer that haven't been
      // promoted to brain/task/goal. Gate on assistantTurnCount, NOT turnCount:
      // an Ask conversation whose stream errored (or whose client disconnected)
      // before the assistant turn persisted still has the user turn (turnCount
      // > 0), but promoteLatestAssistantTurn would fail with NO_ASSISTANT_TURN —
      // so advertising a promote action on it would be a dead-end button.
      const convs = await askConversations.listConversations({ limit: PER_SOURCE_LIMIT * 2 });
      return convs.filter(c => !c.promoted && (c.assistantTurnCount || 0) > 0);
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
    action: 'Approve',
    // approveTask resolves to an `{ error }` object (not a throw) when the task
    // can't be approved; surface that as a failed resolve.
    async resolve(id) {
      const result = await cosTaskStore.approveTask(id);
      if (result && result.error) throw new ServerError(result.error, { status: 409, code: 'CONFLICT' });
      return result;
    },
    async gather() {
      // Internal CoS tasks parked awaiting the user's approval before they run.
      const { awaitingApproval = [] } = await cosTaskStore.getCosTasks();
      return awaitingApproval;
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
    action: 'Approve',
    async resolve(id) {
      return messageDrafts.approveDraft(id);
    },
    async gather() {
      // Drafts the user (or an AI) prepared that haven't been sent yet. Today
      // messageDrafts only emits 'draft' (vs 'approved'); 'pending_review' is
      // matched ahead of the producer adding it. The multi-status filter is
      // pushed down to listDrafts so the whole store isn't loaded + filtered
      // in memory on every Review Hub load.
      return messageDrafts.listDrafts({ status: ['draft', 'pending_review'] });
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
        drillTo: '/messages/drafts',
        ...(Object.keys(meta).length ? { meta } : {})
      };
    }
  },
  {
    source: 'health',
    label: 'Health anomalies',
    drillTo: '/system-health',
    async gather() {
      // System/health alerts; only surface the ones worth interrupting for.
      const { alerts = [] } = await getAlertsCached();
      return alerts.filter(a => a.severity === 'critical' || a.severity === 'high');
    },
    // proactiveAlerts emits { type, severity, title, detail, link } with no
    // stable id and possibly-repeating types, so key on the array index too.
    map(alert, index) {
      // Surface the alert category (system_resource / goal_stall / …) so the
      // user can tell at a glance what kind of anomaly it is. Absent → omitted.
      const alertType = typeof alert.type === 'string' && alert.type.trim()
        ? alert.type.trim()
        : null;
      return {
        id: `health:${alert.type || 'alert'}:${index}`,
        title: alert.title || `${alert.type || 'System'} alert`,
        summary: (alert.detail || alert.message || '').slice(0, 200),
        timestamp: alert.timestamp || null,
        severity: alert.severity === 'critical' ? 'critical' : 'high',
        drillTo: alert.link || '/system-health',
        ...(alertType ? { meta: { alertType } } : {})
      };
    }
  },
  {
    source: 'backup',
    label: 'Failed backups',
    drillTo: '/settings/backup',
    async gather() {
      // A backup needing acknowledgement is either a full failure (status
      // 'error') or a degraded run (status 'degraded' — file rsync succeeded but
      // the DB dump failed; it also carries an `error` string). Both warrant a
      // queue item, but they map to different severities below.
      const state = await backup.getState();
      const needsAttention = state && (state.status === 'error' || state.status === 'degraded' || state.error);
      return needsAttention ? [state] : [];
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
async function gatherProducer(producer, ctx = {}) {
  const raw = await producer.gather();
  const list = Array.isArray(raw) ? raw : [];
  const items = list.slice(0, PER_SOURCE_LIMIT).map((item, index) => ({
    source: producer.source,
    sourceLabel: producer.label,
    // Producer-level default promote targets — the row's map() may override
    // this (Ask adds `goal` + `goalOptions` when active goals exist).
    ...(Array.isArray(producer.promoteTargets) && producer.promoteTargets.length
      ? { promoteTargets: producer.promoteTargets }
      : {}),
    ...producer.map(item, index, ctx),
    // Inline-action verb when the producer declares one resolve primitive; the
    // UI shows an accept/promote button only for rows that carry it.
    ...(producer.action && producer.resolve ? { action: producer.action } : {})
  }));
  return { items, total: list.length };
}

const PRODUCERS_BY_SOURCE = Object.fromEntries(PRODUCERS.map(p => [p.source, p]));

/**
 * Accept/promote a single queue row in place. `queueItemId` is the row's
 * normalized id (`<source>:<rawId>`); we split on the FIRST colon so raw ids
 * that themselves contain colons survive. Throws a 4xx ServerError when the
 * source is unknown, has no inline resolve, or the underlying primitive can't
 * find the record — so the route surfaces a clean status instead of a 500.
 */
export async function resolveQueueItem(queueItemId) {
  const sep = String(queueItemId).indexOf(':');
  const source = sep === -1 ? queueItemId : queueItemId.slice(0, sep);
  const rawId = sep === -1 ? '' : queueItemId.slice(sep + 1);

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

/**
 * Build the cross-domain review queue. Returns the normalized item list (sorted
 * by severity then recency), aggregate `counts`, and a `sources` map with
 * per-source `total` (pre-cap) + `error` so the UI can show "+N more" and flag
 * a source that failed to load.
 */
export async function buildQueue() {
  // Fetch active goals once (not per Ask row) so the goal picker on Ask rows
  // has targets. A failure here degrades to no goal targets, not a sunk queue.
  const goalOptions = await getActiveGoalOptions();
  const ctx = { goalOptions };

  const results = await Promise.all(PRODUCERS.map(async (producer) => {
    return gatherProducer(producer, ctx)
      .then(r => ({ source: producer.source, label: producer.label, ...r, error: null }))
      .catch(err => {
        console.error(`❌ Review queue: ${producer.source} source failed: ${err.message}`);
        return { source: producer.source, label: producer.label, items: [], total: 0, error: err.message };
      });
  }));

  const items = results.flatMap(r => r.items);

  items.sort((a, b) => {
    const sev = (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2);
    if (sev !== 0) return sev;
    return new Date(b.timestamp || 0) - new Date(a.timestamp || 0);
  });

  const sources = {};
  for (const r of results) {
    sources[r.source] = { label: r.label, total: r.total, shown: r.items.length, error: r.error };
  }

  const counts = { total: items.length, critical: 0, high: 0 };
  for (const i of items) {
    if (i.severity === 'critical') counts.critical++;
    else if (i.severity === 'high') counts.high++;
  }

  return {
    items,
    counts,
    sources,
    generatedAt: new Date().toISOString()
  };
}
