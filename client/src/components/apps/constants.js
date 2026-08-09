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

export const getAppTypeLabel = (type) =>
  type === 'ios-native' ? '📱 iOS' :
  type === 'macos-native' ? '🖥️ macOS' :
  type === 'swift' ? '🐦 Swift' : '🔨 Xcode';

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
export const APP_DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'automation', label: 'Automation' },
  { id: 'datadog', label: 'DataDog' },
  { id: 'documents', label: 'Documents' },
  { id: 'git', label: 'Git' },
  { id: 'gsd', label: 'GSD' },
  { id: 'issues', label: 'Issues' },
  { id: 'jira', label: 'JIRA' },
  { id: 'processes', label: 'Processes' },
  { id: 'references', label: 'References' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'update', label: 'Update' },
];
