/**
 * Telegram notification message builder (pure — no I/O).
 *
 * Single source of truth for the wire message both Telegram transports send:
 * `services/telegram.js` (the direct polling bot) and
 * `services/telegramBridge.js` (the MCP-plugin HTTP bridge). They are never both
 * active — `routes/telegram.js` picks one from `settings.telegram.method` — but a
 * user can flip between them, so the message they emit must be identical. The
 * copies had already drifted: the bridge silently dropped the memory-approval
 * inline keyboard and the length cap (#5688).
 *
 * Kept dependency-free so it stays a pure leaf: the emoji map is keyed by the
 * literal `NOTIFICATION_TYPES` values rather than importing the notifications
 * service (which owns disk I/O and an EventEmitter). `telegramMessage.test.js`
 * pins those keys against the real enum.
 */

// Callback-data prefixes for the memory approve/reject inline keyboard. The
// direct bot's `callback_query` handler parses these back out, so the builder
// and the handler must agree on them.
export const CALLBACK_APPROVE = 'mem_approve';
export const CALLBACK_REJECT = 'mem_reject';

/**
 * Telegram rejects a message over 4096 characters outright. Cap the raw body
 * BEFORE escaping so the escaped result is guaranteed under the limit: escaping
 * expands at most 5x per character (`&` → `&amp;`) but typical prose is <1.2x,
 * so 2800 raw lands conservatively under 4096 escaped.
 */
export const TELEGRAM_MAX_RAW_CHARS = 2800;

// Emoji per notification type. Types with no row here (AGENT_WARNING,
// AUTOPILOT_PAUSED, CREATIVE_COMMISSION) intentionally fall back to 🔔.
export const NOTIFICATION_EMOJI = {
  memory_approval: '🧠',
  task_approval: '✅',
  code_review: '🔍',
  health_issue: '⚠️',
  briefing_ready: '📋',
  autobiography_prompt: '📝',
  plan_question: '❓',
  daily_post_reminder: '🧪'
};

export const PRIORITY_EMOJI = {
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴'
};

/**
 * Escape the HTML entities Telegram's `parse_mode: 'HTML'` treats as markup.
 */
export function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Truncate to the raw-character cap, appending an ellipsis when it bites.
 * Callers must truncate BEFORE escaping — slicing escaped text can split an
 * entity (`&am`) and produce broken markup.
 */
export function truncateForTelegram(text) {
  if (!text) return '';
  return text.length > TELEGRAM_MAX_RAW_CHARS
    ? `${text.slice(0, TELEGRAM_MAX_RAW_CHARS)}…`
    : text;
}

/**
 * Whether a notification should carry the memory approve/reject keyboard.
 */
export function isMemoryApprovalNotification(notification) {
  return notification?.type === 'memory_approval' && Boolean(notification?.metadata?.memoryId);
}

/**
 * Build the Telegram message for a notification.
 *
 * @param {object} notification - the notification record ({ type, title, description, priority, metadata })
 * @param {{ approvalBody?: string|null }} [opts] - `approvalBody` is the
 *   already-resolved memory text for a memory-approval notification (the lookup
 *   is I/O, so it stays in the caller); falls back to the description.
 * @returns {{ text: string, options: object }} text plus the sendMessage options
 *   (`parse_mode`, and `reply_markup` as a plain object — both transports post
 *   JSON, so a pre-serialized string would reach Telegram as a literal string).
 */
export function buildNotificationMessage(notification, { approvalBody = null } = {}) {
  const emoji = NOTIFICATION_EMOJI[notification.type] || '🔔';
  const priorityEmoji = PRIORITY_EMOJI[notification.priority] || '';
  const lines = [`${emoji} <b>${escapeHtml(notification.title)}</b>`];
  const options = { parse_mode: 'HTML' };

  const isApproval = isMemoryApprovalNotification(notification);
  const body = truncateForTelegram((isApproval ? approvalBody : null) || notification.description || '');
  if (body) lines.push(escapeHtml(body));

  if (isApproval) {
    const { memoryId } = notification.metadata;
    options.reply_markup = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `${CALLBACK_APPROVE}:${memoryId}` },
        { text: '❌ Reject', callback_data: `${CALLBACK_REJECT}:${memoryId}` }
      ]]
    };
  }

  if (notification.priority) lines.push(`Priority: ${priorityEmoji} ${notification.priority}`);

  return { text: lines.join('\n'), options };
}
