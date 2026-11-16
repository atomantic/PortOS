/**
 * Critical-health notifier: turns the CoS monitor's `health:critical` into a persistent
 * bell card (the socket bridge only reaches an open CoS view). The monitor re-emits every
 * interval, so the card is deduped on the issue SET: unchanged raises nothing, changed
 * replaces, and a `health:check` with no error-level issues retracts. Machine-local.
 *
 * A transition is several awaits (exists, remove, add) and cos.js fires both entry points
 * unawaited, so one module-owned queue runs whole transitions in receipt order.
 */

import { createMutex } from '../lib/asyncMutex.js';
import { addNotification, exists, removeByMetadata, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';

const SOURCE = 'cos-health-critical';

// A rejected transition still releases the queue (createMutex uses try/finally),
// so later work runs and the rejection stays visible to the caller's catch.
const inTransition = createMutex();

const issueKey = (issues) => [...new Set(issues.map(i => i.message))].sort().join('\n');

/**
 * @param {Array<{ message: string, category?: string }>} issues - `health:critical` payload
 * @returns {Promise<boolean>} whether a card was raised
 */
export function notifyCriticalHealth(issues) {
  if (!Array.isArray(issues) || issues.length === 0) return Promise.resolve(false);
  return inTransition(async () => {
    const key = issueKey(issues);
    if (await exists(NOTIFICATION_TYPES.HEALTH_ISSUE, 'healthCriticalKey', key)) return false;
    await removeByMetadata('source', SOURCE);
    const shown = issues.slice(0, 5).map(i => i.message);
    const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : '';
    await addNotification({
      type: NOTIFICATION_TYPES.HEALTH_ISSUE,
      title: `Critical health: ${issues.length} issue${issues.length === 1 ? '' : 's'}`,
      description: `${shown.join('; ')}${more}`,
      priority: PRIORITY_LEVELS.CRITICAL,
      link: '/system-resources/overview',
      metadata: { source: SOURCE, healthCriticalKey: key },
    });
    return true;
  });
}

/**
 * Retract the card once a health check reports no error-level issues.
 *
 * @param {{ issues?: Array<{ type?: string }> }} check - `health:check` payload
 * @returns {Promise<boolean>} whether a card was retracted
 */
export function clearCriticalHealthIfRecovered(check) {
  if ((check?.issues ?? []).some(i => i.type === 'error')) return Promise.resolve(false);
  return inTransition(async () => {
    const { removed } = await removeByMetadata('source', SOURCE);
    return removed > 0;
  });
}
