// Shared constants and pure helpers for the CoS Schedule tab subcomponents.
import { timeUntil } from '../../../../utils/formatters';

export const INTERVAL_LABELS = {
  rotation: 'Rotation',
  daily: 'Daily',
  weekly: 'Weekly',
  once: 'Once',
  'on-demand': 'On Demand',
  custom: 'Custom',
  cron: 'Cron',
  perpetual: 'Perpetual'
};

export const INTERVAL_DESCRIPTIONS = {
  rotation: 'Runs as part of normal task rotation',
  daily: 'Runs once per day',
  weekly: 'Runs once per week',
  once: 'Runs once then stops',
  'on-demand': 'Only runs when manually triggered',
  custom: 'Custom interval',
  cron: 'Cron expression schedule',
  perpetual: 'Drains actionable work back-to-back until none remains, then rechecks on a cadence'
};

// `cyan` is kept as a raw Tailwind hue (not a port-* token) on purpose: this is
// a fixed 7-tone badge palette differentiating mutually-exclusive interval
// variants (INTERVAL_BADGE_VARIANT below); every other tone here already maps
// onto a port-* token ('accent' covers the blue/info role), so collapsing
// cyan onto 'accent' too would make 'cron' badges visually indistinguishable
// from 'daily' badges. See the #1909/#1924 category-color-enum caution.
const BADGE_COLORS = {
  accent: 'bg-port-accent/15 text-port-accent border-port-accent/30',
  purple: 'bg-port-accent-2/15 text-port-accent-2 border-port-accent-2/30',
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
  perpetual: 'success',
};

// --- Status grouping -------------------------------------------------------
// A task falls into exactly one status group, used for the status dot, grid
// ordering, and the status filters. Order here is the grid sort order.
export const STATUS_GROUPS = {
  active: { label: 'Active', dot: 'bg-port-success', order: 0 },
  'on-demand': { label: 'On-Demand', dot: 'bg-gray-400', order: 1 },
  waiting: { label: 'Waiting', dot: 'bg-port-warning', order: 2 },
  completed: { label: 'Completed', dot: 'bg-port-accent', order: 3 },
  disabled: { label: 'Disabled', dot: 'bg-gray-600', order: 4 },
};

// Classify a task config into one status group (mutually exclusive).
// Disabled wins over everything; then dependency-wait; then a one-shot that
// already ran (won't run again until reset — not "active"); then on-demand type.
export function getTaskStatusGroup(config) {
  if (!config?.enabled) return 'disabled';
  if (config.status?.reason === 'waiting-on-dependencies') return 'waiting';
  if (config.type === 'once' && config.status?.reason === 'once-completed') return 'completed';
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
  if (group === 'completed') return { text: 'Completed — reset to run again', tone: 'text-gray-400' };
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
  if (config.type === 'perpetual') {
    // Prefer the per-app park aggregate — claim-issue/claim-work park per-app, so
    // the global status.reason reads 'perpetual-drain' even when all apps are parked.
    const p = config.perpetual;
    if (p && (p.trackedAppCount > 0 || p.globalParked)) {
      // "Parked" only when there's nothing left draining: a global park, or every
      // tracked app parked. A partial park (some apps still have work) is draining.
      const allParked = p.globalParked || (p.trackedAppCount > 0 && p.parkedAppCount === p.trackedAppCount);
      if (allParked) {
        const scope = p.trackedAppCount > 0 ? `${p.trackedAppCount} app(s) parked` : 'parked';
        return {
          text: p.nextRecheckAt ? `${scope} · rechecks ${timeUntil(p.nextRecheckAt, 'soon')}` : `${scope} — no work`,
          tone: 'text-gray-400',
          title: p.parkReason ? `Parked: ${p.parkReason}` : undefined,
        };
      }
      return { text: 'draining — runs back-to-back until done', tone: 'text-port-success' };
    }
    // Global (non-app) perpetual task: the global status.reason is accurate.
    if (config.status?.reason === 'perpetual-parked') {
      const next = config.status?.nextRunAt;
      return {
        text: next ? `parked · rechecks ${timeUntil(next, 'soon')}` : 'parked — no work',
        tone: 'text-gray-400',
        title: config.status?.parkReason ? `Parked: ${config.status.parkReason}` : undefined,
      };
    }
    return { text: 'draining — runs back-to-back until done', tone: 'text-port-success' };
  }
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
  { id: 'completed', label: 'Completed', emptyMessage: 'No completed tasks.', match: ([, config]) => getTaskStatusGroup(config) === 'completed' },
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
