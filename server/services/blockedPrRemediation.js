/**
 * Hand blocked contributor-remediation tasks back to their PR author.
 * Merge follow-ups remain owned by CoS recovery and the development watchdog;
 * their blocked state must not create human notifications or Brain commitments.
 */

import { TIMED_COOLDOWN_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

const queueHandback = createKeyCachedQueue();

async function handBackBlockedRemediation(task) {
  if (task.metadata.blockedCategory === 'pr-head-moved') return false;
  return queueHandback(task.id, async () => {
    const [{ getTaskById, updateTask }, { getAppById }, { handBackPrRemediation }] = await Promise.all([
      import('./cosTaskStore.js'), import('./apps.js'), import('./prRemediationFollowUp.js'),
    ]);
    // Re-read inside the queue: overlapping block events may hold older snapshots.
    const current = await getTaskById(task.id);
    if (current?.status !== 'blocked' || current.metadata?.prRemediationHandedBackAt
      || current.metadata?.blockedCategory === 'pr-head-moved'
      || TIMED_COOLDOWN_BLOCKED_CATEGORIES.has(current.metadata?.blockedCategory)) return false;
    const app = await getAppById(current.app || current.metadata?.app);
    if (!app?.repoPath) return false;
    if (!await handBackPrRemediation({ task: current, workspacePath: app.repoPath })) return false;
    await updateTask(task.id, { metadata: { prRemediationHandedBackAt: new Date().toISOString() } }, 'internal');
    return true;
  });
}

/** Handle a genuine block transition; timed cooldowns recover automatically. */
export async function handBackBlockedPrRemediation({ task, previousStatus } = {}) {
  if (task?.status !== 'blocked' || previousStatus === 'blocked') return false;
  if (TIMED_COOLDOWN_BLOCKED_CATEGORIES.has(task.metadata?.blockedCategory)) return false;
  if (!task.metadata?.prRemediationFollowUp) return false;
  return handBackBlockedRemediation(task);
}
