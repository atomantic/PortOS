// Shared constants and pure helpers for the CoS Schedule tab subcomponents.
import { timeUntil } from '../../../../utils/formatters';

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

// --- Status grouping -------------------------------------------------------
// A task falls into exactly one status group, used for the status dot, grid
// ordering, and the status filters. Order here is the grid sort order.
export const STATUS_GROUPS = {
  active: { label: 'Active', dot: 'bg-port-success', order: 0 },
  'on-demand': { label: 'On-Demand', dot: 'bg-gray-400', order: 1 },
  waiting: { label: 'Waiting', dot: 'bg-port-warning', order: 2 },
  disabled: { label: 'Disabled', dot: 'bg-gray-600', order: 3 },
};

// Classify a task config into one status group (mutually exclusive).
// Disabled wins over everything; then dependency-wait; then on-demand type.
export function getTaskStatusGroup(config) {
  if (!config?.enabled) return 'disabled';
  if (config.status?.reason === 'waiting-on-dependencies') return 'waiting';
  if (config.type === 'on-demand') return 'on-demand';
  return 'active';
}

export const statusDot = (group) => STATUS_GROUPS[group]?.dot || STATUS_GROUPS.disabled.dot;

// Sort key for the card grid: group order first, then soonest next run, then name.
export function taskSortKey(taskType, config) {
  const group = getTaskStatusGroup(config);
  const next = config?.status?.nextRunAt ? new Date(config.status.nextRunAt).getTime() : Infinity;
  return { order: STATUS_GROUPS[group]?.order ?? 9, next: Number.isFinite(next) ? next : Infinity, taskType };
}

// Tailwind tone for the per-task app-coverage bar/label (error none, success full, warning partial).
export function coverageTone(enabled, total) {
  if (enabled === 0) return { text: 'text-port-error', bar: 'bg-port-error' };
  if (enabled === total) return { text: 'text-port-success', bar: 'bg-port-success' };
  return { text: 'text-port-warning', bar: 'bg-port-warning' };
}

// Describe a task's "next run" line for the card: text + Tailwind tone, plus an
// optional title and a `warn` flag for the dependency-wait icon. Pure so it can
// be unit-tested without rendering.
export function describeNextRun(config) {
  const group = getTaskStatusGroup(config);
  if (group === 'disabled') return { text: 'Paused', tone: 'text-gray-500' };
  if (group === 'waiting') {
    const deps = config.status?.pendingDeps?.join(', ');
    return {
      text: `waiting on ${deps || 'dependencies'}`,
      tone: 'text-port-warning',
      warn: true,
      title: deps ? `Waiting for: ${deps}` : undefined,
    };
  }
  if (group === 'on-demand') return { text: 'Manual trigger only', tone: 'text-gray-400' };
  const next = config.status?.nextRunAt;
  return {
    text: next ? timeUntil(next, 'soon') : `${INTERVAL_LABELS[config.type] || config.type} — pending`,
    tone: 'text-gray-300',
  };
}

export const TASK_FILTERS = [
  { id: 'all', label: 'All', emptyMessage: 'No tasks configured.', match: () => true },
  { id: 'active', label: 'Active', emptyMessage: 'No active tasks.', match: ([, config]) => getTaskStatusGroup(config) === 'active' },
  { id: 'on-demand', label: 'On-Demand', emptyMessage: 'No on-demand tasks.', match: ([, config]) => getTaskStatusGroup(config) === 'on-demand' },
  { id: 'waiting', label: 'Waiting', emptyMessage: 'No tasks waiting on dependencies.', match: ([, config]) => getTaskStatusGroup(config) === 'waiting' },
  { id: 'disabled', label: 'Disabled', emptyMessage: 'No disabled tasks.', match: ([, config]) => getTaskStatusGroup(config) === 'disabled' },
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
