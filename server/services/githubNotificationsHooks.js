/**
 * Pre-agent hook for the `github-notifications` scheduled task (#12871).
 *
 * The pass is deterministic (services/githubNotifications.js): sync each
 * enabled account, then record a rule-based triage decision per thread. It
 * starts no agent and calls no model, so the hook always answers `skip`;
 * `resolveTaskInputHook` records the execution, advancing the cadence.
 */
import { describeScheduledCheck, runScheduledNotificationCheck } from './githubNotifications.js';

export async function buildTaskInput({ app } = {}) {
  // The accounts belong to this machine; a per-app dispatch would sync them
  // once per app.
  if (app?.id) return { skip: { reason: 'install-wide-only' } };
  const line = describeScheduledCheck(await runScheduledNotificationCheck());
  console.log(`📬 github-notifications: ${line}`);
  return { skip: { reason: line } };
}
