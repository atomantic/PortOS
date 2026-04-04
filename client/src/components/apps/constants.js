export const NON_PM2_TYPES = new Set(['ios-native', 'macos-native', 'xcode', 'swift']);

export const getAppTypeLabel = (type) =>
  type === 'ios-native' ? '📱 iOS' :
  type === 'macos-native' ? '🖥️ macOS' :
  type === 'swift' ? '🐦 Swift' : '🔨 Xcode';

export const APP_DETAIL_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'automation', label: 'Automation' },
  { id: 'documents', label: 'Documents' },
  { id: 'git', label: 'Git' },
  { id: 'gsd', label: 'GSD' },
  { id: 'processes', label: 'Processes' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'update', label: 'Update' },
];
