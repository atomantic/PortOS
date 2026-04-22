/**
 * Telegram MCP Bridge Service
 *
 * Sends outbound messages via direct Telegram Bot API HTTP calls.
 * Used when telegram method is 'mcp-bridge' — the MCP plugin handles
 * inbound messages via Claude Code, this service handles outbound only.
 *
 * Reads bot token from ~/.claude/channels/telegram/.env
 * Reads chat ID from ~/.claude/channels/telegram/access.json (first allowFrom entry)
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { notificationEvents, NOTIFICATION_TYPES } from './notifications.js';

const CHANNELS_DIR = join(homedir(), '.claude', 'channels', 'telegram');
const ENV_FILE = join(CHANNELS_DIR, '.env');
const ACCESS_FILE = join(CHANNELS_DIR, 'access.json');
const API_BASE = 'https://api.telegram.org/bot';

// Module-level state
let botToken = null;
let chatId = null;
let botUsername = null;
let isActive = false;
let notificationSubscription = null;

// Rate limiter: token bucket (30 messages/minute)
let tokenBucket = 30;
let lastTokenRefill = Date.now();
const BUCKET_MAX = 30;
const REFILL_INTERVAL = 60000;

// Emoji maps (shared with manual bot)
const NOTIFICATION_EMOJI = {
  [NOTIFICATION_TYPES.MEMORY_APPROVAL]: '🧠',
  [NOTIFICATION_TYPES.TASK_APPROVAL]: '✅',
  [NOTIFICATION_TYPES.CODE_REVIEW]: '🔍',
  [NOTIFICATION_TYPES.HEALTH_ISSUE]: '⚠️',
  [NOTIFICATION_TYPES.BRIEFING_READY]: '📋',
  [NOTIFICATION_TYPES.AUTOBIOGRAPHY_PROMPT]: '📝',
  [NOTIFICATION_TYPES.PLAN_QUESTION]: '❓'
};

const PRIORITY_EMOJI = {
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴'
};

function refillTokens() {
  const now = Date.now();
  if (now - lastTokenRefill >= REFILL_INTERVAL) {
    tokenBucket = BUCKET_MAX;
    lastTokenRefill = now;
  }
}

function consumeToken() {
  refillTokens();
  if (tokenBucket <= 0) return false;
  tokenBucket--;
  return true;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Read bot token from MCP plugin's .env file
 */
async function loadBotToken() {
  const content = await readFile(ENV_FILE, 'utf-8').catch(() => null);
  if (!content) return null;
  const match = content.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Read first allowed chat ID from MCP plugin's access.json
 */
async function loadChatId() {
  const content = await readFile(ACCESS_FILE, 'utf-8').catch(() => null);
  if (!content) return null;
  const access = JSON.parse(content);
  return access.allowFrom?.[0] || null;
}

/**
 * Make a Telegram Bot API call
 */
async function apiCall(method, params) {
  if (!botToken) return null;
  const url = `${API_BASE}${botToken}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(10000)
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`📱 TG Bridge: API error on ${method} — ${data.description}`);
    return null;
  }
  return data.result;
}

/**
 * Initialize the MCP bridge
 */
export async function init() {
  await cleanup();

  botToken = await loadBotToken();
  if (!botToken) {
    console.log('📱 TG Bridge: no bot token in ~/.claude/channels/telegram/.env — skipping');
    return false;
  }

  chatId = await loadChatId();
  if (!chatId) {
    console.log('📱 TG Bridge: no allowFrom entries in access.json — skipping');
    return false;
  }

  // Validate token
  const me = await apiCall('getMe', {});
  if (!me) {
    console.error('📱 TG Bridge: invalid bot token');
    botToken = null;
    return false;
  }

  botUsername = me.username;
  isActive = true;
  console.log(`📱 TG Bridge: active as @${botUsername} → chat ${chatId}`);

  // Subscribe to notification events
  initNotificationForwarding();
  return true;
}

/**
 * Cleanup bridge state
 */
export async function cleanup() {
  if (notificationSubscription) {
    notificationEvents.removeListener('added', notificationSubscription);
    notificationSubscription = null;
  }
  isActive = false;
  botToken = null;
  chatId = null;
  botUsername = null;
}

/**
 * Send a message via direct Bot API HTTP call
 */
export async function sendMessage(text) {
  if (!botToken || !chatId) {
    return { success: false, error: !botToken ? 'No bot token' : 'No chat ID' };
  }

  if (!consumeToken()) {
    console.log('📱 TG Bridge: rate limit reached, skipping message');
    return { success: false, error: 'Rate limit exceeded' };
  }

  const result = await apiCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  });

  return result
    ? { success: true }
    : { success: false, error: 'Send failed' };
}

/**
 * Get bridge status
 */
export function getStatus() {
  return {
    connected: isActive,
    botUsername,
    chatId,
    hasBotToken: !!botToken,
    hasChatId: !!chatId
  };
}

/**
 * Reload config from MCP plugin files (called when user changes MCP config externally)
 */
export async function reload() {
  if (!isActive) return;
  const newChatId = await loadChatId();
  if (newChatId && newChatId !== chatId) {
    chatId = newChatId;
    console.log(`📱 TG Bridge: chat ID updated to ${chatId}`);
  }
}

// Cached forward types (set by the route handler)
let cachedForwardTypes = null;

export function updateCachedForwardTypes(forwardTypes) {
  cachedForwardTypes = forwardTypes;
}

/**
 * Forward a notification to Telegram via HTTP API
 */
async function forwardNotification(notification) {
  if (Array.isArray(cachedForwardTypes) && cachedForwardTypes.length > 0) {
    if (!cachedForwardTypes.includes(notification.type)) return;
  }

  const emoji = NOTIFICATION_EMOJI[notification.type] || '🔔';
  const priorityEmoji = PRIORITY_EMOJI[notification.priority] || '';
  const lines = [`${emoji} <b>${escapeHtml(notification.title)}</b>`];
  if (notification.description) lines.push(escapeHtml(notification.description));
  if (notification.priority) lines.push(`Priority: ${priorityEmoji} ${notification.priority}`);

  await sendMessage(lines.join('\n'));
}

/**
 * Subscribe to notification events
 */
function initNotificationForwarding() {
  if (notificationSubscription) {
    notificationEvents.removeListener('added', notificationSubscription);
  }
  notificationSubscription = forwardNotification;
  notificationEvents.on('added', notificationSubscription);
}
