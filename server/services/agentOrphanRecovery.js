/**
 * Orphan recovery decisions — the pure half of `handleOrphanedTask` (#12945).
 *
 * Everything here is a function of its arguments (no I/O, no clock reads), so the
 * guard precedence and the retry-budget contract can be pinned without a task
 * store. `agentManagement.js` owns the reads and writes around these decisions.
 */

import { isLegacyDeepAudit } from '../lib/auditWorkflow.js';
import { MAX_TOTAL_SPAWNS } from '../lib/cosValidation.js';
import { isPrivateSecurityTask } from '../lib/privateSecurityPolicy.js';
import { isRetryHeld } from '../lib/taskRetryHold.js';

// Max genuine orphan retries before the task is blocked and an investigation filed.
export const MAX_ORPHAN_RETRIES = 3;
// Minimum gap between genuine orphan retries (30 minutes).
export const ORPHAN_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

const REFUSAL_CATEGORIES = ['content-refusal', 'content-filtered'];
const TERMINAL_BLOCK_CATEGORIES = ['user-terminated', ...REFUSAL_CATEGORIES];
// A prior orphan in the same sweep already routed the task through recovery.
const ALREADY_HANDLED_CATEGORIES = ['max-retries', 'orphan-cooldown'];

const isBlockedWith = (task, categories) =>
  task.status === 'blocked' && categories.includes(task.metadata?.blockedCategory);

/**
 * Guards checked before any retry accounting, FIRST MATCH WINS — the array order
 * is the precedence. Each reason has a handler in `agentManagement.js`; some only
 * skip, others persist a terminal state (private-security, content-refusal,
 * deep-audit, retry-held). The interleaving is deliberate: a private-security task
 * is failed even when already `max-retries`-blocked, but a user-terminated block
 * outranks it, and `completed` outranks every write below it.
 */
export const ORPHAN_GUARDS = [
  // User stops and policy refusals remain terminal across recovery sweeps.
  { reason: 'terminal-block', matches: (task) => isBlockedWith(task, TERMINAL_BLOCK_CATEGORIES) },
  // Lost in-memory source scope cannot validate a recovered assessment.
  { reason: 'private-security', matches: (task, agentMetadata) => isPrivateSecurityTask(task) || isPrivateSecurityTask({ metadata: agentMetadata }) },
  // Otherwise each extra orphaned agent for the same task files a duplicate investigation.
  { reason: 'already-handled', matches: (task) => isBlockedWith(task, ALREADY_HANDLED_CATEGORIES) },
  { reason: 'completed', matches: (task) => task.status === 'completed' },
  // A crash after the refusal was saved must not authorize a retry or commit rescue.
  { reason: 'content-refusal', matches: (_task, agentMetadata) => REFUSAL_CATEGORIES.includes(agentMetadata?.executionInterruption?.category) },
  // A dead Deep invocation is a checkpoint, never permission to launch another provider call.
  { reason: 'deep-audit', matches: (task) => isLegacyDeepAudit(task.metadata) },
  // A retry whose process died mid-transition (#3373): finish it, don't charge orphan budget.
  { reason: 'retry-held', matches: (task) => isRetryHeld(task.metadata) },
];

/** The reason of the first guard that claims this orphan, or null when it needs a retry decision. */
export function classifyOrphanGuard(task, agentMetadata) {
  return ORPHAN_GUARDS.find(guard => guard.matches(task, agentMetadata))?.reason ?? null;
}

const counter = (value) => Number(value) || 0;

/** Ms left before the next genuine orphan retry may run; 0 when none was recorded (or it is unparseable). */
function remainingCooldownMs(lastOrphanedAt, now) {
  const lastMs = lastOrphanedAt ? new Date(lastOrphanedAt).getTime() : 0;
  return lastMs ? ORPHAN_RETRY_COOLDOWN_MS - (now - lastMs) : 0;
}

/**
 * The retry-budget decision. A genuine orphan costs one retry and arms the
 * cooldown; a run PortOS itself interrupted (host restart) costs neither and has
 * its spawn refunded (#3202), because the task did not kill its own agent.
 * `MAX_TOTAL_SPAWNS` still bounds both, so a restart loop cannot spawn without limit.
 *
 * @returns {{ outcome: 'requeue'|'cooldown'|'blocked', interrupted: boolean,
 *   retryCount: number, totalSpawns: number, cooldownRemaining: number,
 *   cooldownMinutes: number, reason: string|null }}
 *   `reason` is the blockedReason for `cooldown` and `blocked`, null for `requeue`.
 */
export function decideOrphanRetry({ task, wasInterrupted, now }) {
  const priorRetries = counter(task.metadata?.orphanRetryCount);
  const retryCount = wasInterrupted ? priorRetries : priorRetries + 1;
  const priorSpawns = counter(task.metadata?.totalSpawnCount);
  const totalSpawns = wasInterrupted ? Math.max(0, priorSpawns - 1) : priorSpawns;

  const cooldownRemaining = remainingCooldownMs(task.metadata?.lastOrphanedAt, now);
  const cooldownMinutes = Math.ceil(cooldownRemaining / 60000);

  const totalExceeded = totalSpawns >= MAX_TOTAL_SPAWNS;
  // An interrupted run is exempt from the orphan ceiling for the same reason it is
  // exempt from the counter; `totalExceeded` still gates it.
  const withinOrphanBudget = wasInterrupted || retryCount < MAX_ORPHAN_RETRIES;
  const decision = { interrupted: wasInterrupted, retryCount, totalSpawns, cooldownRemaining, cooldownMinutes };

  if (totalExceeded || !withinOrphanBudget) {
    const reason = totalExceeded
      ? `total spawns exceeded (${totalSpawns}/${MAX_TOTAL_SPAWNS})`
      : `orphan retries exceeded (${retryCount}/${MAX_ORPHAN_RETRIES})`;
    return { ...decision, outcome: 'blocked', reason };
  }
  if (!wasInterrupted && cooldownRemaining > 0) {
    return { ...decision, outcome: 'cooldown', reason: `Orphan retry cooldown (${cooldownMinutes}m remaining)` };
  }
  return { ...decision, outcome: 'requeue', reason: null };
}

/**
 * The task update that persists a retry decision. One builder for the three
 * shapes so the `interruptedByRestart` handling is written once: the spread of
 * `task.metadata` carries every prior key forward, so any outcome other than a
 * restart-interrupted requeue must clear the flag or the task would read as
 * restart-interrupted through every later outcome.
 *
 * A restart-interrupted requeue records WHAT happened without touching the orphan
 * bookkeeping: `lastOrphanedAt` stays so a later genuine orphan's cooldown is
 * still measured from the last genuine orphan, not from our restart.
 *
 * @param {object} args
 * @param {number} args.now - epoch ms, the same instant the decision used
 * @param {object} [args.resumePatch] - merged last, requeue only
 * @returns {{ status: 'pending'|'blocked', metadata: object }}
 */
export function buildOrphanOutcome({ decision, task, agentId, now, resumePatch = {} }) {
  const { outcome, interrupted, retryCount, totalSpawns, reason, cooldownRemaining } = decision;
  const nowIso = new Date(now).toISOString();
  const restartInterrupted = outcome === 'requeue' && interrupted;
  const genuineOrphan = { orphanRetryCount: retryCount, lastOrphanedAt: nowIso, lastOrphanedAgentId: agentId };

  const outcomeFields = {
    requeue: restartInterrupted
      // The refunded count is persisted so the restart's spawn is genuinely given back.
      ? { totalSpawnCount: totalSpawns, lastInterruptedAt: nowIso, lastInterruptedAgentId: agentId }
      : genuineOrphan,
    cooldown: {
      ...genuineOrphan,
      blockedReason: reason,
      blockedCategory: 'orphan-cooldown',
      blockedAt: nowIso,
      cooldownUntil: new Date(now + cooldownRemaining).toISOString(),
    },
    blocked: { orphanRetryCount: retryCount, blockedReason: reason, blockedCategory: 'max-retries', blockedAt: nowIso },
  }[outcome];

  return {
    status: outcome === 'requeue' ? 'pending' : 'blocked',
    metadata: {
      ...task.metadata,
      ...outcomeFields,
      interruptedByRestart: restartInterrupted,
      ...(outcome === 'requeue' ? resumePatch : {}),
    },
  };
}
