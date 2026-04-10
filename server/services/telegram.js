/**
 * Telegram Bot Service
 *
 * Manages Telegram bot lifecycle, messaging, notification forwarding,
 * and conversational commands for PortOS.
 */

import { createTelegramBot } from '../lib/telegramClient.js';
import { writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getSettings } from './settings.js';
import { notificationEvents, NOTIFICATION_TYPES, getNotifications } from './notifications.js';
import { approveMemory, rejectMemory, peekMemory } from './memoryBackend.js';
import { ensureDir, PATHS, readJSONFile, formatDuration } from '../lib/fileUtils.js';
import { getActiveAgents } from './subAgentSpawner.js';
import { getGoals } from './identity.js';

const HEALTH_CHECK_INTERVAL_MS = 30_000;

// Module-level state
let bot = null;
let isConnected = false;
let reconnectionTimeout = null;
let healthCheckInterval = null;
let reconnectionAttempts = 0;
let botUsername = null;
let notificationSubscription = null;

// Cached config (refreshed on init)
let authorizedChatId = null;
let cachedForwardTypes = null;

// Rate limiter: token bucket (30 messages/minute)
let tokenBucket = 30;
let lastTokenRefill = Date.now();
const BUCKET_MAX = 30;
const REFILL_INTERVAL = 60000; // 1 minute

// Pending check-ins with 10-minute TTL
const pendingCheckins = new Map();
const CHECKIN_TTL = 10 * 60 * 1000;

const CHECKINS_DIR = join(PATHS.data, 'telegram');
const CHECKINS_FILE = join(CHECKINS_DIR, 'checkins.json');
const MAX_CHECKINS = 500;

// Emoji map for notification types
const NOTIFICATION_EMOJI = {
  [NOTIFICATION_TYPES.MEMORY_APPROVAL]: '🧠',
  [NOTIFICATION_TYPES.TASK_APPROVAL]: '✅',
  [NOTIFICATION_TYPES.CODE_REVIEW]: '🔍',
  [NOTIFICATION_TYPES.HEALTH_ISSUE]: '⚠️',
  [NOTIFICATION_TYPES.BRIEFING_READY]: '📋',
  [NOTIFICATION_TYPES.AUTOBIOGRAPHY_PROMPT]: '📝',
  [NOTIFICATION_TYPES.PLAN_QUESTION]: '❓'
};

// Priority emoji
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

function cleanExpiredCheckins() {
  const now = Date.now();
  for (const [key, value] of pendingCheckins) {
    if (now - new Date(value.askedAt).getTime() > CHECKIN_TTL) {
      pendingCheckins.delete(key);
    }
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Initialize the Telegram bot
 * @param {boolean} sendTestMessage - Send a test message after connecting
 */
export async function init(sendTestMessage = false) {
  await cleanup();

  const settings = await getSettings();
  const token = settings.secrets?.telegram?.token;
  const chatId = settings.telegram?.chatId;
  authorizedChatId = chatId || null;
  cachedForwardTypes = settings.telegram?.forwardTypes || null;

  if (!token) {
    console.log('📱 Telegram: no token configured — skipping');
    return;
  }

  // Ensure data directory exists once at init
  await ensureDir(CHECKINS_DIR);

  bot = createTelegramBot(token, { polling: true });
  reconnectionAttempts = 0;

  // Validate token
  const me = await bot.getMe().catch(err => {
    console.error(`📱 Telegram: invalid token — ${err.message}`);
    bot = null;
    return null;
  });

  if (!me) return;

  botUsername = me.username;
  isConnected = true;
  console.log(`📱 Telegram: connected as @${botUsername}`);

  // Register /start handler (always works, no auth required)
  bot.onText(/\/start/, (msg) => {
    const fromChatId = String(msg.chat.id);
    bot.sendMessage(fromChatId,
      `Your Chat ID: <code>${fromChatId}</code>\n\n` +
      'Paste this into the PortOS Settings → Telegram → Chat ID field, then click Save & Test.',
      { parse_mode: 'HTML' }
    );
  });

  // Register command handlers
  bot.onText(/\/status/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleStatusCommand(msg);
  });

  bot.onText(/\/goals/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleGoalsCommand(msg);
  });

  bot.onText(/\/agents/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleAgentsCommand(msg);
  });

  bot.onText(/\/checkin/, async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleCheckinCommand(msg);
  });

  bot.onText(/\/help/, async (msg) => {
    if (!isAuthorized(msg)) return;
    bot.sendMessage(String(msg.chat.id),
      '<b>PortOS Bot Commands</b>\n\n' +
      '/status — System overview\n' +
      '/goals — Active goals with progress\n' +
      '/agents — Running agents\n' +
      '/checkin — Goal check-in question\n' +
      '/help — Show this message',
      { parse_mode: 'HTML' }
    );
  });

  // Handle non-command messages (check-in responses)
  bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/')) return;
    if (!isAuthorized(msg)) return;
    await handleCheckinResponse(msg);
  });

  // Handle inline keyboard button clicks (memory approve/reject)
  bot.on('callback_query', async (query) => {
    if (String(query.message?.chat?.id) !== authorizedChatId) {
      await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' }).catch(() => {});
      return;
    }
    await handleCallbackQuery(query);
  });

  // Start health check
  healthCheckInterval = setInterval(healthCheck, HEALTH_CHECK_INTERVAL_MS);

  // Subscribe to notification events
  initNotificationForwarding();

  if (sendTestMessage && chatId) {
    await sendMessage('📱 PortOS Telegram bot connected successfully!');
  }
}

/**
 * Check if a message is from the authorized chatId
 */
function isAuthorized(msg) {
  const fromChatId = String(msg.chat.id);
  if (fromChatId !== authorizedChatId) {
    bot?.sendMessage(fromChatId,
      'This bot is not configured for your chat ID.\n' +
      'If you own this bot, message /start to see your chat ID, then configure it in PortOS Settings.'
    );
    return false;
  }
  return true;
}

/**
 * Cleanup bot instance
 */
export async function cleanup() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  if (reconnectionTimeout) {
    clearTimeout(reconnectionTimeout);
    reconnectionTimeout = null;
  }
  if (notificationSubscription) {
    notificationEvents.removeListener('added', notificationSubscription);
    notificationSubscription = null;
  }
  if (bot) {
    await bot.stopPolling().catch(() => {});
    bot = null;
  }
  isConnected = false;
  botUsername = null;
  authorizedChatId = null;
  cachedForwardTypes = null;
}

/**
 * Reconnect with exponential backoff
 */
async function reconnect() {
  if (reconnectionAttempts >= 10) {
    console.error('📱 Telegram: max reconnection attempts reached');
    return;
  }
  reconnectionAttempts++;
  const delay = 5000 * reconnectionAttempts;
  console.log(`📱 Telegram: reconnecting in ${delay / 1000}s (attempt ${reconnectionAttempts}/10)`);

  reconnectionTimeout = setTimeout(async () => {
    await init(false).catch(err => {
      console.error(`📱 Telegram: reconnection failed — ${err.message}`);
    });
  }, delay);
}

/**
 * Health check
 */
async function healthCheck() {
  if (!bot) return;
  await bot.getMe().catch(async (err) => {
    console.error(`📱 Telegram: health check failed — ${err.message}`);
    isConnected = false;
    await reconnect();
  });
}

/**
 * Send a message to the configured chatId
 */
export async function sendMessage(text, opts = { parse_mode: 'HTML' }) {
  if (!bot || !authorizedChatId) return { success: false, error: !bot ? 'Bot not initialized' : 'No chatId configured' };

  if (!consumeToken()) {
    console.log('📱 Telegram: rate limit reached, skipping message');
    return { success: false, error: 'Rate limit exceeded' };
  }

  const result = await bot.sendMessage(authorizedChatId, text, opts).catch(async (err) => {
    console.error(`📱 Telegram: send failed — ${err.message}`);
    isConnected = false;
    await reconnect();
    return null;
  });

  return result ? { success: true } : { success: false, error: 'Send failed' };
}

/**
 * Get bot status
 */
export function getStatus() {
  return {
    connected: isConnected,
    hasChatId: false, // Checked by caller via settings
    hasToken: false,  // Checked by caller via settings
    botUsername
  };
}

/**
 * Update cached forward types (called from route on config change)
 */
export function updateCachedForwardTypes(forwardTypes) {
  cachedForwardTypes = forwardTypes;
}

// Callback data prefixes for inline keyboard actions
const CALLBACK_APPROVE = 'mem_approve';
const CALLBACK_REJECT = 'mem_reject';

/**
 * Handle inline keyboard callback queries (memory approve/reject)
 */
async function handleCallbackQuery(query) {
  const data = query.data;
  if (!data || !query.message) return;

  if (data.startsWith(`${CALLBACK_APPROVE}:`) || data.startsWith(`${CALLBACK_REJECT}:`)) {
    const colonIdx = data.indexOf(':');
    const action = data.slice(0, colonIdx);
    const memoryId = data.slice(colonIdx + 1);

    if (!memoryId) {
      await bot.answerCallbackQuery(query.id, { text: '⚠️ Invalid callback data' }).catch(() => {});
      return;
    }

    const isApprove = action === CALLBACK_APPROVE;

    let result;
    try {
      result = isApprove ? await approveMemory(memoryId) : await rejectMemory(memoryId);
    } catch (err) {
      console.error(`📱 Telegram: memory ${isApprove ? 'approve' : 'reject'} failed — ${err.message}`);
      result = { success: false, error: err.message };
    }

    const responseText = result.success
      ? (isApprove ? '✅ Memory approved' : '❌ Memory rejected')
      : `⚠️ ${result.error || 'Action failed'}`;

    const originalText = query.message.text || '';
    const statusLine = result.success
      ? `\n\n${isApprove ? '✅ Approved' : '❌ Rejected'}`
      : `\n\n⚠️ ${result.error || 'Action failed'}`;

    await Promise.all([
      bot.answerCallbackQuery(query.id, { text: responseText }).catch(() => {}),
      bot.editMessageText(originalText + statusLine, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: JSON.stringify({ inline_keyboard: [] })
      }).catch(() => {})
    ]);
  }
}

/**
 * Forward a notification to Telegram
 */
async function forwardNotification(notification) {
  // Use cached forwardTypes to avoid disk I/O on every notification
  if (Array.isArray(cachedForwardTypes) && cachedForwardTypes.length > 0) {
    if (!cachedForwardTypes.includes(notification.type)) return;
  }

  const emoji = NOTIFICATION_EMOJI[notification.type] || '🔔';
  const priorityEmoji = PRIORITY_EMOJI[notification.priority] || '';
  const lines = [`${emoji} <b>${escapeHtml(notification.title)}</b>`];
  const opts = { parse_mode: 'HTML' };
  const isMemoryApproval = notification.type === NOTIFICATION_TYPES.MEMORY_APPROVAL && notification.metadata?.memoryId;

  if (isMemoryApproval) {
    const memory = await peekMemory(notification.metadata.memoryId).catch(() => null);
    const raw = memory?.summary || memory?.content || notification.description || '';
    // Telegram 4096 char limit; truncate raw text before escaping to guarantee
    // the escaped result stays under limit (escaping expands at most 5x per char
    // for &amp; but typical text is <1.2x; 2800 raw → ≤3500 escaped conservatively)
    const MAX_RAW = 2800;
    const truncated = raw.length > MAX_RAW ? raw.slice(0, MAX_RAW) + '…' : raw;
    if (truncated) lines.push(escapeHtml(truncated));
    opts.reply_markup = JSON.stringify({
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `${CALLBACK_APPROVE}:${notification.metadata.memoryId}` },
        { text: '❌ Reject', callback_data: `${CALLBACK_REJECT}:${notification.metadata.memoryId}` }
      ]]
    });
  } else if (notification.description) {
    lines.push(escapeHtml(notification.description));
  }

  if (notification.priority) lines.push(`Priority: ${priorityEmoji} ${notification.priority}`);
  await sendMessage(lines.join('\n'), opts);
}

/**
 * Subscribe to notification events for forwarding
 */
function initNotificationForwarding() {
  if (notificationSubscription) {
    notificationEvents.removeListener('added', notificationSubscription);
  }
  notificationSubscription = forwardNotification;
  notificationEvents.on('added', notificationSubscription);
}

// === Conversational Commands ===

async function handleStatusCommand(msg) {
  const chatId = String(msg.chat.id);
  const lines = ['<b>📊 PortOS Status</b>\n'];

  const agents = getActiveAgents();
  lines.push(`<b>Agents:</b> ${agents.length} running`);

  const notifications = await getNotifications({ limit: 5, unreadOnly: true });
  lines.push(`<b>Unread notifications:</b> ${notifications.length}`);

  const settings = await getSettings();
  lines.push(`<b>Backup:</b> ${settings.backup?.enabled ? 'enabled' : 'disabled'}`);

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function handleGoalsCommand(msg) {
  const chatId = String(msg.chat.id);
  const data = await getGoals();
  const activeGoals = data.goals.filter(g => g.status === 'active');

  if (activeGoals.length === 0) {
    await bot.sendMessage(chatId, 'No active goals.', { parse_mode: 'HTML' });
    return;
  }

  const lines = ['<b>🎯 Active Goals</b>\n'];
  for (const goal of activeGoals) {
    const progress = goal.progress || 0;
    const filled = Math.round(progress / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const velocity = goal.velocity?.percentPerMonth
      ? ` (${goal.velocity.percentPerMonth.toFixed(1)}%/mo)`
      : '';
    lines.push(`${bar} ${progress}% — <b>${escapeHtml(goal.title)}</b>${velocity}`);
  }

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function handleAgentsCommand(msg) {
  const chatId = String(msg.chat.id);
  const agents = getActiveAgents();

  if (agents.length === 0) {
    await bot.sendMessage(chatId, 'No agents currently running.', { parse_mode: 'HTML' });
    return;
  }

  const lines = ['<b>🤖 Running Agents</b>\n'];
  for (const agent of agents) {
    const runtime = formatDuration(agent.runningTime);
    lines.push(`• <b>${escapeHtml(agent.taskId || agent.id)}</b> — ${runtime} (${agent.mode})`);
  }

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function handleCheckinCommand(msg) {
  const chatId = String(msg.chat.id);
  const data = await getGoals();
  const activeGoals = data.goals.filter(g => g.status === 'active');

  if (activeGoals.length === 0) {
    await bot.sendMessage(chatId, 'No active goals to check in on.', { parse_mode: 'HTML' });
    return;
  }

  // Pick goal with oldest check-in or no check-ins
  const checkins = await loadCheckins();
  let targetGoal = null;
  let oldestCheckinTime = Infinity;

  for (const goal of activeGoals) {
    const lastCheckin = checkins.checkins
      .filter(c => c.goalId === goal.id)
      .sort((a, b) => new Date(b.askedAt) - new Date(a.askedAt))[0];

    const checkinTime = lastCheckin ? new Date(lastCheckin.askedAt).getTime() : 0;
    if (checkinTime < oldestCheckinTime) {
      oldestCheckinTime = checkinTime;
      targetGoal = goal;
    }
  }

  if (!targetGoal) return;

  const question = `How's progress on "<b>${escapeHtml(targetGoal.title)}</b>"? (currently ${targetGoal.progress || 0}%)`;
  pendingCheckins.set(chatId, {
    question,
    goalId: targetGoal.id,
    askedAt: new Date().toISOString()
  });

  await bot.sendMessage(chatId, question, { parse_mode: 'HTML' });
}

async function handleCheckinResponse(msg) {
  const chatId = String(msg.chat.id);
  cleanExpiredCheckins();
  const pending = pendingCheckins.get(chatId);
  if (!pending) return;

  const checkins = await loadCheckins();
  checkins.checkins.push({
    id: uuidv4(),
    question: pending.question,
    response: msg.text,
    goalId: pending.goalId,
    askedAt: pending.askedAt,
    answeredAt: new Date().toISOString()
  });

  // Cap at MAX_CHECKINS entries
  if (checkins.checkins.length > MAX_CHECKINS) {
    checkins.checkins = checkins.checkins.slice(-MAX_CHECKINS);
  }

  await saveCheckins(checkins);
  pendingCheckins.delete(chatId);

  await bot.sendMessage(chatId, '✅ Check-in recorded. Thanks!', { parse_mode: 'HTML' });
}

/**
 * Send a check-in prompt for a specific goal (or auto-pick)
 * Exported for use by scheduled jobs
 */
export async function sendCheckin(goalId) {
  if (!bot || !authorizedChatId) return;

  const data = await getGoals();
  const activeGoals = data.goals.filter(g => g.status === 'active');

  let targetGoal;
  if (goalId) {
    targetGoal = activeGoals.find(g => g.id === goalId);
  } else {
    // Pick most stale goal
    const checkins = await loadCheckins();
    let oldestTime = Infinity;
    for (const goal of activeGoals) {
      const last = checkins.checkins
        .filter(c => c.goalId === goal.id)
        .sort((a, b) => new Date(b.askedAt) - new Date(a.askedAt))[0];
      const t = last ? new Date(last.askedAt).getTime() : 0;
      if (t < oldestTime) { oldestTime = t; targetGoal = goal; }
    }
  }

  if (!targetGoal) return;

  const question = `How's progress on "<b>${escapeHtml(targetGoal.title)}</b>"? (currently ${targetGoal.progress || 0}%)`;
  pendingCheckins.set(authorizedChatId, {
    question,
    goalId: targetGoal.id,
    askedAt: new Date().toISOString()
  });

  await sendMessage(question);
}

// === Check-in persistence ===

async function loadCheckins() {
  return readJSONFile(CHECKINS_FILE, { checkins: [] });
}

async function saveCheckins(data) {
  const tmp = `${CHECKINS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, CHECKINS_FILE);
}

// Process signal handlers to prevent orphan polling
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
