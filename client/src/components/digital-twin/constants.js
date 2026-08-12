import {
  Heart,
  FileText,
  CheckCircle,
  Sparkles,
  Download,
  Upload,
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
  AlertOctagon,
  Fingerprint,
  Globe,
  PenLine,
  Target,
  Archive,
  Drama,
  Mic,
  Camera,
  Package,
  UserRound
} from 'lucide-react';

// Main navigation sections, ordered by the group they belong to (see
// SECTION_GROUPS below). This array stays FLAT and stays the single registry of
// section ids: `server/lib/navManifest.test.js` scrapes `id:` out of it to prove
// every section is addressable as `/digital-twin/<id>` from ⌘K and voice, and
// its extractor stops at the first `];` — so a nested array here would silently
// truncate the guard. Grouping therefore lives in a separate constant.
export const TABS = [
  // Profile
  { id: 'overview', label: 'Overview', icon: Heart },
  { id: 'identity', label: 'Identity', icon: Fingerprint },
  { id: 'personas', label: 'Personas', icon: Drama },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'taste', label: 'Taste', icon: Palette },
  // Sources
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'import', label: 'Import', icon: Upload },
  { id: 'accounts', label: 'Accounts', icon: Globe },
  { id: 'interview', label: 'Interview', icon: MessageSquare },
  { id: 'autobiography', label: 'Autobiography', icon: PenLine },
  { id: 'enrich', label: 'Enrich', icon: Sparkles },
  // Assessment
  { id: 'test', label: 'Test', icon: CheckCircle },
  { id: 'personality', label: 'Personality', icon: Brain },
  // Presence
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'appearance', label: 'Appearance', icon: Camera },
  { id: 'avatar-bio', label: 'Avatar Bio', icon: UserRound },
  // Legacy
  { id: 'export', label: 'Export', icon: Download },
  { id: 'legacy', label: 'Legacy', icon: Package },
  { id: 'time-capsule', label: 'Time Capsule', icon: Archive }
];

// Two-level nav taxonomy (#3795). 19 sections in one flat strip stopped working
// as navigation, so they collapse into five groups keyed on what the user is
// doing to the twin — the only axis inferable without already knowing the
// feature names. The group is always DERIVED from the section id in the URL
// (`sectionGroupId`), never stored, so `/digital-twin/:tab` deep links, ⌘K, and
// voice `ui_navigate` keep addressing sections directly.
export const SECTION_GROUPS = [
  { id: 'profile', label: 'Profile', icon: Fingerprint, sectionIds: ['overview', 'identity', 'personas', 'goals', 'taste'] },
  { id: 'sources', label: 'Sources', icon: FileText, sectionIds: ['documents', 'import', 'accounts', 'interview', 'autobiography', 'enrich'] },
  { id: 'assessment', label: 'Assessment', icon: CheckCircle, sectionIds: ['test', 'personality'] },
  { id: 'presence', label: 'Presence', icon: Mic, sectionIds: ['voice', 'appearance', 'avatar-bio'] },
  { id: 'legacy', label: 'Legacy', icon: Archive, sectionIds: ['export', 'legacy', 'time-capsule'] }
];

// Resolved once at module load: both constants are static, so the nav never
// re-walks them per render.
const TABS_BY_ID = new Map(TABS.map((t) => [t.id, t]));
const GROUP_SECTIONS = new Map(SECTION_GROUPS.map((g) => [
  g.id,
  g.sectionIds.map((id) => TABS_BY_ID.get(id)).filter(Boolean),
]));

// The group's sections as full tab objects, in group order. An unknown group
// yields an empty list rather than throwing.
export function groupSections(group) {
  return GROUP_SECTIONS.get(group?.id) ?? [];
}

// Which group owns a section id. Falls back to the first group so an unknown or
// stale `:tab` still renders a coherent nav (the page itself falls back to the
// Overview body for the same input).
export function sectionGroupId(sectionId) {
  return SECTION_GROUPS.find((g) => g.sectionIds.includes(sectionId))?.id ?? SECTION_GROUPS[0].id;
}

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

// Values-alignment result states (M34 P6)
export const VALUES_STATUS = {
  aligned: {
    label: 'Aligned',
    color: 'bg-green-500/20 text-green-400 border-green-500/30'
  },
  partial: {
    label: 'Partial',
    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  },
  misaligned: {
    label: 'Misaligned',
    color: 'bg-red-500/20 text-red-400 border-red-500/30'
  },
  pending: {
    label: 'Pending',
    color: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  }
};

// Adversarial-boundary result states (M34 P6)
export const ADVERSARIAL_STATUS = {
  held: {
    label: 'Held',
    color: 'bg-green-500/20 text-green-400 border-green-500/30'
  },
  partial: {
    label: 'Partial',
    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  },
  breached: {
    label: 'Breached',
    color: 'bg-red-500/20 text-red-400 border-red-500/30'
  },
  pending: {
    label: 'Pending',
    color: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  }
};

// Multi-turn conversation result states (M34 P6)
export const MULTI_TURN_STATUS = {
  consistent: {
    label: 'Consistent',
    color: 'bg-green-500/20 text-green-400 border-green-500/30'
  },
  partial: {
    label: 'Partial',
    color: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'
  },
  inconsistent: {
    label: 'Inconsistent',
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
    color: 'blue',
    listBased: true,
    itemLabel: 'Book',
    itemPlaceholder: 'e.g., Gödel, Escher, Bach by Douglas Hofstadter',
    notePlaceholder: 'Why this book matters to you, what it taught you...'
  },
  favorite_movies: {
    id: 'favorite_movies',
    label: 'Favorite Movies',
    description: 'Films that resonate with your aesthetic and values',
    icon: Film,
    color: 'red',
    listBased: true,
    itemLabel: 'Movie',
    itemPlaceholder: 'e.g., Blade Runner 2049',
    notePlaceholder: 'What draws you to this film, memorable scenes or themes...'
  },
  music_taste: {
    id: 'music_taste',
    label: 'Music Taste',
    description: 'Music as cognitive infrastructure',
    icon: Music,
    color: 'green',
    listBased: true,
    itemLabel: 'Album/Artist',
    itemPlaceholder: 'e.g., OK Computer by Radiohead',
    notePlaceholder: 'When you listen to this, how you use it (focus, energy, mood)...'
  },
  communication: {
    id: 'communication',
    label: 'Communication Style',
    description: 'How you prefer to give and receive information',
    icon: MessageSquare,
    color: 'cyan',
    hasScaleQuestions: true
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
    color: 'pink',
    hasScaleQuestions: true
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
    color: 'amber',
    hasScaleQuestions: true
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
    color: 'indigo',
    hasScaleQuestions: true
  },
  error_intolerance: {
    id: 'error_intolerance',
    label: 'Error Intolerance',
    description: 'What your digital twin should never do',
    icon: AlertOctagon,
    color: 'rose'
  },
  personality_assessments: {
    id: 'personality_assessments',
    label: 'Personality Assessments',
    description: 'Myers-Briggs, Big Five, Enneagram, and other personality type results',
    icon: Fingerprint,
    color: 'sky',
    hasScaleQuestions: true
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

// Shared 0–1 test-run score → Tailwind text color, used by the values-alignment,
// adversarial-boundary, and multi-turn test panels so their score readouts stay
// visually consistent (green ≥80%, yellow ≥50%, red below).
export function scoreToColor(score) {
  if (score >= 0.8) return 'text-green-400';
  if (score >= 0.5) return 'text-yellow-400';
  return 'text-red-400';
}

