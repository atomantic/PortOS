/**
 * `blockedCategory` vocabulary — which blocks are the system's to clear, and
 * which are a person's.
 *
 * A blocked task carries a `blockedCategory` naming WHY it stopped, and three
 * separate automations have to answer "may I move this?" from that one value:
 * the pause logic (does this block keep a resume pointer?), the failure reaper
 * (may I auto-expire this at 14 days?), and the investigation auto-retry (may I
 * put this back in the queue?). Each used to keep its own hand-written literal
 * set, which is how the retry's first draft shipped a `'user-paused'` that
 * matches nothing — the real category is `agent-paused` — and silently missed
 * `challenge-escalation` entirely.
 *
 * Pure and dependency-free (beyond the pause category it shares with
 * `taskPauseHold.js`) so all three read ONE vocabulary.
 */

import { AGENT_PAUSED_CATEGORY } from './taskPauseHold.js';

/**
 * A PERMANENT provider-config failure: the task's resolved provider cannot run
 * an agent at all (today, an `api`-type provider pinned to or resolved for an
 * agent task — it has no file-writing harness). Stamped by `runAgentSpawn`
 * (services/agentLifecycle.js) and read by both sets below, so it lives here
 * rather than as a third hand-written literal — exactly the drift this module
 * exists to prevent.
 */
export const PROVIDER_CONFIG_BLOCKED_CATEGORY = 'provider-config';

/**
 * Pauses a TIMER clears, not a person: the task carries a `cooldownUntil` and the
 * cooldown sweeper (`unblockExpiredCooldowns`, cosTaskGenerator.js) flips it back
 * to `pending` once that stamp passes.
 *
 * Membership is what makes a block self-reviving, so anything that reports a
 * block to a human — the orphaned-PR notifier is the one that matters, since a
 * merge follow-up's block means its PR is stranded — must check here first and
 * stay quiet: the system is already going to clear this one.
 */
export const TIMED_COOLDOWN_BLOCKED_CATEGORIES = new Set([
  'orphan-cooldown',  // the orphan sweep's retry backoff
  'worktree-busy'     // the branch is checked out in another worktree
]);

/**
 * "Paused until something outside the task changes", not "finished with". A
 * pause keeps the resume pointer (see `updateTask`) and is never auto-expired by
 * the failure reaper — the task is expected to run again once the cooldown
 * lapses or the user fixes the config.
 *
 * Every TIMED cooldown is a pause by construction, so it is spread in rather
 * than re-listed: a new timed category added to one set but not the other would
 * either lose its resume pointer or never revive — exactly the three-literal-sets
 * drift this module exists to prevent.
 */
export const PAUSED_BLOCKED_CATEGORIES = new Set([
  ...TIMED_COOLDOWN_BLOCKED_CATEGORIES,
  'app-unresolved',    // the task's app has no usable Repository Path
  'workspace-invalid', // the resolved workspace isn't a usable directory
  // A CONFIG pause, NOT a timed one: nothing stamps a `cooldownUntil` for it and
  // no sweeper revives it — the user adds a CLI provider (or re-pins the task)
  // and unblocks it by hand. It therefore belongs here and in the user-decision
  // set, but never in TIMED_COOLDOWN_BLOCKED_CATEGORIES. Without this membership
  // the revived task restarts on a fresh branch and orphans the worktree its dead
  // agent left behind.
  PROVIDER_CONFIG_BLOCKED_CATEGORY
]);

/**
 * Blocks that encode USER INTENT or an OPEN user decision, not a stale failure
 * artifact — the reaper leaves these alone. Everything else with a
 * `blockedCategory` is a failure-path block and therefore reapable.
 *
 * The CONFIG pauses are an open user decision, not a stale failure: the task is
 * waiting for the app's Repository Path to be fixed, or for a provider that can
 * actually run an agent, and auto-completing it at 14 days would silently retire
 * work nobody decided to drop. (The TIMED pause categories stay reapable — they
 * revive themselves in minutes, so one still sitting there after 14 days IS
 * stale.)
 */
export const USER_DECISION_BLOCKED_CATEGORIES = new Set([
  'user-terminated',      // user explicitly stopped the agent
  AGENT_PAUSED_CATEGORY,  // user paused; resumable on demand
  'challenge-escalation', // parked awaiting the user's arbitration
  'app-unresolved',
  'workspace-invalid',
  // Same shape: a config error only the user can clear. Exempt from the 14-day
  // `sweepResolvedFailureTasks` auto-expiry (cosTaskStore.js), which would
  // otherwise flip it to `completed` with `resolution: 'auto-expired'` and
  // federate that false `completed` to every peer — silently reporting work
  // nobody decided to drop as done.
  PROVIDER_CONFIG_BLOCKED_CATEGORY
]);

/**
 * Blocks a completed investigation must NOT auto-retry. The union of the two
 * sets above, expressed as a union rather than re-listed so it cannot drift from
 * them: a standing user decision is not ours to override, and a self-reviving
 * pause (`orphan-cooldown`) already has an owner that revives it on schedule —
 * retrying it here would just double-drive that timer.
 */
export const NON_AUTO_RETRY_BLOCK_CATEGORIES = new Set([
  ...USER_DECISION_BLOCKED_CATEGORIES,
  ...PAUSED_BLOCKED_CATEGORIES
]);
