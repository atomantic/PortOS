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
 * Format a timestamp as a localized time-of-day string (e.g., "1:30 PM")
 * @param {string|Date} dateStr - ISO timestamp or Date object
 * @returns {string} Formatted time of day
 */
export function formatTimeOfDay(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format a date as a localized date string (e.g., "March 5, 2026")
 * @param {string|Date} dateStr - ISO timestamp or Date object
 * @returns {string|null} Formatted date, or null for missing input
 */
export function formatDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Format a date with full detail including weekday (e.g., "Saturday, March 5, 2026")
 * @param {Date} date - Date object
 * @returns {string} Formatted date string
 */
export function formatDateFull(date) {
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Format a Date as a clock time string with seconds (e.g., "02:30:45 PM")
 * @param {Date} date - Date object
 * @returns {string} Formatted clock time
 */
export function formatClockTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
 * Format a timestamp as a localized date+time string (e.g., "Apr 1, 2026, 1:30 PM")
 * @param {string|Date|null} value - ISO timestamp or Date object
 * @returns {string} Formatted date and time, or 'Unknown time' for invalid input
 */
const _dateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function formatDateTime(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return _dateTimeFormatter.format(date);
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
