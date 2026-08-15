// From lib/, NOT services/apiCore.js: this file is imported by a node-env server
// test (streamingDetect's DESKTOP_TYPES parity check), where apiCore's React
// dependency doesn't resolve.
import { PORTOS_APP_ID } from '../../lib/appIdentity.js';

export const NON_PM2_TYPES = new Set(['ios-native', 'macos-native', 'xcode', 'swift']);

// The app-config text input / select styling. Shared so a restyle of these forms
// is one edit rather than one per config surface. Must stay a COMPLETE literal
// class string — Tailwind only sees classes it can read in source.
export const INPUT_CLASS = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden';

// Mirrors DESKTOP_TYPES in server/services/streamingDetect.js — app types that run
// a GUI/desktop process with no HTTP port (a game binary). Kept in sync by hand
// (a parity test asserts the two Sets match); the server stays the source of truth
// for what the type MEANS (autorestart off, command-launched, exempt from
// auto-restart supervision). The client only needs it to decide whether Start
// should open the build-output panel.
export const DESKTOP_TYPES = new Set(['desktop']);

/** Whether an app type is a portless GUI/desktop process. */
export const isDesktopType = (type) => DESKTOP_TYPES.has(type);

/**
 * The process whose live output the launch panel should tail after a Start —
 * or `null` when no panel should open.
 *
 * The gate is on the PROCESS's own result, not on the response being truthy:
 * `POST /api/apps/:id/start` answers 200 `{ success: true, results }` even when
 * every entry in `results` reports `{ success: false }`, so truthiness would open
 * a panel that spins on "Building and importing assets" forever for a process
 * that never launched — the exact "reads as hung" failure the panel exists to
 * remove. A rejected request (`result` null) opens nothing either. A 200 that
 * carries no per-process detail is trusted, so an older server still gets a panel.
 *
 * @param {object|null} app The app record (needs `type` + `pm2ProcessNames`).
 * @param {object|null} result The start endpoint's parsed response, or null if it threw.
 * @returns {string|null} PM2 process name to tail, or null.
 */
export function resolveLaunchPanelProcess(app, result) {
  if (!isDesktopType(app?.type)) return null;
  const processName = app?.pm2ProcessNames?.[0];
  if (!processName || !result) return null;
  return result?.results?.[processName]?.success === false ? null : processName;
}

// Mirrors STANDARDIZABLE_TYPES in server/services/streamingDetect.js (a parity
// test asserts the two Sets match). POSITIVE list: the PM2 standardizer writes a
// NODE ecosystem config from a prompt that opens "You are analyzing a Node.js
// application", so a Python/Go/Docker/static repo must not be offered the flow.
// `unknown` and `desktop` stay in for continuity — see the server's rationale.
export const STANDARDIZABLE_TYPES = new Set([
  'vite+express', 'vite', 'single-node-server', 'nextjs', 'desktop', 'unknown'
]);

/** Whether the PM2 standardizer (which writes a NODE ecosystem config) applies. */
export const isStandardizable = (type) => STANDARDIZABLE_TYPES.has(type ?? 'unknown');

// Every app type that can reach a UI label. Kept TOTAL (with a raw-type
// fallback) rather than a ternary chain ending in '🔨 Xcode' — that default
// meant any type not explicitly listed rendered as an Xcode project.
const APP_TYPE_LABELS = {
  'ios-native': '📱 iOS',
  'macos-native': '🖥️ macOS',
  swift: '🐦 Swift',
  xcode: '🔨 Xcode',
  python: '🐍 Python',
  go: '🐹 Go',
  docker: '🐳 Docker',
  static: '📄 Static',
  desktop: '🎮 Desktop',
  'vite+express': '⚡ Vite + Express',
  vite: '⚡ Vite',
  'single-node-server': '🟢 Node',
  nextjs: '▲ Next.js'
};

export const getAppTypeLabel = (type) => APP_TYPE_LABELS[type] || type || 'Unknown';

// Where an app's autonomous work items live. Mirrors WORK_TRACKERS +
// TRACKER_LABELS in server/lib/workTracker.js — shared by the Edit App picker
// and the /do:next run drawer so one vocabulary describes both.
export const WORK_TRACKER_OPTIONS = [
  { value: 'auto', label: 'Auto (detect from git origin)' },
  { value: 'plan', label: 'PLAN.md' },
  { value: 'github', label: 'GitHub Issues' },
  { value: 'gitlab', label: 'GitLab Issues' },
  { value: 'jira', label: 'JIRA' }
];

export const WORK_TRACKER_LABELS = Object.fromEntries(
  WORK_TRACKER_OPTIONS.map(o => [o.value, o.label])
);

/** The word a tracker uses for one work item — "issue", "ticket", "item". */
export const workItemNoun = (tracker) =>
  tracker === 'jira' ? 'ticket' : (tracker === 'github' || tracker === 'gitlab') ? 'issue' : 'item';

// Overview first, then alphabetical. Every id is a real route segment
// (`/apps/:appId/:tab`) so each tab is linkable, bookmarkable, and reachable
// from ⌘K — see the routing rules in client/src/CLAUDE.md.
//
// `visibleWhen(app)` gates a tab that only some apps earn; omit it for the tabs
// every app gets. Keeping the predicate on the entry means adding a conditional
// tab is one edit here rather than a second id-string case in the detail view.
export const APP_DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'automation', label: 'Automation' },
  { id: 'datadog', label: 'DataDog', visibleWhen: (app) => !!app?.datadog?.enabled },
  { id: 'documents', label: 'Documents' },
  { id: 'git', label: 'Git' },
  { id: 'gsd', label: 'GSD' },
  { id: 'issues', label: 'Issues' },
  { id: 'jira', label: 'JIRA' },
  { id: 'processes', label: 'Processes' },
  { id: 'references', label: 'References' },
  // Only repos that declare submodules (a .gitmodules file) get the tab — most
  // managed apps have none, and an always-empty tab is just noise.
  { id: 'submodules', label: 'Submodules', visibleWhen: (app) => !!app?.hasSubmodules },
  { id: 'tasks', label: 'Tasks' },
  { id: 'update', label: 'Update', visibleWhen: (app) => app?.id === PORTOS_APP_ID },
];
