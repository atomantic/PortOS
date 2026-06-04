import {
  Target, Lightbulb, Users, Heart, DollarSign, Flame
} from 'lucide-react';

export const CATEGORY_CONFIG = {
  creative: { label: 'Creative', icon: Lightbulb, color: 'text-purple-400', bg: 'bg-purple-500/20', hex: '#a855f7' },
  family: { label: 'Family', icon: Users, color: 'text-pink-400', bg: 'bg-pink-500/20', hex: '#ec4899' },
  health: { label: 'Health', icon: Heart, color: 'text-green-400', bg: 'bg-green-500/20', hex: '#22c55e' },
  financial: { label: 'Financial', icon: DollarSign, color: 'text-yellow-400', bg: 'bg-yellow-500/20', hex: '#eab308' },
  legacy: { label: 'Legacy', icon: Flame, color: 'text-orange-400', bg: 'bg-orange-500/20', hex: '#f97316' },
  mastery: { label: 'Mastery', icon: Target, color: 'text-blue-400', bg: 'bg-blue-500/20', hex: '#3b82f6' }
};

export const HORIZON_OPTIONS = [
  { value: '1-year', label: '1 Year' },
  { value: '3-year', label: '3 Years' },
  { value: '5-year', label: '5 Years' },
  { value: '10-year', label: '10 Years' },
  { value: '20-year', label: '20 Years' },
  { value: 'lifetime', label: 'Lifetime' }
];

export const GOAL_TYPE_CONFIG = {
  apex: { label: 'Apex', color: 'text-amber-400', bg: 'bg-amber-500/20', description: 'North-star purpose' },
  'sub-apex': { label: 'Sub-Apex', color: 'text-purple-400', bg: 'bg-purple-500/20', description: 'Major life pillar' },
  standard: { label: 'Standard', color: 'text-gray-400', bg: 'bg-gray-500/20', description: 'Regular goal' }
};

export const GOAL_TYPE_OPTIONS = Object.entries(GOAL_TYPE_CONFIG).map(([value, cfg]) => ({ value, label: cfg.label }));

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 50;

export const DEFAULT_NEW_GOAL = { title: '', description: '', horizon: '5-year', category: 'mastery', parentId: null };

export const CHECK_IN_STATUS_CONFIG = {
  'on-track': { color: 'text-green-400', bg: 'bg-green-500/20', label: 'On Track' },
  'behind': { color: 'text-yellow-400', bg: 'bg-yellow-500/20', label: 'Behind' },
  'at-risk': { color: 'text-red-400', bg: 'bg-red-500/20', label: 'At Risk' }
};

export const CHECK_IN_DOT_COLORS = { 'on-track': 'bg-green-500', 'behind': 'bg-yellow-500', 'at-risk': 'bg-red-500' };
