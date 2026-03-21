/**
 * Shared formatting utilities for the client
 * These functions are used across multiple pages and components
 */

/**
 * Format a timestamp as a relative time string
 * @param {string|Date} timestamp - ISO timestamp or Date object
 * @returns {string} Formatted relative time (e.g., "Just now", "5m ago", "2h ago")
 */
export function formatTime(timestamp) {
  if (timestamp == null || timestamp === '') return 'Unknown';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'Invalid date';
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return date.toLocaleDateString();
}

/**
 * Format a duration in milliseconds as a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string|null} Formatted duration (e.g., "500ms", "1.5s", "2.0m")
 */
export function formatRuntime(ms) {
  if (!ms) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Format a timestamp as relative time (e.g., "just now", "5m ago", "2d ago")
 * Handles null/missing values with configurable fallback.
 * @param {string|Date|null} dateStr - ISO timestamp, Date object, or null
 * @param {string} fallback - Text to show for null/missing dates (default: 'never')
 * @returns {string} Relative time string
 */
export function timeAgo(dateStr, fallback = 'never') {
  if (!dateStr) return fallback;
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return seconds < 10 ? 'just now' : `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Format bytes as a human-readable string
 * @param {number} bytes - Size in bytes
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted size (e.g., "1.5 KB", "2.3 MB")
 */
export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/**
 * Get app name from app ID by looking up in apps array
 * @param {string|null} appId - The app ID to look up
 * @param {Array<{id: string, name: string}>} apps - Array of app objects
 * @param {string} fallback - Fallback value if app not found
 * @returns {string|null} App name or fallback
 */
export function getAppName(appId, apps, fallback = null) {
  if (!appId) return fallback;
  const app = apps?.find(a => a.id === appId);
  return app?.name || fallback;
}
