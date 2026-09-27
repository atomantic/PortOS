import { noteReadinessChanged } from './readinessNotify.js';
/**
 * Telegram Bot Service
 *
 * Manages Telegram bot lifecycle, messaging, notification forwarding,
 * and conversational commands for PortOS.
 */

import { createTelegramBot } from '../lib/telegramClient.js';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { getSettings } from './settings.js';
import { notificationEvents, getNotifications } from './notifications.js';
import { forwardNotification as forwardToTelegram } from './telegramForward.js';
import { approveMemory, rejectMemory } from './memoryBackend.js';
import { ensureDir, PATHS, readJSONFileStrict, formatDuration, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createTokenBucket } from '../lib/telegramRateLimit.js';
import { escapeHtml, CALLBACK_APPROVE, CALLBACK_REJECT } from '../lib/telegramMessage.js';
import { getActiveAgents } from './agentManagement.js';
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

// Rate limiter: token bucket (30 messages/minute). Per-transport instance —
// see lib/telegramRateLimit.js for why it is not shared with the bridge.
const rateLimiter = createTokenBucket();

// Pending check-ins with 10-minute TTL
const pendingCheckins = new Map();
const CHECKIN_TTL = 10 * 60 * 1000;

const CHECKINS_DIR = join(PATHS.data, 'telegram');
const CHECKINS_FILE = join(CHECKINS_DIR, 'checkins.json');
const MAX_CHECKINS = 500;

// Serializes the checkins.json load -> mutate -> save cycle (handleCheckinResponse)
// against concurrent Telegram messages/callbacks, matching voice/timers.js's use of
// the same helper for its single JSON state file.
const queueCheckinsWrite = createFileWriteQueue();

/**
 * Wrap an async `bot.onText`/`bot.on(...)` callback so a rejection is caught
 * and logged instead of leaking as an unhandled rejection. node-telegram-bot-api's
 * EventEmitter never awaits these callbacks, so an uncaught throw/rejection
 * bypasses every caller and lands on `process.on('unhandledRejection')`.
 */
function safeHandler(fn) {
  return (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch((err) => {
        console.error(`📱 Telegram: handler error — ${err?.message || String(err)}`);
      });
}

function cleanExpiredCheckins() {
  const now = Date.now();
  for (const [key, value] of pendingCheckins) {
    if (now - new Date(value.askedAt).getTime() > CHECKIN_TTL) {
      pendingCheckins.delete(key);
    }
  }
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
  const me = await bot.getMe().catch(async err => {
    console.error(`📱 Telegram: invalid token — ${err.message}`);
    // Polling starts at construction; stop it before dropping the failed bot.
    await cleanup();
    return null;
  });

  if (!me) return;

  botUsername = me.username;
  isConnected = true;
  noteReadinessChanged();
  console.log(`📱 Telegram: connected as @${botUsername}`);

  // Register /start handler (always works, no auth required)
  bot.onText(/\/start/, safeHandler(async (msg) => {
    const fromChatId = String(msg.chat.id);
    await bot.sendMessage(fromChatId,
      `Your Chat ID: <code>${fromChatId}</code>\n\n` +
      'Paste this into the PortOS Settings → Telegram → Chat ID field, then click Save & Test.',
      { parse_mode: 'HTML' }
    );
  }));

  // Register command handlers
  bot.onText(/\/status/, safeHandler(async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleStatusCommand(msg);
  }));

  bot.onText(/\/goals/, safeHandler(async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleGoalsCommand(msg);
  }));

  bot.onText(/\/agents/, safeHandler(async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleAgentsCommand(msg);
  }));

  bot.onText(/\/checkin/, safeHandler(async (msg) => {
    if (!isAuthorized(msg)) return;
    await handleCheckinCommand(msg);
  }));

  bot.onText(/\/help/, safeHandler(async (msg) => {
    if (!isAuthorized(msg)) return;
    await bot.sendMessage(String(msg.chat.id),
      '<b>PortOS Bot Commands</b>\n\n' +
      '/status — System overview\n' +
      '/goals — Active goals with progress\n' +
      '/agents — Running agents\n' +
      '/checkin — Goal check-in question\n' +
      '/help — Show this message',
      { parse_mode: 'HTML' }
    );
  }));

  // Handle non-command messages (check-in responses)
  bot.on('message', safeHandler(async (msg) => {
    if (msg.text?.startsWith('/')) return;
    if (!isAuthorized(msg)) return;
    await handleCheckinResponse(msg);
  }));

  // Handle inline keyboard button clicks (memory approve/reject)
  bot.on('callback_query', safeHandler(async (query) => {
    if (String(query.message?.chat?.id) !== authorizedChatId) {
      await bot.answerCallbackQuery(query.id, { text: 'Unauthorized' }).catch(() => {});
      return;
    }
    await handleCallbackQuery(query);
  }));

  // Start health check. setInterval doesn't await the async callback, so a
  // rejection would leak as an unhandled rejection — catch it here.
  healthCheckInterval = setInterval(() => {
    healthCheck().catch(err => console.error(`📱 Telegram: health check error — ${err?.message || String(err)}`));
  }, HEALTH_CHECK_INTERVAL_MS);

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
    // Fire-and-forget from a sync guard — catch so the send failure can't leak
    // an unhandled rejection.
    bot?.sendMessage(fromChatId,
      'This bot is not configured for your chat ID.\n' +
      'If you own this bot, message /start to see your chat ID, then configure it in PortOS Settings.'
    ).catch(err => console.error(`📱 Telegram: unauthorized-notice send failed — ${err?.message || String(err)}`));
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
  noteReadinessChanged();
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
  // Piggyback expired-checkin cleanup on the existing health-check cadence
  // rather than adding a separate timer.
  cleanExpiredCheckins();
  await bot.getMe().catch(async (err) => {
    console.error(`📱 Telegram: health check failed — ${err.message}`);
    isConnected = false;
    noteReadinessChanged();
    await reconnect();
  });
}

/**
 * Send a message to the configured chatId
 */
export async function sendMessage(text, opts = { parse_mode: 'HTML' }) {
  if (!bot || !authorizedChatId) return { success: false, error: !bot ? 'Bot not initialized' : 'No chatId configured' };

  if (!rateLimiter.consume()) {
    console.log('📱 Telegram: rate limit reached, skipping message');
    return { success: false, error: 'Rate limit exceeded' };
  }

  const result = await bot.sendMessage(authorizedChatId, text, opts).catch(async (err) => {
    console.error(`📱 Telegram: send failed — ${err.message}`);
    isConnected = false;
    noteReadinessChanged();
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

// Forward a notification through the shared pipeline. An arrow (not a bound
// reference) so the CURRENT cachedForwardTypes is read on every event.
const forwardNotification = (notification) =>
  forwardToTelegram(notification, { cachedForwardTypes, sendMessage });

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
    const progress = goal.progress ?? 0;
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
  if (!checkins) {
    await bot.sendMessage(chatId, "⚠️ Couldn't read your check-in history, so I can't pick the most overdue goal. Try again once it's readable.", { parse_mode: 'HTML' });
    return;
  }
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

  const question = `How's progress on "<b>${escapeHtml(targetGoal.title)}</b>"? (currently ${targetGoal.progress ?? 0}%)`;
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
  // Captured synchronously, at dispatch time — this is THIS message's
  // outstanding question, independent of whatever else mutates
  // pendingCheckins before the queued critical section below actually runs.
  const pending = pendingCheckins.get(chatId);
  if (!pending) return;

  // Serialize the load -> mutate -> save cycle on a single tail so two
  // concurrent responses can't interleave and drop or duplicate a record
  // (createFileWriteQueue, matching voice/timers.js's use of the same helper
  // for its single JSON state file). The re-check below consumes `pending`
  // exactly once: if a second message raced this one for the SAME question,
  // whichever's critical section runs first deletes it, so the other finds it
  // already gone and skips — otherwise both would append an answer to one
  // prompt.
  const status = await queueCheckinsWrite(async () => {
    if (pendingCheckins.get(chatId) !== pending) return 'stale';

    const checkins = await loadCheckins();
    // Bail rather than write: pushing onto the empty default would atomicWrite a
    // one-entry log over the whole history. The pending check-in stays pending so
    // the answer can be re-sent once the file is readable again — including
    // when `pending` was superseded by a new question during this same await
    // (the compare-and-delete below leaves that new entry untouched either way).
    if (!checkins) return 'unreadable';

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

    // Consume `pending` only now that it's durably persisted, and only if it's
    // still the current entry — `loadCheckins`/`saveCheckins` both await, so a
    // new question could have replaced pendingCheckins for this chat while we
    // were reading/writing; an unconditional delete here would wipe THAT
    // still-unanswered question instead of the one we just recorded.
    if (pendingCheckins.get(chatId) === pending) pendingCheckins.delete(chatId);
    return 'recorded';
  });

  if (status === 'stale') return; // another response already answered this question
  if (status === 'unreadable') {
    await bot.sendMessage(chatId, "⚠️ Couldn't read your check-in history, so I didn't record that. Nothing was overwritten — send it again once it's readable.", { parse_mode: 'HTML' });
    return;
  }

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
    // Pick most stale goal. An unreadable log can't rank staleness, and asking
    // about an arbitrary goal would then record an answer against it — skip the
    // send instead (the scheduled job simply retries next window).
    const checkins = await loadCheckins();
    if (!checkins) return;
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

  const question = `How's progress on "<b>${escapeHtml(targetGoal.title)}</b>"? (currently ${targetGoal.progress ?? 0}%)`;
  pendingCheckins.set(authorizedChatId, {
    question,
    goalId: targetGoal.id,
    askedAt: new Date().toISOString()
  });

  await sendMessage(question);
}

// === Check-in persistence ===

/**
 * Load the check-in log, or `null` when the file is present but unreadable.
 *
 * Strict (#4115) with a null sentinel rather than a throw: every caller runs
 * inside a `bot.on(...)` handler that node-telegram-bot-api never awaits, so a
 * rejection would leak as an unhandled rejection instead of reaching a caller.
 * Callers must bail on `null` — `handleCheckinResponse` is a
 * `load → push → atomicWrite`, so treating an unreadable file as "no check-ins
 * yet" would write a one-entry log over the user's entire check-in history.
 *
 * A file that reads cleanly but has no `checkins` array is untrustworthy for the
 * same reason and gets the same `null`: we can't interpret it, so we must not
 * replace it. Only ENOENT yields the real empty log (the default below).
 *
 * @returns {Promise<{checkins: Array}|null>} the log, or null if untrustworthy
 */
async function loadCheckins() {
  const { ok, value } = await readJSONFileStrict(CHECKINS_FILE, { checkins: [] });
  if (!ok || !Array.isArray(value?.checkins)) {
    console.error(`📱 Telegram: check-in log at ${CHECKINS_FILE} is unreadable — refusing to overwrite it`);
    return null;
  }
  return value;
}

async function saveCheckins(data) {
  await atomicWrite(CHECKINS_FILE, data);
}

// Process signal handlers to prevent orphan polling
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
