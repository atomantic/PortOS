/**
 * Agent Feature Constants
 */

import { DEFAULT_AVATAR_COLOR } from '../../themes/portosThemes';

export const AGENT_DETAIL_TABS = [
  { id: 'overview', label: 'Overview', icon: '📋' },
  { id: 'tools', label: 'Moltbook', icon: '📚' },
  { id: 'world', label: 'World', icon: '🌍' },
  { id: 'published', label: 'Published', icon: '📰' },
  { id: 'schedules', label: 'Schedules', icon: '📅' },
  { id: 'activity', label: 'Activity', icon: '📊' }
];

export const PERSONALITY_STYLES = [
  { value: 'professional', label: 'Professional', description: 'Formal, business-oriented communication' },
  { value: 'casual', label: 'Casual', description: 'Relaxed, friendly tone' },
  { value: 'witty', label: 'Witty', description: 'Clever humor and wordplay' },
  { value: 'academic', label: 'Academic', description: 'Educational, research-focused' },
  { value: 'creative', label: 'Creative', description: 'Artistic, imaginative expression' }
];

export const ACTION_TYPES = [
  // Moltbook actions
  { value: 'post', label: 'Post', description: 'Create new posts', icon: '📝', platform: 'moltbook' },
  { value: 'comment', label: 'Comment', description: 'Reply to posts', icon: '💬', platform: 'moltbook' },
  { value: 'vote', label: 'Vote', description: 'Upvote or downvote content', icon: '👍', platform: 'moltbook' },
  { value: 'heartbeat', label: 'Heartbeat', description: 'Browse and engage naturally', icon: '💓', platform: 'moltbook' },
  { value: 'engage', label: 'Engage', description: 'AI-powered browsing, commenting, and voting', icon: '🤝', platform: 'moltbook' },
  { value: 'monitor', label: 'Monitor', description: 'Check post engagement and respond', icon: '👀', platform: 'moltbook' },
  // Moltworld actions
  { value: 'mw_heartbeat', label: 'Heartbeat', description: 'Stay visible in the world', icon: '💓', platform: 'moltworld' },
  { value: 'mw_explore', label: 'Explore', description: 'Move to coordinates and observe', icon: '🌍', platform: 'moltworld' },
  { value: 'mw_build', label: 'Build', description: 'Place or remove blocks', icon: '🧱', platform: 'moltworld' },
  { value: 'mw_say', label: 'Say', description: 'Send messages to nearby agents', icon: '💬', platform: 'moltworld' },
  { value: 'mw_think', label: 'Think', description: 'Send a visible thought', icon: '💭', platform: 'moltworld' },
  { value: 'mw_interact', label: 'Interact', description: 'Move, think, and optionally build', icon: '🤝', platform: 'moltworld' }
];

export const SCHEDULE_TYPES = [
  { value: 'cron', label: 'Cron', description: 'Run at specific times' },
  { value: 'interval', label: 'Interval', description: 'Run every N minutes/hours' },
  { value: 'random', label: 'Random', description: 'Run at random intervals within window' }
];

export const PLATFORM_TYPES = [
  { value: 'moltbook', label: 'Moltbook', description: 'AI social platform', icon: '📚' },
  { value: 'moltworld', label: 'Moltworld', description: 'Shared voxel world', icon: '🌍' }
];

export const ACCOUNT_STATUSES = {
  active: { label: 'Active', color: 'text-port-success', bgColor: 'bg-port-success/20' },
  pending: { label: 'Pending', color: 'text-port-warning', bgColor: 'bg-port-warning/20' },
  suspended: { label: 'Suspended', color: 'text-port-error', bgColor: 'bg-port-error/20' },
  error: { label: 'Error', color: 'text-port-error', bgColor: 'bg-port-error/20' }
};

export const DEFAULT_PERSONALITY = {
  style: 'casual',
  tone: 'friendly and helpful',
  topics: [],
  quirks: [],
  promptPrefix: ''
};

export const DEFAULT_AVATAR = {
  emoji: '🤖',
  color: DEFAULT_AVATAR_COLOR
};

// Re-export shared cron presets for agent scheduling
export { CRON_PRESETS } from '../../utils/cronHelpers';

// Interval presets (in milliseconds)
export const INTERVAL_PRESETS = [
  { value: 30 * 60 * 1000, label: '30 minutes' },
  { value: 60 * 60 * 1000, label: '1 hour' },
  { value: 2 * 60 * 60 * 1000, label: '2 hours' },
  { value: 4 * 60 * 60 * 1000, label: '4 hours' },
  { value: 6 * 60 * 60 * 1000, label: '6 hours' },
  { value: 12 * 60 * 60 * 1000, label: '12 hours' },
  { value: 24 * 60 * 60 * 1000, label: '24 hours' }
];
