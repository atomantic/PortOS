/**
 * Auto-Fix Metrics aggregation (issue #2328)
 *
 * Reads the structured per-attempt auto-fix diagnostics that ride on task
 * records (`metadata.diagnostics`, persisted since #2335) and aggregates
 * auto-fix outcomes by fallback tier, failure category, task status, and
 * time-to-recovery — plus a daily success-rate trend for the dashboard.
 *
 * `aggregateAutoFixDiagnostics` is a pure reducer over an in-memory task list
 * (no I/O — trivially unit-testable); `getAutoFixMetrics` is the thin I/O shim
 * the route calls to load persisted tasks and hand them to the reducer.
 *
 * Sentinel discipline (per CLAUDE.md): a rate with no denominator and a
 * duration summary with no completed-with-timing samples return `null`, NOT a
 * fabricated 0 — "no data yet" must never read as "0% success" or "0ms
 * recovery".
 */

import { getAllTasks } from './cosTaskStore.js';
import { fixTierMeta } from './autoFixer.js';

// A diagnostics-bearing task is "resolved" once its task reaches the terminal
// completed status. Everything else (pending / in_progress / blocked) is still
// open — not a failure, just not-yet-recovered — so it drags the success rate
// but is never counted as a failed recovery.
const isResolved = (status) => status === 'completed';

// Parse an ISO string → epoch ms, or null when absent/invalid. Sentinel
// discipline: a missing or garbled timestamp must not collapse into 0 (the
// Unix epoch) and manufacture a ~57-year recovery duration.
function toMs(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// resolved / total, or null when there's no denominator to divide by.
const rate = (resolved, total) => (total > 0 ? resolved / total : null);

// Median of an ascending numeric array (caller sorts once and reuses).
function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? Math.round((sortedAsc[mid - 1] + sortedAsc[mid]) / 2) : sortedAsc[mid];
}

function hasDiagnostics(task) {
  const d = task?.metadata?.diagnostics;
  return !!d && typeof d === 'object' && !Array.isArray(d);
}

/**
 * Aggregate auto-fix diagnostics across a flat list of task records. Pure.
 *
 * @param {Array<object>} tasks - task records ({ status, metadata: { diagnostics, updatedAt } }).
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()] - injectable clock for deterministic `generatedAt`.
 * @returns {{
 *   generatedAt: string,
 *   total: number,
 *   byStatus: { pending: number, in_progress: number, blocked: number, completed: number },
 *   overall: { resolved: number, open: number, successRate: number|null },
 *   byTier: Array<{ tier: number, strategy: string, label: string, total: number, resolved: number, open: number, successRate: number|null }>,
 *   byCategory: Array<{ category: string, total: number, resolved: number, open: number, successRate: number|null }>,
 *   timeToRecovery: { count: number, avgMs: number, medianMs: number, minMs: number, maxMs: number }|null,
 *   trend: Array<{ date: string, total: number, resolved: number, successRate: number|null }>
 * }}
 */
export function aggregateAutoFixDiagnostics(tasks, { now = Date.now() } = {}) {
  const records = (Array.isArray(tasks) ? tasks : []).filter(hasDiagnostics);

  const byStatus = { pending: 0, in_progress: 0, blocked: 0, completed: 0 };
  const tierMap = new Map();     // tier -> { tier, strategy, label, total, resolved }
  const categoryMap = new Map(); // category -> { category, total, resolved }
  const dayMap = new Map();      // 'YYYY-MM-DD' -> { date, total, resolved }
  const recoveryMs = [];
  let resolvedCount = 0;

  for (const task of records) {
    const d = task.metadata.diagnostics;
    const status = task.status || 'pending';
    byStatus[status] = (byStatus[status] || 0) + 1;
    const resolved = isResolved(status);
    if (resolved) resolvedCount += 1;

    // Tier breakdown (tier number rides on the persisted diagnostics; resolve
    // its label from the number rather than re-classifying the category).
    const tier = Number.isFinite(d.tier) ? d.tier : 0;
    if (!tierMap.has(tier)) {
      const meta = fixTierMeta(tier);
      tierMap.set(tier, { tier, strategy: d.fixStrategy || meta.strategy, label: meta.label, total: 0, resolved: 0 });
    }
    const te = tierMap.get(tier);
    te.total += 1;
    if (resolved) te.resolved += 1;

    // Failure-category breakdown.
    const category = d.category || d.errorType || 'unknown';
    if (!categoryMap.has(category)) categoryMap.set(category, { category, total: 0, resolved: 0 });
    const ce = categoryMap.get(category);
    ce.total += 1;
    if (resolved) ce.resolved += 1;

    // Time-to-recovery: failure observed at diagnostics.observedAt; recovery at
    // the task's last content edit (metadata.updatedAt), which for a completed
    // task is its completion. Only count a completed task with BOTH timestamps
    // present, parseable, and ordered — a legacy diagnostics record without
    // observedAt (pre-#2328) is simply excluded from the duration sample rather
    // than fabricating a bogus interval.
    const observedMs = toMs(d.observedAt);
    if (resolved) {
      const recoveredMs = toMs(task.metadata.updatedAt);
      if (observedMs !== null && recoveredMs !== null && recoveredMs >= observedMs) {
        recoveryMs.push(recoveredMs - observedMs);
      }
    }

    // Daily trend bucket keyed on the failure day (fall back to the last-edit
    // day for legacy records missing observedAt).
    const dayMs = observedMs ?? toMs(task.metadata.updatedAt);
    if (dayMs !== null) {
      const date = new Date(dayMs).toISOString().slice(0, 10);
      if (!dayMap.has(date)) dayMap.set(date, { date, total: 0, resolved: 0 });
      const de = dayMap.get(date);
      de.total += 1;
      if (resolved) de.resolved += 1;
    }
  }

  const total = records.length;

  const byTier = [...tierMap.values()]
    .sort((a, b) => a.tier - b.tier)
    .map((e) => ({ ...e, open: e.total - e.resolved, successRate: rate(e.resolved, e.total) }));

  const byCategory = [...categoryMap.values()]
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category))
    .map((e) => ({ ...e, open: e.total - e.resolved, successRate: rate(e.resolved, e.total) }));

  const trend = [...dayMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => ({ ...e, successRate: rate(e.resolved, e.total) }));

  let timeToRecovery = null;
  if (recoveryMs.length > 0) {
    const sorted = [...recoveryMs].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    timeToRecovery = {
      count: sorted.length,
      avgMs: Math.round(sum / sorted.length),
      medianMs: median(sorted),
      minMs: sorted[0],
      maxMs: sorted[sorted.length - 1],
    };
  }

  return {
    generatedAt: new Date(now).toISOString(),
    total,
    byStatus,
    overall: { resolved: resolvedCount, open: total - resolvedCount, successRate: rate(resolvedCount, total) },
    byTier,
    byCategory,
    timeToRecovery,
    trend,
  };
}

/**
 * Load all persisted tasks (user + internal) and aggregate their auto-fix
 * diagnostics. Thin I/O shim over the pure reducer above.
 */
export async function getAutoFixMetrics({ now = Date.now() } = {}) {
  const { user, cos } = await getAllTasks();
  const tasks = [...(user?.tasks || []), ...(cos?.tasks || [])];
  return aggregateAutoFixDiagnostics(tasks, { now });
}
