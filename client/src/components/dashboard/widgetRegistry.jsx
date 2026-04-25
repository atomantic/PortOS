import BackupWidget from '../BackupWidget';
import SystemHealthWidget from '../SystemHealthWidget';
import CosDashboardWidget from '../CosDashboardWidget';
import GoalProgressWidget from '../GoalProgressWidget';
import UpcomingTasksWidget from '../UpcomingTasksWidget';
import DecisionLogWidget from '../DecisionLogWidget';
import DeathClockWidget from '../DeathClockWidget';
import ProactiveAlertsWidget from '../ProactiveAlertsWidget';
import QuickBrainCapture from '../QuickBrainCapture';
import QuickTaskWidget from '../QuickTaskWidget';
import ReviewHubCard from '../ReviewHubCard';
import AppsGridWidget from './builtins/AppsGridWidget';
import QuickStatsWidget from './builtins/QuickStatsWidget';
import ActivityStreakWidget from './builtins/ActivityStreakWidget';
import HourlyActivityWidget from './builtins/HourlyActivityWidget';

// Each entry: { id, label, Component, width, gate? }. `gate(state) => bool`
// skips the widget when it has nothing useful to show. The Apps tile is
// intentionally un-gated — it renders its own empty-state CTA so the "add
// your first app" path is always visible on a blank install.
export const WIDGETS = [
  { id: 'quick-brain',       label: 'Quick Brain Capture',   Component: QuickBrainCapture,      width: 'half' },
  { id: 'quick-task',        label: 'Quick Task',            Component: QuickTaskWidget,        width: 'half' },
  { id: 'apps',              label: 'Apps Grid',             Component: AppsGridWidget,         width: 'full' },
  { id: 'cos',               label: 'Chief of Staff',        Component: CosDashboardWidget,     width: 'third' },
  { id: 'goal-progress',     label: 'Goal Progress',         Component: GoalProgressWidget,     width: 'third' },
  { id: 'upcoming-tasks',    label: 'Upcoming Tasks',        Component: UpcomingTasksWidget,    width: 'third' },
  { id: 'proactive-alerts',  label: 'Proactive Alerts',      Component: ProactiveAlertsWidget,  width: 'quarter' },
  { id: 'review-hub',        label: 'Review Hub',            Component: ReviewHubCard,          width: 'quarter' },
  { id: 'system-health',     label: 'System Health',         Component: SystemHealthWidget,     width: 'quarter' },
  { id: 'backup',            label: 'Backup',                Component: BackupWidget,           width: 'quarter' },
  { id: 'death-clock',       label: 'Death Clock',           Component: DeathClockWidget,       width: 'quarter' },
  { id: 'quick-stats',       label: 'Quick Stats',           Component: QuickStatsWidget,       width: 'quarter', gate: (s) => s.apps.length > 0 },
  { id: 'decision-log',      label: 'Decision Log',          Component: DecisionLogWidget,      width: 'quarter' },
  { id: 'activity-streak',   label: 'Activity Streak',       Component: ActivityStreakWidget,   width: 'third',   gate: (s) => s.usage?.currentStreak > 0 || s.usage?.longestStreak > 0 },
  { id: 'hourly-activity',   label: 'Activity by Hour',      Component: HourlyActivityWidget,   width: 'full',    gate: (s) => !!s.usage?.hourlyActivity && s.usage.hourlyActivity.some((v) => v > 0) },
];

export const WIDGETS_BY_ID = Object.fromEntries(WIDGETS.map((w) => [w.id, w]));

// Local fallback used when the layouts endpoint is unreachable. Keeps the
// dashboard usable during a transient server outage instead of rendering a
// blank page. Intentionally minimal — the full built-ins live server-side.
export const FALLBACK_LAYOUT = Object.freeze({
  id: '_fallback',
  name: 'Default (offline)',
  builtIn: true,
  widgets: ['apps', 'cos', 'upcoming-tasks', 'system-health'],
});

export const WIDTH_CLASS = {
  full:    'col-span-12',
  half:    'col-span-12 md:col-span-6',
  third:   'col-span-12 md:col-span-6 lg:col-span-4',
  quarter: 'col-span-12 sm:col-span-6 lg:col-span-3',
};
