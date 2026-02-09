/**
 * Agent Feature Constants
 */

export const TABS = [
  { id: 'personalities', label: 'Personalities', icon: '🤖' },
  { id: 'accounts', label: 'Accounts', icon: '🔗' },
  { id: 'schedules', label: 'Schedules', icon: '📅' },
  { id: 'tools', label: 'Tools', icon: '🛠️' },
  { id: 'activity', label: 'Activity', icon: '📊' },
  { id: 'config', label: 'Config', icon: '⚙️' }
];

export const PERSONALITY_STYLES = [
  { value: 'professional', label: 'Professional', description: 'Formal, business-oriented communication' },
  { value: 'casual', label: 'Casual', description: 'Relaxed, friendly tone' },
  { value: 'witty', label: 'Witty', description: 'Clever humor and wordplay' },
  { value: 'academic', label: 'Academic', description: 'Educational, research-focused' },
  { value: 'creative', label: 'Creative', description: 'Artistic, imaginative expression' }
];

export const ACTION_TYPES = [
  { value: 'post', label: 'Post', description: 'Create new posts', icon: '📝' },
  { value: 'comment', label: 'Comment', description: 'Reply to posts', icon: '💬' },
  { value: 'vote', label: 'Vote', description: 'Upvote or downvote content', icon: '👍' },
  { value: 'heartbeat', label: 'Heartbeat', description: 'Browse and engage naturally', icon: '💓' },
  { value: 'engage', label: 'Engage', description: 'AI-powered browsing, commenting, and voting', icon: '🤝' }
];

export const SCHEDULE_TYPES = [
  { value: 'cron', label: 'Cron', description: 'Run at specific times' },
  { value: 'interval', label: 'Interval', description: 'Run every N minutes/hours' },
  { value: 'random', label: 'Random', description: 'Run at random intervals within window' }
];

export const PLATFORM_TYPES = [
  { value: 'moltbook', label: 'Moltbook', description: 'AI social platform', icon: '📚' }
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
  color: '#3b82f6'
};

// Cron presets for easy scheduling
export const CRON_PRESETS = [
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */2 * * *', label: 'Every 2 hours' },
  { value: '0 */4 * * *', label: 'Every 4 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 9,12,15,18 * * *', label: 'Peak hours (9am, 12pm, 3pm, 6pm)' },
  { value: '0 9 * * *', label: 'Daily at 9am' },
  { value: '0 12 * * *', label: 'Daily at noon' }
];

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
