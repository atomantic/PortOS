/** Declare Review Queue source adapters, their bounded reads, and their source-owned resolution hooks. */

import * as brain from './brain.js';
import * as brainStorage from './brainStorage.js';
import * as askConversations from './askConversations.js';
import * as cosTaskStore from './cos/cosTaskStore.js';
import * as messageDrafts from './messageDrafts.js';
import { buildHealthAlertInvestigation } from './healthAlertAgentTask.js';
import { generateNonProductAlerts } from './proactiveAlertSources.js';
import * as identity from './identity.js';
import * as reviewService from './review.js';
import * as notifications from './notifications.js';
import * as stackerNews from './stackerNews.js';
import * as x from './x.js';
import { resolveBackupConfig } from '../lib/backupConfig.js';
import { ServerError } from '../lib/errorHandler.js';
import { getProductEngagement } from './portosProductMetrics.js';
import { anchorLocalMidnightUtc, todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';
import { scheduleQueueClockInvalidation } from './reviewQueueSnapshots.js';
import { TIMED_COOLDOWN_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { isTerminalThreadStatus, threadNextLine } from '../lib/brainThreads.js';
import { getSettings } from './settings.js';
import { getAppById } from './apps.js';

// Producers are read with a bounded upper limit. The queue reports a lower
// bound, rather than pretending that a full count is known, when a producer
// fills this window.
export const REVIEW_QUEUE_SOURCE_READ_LIMIT = 100;
const REVIEW_QUEUE_SOURCE_PROBE_LIMIT = REVIEW_QUEUE_SOURCE_READ_LIMIT + 1;

export const SEVERITY_ORDER = { critical: 0, high: 1, normal: 2 };

export const ACTION_KINDS = Object.freeze({
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
  threads: 'brain.thread',
  todo: 'review.todo',
  history: 'review.history',
  feedback: 'cos.feedback',
  github: 'github.notification',
  product: 'product.recommendation',
  updates: 'software.update',
});

// generateNonProductAlerts() runs a full system-health sweep (CPU/disk/PM2/goals/usage),
// so cache it briefly — the Review Hub can be polled, and a stale-by-seconds
// alert list is fine here (the dedicated health views read it live).
const ALERTS_TTL_MS = 30_000;
let alertsCache = { data: null, timestamp: 0 };
let alertsGeneration = 0;

async function getAlertsCached() {
  if (alertsCache.data && (Date.now() - alertsCache.timestamp) < ALERTS_TTL_MS) {
    return alertsCache.data;
  }
  const generation = alertsGeneration;
  const result = await generateNonProductAlerts();
  if (generation === alertsGeneration) alertsCache = { data: result, timestamp: Date.now() };
  return result;
}

// Test seam: drop the alerts cache so a suite can assert fresh per-case data.
export function __resetAlertsCache() {
  alertsGeneration++;
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

const COMMITMENT_VIEWS = new Set(['today', 'all', 'waiting', 'someday', 'history', 'snoozed']);
const ACTIVE_THREAD_STATUSES = new Set(['open', 'waiting', 'someday']);

function isDueByLocalToday(thread, timezone, now = new Date()) {
  if (!thread.dueAt) return thread.status === 'open';
  const dueAt = Date.parse(thread.dueAt);
  if (!Number.isFinite(dueAt)) return false;
  const today = todayInTimezone(timezone, now);
  const dueDay = todayInTimezone(timezone, new Date(dueAt));
  return dueDay <= today;
}

function threadBelongsToView(thread, view, timezone, now = new Date()) {
  if (!thread || typeof thread.id !== 'string' || !thread.id) return false;
  if (!view) return ACTIVE_THREAD_STATUSES.has(thread.status);
  if (!COMMITMENT_VIEWS.has(view)) return ACTIVE_THREAD_STATUSES.has(thread.status);
  if (view === 'all') return ACTIVE_THREAD_STATUSES.has(thread.status);
  if (view === 'history') return isTerminalThreadStatus(thread.status);
  if (view === 'snoozed') return ACTIVE_THREAD_STATUSES.has(thread.status);
  if (view === 'waiting' || view === 'someday') return thread.status === view;
  return ACTIVE_THREAD_STATUSES.has(thread.status) && isDueByLocalToday(thread, timezone, now);
}

// These are task-owned obligations, not independent promises made by the user.
// Read live state so legacy recovery commitments clear as soon as
// automation resumes or finishes. Missing tasks stay visible; unreadable tasks
// fail the source read rather than falsely reporting an empty queue.
async function taskActionContext(taskId) {
  const task = await cosTaskStore.getTaskById(taskId);
  if (!task) return { needsUserAction: true, task: null };
  if (task.status === 'pending' && task.approvalRequired) return { needsUserAction: true, task };
  if (task.status === 'blocked') {
    return { needsUserAction: !TIMED_COOLDOWN_BLOCKED_CATEGORIES.has(task.metadata?.blockedCategory), task };
  }
  return {
    needsUserAction: !['pending', 'in_progress', 'completed', 'cancelled'].includes(task.status),
    task,
  };
}

const visibleInLiveViews = (producer, view) => {
  if (!view) return producer.source !== 'history';
  if (view === 'snoozed') return producer.source !== 'history';
  if (Array.isArray(producer.views)) return producer.views.includes(view);
  return view === 'today' || view === 'all';
};

const threadAction = (thread) => {
  const terminal = isTerminalThreadStatus(thread.status);
  return terminal
    ? [{ id: 'reopen', label: 'Reopen', available: true }]
    : [{ id: 'complete', label: 'Complete', available: true }];
};

const threadMeta = (thread) => ({
  localStatus: thread.status,
  ...(typeof thread.externalState === 'string' && thread.externalState.trim()
    ? { externalState: thread.externalState.trim() }
    : {}),
  ...(typeof thread.source === 'string' && thread.source.trim()
    ? { externalSource: thread.source.trim() }
    : {}),
});

const backupNeedsAttention = (state) => Boolean(state && (state.status === 'error' || state.status === 'degraded' || state.error));

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
    source: 'threads',
    label: 'Brain commitments',
    drillTo: '/brain/threads',
    views: ['today', 'all', 'waiting', 'someday', 'history'],
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT, ctx = {}) {
      const timezone = ctx.timezone || 'UTC';
      const now = ctx.now || new Date();
      const threads = await brainStorage.getThreadListRows();
      const candidates = (Array.isArray(threads) ? threads : [])
        .filter((thread) => threadBelongsToView(thread, ctx.view, timezone, now));
      const actionable = await Promise.all(candidates.map(async thread => {
        const taskRef = thread.source === 'cos' && thread.refs?.find(ref => ref?.kind === 'cos.task' && ref.id);
        if (!taskRef || ctx.view === 'history') return { needsUserAction: true, task: null };
        return taskActionContext(taskRef.id);
      }));
      const matching = candidates.flatMap((thread, index) => actionable[index].needsUserAction
        ? [{ thread, task: actionable[index].task }]
        : []);
      const appIds = [...new Set(matching
        .map(({ task }) => typeof task?.metadata?.app === 'string' ? task.metadata.app.trim() : '')
        .filter(Boolean))];
      const appNames = new Map();
      if (appIds.length) {
        await Promise.all(appIds.map(async appId => {
          const app = await getAppById(appId).catch(() => null);
          if (typeof app?.name === 'string' && app.name.trim()) appNames.set(appId, app.name.trim());
        }));
      }
      return {
        items: matching.map(({ thread, task }) => {
          const nextAction = threadNextLine(thread);
          const summaryParts = [nextAction || (thread.waitingOn ? `Waiting on ${thread.waitingOn}` : 'No next action set')];
          const metadata = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
          const blockedCategory = typeof metadata.blockedCategory === 'string' ? metadata.blockedCategory.trim() : '';
          if (task?.status === 'blocked') {
            const reason = typeof metadata.blockedReason === 'string' ? metadata.blockedReason.trim() : '';
            summaryParts.push(reason
              ? `Still blocked: ${reason}`
              : `Still blocked${blockedCategory ? ` (${blockedCategory})` : ''}.`);
          }
          const appId = typeof metadata.app === 'string' ? metadata.app.trim() : '';
          const appLabel = appId ? (appNames.get(appId) || appId) : '';
          const prUrl = typeof metadata.reviewLoopPRUrl === 'string'
            ? metadata.reviewLoopPRUrl.trim()
            : typeof metadata.prUrl === 'string' ? metadata.prUrl.trim() : '';
          const meta = {
            ...threadMeta(thread),
            ...(typeof task?.status === 'string' ? { taskStatus: task.status } : {}),
            ...(blockedCategory ? { blockedCategory } : {}),
            ...(appLabel ? { appLabel } : {}),
            ...(prUrl ? { reviewLoopPRUrl: prUrl } : {}),
          };
          return {
            ...thread,
            queueSummary: summaryParts.join(' ').slice(0, 500),
            queueMeta: meta,
          };
        }),
        truncated: matching.length > limit,
      };
    },
    map(thread) {
      return {
        id: `threads:${thread.id}`,
        title: thread.title || 'Untitled commitment',
        summary: thread.queueSummary || threadNextLine(thread) || (thread.waitingOn ? `Waiting on ${thread.waitingOn}` : 'No next action set'),
        timestamp: thread.updatedAt || thread.createdAt || null,
        severity: thread.priority === 'urgent' ? 'high' : 'normal',
        required: true,
        isRecommendation: false,
        dueAt: thread.dueAt || null,
        drillTo: `/brain/threads?thread=${encodeURIComponent(thread.id)}`,
        operations: threadAction(thread),
        meta: thread.queueMeta || threadMeta(thread),
      };
    },
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
      const { awaitingApproval } = await cosTaskStore.getCosApprovalView({ limit });
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
    source: 'feedback',
    label: 'CoS run feedback',
    drillTo: '/cos/agents?feedback=needs-feedback',
    views: ['today', 'all', 'history'],
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT, ctx = {}) {
      const { getPendingAgentFeedback } = await import('./cos/cosAgentFeedback.js');
      const pending = await getPendingAgentFeedback({ includeUnavailable: ctx.view === 'history' });
      const items = [
        ...(Array.isArray(pending?.agents) ? pending.agents : []),
        ...(ctx.view === 'history' && Array.isArray(pending?.unavailable) ? pending.unavailable : []),
      ];
      return { items: items.slice(0, limit), truncated: items.length > limit };
    },
    map(agent) {
      const unavailable = agent.availability === 'unavailable';
      const description = agent.metadata?.taskDescription;
      return {
        id: `feedback:${agent.id || agent.agentId}`,
        title: unavailable ? 'Completed CoS run unavailable for feedback' : 'Rate completed CoS run',
        summary: unavailable
          ? 'The source run is no longer available to rate; the action is retained as history.'
          : (typeof description === 'string' && description.trim()
            ? description.trim().slice(0, 200)
            : 'Completed manual CoS run'),
        timestamp: agent.completedAt || null,
        severity: 'normal',
        required: !unavailable,
        isRecommendation: false,
        sourceRef: agent.id || agent.agentId,
        ...(!unavailable
          ? { drillTo: `/cos/agents/${encodeURIComponent(agent.id || agent.agentId)}?feedback=needs-feedback` }
          : {}),
        availability: unavailable ? 'unavailable' : 'available',
        available: !unavailable,
        ...(unavailable
          ? {
            meta: { unavailableReason: agent.unavailableReason || 'unavailable' },
            nextAction: 'Unavailable',
            operations: [],
          }
          : {
            operations: [{
              id: 'rate',
              label: 'Rate',
              available: true,
              input: { type: 'rating', required: true, options: ['positive', 'negative', 'neutral'] },
            }],
          }),
      };
    },
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
      const { adaptStoredReviewItem } = await import('./reviewActionAdapters.js');
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
    source: 'todo',
    label: 'Manual commitments',
    drillTo: '/review?view=history',
    views: ['today', 'all', 'history'],
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT, ctx = {}) {
      const page = await reviewService.getItems(ctx.view === 'history'
        ? { type: 'todo', matches: item => item.status !== 'pending', limit }
        : { type: 'todo', status: 'pending', limit });
      return { items: page.items, truncated: page.total > page.items.length };
    },
    map(item) {
      const completed = item.status !== 'pending';
      return {
        id: `todo:${item.id}`,
        title: item.title || 'Untitled commitment',
        summary: item.description || item.title || '',
        timestamp: item.updatedAt || item.createdAt || null,
        dueAt: item.metadata?.dueAt || null,
        required: !completed,
        isRecommendation: false,
        drillTo: `/review/${encodeURIComponent(`todo:${item.id}`)}?view=${completed ? 'history' : 'today'}`,
        operations: completed
          ? [{ id: 'reopen', label: 'Reopen', available: true }]
          : [{ id: 'complete', label: 'Complete', available: true }],
        meta: { status: item.status, reviewItemId: item.id },
      };
    },
  },
  {
    source: 'history',
    label: 'Review history',
    drillTo: '/review?view=history',
    views: ['history'],
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      const page = await reviewService.getItems({
        matches: item => item.status !== 'pending' && item.type !== 'todo',
        limit,
      });
      return { items: page.items, truncated: page.total > page.items.length };
    },
    map(item) {
      return {
        id: `history:${item.id}`,
        title: item.title || 'Review history item',
        summary: item.description || item.title || '',
        timestamp: item.updatedAt || item.createdAt || null,
        required: false,
        isRecommendation: false,
        operations: [],
        drillTo: item.metadata?.link || '/review?view=history',
        meta: { status: item.status, type: item.type, reviewItemId: item.id },
      };
    },
  },
  {
    source: 'notifications',
    label: 'Actionable notifications',
    drillTo: '/review',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      const { adaptNotification } = await import('./reviewActionAdapters.js');
      // Filter before applying the queue cap. A busy history stream must not
      // hide a source-owned approval that happens to be older than it.
      const records = await notifications.getNotifications({ includeHidden: true });
      const items = (Array.isArray(records) ? records : [])
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
    source: 'github',
    label: 'GitHub alerts',
    drillTo: '/devtools/github/inbox',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      const { listActionableNotifications } = await import('./githubNotifications.js');
      return listActionableNotifications({ limit });
    },
    map(notification) {
      const sourceRef = `${notification.accountId}/${notification.threadId}`;
      return {
        id: `github:${sourceRef}`,
        sourceRef,
        title: notification.title,
        summary: notification.repoFullName || 'GitHub notification needs attention',
        timestamp: notification.updatedAt,
        severity: notification.suspect || notification.reason === 'security_alert' ? 'high' : 'normal',
        drillTo: `/devtools/github/inbox/${encodeURIComponent(notification.accountId)}/${notification.threadId}`,
        nextAction: 'Review GitHub notification',
        // The shared card uses the source endpoints, preserving their authority checks.
        operations: [],
        githubNotification: notification,
      };
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
    source: 'product',
    label: 'Product recommendations',
    drillTo: '/review',
    preserveTriageActionKinds: [ACTION_KINDS.product],
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      const result = await getProductEngagement();
      const actions = Array.isArray(result?.actions) ? result.actions : [];
      const unavailable = [result?.post, result?.creativeCommissions]
        .filter((metric) => metric?.status === 'unavailable');
      if (unavailable.length) {
        const reasons = unavailable
          .map((metric) => metric.reason)
          .filter((reason) => typeof reason === 'string' && reason.trim());
        throw new Error(`Product metrics unavailable${reasons.length ? `: ${reasons.join(', ')}` : ''}`);
      }
      if (actions.some((action) => typeof action?.id !== 'string' || !action.id.trim())) {
        throw new Error('Product recommendation identity is unavailable');
      }
      return {
        items: actions.slice(0, limit),
        truncated: actions.length > limit,
      };
    },
    map(action) {
      const metadata = action.metadata && typeof action.metadata === 'object' && !Array.isArray(action.metadata)
        ? action.metadata
        : {};
      return {
        id: `product:${action.id}`,
        sourceRef: action.id,
        actionKind: ACTION_KINDS.product,
        title: action.title || 'Product recommendation',
        summary: action.detail || '',
        timestamp: action.timestamp || null,
        severity: ['critical', 'high', 'medium', 'normal'].includes(action.severity) ? action.severity : 'normal',
        drillTo: action.link || '/review',
        nextAction: 'Open',
        required: false,
        isRecommendation: true,
        occurrence: action.occurrence ?? null,
        revision: action.revision ?? null,
        operations: [],
        ...(action.featureId ? { featureId: action.featureId } : {}),
        ...(action.featureLabel ? { featureLabel: action.featureLabel } : {}),
        ...(Object.keys(metadata).length ? { meta: metadata } : {}),
      };
    },
  },
  {
    source: 'health',
    label: 'Health anomalies',
    drillTo: '/system-resources/overview',
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // System/health alerts; only surface the ones worth interrupting for.
      const alerts = await getAlertsCached();
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
      const selected = [...byId.values()].slice(0, limit);
      if (!selected.some(alert => alert.type === 'process_error')) return selected;
      const { attachProcessInvestigations } = await import('./reviewQueueInvestigations.js');
      return attachProcessInvestigations(selected);
    },
    // The collector owns semantic identity; the queue only namespaces it.
    map(alert) {
      // Surface the alert category (system_resource / goal_stall / …) so the
      // user can tell at a glance what kind of anomaly it is. Absent → omitted.
      const alertType = typeof alert.type === 'string' && alert.type.trim()
        ? alert.type.trim()
        : null;
      const drillTo = alert.type === 'system_resource'
        ? '/system-resources/overview'
        : alert.link || '/system-resources/overview';
      return {
        id: `health:${alert.id}`,
        // Process-crash alerts carry an app-scoped task; every other alert gets
        // the PortOS-scoped resolve-with-agent task.
        ...(alert.investigationUnavailable ? {} : { investigation: alert.investigation || buildHealthAlertInvestigation(alert) }),
        ...(alert.investigationUnavailable ? { investigationUnavailable: alert.investigationUnavailable } : {}),
        operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
        nextAction: 'Investigate or mark resolved',
        title: alert.title || `${alert.type || 'System'} alert`,
        summary: (alert.detail || alert.message || '').slice(0, 200),
        timestamp: alert.timestamp || null,
        severity: alert.severity === 'critical' ? 'critical' : 'high',
        drillTo,
        drillLabel: drillTo.startsWith('/cos/learning')
          ? 'Open Learning'
          : drillTo.startsWith('/system-resources/overview')
            ? 'Open system resources'
            : 'View details',
        ...(alertType ? { meta: { alertType } } : {})
      };
    }
  },
  {
    source: 'updates',
    label: 'Software updates',
    async gather() {
      const { getRuntimeUpdateReviewSnapshot } = await import('./runtimeUpdateReview.js');
      return getRuntimeUpdateReviewSnapshot();
    },
    map(entry) {
      return { ...entry, id: `updates:${entry.id}` };
    },
  },
  {
    source: 'backup',
    label: 'Failed backups',
    drillTo: '/settings/backup',
    // Acknowledging clears the recorded failure; the next failed run re-raises it.
    actionLabel: 'Done',
    async resolve() {
      const { getState, saveState } = await import('./backup.js');
      const state = await getState();
      if (!backupNeedsAttention(state)) return null;
      await saveState({ status: state.lastSnapshotId ? 'ok' : 'never', error: null });
      return { acknowledged: true };
    },
    async gather(limit = REVIEW_QUEUE_SOURCE_READ_LIMIT) {
      // Disabling backups makes a past failure moot.
      if (resolveBackupConfig((await getSettings())?.backup).enabled === false) return [];
      const { getState } = await import('./backup.js');
      // A backup needing acknowledgement is either a full failure (status
      // 'error') or a degraded run (status 'degraded' — file rsync succeeded but
      // the DB dump failed; it also carries an `error` string). Both warrant a
      // queue item, but they map to different severities below.
      const state = await getState();
      return backupNeedsAttention(state) ? [state].slice(0, limit) : [];
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
        drillTo: '/settings/backup',
        drillLabel: 'Open backup settings'
      };
    }
  }
];

export const PRODUCERS_BY_SOURCE = Object.fromEntries(PRODUCERS.map(p => [p.source, p]));

/**
 * Gather one producer into normalized rows. A producer may return either an
 * array or `{ items, truncated, incomplete }` when its read is bounded or unverified.
 * Totals are nullable whenever the read filled its bound: the collected rows
 * are a lower bound, not evidence that the source is exhausted.
 */
async function gatherProducer(producer, ctx, normalizeQueueItem) {
  const gathered = await producer.gather(REVIEW_QUEUE_SOURCE_PROBE_LIMIT, ctx);
  const descriptor = Array.isArray(gathered) ? { items: gathered } : gathered;
  const rawItems = Array.isArray(descriptor?.items) ? descriptor.items : [];
  const truncated = descriptor?.truncated === true || rawItems.length > REVIEW_QUEUE_SOURCE_READ_LIMIT;
  const incomplete = descriptor?.incomplete === true;
  const list = rawItems.slice(0, REVIEW_QUEUE_SOURCE_READ_LIMIT);
  const items = list.map((item, index) => {
    const mapped = {
      source: producer.source,
      sourceLabel: producer.label,
      ...(Array.isArray(producer.promoteTargets) && producer.promoteTargets.length
        ? { promoteTargets: producer.promoteTargets }
        : {}),
      // A mapper may override producer defaults (e.g. Ask's goal target).
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
    total: truncated || incomplete ? null : list.length,
    lowerBound: list.length,
    truncation: truncated,
    incomplete,
    preserveTriageActionKinds: Array.isArray(descriptor?.preserveTriageActionKinds)
      ? descriptor.preserveTriageActionKinds
      : (producer.preserveTriageActionKinds || []),
  };
}

export async function gatherQueueSources({ view, now, onlySources }, normalizeQueueItem) {
  const visibleProducers = PRODUCERS.filter(producer => (
    (!onlySources || onlySources.has(producer.source)) && visibleInLiveViews(producer, view)
  ));
  // Fetch active goals once (not per Ask row) so the goal picker on Ask rows
  // has targets. A failure here degrades to no goal targets, not a sunk queue.
  const goalOptions = visibleProducers.some(producer => producer.source === 'ask') ? await getActiveGoalOptions() : [];
  const timezone = view === 'today'
    ? await getUserTimezone().catch((err) => {
      console.error(`⚠️ Review queue: timezone read failed: ${err.message}`);
      return 'UTC';
    })
    : 'UTC';
  const clock = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  if (view === 'today') {
    const tomorrow = new Date(`${todayInTimezone(timezone, clock)}T12:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    scheduleQueueClockInvalidation(anchorLocalMidnightUtc(tomorrow.toISOString().slice(0, 10), timezone));
  }
  const ctx = { goalOptions, view, timezone, now: clock };

  const results = await Promise.all(visibleProducers.map(async (producer) => {
    return gatherProducer(producer, ctx, normalizeQueueItem)
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
          preserveTriageActionKinds: producer.preserveTriageActionKinds || [],
          error: message,
        };
      });
  }));
  return { results, clock };
}
