import { NOTIFICATION_ACTION_POLICY } from '../lib/notificationTypes.js';

const SOURCE_OWNED_REVIEW_CATEGORIES = new Set([
  'content-review',
  'goal-fidelity',
  'memory-approval',
  'plan-question',
  'task-approval',
  'autopilot-paused',
]);

const CONTEXT_ONLY_REVIEW_CATEGORIES = new Set([
  'client-error',
  'health-issue',
  'warning',
]);

const toText = (value) => (typeof value === 'string' ? value.trim() : '');

const toReference = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return toText(value);
};

const severityFor = (value) => {
  const normalized = toText(value).toLowerCase();
  if (['critical', 'high', 'medium', 'low'].includes(normalized)) return normalized;
  if (value === 1 || value === '1') return 'high';
  if (value === 2 || value === '2') return 'medium';
  return 'normal';
};

const operation = (id, label, available = true) => ({
  id,
  label,
  available,
});

export const canonicalActionId = (source, sourceRef) => `${source}:${sourceRef}`;

export const isSourceOwnedReviewItem = (item) => {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const category = toText(metadata.category);

  if (metadata.sourceOwned === true || metadata.triageOnly === true) return true;
  if (SOURCE_OWNED_REVIEW_CATEGORIES.has(category)) return true;
  if (item?.type === 'cos' && (toReference(metadata.taskId) || toReference(metadata.referenceId))) {
    return true;
  }
  return item?.type === 'alert';
};

const reviewItemBase = (item, values) => ({
  ...values,
  title: toText(item?.title) || 'Review obligation',
  summary: toText(item?.description) || toText(item?.title),
  timestamp: item?.createdAt,
  severity: severityFor(item?.metadata?.severity ?? item?.metadata?.priority),
  meta: {
    reviewItemId: item?.id,
    ...values.meta,
  },
});

export function adaptStoredReviewItem(item) {
  if (!item || item.status !== 'pending') return null;

  const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const category = toText(metadata.category);
  const referenceId = toReference(metadata.referenceId);
  const link = toText(metadata.link) || toText(metadata.reportUrl);

  if (category === 'memory-approval' || toReference(metadata.memoryId)) {
    const sourceRef = toReference(metadata.memoryId) || referenceId;
    if (!sourceRef) return null;
    return reviewItemBase(item, {
      id: canonicalActionId('memory', sourceRef),
      sourceRef,
      actionKind: 'memory.approval',
      required: true,
      sourceOwned: true,
      drillTo: link || '/cos/memory',
      operations: [operation('approve', 'Approve'), operation('reject', 'Reject')],
      meta: { category: 'memory-approval' },
    });
  }

  if (category === 'goal-fidelity') {
    const sourceRef = toReference(metadata.agentId) || referenceId;
    if (!sourceRef) return null;
    return reviewItemBase(item, {
      id: canonicalActionId('goal-fidelity', sourceRef),
      sourceRef,
      actionKind: 'goal-fidelity.review',
      required: true,
      sourceOwned: true,
      drillTo: link || `/cos/agents/${encodeURIComponent(sourceRef)}`,
      operations: [operation('review', 'Review', false)],
      meta: { category: 'goal-fidelity' },
    });
  }

  if (category === 'task-approval' || item.type === 'cos') {
    const sourceRef = toReference(metadata.taskId) || referenceId;
    if (!sourceRef) return null;
    return reviewItemBase(item, {
      id: canonicalActionId('cos', sourceRef),
      sourceRef,
      actionKind: 'task.approval',
      required: true,
      sourceOwned: true,
      drillTo: link || '/cos',
      operations: [operation('approve', 'Approve')],
      meta: { category: 'task-approval' },
    });
  }

  if (category === 'plan-question') {
    const sourceRef = toReference(metadata.agentId) || toReference(metadata.appId) || referenceId;
    if (!sourceRef) return null;
    return reviewItemBase(item, {
      id: canonicalActionId('plan', sourceRef),
      sourceRef,
      actionKind: 'plan.question',
      required: true,
      sourceOwned: true,
      drillTo: link || '/cos',
      operations: [operation('review', 'Review', false)],
      meta: { category: 'plan-question' },
    });
  }

  if (category === 'autopilot-paused') {
    const seriesId = toReference(metadata.autopilotPauseSeriesId) || toReference(metadata.seriesId);
    const runId = toReference(metadata.runId);
    if (!seriesId) return null;
    const sourceRef = [seriesId, runId].filter(Boolean).join(':');
    return reviewItemBase(item, {
      id: canonicalActionId('autopilot', sourceRef),
      sourceRef,
      actionKind: 'autopilot.resume',
      required: true,
      sourceOwned: true,
      drillTo: link || `/pipeline/series/${encodeURIComponent(seriesId)}`,
      operations: [operation('resume', 'Resume', false)],
      meta: { category: 'autopilot-paused' },
    });
  }

  if (CONTEXT_ONLY_REVIEW_CATEGORIES.has(category)) return null;

  if (category === 'content-review' || metadata.contentReview === true) {
    if (!referenceId) return null;
    return reviewItemBase(item, {
      id: canonicalActionId('content', referenceId),
      sourceRef: referenceId,
      actionKind: 'content.review',
      required: true,
      sourceOwned: true,
      drillTo: link || '/review',
      operations: [operation('review', 'Review', false)],
      meta: { category: 'content-review' },
    });
  }

  if (item.type !== 'alert') return null;

  const legacyReference = toReference(item.id);
  if (!legacyReference) return null;

  return reviewItemBase(item, {
    id: canonicalActionId('review', legacyReference),
    sourceRef: legacyReference,
    actionKind: 'review.triage',
    required: true,
    sourceOwned: true,
    triageOnly: true,
    drillTo: link || '/review',
    operations: [operation('triage', 'Review', false)],
    meta: { category: 'legacy-review-triage', triage: true },
  });
}

const notificationReference = (notification, policy) => {
  const metadata = notification?.metadata && typeof notification.metadata === 'object'
    ? notification.metadata
    : {};
  const fields = policy.referenceFields ?? [];
  const values = fields.map((field) => toReference(metadata[field])).filter(Boolean);
  if (policy.compoundReference) return values.join(':');
  return values[0] || '';
};

export function adaptNotification(notification) {
  // Read and clear apply to event history, never to the source obligation.
  if (!notification) return null;

  const policy = NOTIFICATION_ACTION_POLICY[notification.type];
  if (!policy) return null;

  const sourceRef = notificationReference(notification, policy);
  const drillTo = toText(notification.link) || toText(policy.fallbackDrillTo);
  if (!sourceRef || !drillTo) return null;

  const operations = policy.operations.map(({ id, label, available }) => operation(id, label, available));
  return {
    id: canonicalActionId(policy.actionSource, sourceRef),
    sourceRef,
    actionKind: policy.actionKind,
    required: policy.required,
    sourceOwned: true,
    title: toText(notification.title) || policy.label,
    summary: toText(notification.description) || toText(notification.message) || toText(notification.title),
    timestamp: notification.timestamp || notification.createdAt,
    severity: severityFor(notification.priority ?? notification.severity),
    drillTo,
    operations,
    meta: {
      notificationId: notification.id,
      category: policy.category,
      actionSource: policy.actionSource,
    },
  };
}
