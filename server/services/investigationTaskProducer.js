/**
 * Investigation-task producer — the one place a failure-driven task is filed.
 *
 * Producers (`agentErrorAnalysis.js`, `autoFixer.js`, `agentManagement.js`) must agree on
 * the APPROVAL verdict (unattended unless a failure loop), the MARKERS (`isInvestigation`,
 * `investigationFingerprint`, `affectedTasks`, `approvalReason`) and the STORM COUNTER,
 * which only works if every producer both reads and contributes to it.
 *
 * Uses the `cos.js` facade for task I/O (adds no module edge); the RETRY side
 * (`investigationRetry.js`) must use `cosTaskStore` directly or it closes a load-time cycle.
 */

import { addTask, getAllTasks } from './cosTaskStore.js';
import {
  INVESTIGATION_CIRCUIT_MAX_CREATIONS,
  INVESTIGATION_CIRCUIT_WINDOW_MS,
  INVESTIGATION_TASK_DELIVERY,
  UNATTENDED_APPROVAL_VERDICT,
  resolveInvestigationApproval,
} from '../lib/investigationTasks.js';

let investigationCreationStamps = []; // ms timestamps, newest-last

/**
 * How many investigation creations are still inside the rolling circuit window (prunes
 * aged-out stamps). Below the cap, a non-zero count is the `failure-storm` signal that
 * holds the task for a human; at the cap the task is suppressed.
 */
export function recentInvestigationCreations(now = Date.now()) {
  investigationCreationStamps = investigationCreationStamps.filter(t => now - t < INVESTIGATION_CIRCUIT_WINDOW_MS);
  return investigationCreationStamps.length;
}

/** Is the circuit OPEN — i.e. should this producer suppress the task entirely? */
export function investigationCircuitOpen(now = Date.now()) {
  return recentInvestigationCreations(now) >= INVESTIGATION_CIRCUIT_MAX_CREATIONS;
}

/**
 * Record a genuine creation against the shared circuit, after `addTask` mints a task (a
 * dedup returning an existing task must not count).
 */
export function noteInvestigationFiled(now = Date.now()) {
  investigationCreationStamps.push(now);
}

/** Test hook — the stamp list is module state, so suites reset it between cases. */
export function __resetInvestigationCircuit() {
  investigationCreationStamps = [];
}

/** Every task across both queues, flattened. */
export async function readAllTasksFlat() {
  const { user, cos } = await getAllTasks();
  return [...(user?.tasks || []), ...(cos?.tasks || [])];
}

/**
 * The approval verdict for a new investigation, read against the live backlog (async half
 * of the pure `resolveInvestigationApproval`). FAILS OPEN: a throwing policy read must not
 * put the diagnosis back behind a human.
 *
 * @param {string} fingerprint the failure's `category:kind:scope` dedup key
 * @param {{ now?: number, tasks?: object[] }} [opts] `tasks` lets a caller that already
 *   read the backlog skip a second read.
 */
export async function resolveAutoInvestigationApproval(fingerprint, { now = Date.now(), tasks } = {}) {
  const backlog = tasks || await readAllTasksFlat().catch(() => null);
  if (!backlog) return UNATTENDED_APPROVAL_VERDICT;
  return resolveInvestigationApproval({
    fingerprint,
    tasks: backlog,
    recentCreations: recentInvestigationCreations(now),
    now
  });
}

/**
 * File an investigation task with the shared verdict + markers, and record it against the
 * circuit. For producers with no per-task dedup of their own (provider, crash, orphan
 * paths); the agent-failure producer keeps its own creation path for its durable
 * fingerprint dedup and TOCTOU serialization. A held task gets the "why this is held for
 * you" prose appended.
 *
 * Deliberately does NOT hard-suppress on `investigationCircuitOpen`: callers bound their
 * own fan-out, and dropping a user's manual "investigate this" because unrelated failures
 * filled the window is worse than filing it. The counter still drives the softer
 * `failure-storm` hold.
 *
 * @param {{ fingerprint: string, description: string, affectedTasks?: string[] }} args
 *   plus any further `addTask` fields (priority, context, diagnostics)
 * @param {{ now?: number, taskType?: string, delivery?: object }} [opts] `taskType` and
 *   `delivery` differ for a USER-queued investigation (#6043); `delivery` is applied AFTER
 *   the caller's fields because isolation and PR posture are set by policy.
 * @returns {Promise<{ task: object|null, approvalRequired: boolean, loopReason: string|null }>}
 */
export async function fileInvestigationTask(
  { fingerprint, description, affectedTasks = [], ...extra } = {},
  { now = Date.now(), taskType = 'internal', delivery = INVESTIGATION_TASK_DELIVERY } = {}
) {
  const verdict = await resolveAutoInvestigationApproval(fingerprint, { now });
  const body = verdict.loopProse
    ? `${description}\n\n## Why this is held for you\n${verdict.loopProse}`
    : description;

  const task = await addTask({
    ...extra,
    ...delivery,
    description: body,
    approvalRequired: verdict.approvalRequired,
    approvalReason: verdict.approvalReason,
    // Markers the dedup scan, reaper, meta-cascade guard and auto-retry read.
    isInvestigation: true,
    investigationFingerprint: fingerprint,
    ...(affectedTasks.length > 0 && { affectedTasks })
  }, taskType);

  if (!task?.duplicate) noteInvestigationFiled(now);
  return { task, approvalRequired: verdict.approvalRequired, loopReason: verdict.loopReason };
}

