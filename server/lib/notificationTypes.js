/** Notification vocabulary and labels shared by producers and forwarding settings. */
export const NOTIFICATION_CATALOG = {
  MEMORY_APPROVAL: { key: 'memory_approval', label: 'Memory Approvals' },
  TASK_APPROVAL: { key: 'task_approval', label: 'Task Approvals' },
  CODE_REVIEW: { key: 'code_review', label: 'Code Reviews' },
  HEALTH_ISSUE: { key: 'health_issue', label: 'Health Issues' },
  BRIEFING_READY: { key: 'briefing_ready', label: 'Briefings' },
  AUTOBIOGRAPHY_PROMPT: { key: 'autobiography_prompt', label: 'Autobiography Prompts' },
  PLAN_QUESTION: { key: 'plan_question', label: 'Plan Questions' },
  AGENT_WARNING: { key: 'agent_warning', label: 'Agent Warnings' },
  AUTOPILOT_PAUSED: { key: 'autopilot_paused', label: 'Autopilot Paused' },
  DAILY_POST_REMINDER: { key: 'daily_post_reminder', label: 'POST Reminders' },
  CREATIVE_COMMISSION: { key: 'creative_commission', label: 'Creative Commissions' }
};

export const NOTIFICATION_TYPES = Object.fromEntries(
  Object.entries(NOTIFICATION_CATALOG).map(([name, { key }]) => [name, key])
);

// These are the only notification types that can enter the canonical action
// queue. Everything else remains history/context until its owning domain adds
// an explicit source adapter and mutation contract.
export const NOTIFICATION_ACTION_POLICY = Object.freeze({
  [NOTIFICATION_TYPES.MEMORY_APPROVAL]: {
    label: 'Memory approval',
    category: 'memory-approval',
    actionSource: 'memory',
    actionKind: 'memory.approval',
    referenceFields: ['memoryId'],
    required: true,
    operations: [
      { id: 'approve', label: 'Approve', available: true },
      { id: 'reject', label: 'Reject', available: true },
    ],
  },
  [NOTIFICATION_TYPES.TASK_APPROVAL]: {
    label: 'Task approval',
    category: 'task-approval',
    actionSource: 'cos',
    actionKind: 'task.approval',
    referenceFields: ['taskId'],
    required: true,
    operations: [{ id: 'approve', label: 'Approve', available: true }],
  },
  [NOTIFICATION_TYPES.CODE_REVIEW]: {
    label: 'Content review',
    category: 'content-review',
    actionSource: 'content',
    actionKind: 'content.review',
    referenceFields: ['prNumber', 'reviewId', 'referenceId'],
    required: true,
    operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
  },
  [NOTIFICATION_TYPES.PLAN_QUESTION]: {
    label: 'Plan question',
    category: 'plan-question',
    actionSource: 'plan',
    actionKind: 'plan.question',
    referenceFields: ['agentId', 'appId', 'referenceId'],
    fallbackDrillTo: '/cos',
    required: true,
    operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
  },
  [NOTIFICATION_TYPES.AUTOPILOT_PAUSED]: {
    label: 'Paused automation',
    category: 'autopilot-paused',
    actionSource: 'autopilot',
    actionKind: 'autopilot.resume',
    referenceFields: ['autopilotPauseSeriesId', 'runId'],
    compoundReference: true,
    required: true,
    operations: [{ id: 'complete', label: 'Mark resolved', available: true }],
  },
});

export const AVAILABLE_FORWARD_TYPES = Object.values(NOTIFICATION_CATALOG);
