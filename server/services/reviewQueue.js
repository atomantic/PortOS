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
 * the queue needing to know how to render each domain. v1 is read + drill-down;
 * per-source accept/promote actions are a follow-up (see issue #709).
 */

import * as brain from './brain.js';
import * as askConversations from './askConversations.js';
import * as cosTaskStore from './cosTaskStore.js';
import * as messageDrafts from './messageDrafts.js';
import * as proactiveAlerts from './proactiveAlerts.js';
import * as backup from './backup.js';

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
    async gather() {
      // Inbox entries the auto-classifier couldn't place — they need a human
      // to pick a destination.
      return brain.getInboxLog({ status: 'needs_review', limit: PER_SOURCE_LIMIT * 2 });
    },
    map(entry) {
      const text = (entry.capturedText || '').trim();
      return {
        id: `brain:${entry.id}`,
        title: 'Inbox item needs classification',
        summary: text.slice(0, 200),
        timestamp: entry.capturedAt || entry.createdAt || null,
        severity: 'normal',
        drillTo: '/brain/inbox'
      };
    }
  },
  {
    source: 'ask',
    label: 'Ask answers',
    drillTo: '/ask',
    async gather() {
      // Conversations with content that haven't been promoted to brain/task/goal.
      const convs = await askConversations.listConversations({ limit: PER_SOURCE_LIMIT * 2 });
      return convs.filter(c => !c.promoted && (c.turnCount || 0) > 0);
    },
    map(conv) {
      return {
        id: `ask:${conv.id}`,
        title: 'Ask answer ready to promote',
        summary: conv.title || '(untitled conversation)',
        timestamp: conv.updatedAt || conv.createdAt || null,
        severity: 'normal',
        drillTo: `/ask/${conv.id}`
      };
    }
  },
  {
    source: 'cos',
    label: 'CoS approvals',
    drillTo: '/cos/tasks',
    async gather() {
      // Internal CoS tasks parked awaiting the user's approval before they run.
      const { awaitingApproval = [] } = await cosTaskStore.getCosTasks();
      return awaitingApproval;
    },
    map(task) {
      return {
        id: `cos:${task.id}`,
        title: 'CoS task pending approval',
        summary: (task.description || '').slice(0, 200),
        timestamp: task.createdAt || null,
        severity: task.priority === 'HIGH' ? 'high' : 'normal',
        drillTo: '/cos/tasks'
      };
    }
  },
  {
    source: 'drafts',
    label: 'Message drafts',
    drillTo: '/messages/drafts',
    async gather() {
      // Drafts the user (or an AI) prepared that haven't been sent yet. Today
      // messageDrafts only emits 'draft' (vs 'approved'); 'pending_review' is
      // matched ahead of the producer adding it (see #832) so this needs no
      // change when it lands.
      const drafts = await messageDrafts.listDrafts();
      return drafts.filter(d => d.status === 'draft' || d.status === 'pending_review');
    },
    map(draft) {
      return {
        id: `draft:${draft.id}`,
        title: draft.status === 'pending_review' ? 'Draft awaiting review' : 'Unsent message draft',
        summary: draft.subject || (draft.body || '').slice(0, 120) || '(no subject)',
        timestamp: draft.updatedAt || draft.createdAt || null,
        severity: 'normal',
        drillTo: '/messages/drafts'
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
      return {
        id: `health:${alert.type || 'alert'}:${index}`,
        title: alert.title || `${alert.type || 'System'} alert`,
        summary: (alert.detail || alert.message || '').slice(0, 200),
        timestamp: alert.timestamp || null,
        severity: alert.severity === 'critical' ? 'critical' : 'high',
        drillTo: alert.link || '/system-health'
      };
    }
  },
  {
    source: 'backup',
    label: 'Failed backups',
    drillTo: '/settings/backup',
    async gather() {
      // A backup that errored on its last run needs acknowledgement. The
      // backup service records failure as status 'error' with an `error` field.
      const state = await backup.getState();
      const failed = state && (state.status === 'error' || state.error);
      return failed ? [state] : [];
    },
    map(state) {
      return {
        id: 'backup:last-run',
        title: 'Backup failed',
        summary: (state.error || 'The most recent backup did not complete.').slice(0, 200),
        timestamp: state.lastRun || null,
        severity: 'high',
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
 */
async function gatherProducer(producer) {
  const raw = await producer.gather();
  const list = Array.isArray(raw) ? raw : [];
  const items = list.slice(0, PER_SOURCE_LIMIT).map((item, index) => ({
    source: producer.source,
    sourceLabel: producer.label,
    ...producer.map(item, index)
  }));
  return { items, total: list.length };
}

/**
 * Build the cross-domain review queue. Returns the normalized item list (sorted
 * by severity then recency), aggregate `counts`, and a `sources` map with
 * per-source `total` (pre-cap) + `error` so the UI can show "+N more" and flag
 * a source that failed to load.
 */
export async function buildQueue() {
  const results = await Promise.all(PRODUCERS.map(async (producer) => {
    return gatherProducer(producer)
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
