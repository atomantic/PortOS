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

// Each entry: { id, label, Component, width, defaultH?, gate?, module? }.
// `gate(state) => bool` skips the widget when it has nothing useful to show.
// The Apps tile is intentionally un-gated — it renders its own empty-state
// CTA so the "add your first app" path is always visible on a blank install.
//
// `defaultH` is the row count (each row ≈ 80px) used when a widget is
// auto-placed into the grid for the first time — picked from the widget's
// natural content height so unmigrated layouts and newly-added widgets land
// at a usable size instead of the generic h=4 fallback. Once a layout has
// been edited, persisted h values win.
//
// `module` is optional micrographic chrome — when set, the dashboard
// renders a SchematicLabel ("MODULE.04 // ALERTS ●") as a tab on the
// widget's top border. Six widgets carry this by default; the rest are
// label-free so the dashboard doesn't turn into a wall of HUD chrome.
export const WIDGETS = [
  { id: 'quick-brain',       label: 'Quick Brain Capture',   Component: QuickBrainCapture,      width: 'half',    defaultH: 3 },
  { id: 'quick-task',        label: 'Quick Task',            Component: QuickTaskWidget,        width: 'half',    defaultH: 5 },
  { id: 'apps',              label: 'Apps Grid',             Component: AppsGridWidget,         width: 'full',    defaultH: 5, module: { id: '03', status: 'APPS',    glyph: 'matrix' } },
  { id: 'cos',               label: 'Chief of Staff',        Component: CosDashboardWidget,     width: 'third',   defaultH: 6, module: { id: '02', status: 'STAFF',   glyph: 'orbit' } },
  { id: 'goal-progress',     label: 'Goal Progress',         Component: GoalProgressWidget,     width: 'third',   defaultH: 5 },
  { id: 'upcoming-tasks',    label: 'Upcoming Tasks',        Component: UpcomingTasksWidget,    width: 'third',   defaultH: 5 },
  { id: 'proactive-alerts',  label: 'Proactive Alerts',      Component: ProactiveAlertsWidget,  width: 'quarter', defaultH: 4, module: { id: '04', status: 'ALERTS',  glyph: 'warning-tri' } },
  { id: 'review-hub',        label: 'Review Hub',            Component: ReviewHubCard,          width: 'quarter', defaultH: 4, module: { id: '05', status: 'REVIEW',  glyph: 'reticle' } },
  { id: 'system-health',     label: 'System Health',         Component: SystemHealthWidget,     width: 'quarter', defaultH: 8, module: { id: '01', status: 'HEALTH',  glyph: 'matrix' } },
  { id: 'backup',            label: 'Backup',                Component: BackupWidget,           width: 'quarter', defaultH: 5 },
  { id: 'death-clock',       label: 'Death Clock',           Component: DeathClockWidget,       width: 'quarter', defaultH: 4 },
  { id: 'quick-stats',       label: 'Quick Stats',           Component: QuickStatsWidget,       width: 'quarter', defaultH: 3, gate: (s) => s.apps.length > 0 },
  { id: 'decision-log',      label: 'Decision Log',          Component: DecisionLogWidget,      width: 'quarter', defaultH: 4 },
  { id: 'activity-streak',   label: 'Activity Streak',       Component: ActivityStreakWidget,   width: 'third',   defaultH: 3, gate: (s) => s.usage?.currentStreak > 0 || s.usage?.longestStreak > 0, module: { id: '06', status: 'STREAK',  glyph: 'spark' } },
  { id: 'hourly-activity',   label: 'Activity by Hour',      Component: HourlyActivityWidget,   width: 'full',    defaultH: 4, gate: (s) => !!s.usage?.hourlyActivity && s.usage.hourlyActivity.some((v) => v > 0) },
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

// Width keyword → 12-column grid units. Used when synthesizing a default
// grid for a layout that hasn't been positionally edited yet.
export const WIDTH_TO_COLS = {
  full:    12,
  half:    6,
  third:   4,
  quarter: 3,
};

export const GRID_COLS = 12;
export const GRID_DEFAULT_H = 4;
