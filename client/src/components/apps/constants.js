export const NON_PM2_TYPES = new Set(['ios-native', 'macos-native', 'xcode', 'swift']);

// Mirrors DESKTOP_TYPES in server/services/streamingDetect.js — app types that run
// a GUI/desktop process with no HTTP port (a game binary). Kept in sync by hand;
// the server stays the source of truth for what the type MEANS (autorestart off,
// command-launched), this mirror only drives client-side presentation.
export const DESKTOP_TYPES = new Set(['desktop']);

/** Whether an app type is a portless GUI/desktop process. */
export const isDesktopType = (type) => DESKTOP_TYPES.has(type);

export const getAppTypeLabel = (type) =>
  type === 'ios-native' ? '📱 iOS' :
  type === 'macos-native' ? '🖥️ macOS' :
  type === 'swift' ? '🐦 Swift' : '🔨 Xcode';

export const APP_DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'automation', label: 'Automation' },
  { id: 'datadog', label: 'DataDog' },
  { id: 'documents', label: 'Documents' },
  { id: 'git', label: 'Git' },
  { id: 'gsd', label: 'GSD' },
  { id: 'processes', label: 'Processes' },
  { id: 'references', label: 'References' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'update', label: 'Update' },
];
