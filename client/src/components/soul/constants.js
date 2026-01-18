import {
  Heart,
  FileText,
  CheckCircle,
  Sparkles,
  Download,
  Settings,
  BookOpen,
  Film,
  Music,
  MessageSquare,
  Brain,
  Palette,
  Clock,
  Briefcase,
  Star,
  Tv,
  Users,
  Coffee,
  Paintbrush,
  Shield,
  GitBranch,
  AlertOctagon
} from 'lucide-react';

// Main navigation tabs
export const TABS = [
  { id: 'overview', label: 'Overview', icon: Heart },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'test', label: 'Test', icon: CheckCircle },
  { id: 'enrich', label: 'Enrich', icon: Sparkles },
  { id: 'export', label: 'Export', icon: Download }
];

// Document category configurations
export const DOCUMENT_CATEGORIES = {
  core: {
    label: 'Core Identity',
    color: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    icon: Heart
  },
  audio: {
    label: 'Audio/Music',
    color: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    icon: Music
  },
  behavioral: {
    label: 'Behavioral Tests',
    color: 'bg-green-500/20 text-green-400 border-green-500/30',
    icon: CheckCircle
  },
  enrichment: {
    label: 'Enrichment',
    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    icon: Sparkles
  },
  entertainment: {
    label: 'Entertainment',
    color: 'bg-red-500/20 text-red-400 border-red-500/30',
    icon: Tv
  },
  professional: {
    label: 'Professional',
    color: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
    icon: Briefcase
  },
  lifestyle: {
    label: 'Lifestyle',
    color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    icon: Coffee
  },
  social: {
    label: 'Social',
    color: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
    icon: Users
  },
  creative: {
    label: 'Creative',
    color: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    icon: Paintbrush
  }
};

// Test result status colors
export const TEST_STATUS = {
  passed: {
    label: 'Passed',
    color: 'bg-green-500/20 text-green-400 border-green-500/30'
  },
  partial: {
    label: 'Partial',
    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  },
  failed: {
    label: 'Failed',
    color: 'bg-red-500/20 text-red-400 border-red-500/30'
  },
  pending: {
    label: 'Pending',
    color: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  }
};

// Enrichment category configurations
export const ENRICHMENT_CATEGORIES = {
  core_memories: {
    id: 'core_memories',
    label: 'Core Memories',
    description: 'Formative experiences that shaped your identity',
    icon: Star,
    color: 'purple'
  },
  favorite_books: {
    id: 'favorite_books',
    label: 'Favorite Books',
    description: 'Books that shaped your thinking',
    icon: BookOpen,
    color: 'blue'
  },
  favorite_movies: {
    id: 'favorite_movies',
    label: 'Favorite Movies',
    description: 'Films that resonate with your aesthetic and values',
    icon: Film,
    color: 'red'
  },
  music_taste: {
    id: 'music_taste',
    label: 'Music Taste',
    description: 'Music as cognitive infrastructure',
    icon: Music,
    color: 'green'
  },
  communication: {
    id: 'communication',
    label: 'Communication Style',
    description: 'How you prefer to give and receive information',
    icon: MessageSquare,
    color: 'cyan'
  },
  decision_making: {
    id: 'decision_making',
    label: 'Decision Making',
    description: 'How you approach choices and uncertainty',
    icon: Brain,
    color: 'orange'
  },
  values: {
    id: 'values',
    label: 'Values',
    description: 'Core principles that guide your actions',
    icon: Heart,
    color: 'pink'
  },
  aesthetics: {
    id: 'aesthetics',
    label: 'Aesthetic Preferences',
    description: 'Visual and design sensibilities',
    icon: Palette,
    color: 'violet'
  },
  daily_routines: {
    id: 'daily_routines',
    label: 'Daily Routines',
    description: 'Habits and rhythms that structure your day',
    icon: Clock,
    color: 'amber'
  },
  career_skills: {
    id: 'career_skills',
    label: 'Career & Skills',
    description: 'Professional expertise and growth areas',
    icon: Briefcase,
    color: 'emerald'
  },
  non_negotiables: {
    id: 'non_negotiables',
    label: 'Non-Negotiables',
    description: 'Principles and boundaries that define your limits',
    icon: Shield,
    color: 'red'
  },
  decision_heuristics: {
    id: 'decision_heuristics',
    label: 'Decision Heuristics',
    description: 'Mental models and shortcuts for making choices',
    icon: GitBranch,
    color: 'indigo'
  },
  error_intolerance: {
    id: 'error_intolerance',
    label: 'Error Intolerance',
    description: 'What your digital twin should never do',
    icon: AlertOctagon,
    color: 'rose'
  }
};

// Export format configurations
export const EXPORT_FORMATS = {
  system_prompt: {
    id: 'system_prompt',
    label: 'System Prompt',
    description: 'Combined markdown for direct injection into LLM system prompts'
  },
  claude_md: {
    id: 'claude_md',
    label: 'CLAUDE.md',
    description: 'Format optimized for Claude Code integration'
  },
  json: {
    id: 'json',
    label: 'JSON',
    description: 'Structured JSON for API integration'
  },
  individual: {
    id: 'individual',
    label: 'Individual Files',
    description: 'Separate files for each document'
  }
};

// Health score thresholds
export const HEALTH_THRESHOLDS = {
  excellent: 80,
  good: 60,
  fair: 40
};

export function getHealthColor(score) {
  if (score >= HEALTH_THRESHOLDS.excellent) return 'text-green-400';
  if (score >= HEALTH_THRESHOLDS.good) return 'text-blue-400';
  if (score >= HEALTH_THRESHOLDS.fair) return 'text-yellow-400';
  return 'text-red-400';
}

export function getHealthLabel(score) {
  if (score >= HEALTH_THRESHOLDS.excellent) return 'Excellent';
  if (score >= HEALTH_THRESHOLDS.good) return 'Good';
  if (score >= HEALTH_THRESHOLDS.fair) return 'Fair';
  return 'Needs Work';
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
