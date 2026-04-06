import { MessageSquare, Database, Calendar, Rss, Shield, Users, FolderKanban, Lightbulb, ClipboardList, Settings, Link2, BookOpen, Network, FileText } from 'lucide-react';

// Main navigation tabs
export const TABS = [
  { id: 'inbox', label: 'Inbox', icon: MessageSquare },
  { id: 'links', label: 'Links', icon: Link2 },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'graph', label: 'Graph', icon: Network },
  { id: 'digest', label: 'Digest', icon: Calendar },
  { id: 'feeds', label: 'Feeds', icon: Rss },
  { id: 'trust', label: 'Trust', icon: Shield },
  { id: 'config', label: 'Config', icon: Settings }
];

// Memory sub-tabs for entity types (alphabetical)
export const MEMORY_TABS = [
  { id: 'admin', label: 'Admin', icon: ClipboardList },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb },
  { id: 'memories', label: 'Memories', icon: BookOpen },
  { id: 'people', label: 'People', icon: Users },
  { id: 'projects', label: 'Projects', icon: FolderKanban }
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
  memories: {
    label: 'Memories',
    icon: BookOpen,
    color: 'bg-pink-500/20 text-pink-400 border-pink-500/30'
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

// Idea status colors
export const IDEA_STATUS_COLORS = {
  active: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
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

// Brain entity type hex colors for graph visualization
export const BRAIN_TYPE_HEX = {
  people: '#a855f7',
  projects: '#3b82f6',
  ideas: '#eab308',
  admin: '#22c55e',
  memories: '#ec4899'
};

