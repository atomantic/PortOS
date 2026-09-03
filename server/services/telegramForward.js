/**
 * The one notification-forward pipeline shared by both Telegram transports.
 *
 * `telegram.js` (the direct polling bot) and `telegramBridge.js` (the
 * MCP-plugin HTTP bridge) are selected by `settings.telegram.method` and run the
 * identical chain: forward-type filter → per-domain autonomy gate → daily
 * messages budget → message assembly → send → usage accounting. They used to
 * carry a copy each, and the copies drifted — the bridge silently lost the
 * memory-approval keyboard and the length cap (#5688). The only per-transport
 * piece is the `sendMessage` implementation, which the caller injects.
 *
 * Lives in `services/` rather than `lib/` because it reads domain autonomy and
 * budget state and resolves the pending memory; the pure message assembly is in
 * `lib/telegramMessage.js`.
 */

import { getDomainAutonomyMode } from './cosState.js';
import { getDomainBudgetStatus, recordDomainUsage } from './domainUsage.js';
import { peekMemory } from './memoryBackend.js';
import { buildNotificationMessage, isMemoryApprovalNotification } from '../lib/telegramMessage.js';

const DOMAIN = 'messages';

/**
 * Whether a notification may be forwarded to Telegram.
 *
 * The cached forward-type filter runs FIRST so a filtered-out notification skips
 * the state reads entirely, and so `dry-run` only reports what `execute` would
 * actually have sent.
 *
 * @param {object} notification - the notification record
 * @param {string[]|null} cachedForwardTypes - configured whitelist; null/empty means "all"
 * @returns {Promise<boolean>}
 */
async function shouldForward(notification, cachedForwardTypes) {
  if (Array.isArray(cachedForwardTypes) && cachedForwardTypes.length > 0
    && !cachedForwardTypes.includes(notification.type)) {
    return false;
  }

  // Per-domain autonomy gate: `off` suppresses outbound forwarding; `dry-run`
  // logs what would have been sent without actually messaging the channel.
  const mode = await getDomainAutonomyMode(DOMAIN);
  if (mode !== 'execute') {
    if (mode === 'dry-run') {
      console.log(`📨 [dry-run] Messages auto-send would forward notification: ${notification.type} — "${notification.title}"`);
    }
    return false;
  }

  // Daily messages budget (#711): once today's auto-send count reaches the cap,
  // suppress further forwarding for the rest of the day (acts like `off`).
  const budget = await getDomainBudgetStatus(DOMAIN);
  if (!budget.withinBudget) {
    console.log(`📨 Messages auto-send daily ${budget.exceeded} budget reached — suppressing forward: ${notification.type} — "${notification.title}"`);
    return false;
  }

  return true;
}

/**
 * Gate, build and send one notification through the given transport.
 *
 * @param {object} notification - the notification record
 * @param {object} deps
 * @param {string[]|null} deps.cachedForwardTypes - the transport's cached whitelist,
 *   read at call time so a `updateCachedForwardTypes` between events takes effect
 * @param {(text: string, options: object) => Promise<any>} deps.sendMessage -
 *   the transport's own sender; it must forward `options` (`parse_mode`,
 *   `reply_markup`) to the Telegram API call
 */
export async function forwardNotification(notification, { cachedForwardTypes, sendMessage }) {
  if (!await shouldForward(notification, cachedForwardTypes)) return;

  // The approval body is the one piece of the message that needs I/O, so it is
  // resolved here and handed to the pure builder.
  const approvalBody = isMemoryApprovalNotification(notification)
    ? await peekMemory(notification.metadata.memoryId)
      .then(memory => memory?.summary || memory?.content || null)
      .catch(() => null)
    : null;

  const { text, options } = buildNotificationMessage(notification, { approvalBody });

  // Count the forward (and its wall-clock) against the messages daily budget
  // (#711) so both the actions and minutes caps are enforced for this domain.
  const startTime = Date.now();
  await sendMessage(text, options);
  await recordDomainUsage(DOMAIN, { actions: 1, ms: Date.now() - startTime })
    .catch(err => console.error(`❌ Failed to record messages budget usage: ${err.message}`));
}
