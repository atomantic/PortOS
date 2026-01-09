/**
 * Notifications Service
 *
 * Manages user task notifications for items requiring attention:
 * - Memory approvals
 * - CoS task approvals
 * - Code reviews
 * - Health issues
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data');
const NOTIFICATIONS_FILE = join(DATA_DIR, 'notifications.json');

// Event emitter for notification changes
export const notificationEvents = new EventEmitter();

// In-memory cache
let notificationsCache = null;

// Notification types
export const NOTIFICATION_TYPES = {
  MEMORY_APPROVAL: 'memory_approval',
  TASK_APPROVAL: 'task_approval',
  CODE_REVIEW: 'code_review',
  HEALTH_ISSUE: 'health_issue'
};

// Priority levels
export const PRIORITY_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * Ensure data directory exists
 */
async function ensureDirectory() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

/**
 * Load notifications from file
 */
async function loadNotifications() {
  if (notificationsCache) return notificationsCache;

  await ensureDirectory();

  if (!existsSync(NOTIFICATIONS_FILE)) {
    notificationsCache = { version: 1, notifications: [] };
    return notificationsCache;
  }

  const content = await readFile(NOTIFICATIONS_FILE, 'utf-8');
  notificationsCache = JSON.parse(content);
  return notificationsCache;
}

/**
 * Save notifications to file
 */
async function saveNotifications(data) {
  await ensureDirectory();
  notificationsCache = data;
  await writeFile(NOTIFICATIONS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get all notifications
 */
export async function getNotifications(options = {}) {
  const data = await loadNotifications();
  let notifications = [...data.notifications];

  // Filter by type
  if (options.type) {
    notifications = notifications.filter(n => n.type === options.type);
  }

  // Filter by read status
  if (options.unreadOnly) {
    notifications = notifications.filter(n => !n.read);
  }

  // Sort by timestamp descending (newest first)
  notifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Limit
  if (options.limit) {
    notifications = notifications.slice(0, options.limit);
  }

  return notifications;
}

/**
 * Get unread notification count
 */
export async function getUnreadCount() {
  const data = await loadNotifications();
  return data.notifications.filter(n => !n.read).length;
}

/**
 * Get notification counts by type
 */
export async function getCountsByType() {
  const data = await loadNotifications();
  const counts = {
    total: 0,
    unread: 0,
    byType: {}
  };

  for (const n of data.notifications) {
    counts.total++;
    if (!n.read) counts.unread++;
    counts.byType[n.type] = (counts.byType[n.type] || 0) + 1;
  }

  return counts;
}

/**
 * Add a new notification
 */
export async function addNotification(notification) {
  const data = await loadNotifications();

  const newNotification = {
    id: uuidv4(),
    type: notification.type,
    title: notification.title,
    description: notification.description || '',
    priority: notification.priority || PRIORITY_LEVELS.MEDIUM,
    timestamp: new Date().toISOString(),
    link: notification.link || null,
    read: false,
    metadata: notification.metadata || {}
  };

  data.notifications.push(newNotification);
  await saveNotifications(data);

  console.log(`🔔 Notification added: ${newNotification.type} - ${newNotification.title}`);
  notificationEvents.emit('added', newNotification);
  notificationEvents.emit('count-changed', await getUnreadCount());

  return newNotification;
}

/**
 * Remove a notification by ID
 */
export async function removeNotification(id) {
  const data = await loadNotifications();
  const index = data.notifications.findIndex(n => n.id === id);

  if (index === -1) {
    return { success: false, error: 'Notification not found' };
  }

  const removed = data.notifications.splice(index, 1)[0];
  await saveNotifications(data);

  console.log(`🔔 Notification removed: ${id}`);
  notificationEvents.emit('removed', { id });
  notificationEvents.emit('count-changed', await getUnreadCount());

  return { success: true, notification: removed };
}

/**
 * Remove notifications by metadata field
 * Useful for removing notifications when the underlying item is handled
 */
export async function removeByMetadata(field, value) {
  const data = await loadNotifications();
  const before = data.notifications.length;

  data.notifications = data.notifications.filter(n => n.metadata[field] !== value);

  const removed = before - data.notifications.length;
  if (removed > 0) {
    await saveNotifications(data);
    console.log(`🔔 Removed ${removed} notifications with ${field}=${value}`);
    notificationEvents.emit('count-changed', await getUnreadCount());
  }

  return { success: true, removed };
}

/**
 * Mark a notification as read
 */
export async function markAsRead(id) {
  const data = await loadNotifications();
  const notification = data.notifications.find(n => n.id === id);

  if (!notification) {
    return { success: false, error: 'Notification not found' };
  }

  if (!notification.read) {
    notification.read = true;
    await saveNotifications(data);

    notificationEvents.emit('updated', notification);
    notificationEvents.emit('count-changed', await getUnreadCount());
  }

  return { success: true, notification };
}

/**
 * Mark all notifications as read
 */
export async function markAllAsRead() {
  const data = await loadNotifications();
  let updated = 0;

  for (const notification of data.notifications) {
    if (!notification.read) {
      notification.read = true;
      updated++;
    }
  }

  if (updated > 0) {
    await saveNotifications(data);
    notificationEvents.emit('count-changed', 0);
  }

  return { success: true, updated };
}

/**
 * Clear all notifications
 */
export async function clearAll() {
  const data = await loadNotifications();
  const count = data.notifications.length;

  data.notifications = [];
  await saveNotifications(data);

  notificationEvents.emit('cleared');
  notificationEvents.emit('count-changed', 0);

  return { success: true, cleared: count };
}

/**
 * Check if a notification already exists (prevent duplicates)
 */
export async function exists(type, metadataField, metadataValue) {
  const data = await loadNotifications();
  return data.notifications.some(
    n => n.type === type && n.metadata[metadataField] === metadataValue
  );
}

/**
 * Invalidate cache (call after external changes)
 */
export function invalidateCache() {
  notificationsCache = null;
}
