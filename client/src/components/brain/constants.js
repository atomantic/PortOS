import { MessageSquare, Database, Calendar, Rss, Shield, Users, FolderKanban, Lightbulb, ClipboardList, Settings, Link2, BookOpen, Network, FileText, NotebookPen, Upload, Target, BookText, Music, Video } from 'lucide-react';

// Main navigation tabs.
// `fullBleed: true` marks a tab that fills the available height and owns its
// own internal scroll — Brain renders these inside an overflow-hidden wrapper
// with no padding (the rest scroll inside a padded wrapper). See issue #1177.
export const TABS = [
  { id: 'inbox', label: 'Inbox', icon: MessageSquare },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb },
  { id: 'daily-log', label: 'Daily Log', icon: NotebookPen, fullBleed: true },
  { id: 'links', label: 'Links', icon: Link2 },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'notes', label: 'Notes', icon: FileText, fullBleed: true },
  { id: 'graph', label: 'Graph', icon: Network, fullBleed: true },
  { id: 'digest', label: 'Digest', icon: Calendar },
  { id: 'feeds', label: 'Feeds', icon: Rss },
  { id: 'trust', label: 'Trust', icon: Shield },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'spotify', label: 'Spotify', icon: Music },
  { id: 'youtube', label: 'YouTube', icon: Video },
  { id: 'config', label: 'Config', icon: Settings }
];

// Tab ids that render full-bleed (derived from TABS so the list can't drift).
export const FULL_BLEED_TAB_IDS = new Set(TABS.filter((t) => t.fullBleed).map((t) => t.id));

// Memory sub-tabs for entity types (alphabetical)
export const MEMORY_TABS = [
  { id: 'admin', label: 'Admin', icon: ClipboardList },
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
  links: {
    label: 'Links',
    icon: Link2,
    color: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30'
  },
  goals: {
    label: 'Goals',
    icon: Target,
    color: 'bg-orange-500/20 text-orange-400 border-orange-500/30'
  },
  journals: {
    label: 'Journal',
    icon: BookText,
    color: 'bg-teal-500/20 text-teal-400 border-teal-500/30'
  },
  songs: {
    label: 'SongBook',
    icon: Music,
    color: 'bg-rose-500/20 text-rose-400 border-rose-500/30'
  },
  unknown: {
    label: 'Unknown',
    icon: MessageSquare,
    color: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  }
};

// Destinations a user can file an inbox entry to by hand (Route / Fix pickers).
// Mirrors the server's `manualDestinationEnum` — NOT `Object.keys(DESTINATIONS)`,
// which also holds display-only entries (`links`, `goals`, `journals`, `songs`)
// the resolve/fix endpoints reject.
export const MANUAL_DESTINATIONS = ['people', 'projects', 'ideas', 'admin', 'memories'];

/**
 * Display info for where an inbox entry ended up. `filed` wins over the
 * classifier's guess — a URL capture is filed to Links with no classification at
 * all, and a corrected entry lives in its new destination. An unmapped value
 * (a peer on newer code can sync one) degrades to Unknown instead of crashing
 * the list.
 */
export const destinationInfo = (entry) =>
  DESTINATIONS[entry.filed?.destination || entry.classification?.destination || 'unknown']
  || DESTINATIONS.unknown;

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
  memories: '#ec4899',
  goals: '#f97316',
  journals: '#14b8a6',
  songs: '#f43f5e'
};
