import { LayoutDashboard, Settings, Play, GitBranch, Terminal } from 'lucide-react';

export function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'config', label: 'Config', icon: Settings },
  { id: 'runs', label: 'Runs', icon: Play },
  { id: 'output', label: 'Output', icon: Terminal },
  { id: 'git', label: 'Git', icon: GitBranch }
];

export const VALID_TAB_IDS = new Set(TABS.map(t => t.id));

export const STATUS_COLORS = {
  draft: 'text-gray-400',
  active: 'text-port-success',
  paused: 'text-port-warning',
  completed: 'text-port-accent',
  error: 'text-port-error'
};

export const STATUS_BG = {
  draft: 'bg-gray-400/10',
  active: 'bg-port-success/10',
  paused: 'bg-port-warning/10',
  completed: 'bg-port-accent/10',
  error: 'bg-port-error/10'
};

export const PRIORITY_COLORS = {
  LOW: 'text-gray-400',
  MEDIUM: 'text-port-accent',
  HIGH: 'text-port-warning',
  CRITICAL: 'text-port-error'
};

export const SCHEDULE_LABELS = {
  continuous: 'Continuous',
  interval: 'Interval'
};

export const AUTONOMY_LABELS = {
  standby: 'Standby',
  assistant: 'Assistant',
  manager: 'Manager',
  yolo: 'YOLO'
};
