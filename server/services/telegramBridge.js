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

import { join } from 'path';
import { homedir } from 'os';
import { tryReadFile } from '../lib/fileUtils.js';
import { notificationEvents } from './notifications.js';
import { forwardNotification as forwardToTelegram } from './telegramForward.js';
import { createTokenBucket } from '../lib/telegramRateLimit.js';

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

// Rate limiter: token bucket (30 messages/minute). Per-transport instance —
// see lib/telegramRateLimit.js for why it is not shared with the direct bot.
const rateLimiter = createTokenBucket();

/**
 * Read bot token from MCP plugin's .env file
 */
async function loadBotToken() {
  const content = await tryReadFile(ENV_FILE);
  if (!content) return null;
  const match = content.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Read first allowed chat ID from MCP plugin's access.json
 */
async function loadChatId() {
  const content = await tryReadFile(ACCESS_FILE);
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
export async function sendMessage(text, opts = { parse_mode: 'HTML' }) {
  if (!botToken || !chatId) {
    return { success: false, error: !botToken ? 'No bot token' : 'No chat ID' };
  }

  if (!rateLimiter.consume()) {
    console.log('📱 TG Bridge: rate limit reached, skipping message');
    return { success: false, error: 'Rate limit exceeded' };
  }

  // Spread the caller's options so parse_mode AND reply_markup (the memory
  // approve/reject keyboard) reach the API call, not just the text.
  const result = await apiCall('sendMessage', { chat_id: chatId, text, ...opts });

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

// Forward a notification through the shared pipeline. An arrow (not a bound
// reference) so the CURRENT cachedForwardTypes is read on every event.
const forwardNotification = (notification) =>
  forwardToTelegram(notification, { cachedForwardTypes, sendMessage });

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
