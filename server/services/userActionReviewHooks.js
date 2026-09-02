/**
 * Programmatic pre-agent hook for the `user-action-review` scheduled task
 * (#5595, epic #5593).
 *
 * The review's whole input is the operator-action ledger; when the last 7 days
 * hold nothing, dispatching an agent would burn a provider call to conclude
 * "nothing to review". This deterministic hook (no LLM) makes that the
 * generator's decision instead: `resolveTaskInputHook` records the execution
 * (so the cadence advances) and spawns nothing.
 */

import { listUserActions } from './userActions.js';
import { detectIdleLeftoverBranches } from './userActionDetectors.js';

export const USER_ACTION_REVIEW_LOOKBACK_DAYS = 7;

export async function buildTaskInput({ app } = {}) {
  // The ledger is one install-wide log; INSTALL_WIDE_TASK_TYPES only shapes the
  // UI, so a per-app cadence override would otherwise dispatch one identical
  // global review PER APP. Only the global lane (synthetic null-id app) runs.
  if (app?.id) return { skip: { reason: 'install-wide-only' } };
  const from = new Date(Date.now() - USER_ACTION_REVIEW_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // One row is enough to answer "is there anything to review?".
  const events = await listUserActions({ from, limit: 1 });
  if (events.length === 0) {
    const findings = await detectIdleLeftoverBranches().catch((error) => {
      console.error(`❌ user-action-review leftover-branch detector failed: ${error.message}`);
      return [];
    });
    if (findings.length === 0) return { skip: { reason: 'no-user-actions' } };
  }
  return {};
}
