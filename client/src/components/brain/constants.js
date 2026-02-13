import { MessageSquare, Database, Calendar, Shield, Users, FolderKanban, Lightbulb, ClipboardList, Settings, Link2 } from 'lucide-react';

// Main navigation tabs
export const TABS = [
  { id: 'inbox', label: 'Inbox', icon: MessageSquare },
  { id: 'links', label: 'Links', icon: Link2 },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'digest', label: 'Digest', icon: Calendar },
  { id: 'trust', label: 'Trust', icon: Shield },
  { id: 'config', label: 'Config', icon: Settings }
];

// Memory sub-tabs for entity types
export const MEMORY_TABS = [
  { id: 'people', label: 'People', icon: Users },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb },
  { id: 'admin', label: 'Admin', icon: ClipboardList }
];

// Destination display info
export const DESTINATIONS = {
  people: {
    label: 'People',
    icon: Users,
    color: 'bg-purple-500/20 text-purple-400 border-purple-500/30'
  },
  projects: {
    label: 'Projects',
    icon: FolderKanban,
    color: 'bg-blue-500/20 text-blue-400 border-blue-500/30'
  },
  ideas: {
    label: 'Ideas',
    icon: Lightbulb,
    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  },
  admin: {
    label: 'Admin',
    icon: ClipboardList,
    color: 'bg-green-500/20 text-green-400 border-green-500/30'
  },
  unknown: {
    label: 'Unknown',
    icon: MessageSquare,
    color: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  }
};

// Inbox status colors
export const STATUS_COLORS = {
  classifying: 'bg-port-accent/20 text-port-accent border-port-accent/30',
  filed: 'bg-port-success/20 text-port-success border-port-success/30',
  needs_review: 'bg-port-warning/20 text-port-warning border-port-warning/30',
  corrected: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  done: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  error: 'bg-port-error/20 text-port-error border-port-error/30'
};

// Project status colors
export const PROJECT_STATUS_COLORS = {
  active: 'bg-green-500/20 text-green-400 border-green-500/30',
  waiting: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  blocked: 'bg-red-500/20 text-red-400 border-red-500/30',
  someday: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  done: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
};

// Admin status colors
export const ADMIN_STATUS_COLORS = {
  open: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  waiting: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  done: 'bg-green-500/20 text-green-400 border-green-500/30'
};

// Confidence thresholds for display
export const CONFIDENCE_COLORS = {
  high: 'text-green-400',    // >= 0.8
  medium: 'text-yellow-400', // >= 0.6
  low: 'text-red-400'        // < 0.6
};

export function getConfidenceColor(confidence) {
  if (confidence >= 0.8) return CONFIDENCE_COLORS.high;
  if (confidence >= 0.6) return CONFIDENCE_COLORS.medium;
  return CONFIDENCE_COLORS.low;
}

// Format relative time
export function formatRelativeTime(dateString) {
  if (!dateString) return 'Never';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}
