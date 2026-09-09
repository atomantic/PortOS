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

export const AVAILABLE_FORWARD_TYPES = Object.values(NOTIFICATION_CATALOG);
