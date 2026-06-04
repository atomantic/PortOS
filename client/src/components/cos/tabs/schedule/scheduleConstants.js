// Shared constants and pure helpers for the CoS Schedule tab subcomponents.

export const INTERVAL_LABELS = {
  rotation: 'Rotation',
  daily: 'Daily',
  weekly: 'Weekly',
  once: 'Once',
  'on-demand': 'On Demand',
  custom: 'Custom',
  cron: 'Cron'
};

export const INTERVAL_DESCRIPTIONS = {
  rotation: 'Runs as part of normal task rotation',
  daily: 'Runs once per day',
  weekly: 'Runs once per week',
  once: 'Runs once then stops',
  'on-demand': 'Only runs when manually triggered',
  custom: 'Custom interval',
  cron: 'Cron expression schedule'
};

const BADGE_COLORS = {
  accent: 'bg-port-accent/15 text-port-accent border-port-accent/30',
  purple: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  warning: 'bg-port-warning/15 text-port-warning border-port-warning/30',
  gray: 'bg-gray-600/30 text-gray-400 border-gray-500/30',
  cyan: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  success: 'bg-port-success/15 text-port-success border-port-success/30',
  error: 'bg-port-error/15 text-port-error border-port-error/30',
};

export const badge = (variant) => `text-xs font-medium px-2.5 py-1 rounded-full border ${BADGE_COLORS[variant] || BADGE_COLORS.gray}`;

export const IMPROVEMENT_DISABLED_TITLE = 'Improvement is disabled — enable it in CoS → Config';

export const triggerButtonClass = (disabled) =>
  `flex items-center gap-1 px-3 py-1.5 text-sm rounded transition-colors ${disabled ? 'bg-port-border/30 text-gray-500 cursor-not-allowed' : 'bg-port-accent/20 hover:bg-port-accent/30 text-port-accent'}`;

export const INTERVAL_BADGE_VARIANT = {
  daily: 'accent',
  weekly: 'purple',
  once: 'warning',
  'on-demand': 'gray',
  cron: 'cyan',
};

export const TASK_FILTERS = [
  { id: 'all', label: 'All', emptyMessage: 'No tasks configured.', match: () => true },
  { id: 'enabled', label: 'Enabled', emptyMessage: 'No enabled tasks.', match: ([, config]) => config.enabled },
];
export const DEFAULT_FILTER_ID = TASK_FILTERS[0].id;

// Toggle a global taskMetadata field, enforcing the openPR→useWorktree invariant.
// Persists both true and false values so explicit overrides survive the server-side
// merge with task-type defaults (e.g., feature-ideas defaults openPR to true).
export function toggleMetadataField(metadata, field) {
  const current = metadata || {};
  const newMeta = { ...current, [field]: !current[field] };
  // openPR requires useWorktree
  if (newMeta.openPR && !newMeta.useWorktree) {
    newMeta.useWorktree = true;
  }
  // useWorktree off means openPR must be off
  if (newMeta.useWorktree === false && newMeta.openPR) {
    newMeta.openPR = false;
  }
  return newMeta;
}
