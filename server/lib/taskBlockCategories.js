/**
 * The `blockedCategory` vocabulary: which task blocks the system clears and which belong to a person.
 *
 * The `blockedCategory` vocabulary: which blocks are the system's to clear and which are a person's, read by the pause logic (does it keep a resume pointer?), the failure reaper (may it auto-expire at 14 days?) and the investigation
 * auto-retry (may it re-queue?) so they can't drift into three literal sets (the retry's first draft shipped a `'user-paused'` matching nothing, the real category being `agent-paused`, and missed `challenge-escalation`).
 * `PAUSED_BLOCKED_CATEGORIES` (paused until something outside the task changes; keeps the resume pointer), `USER_DECISION_BLOCKED_CATEGORIES` (user intent / open decision; the reaper's exemption),
 * `NON_AUTO_RETRY_BLOCK_CATEGORIES` (their union; a completed investigation must never revive these), `TIMED_COOLDOWN_BLOCKED_CATEGORIES` (a timer clears these: the cooldown sweeper revives them, so block reporters stay quiet),
 * `PREREQUISITE_BLOCKED_CATEGORIES` / `DELIVERY_RECOVERY_BLOCKED_CATEGORIES` (delivery prerequisite and retry-hold blocks that keep preserved resume pointers),
 * `PROVIDER_CONFIG_BLOCKED_CATEGORY` and `MAX_SPAWNS_BLOCKED_CATEGORY` (shared literals the spawn gates stamp). Pure and dependency-free (beyond two categories shared with `taskPauseHold.js` and `taskParser.js`).
 */

import { AGENT_PAUSED_CATEGORY } from './taskPauseHold.js';
import { UNKNOWN_STATUS_BLOCKED_CATEGORY } from './taskParser.js';

/** A PERMANENT provider-config failure: the task's resolved provider can't run an agent at all (an `api`-type provider has no file-writing harness). Stamped by `runAgentSpawn` (services/agent/agentLifecycle.js) and read by both sets below, so it lives here, not as a third literal. */
export const PROVIDER_CONFIG_BLOCKED_CATEGORY = 'provider-config';

/**
 * Pauses a TIMER clears, not a person: the task carries a `cooldownUntil` and the sweeper (`unblockExpiredCooldowns`, cosTaskGenerator.js) flips it to `pending` once it passes. Membership makes a block self-reviving, so anything
 * reporting a block to a human (the orphaned-PR notifier: a merge follow-up's block strands its PR) must check here first and stay quiet.
 */
export const TIMED_COOLDOWN_BLOCKED_CATEGORIES = new Set([
  'orphan-cooldown',  // the orphan sweep's retry backoff
  'worktree-busy',    // the branch is checked out in another worktree
  'git-conflict-wait' // the shared checkout won't pull; a resolver task is fixing it
]);

/**
 * "Paused until something outside the task changes", not "finished with": keeps the resume pointer (see `updateTask`) and is never auto-expired by the failure reaper. Every TIMED cooldown is a pause, so it is spread in rather than
 * re-listed (a category in one set but not the other would lose its resume pointer or never revive).
 */
export const PAUSED_BLOCKED_CATEGORIES = new Set([
  ...TIMED_COOLDOWN_BLOCKED_CATEGORIES,
  'internal-dependency', // Server-owned investigation wait; preserve its pointer and never expire it as a failed task.
  'internal-dependency-unverified', // Unknown ownership is a retained refusal, never an automatic completion.
  'runtime-verification', // Server-owned boot prerequisite; retain work and never expire or auto-retry.
  'task-approval', // A user decision must retain its checkout and never silently expire.
  'task-recovery-exhausted', // Continuing beyond the retry/spawn limit needs an explicit decision.
  'deep-audit-partial', // Explicit resume only; keep retained remediation and never auto-expire.
  'app-unresolved',    // the task's app has no usable Repository Path
  'workspace-invalid', // the resolved workspace isn't a usable directory
  // A CONFIG pause, NOT timed: nothing stamps a `cooldownUntil` and no sweeper revives it (the user adds a CLI provider or re-pins the task and unblocks by hand). It belongs here and in the user-decision set, never in TIMED_COOLDOWN_BLOCKED_CATEGORIES;
  // without this membership the revived task restarts on a fresh branch and orphans the worktree its dead agent left.
  PROVIDER_CONFIG_BLOCKED_CATEGORY
]);

/**
 * Blocks encoding USER INTENT or an OPEN user decision, not a stale failure artifact: the reaper leaves these alone (everything else with a `blockedCategory` is reapable). The CONFIG pauses are an open decision (the app's Repository Path
 * to fix, or a provider that can run an agent), and auto-completing at 14 days would retire work nobody decided to drop; TIMED pauses stay reapable (they self-revive in minutes, so one sitting after 14 days IS stale).
 */
export const USER_DECISION_BLOCKED_CATEGORIES = new Set([
  'user-terminated',      // user explicitly stopped the agent
  AGENT_PAUSED_CATEGORY,  // user paused; resumable on demand
  'challenge-escalation', // parked awaiting the user's arbitration
  'runtime-verification', // Server-owned boot prerequisite; retain work and never expire or auto-retry.
  'task-approval', // A user decision must retain its checkout and never silently expire.
  'task-recovery-exhausted', // Continuing beyond the retry/spawn limit needs an explicit decision.
  'deep-audit-partial', // Explicit resume only; keep retained remediation and never auto-expire.
  'app-unresolved',
  'workspace-invalid',
  // A task the markdown store couldn't represent, parked by generateTasksMarkdown's repair instead of deleted (#7239): its real status is unknown, so auto-expiring to `completed` would retire (and federate as done) the work the repair rescued.
  UNKNOWN_STATUS_BLOCKED_CATEGORY,
  // A config error only the user can clear: exempt from the 14-day `sweepResolvedFailureTasks` auto-expiry (cosTaskStore.js), which would flip it to `completed` / `auto-expired` and federate that false `completed` to every peer.
  PROVIDER_CONFIG_BLOCKED_CATEGORY
]);

/** The spawn cap's own block: the task spent `MAX_TOTAL_SPAWNS`, so unblocking alone re-blocks it and only an explicit budget reset runs it again. Stamped by `prepareAgentSpawn` and the dequeue's spawn-cap gate, and read by the task list to offer that reset. */
export const MAX_SPAWNS_BLOCKED_CATEGORY = 'max-spawns';

/** Explicit spawn-budget resets do not satisfy a separate task prerequisite. */
export function hasSpawnBudgetResetPrerequisite(metadata = {}) {
  const category = metadata?.blockedCategory;
  return !!metadata?.blocker || !!metadata?.releaseSynchronization
    || (category !== 'task-recovery-exhausted'
      && (PAUSED_BLOCKED_CATEGORIES.has(category) || USER_DECISION_BLOCKED_CATEGORIES.has(category)));
}

/** Blocks a completed investigation must NOT auto-retry: the union of the two sets (not re-listed, so it can't drift). A standing user decision isn't ours to override, and a self-reviving pause (`orphan-cooldown`) already has an owner that would be double-driven. */
export const NON_AUTO_RETRY_BLOCK_CATEGORIES = new Set([
  ...USER_DECISION_BLOCKED_CATEGORIES,
  ...PAUSED_BLOCKED_CATEGORIES
]);

/** Delivery prerequisite blocks that pause execution on server verification or an owned dependency rather than generic retry. */
export const PREREQUISITE_BLOCKED_CATEGORIES = new Set([
  'runtime-verification',
  'internal-dependency',
  'internal-dependency-unverified',
]);

/** Delivery-held blocked categories whose decision owner keeps a preserved resume pointer via `releaseRetryHold`. */
export const DELIVERY_RECOVERY_BLOCKED_CATEGORIES = new Set([
  'task-approval',
  'task-recovery-exhausted',
  ...PREREQUISITE_BLOCKED_CATEGORIES,
]);
