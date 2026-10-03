/**
 * CoS Health Monitor Module
 *
 * Daemon health checks extracted from cos.js. Inspects PM2 process state and
 * memory usage, auto-restarts errored processes, records the latest health
 * snapshot to CoS state, and emits health events for downstream consumers.
 */

import { execPm2, listProcessesStrict, clearJlistCache } from './pm2.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { loadState, saveState, withStateLock, isDaemonRunning } from './cosState.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { annotateExpectedExit } from './appProcessStatus.js';

// A restart that PM2 accepted proves the command ran, not that the process
// stayed up. Verification is bounded: a few fresh reads, waiting only while PM2
// still reports a transitional state. Exported for tests to shrink the wait.
export const RESTART_VERIFY = { attempts: 3, delayMs: 2000 };
const TRANSITIONAL = new Set(['launching', 'waiting restart', 'stopping']);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Stable identity: pm_id distinguishes cluster instances sharing a name.
const processKey = (p) => (p.pm_id ?? null) !== null ? `id:${p.pm_id}` : `name:${p.name}`;

async function summarizePm2(processes) {
  const annotated = await annotateExpectedExit(processes);
  const supervised = annotated.filter(p => !p.expectedExit);
  const erroredProcesses = supervised.filter(p => p.status === 'errored');
  // Reported on its own rather than folded into `errored` (which would
  // degrade health for a normal user action) or dropped from the totals.
  // Counted from the expected-exit processes only, so it never overlaps
  // `errored`/`stopped` — those count supervised processes exclusively.
  const desktopExited = annotated.filter(
    p => p.expectedExit && ['errored', 'stopped'].includes(p.status)
  ).length;
  // `online` counts EVERY process, exempt or not: the exemption is about
  // exit semantics, not liveness, so a running desktop app must still report
  // as online.
  return {
    erroredProcesses,
    pm2: {
      total: processes.length,
      online: annotated.filter(p => p.status === 'online').length,
      errored: erroredProcesses.length,
      stopped: supervised.filter(p => p.status === 'stopped').length,
      desktopExited
    }
  };
}

/**
 * Observe whether restarted processes came back. Returns
 * { processes: fresh list | null, unconfirmed: [{ name, reason }] }.
 */
async function verifyRecovery(restarted) {
  const wanted = new Map(restarted.map(p => [processKey(p), p]));
  let fresh = null;
  for (let attempt = 0; attempt < RESTART_VERIFY.attempts; attempt++) {
    if (attempt > 0) await sleep(RESTART_VERIFY.delayMs);
    clearJlistCache();
    fresh = await listProcessesStrict();
    if (fresh === null) continue;
    // Wait only while a restarted process is still in a transitional state;
    // online, errored, stopped or missing are all settled answers.
    const byKey = new Map(fresh.map(p => [processKey(p), p]));
    if (![...wanted.keys()].some(key => TRANSITIONAL.has(byKey.get(key)?.status))) break;
  }
  if (fresh === null) {
    return { processes: null, unconfirmed: [...wanted.values()].map(p => ({ name: p.name, reason: 'verification read failed' })) };
  }
  const byKey = new Map(fresh.map(p => [processKey(p), p]));
  const unconfirmed = [...wanted.entries()]
    .filter(([key]) => byKey.get(key)?.status !== 'online')
    .map(([key, p]) => {
      const status = byKey.get(key)?.status;
      if (!status) return { name: p.name, reason: 'missing after restart' };
      return { name: p.name, reason: TRANSITIONAL.has(status) ? `still ${status}` : status };
    });
  return { processes: fresh, unconfirmed };
}

/**
 * Run a daemon health check: inspect PM2 processes and memory, auto-restart
 * errored processes, store the result, and emit health events.
 */
export async function runHealthCheck() {
  if (!isDaemonRunning()) return;

  const state = await loadState();
  const issues = [];
  const metrics = {
    timestamp: new Date().toISOString(),
    pm2: null,
    memory: null,
    ports: null
  };

  // Check PM2 processes. `listProcessesStrict()` returns `null` when the read
  // itself FAILED (vs `[]` for a successful read with no processes) — the
  // absent-vs-empty contract from issue #968, now the one non-test owner of raw
  // `pm2 jlist` execution/parsing alongside `autofixer/shared.js` (#8164). A
  // failed read must not be recorded as zero processes: that would suppress
  // repair (no errored processes found) and misreport health as clean.
  const pm2Processes = await listProcessesStrict();

  if (pm2Processes === null) {
    metrics.pm2 = null;
    issues.push({
      type: 'error',
      category: 'processes',
      message: 'PM2 process read failed — process health is unavailable, not necessarily clean'
    });
  } else {
    // A process whose stopping is a normal outcome (a desktop app the user
    // closed) must not be auto-restarted — that would reopen the window they
    // just closed, the same relaunch loop `autorestart: false` prevents,
    // arriving by another path. See issue #2991.
    const summary = await summarizePm2(pm2Processes);
    const erroredProcesses = summary.erroredProcesses;
    metrics.pm2 = summary.pm2;

    // Check for runaway processes (too many)
    if (pm2Processes.length > state.config.maxTotalProcesses) {
      issues.push({
        type: 'warning',
        category: 'processes',
        message: `High process count: ${pm2Processes.length} PM2 processes (limit: ${state.config.maxTotalProcesses})`
      });
    }

    // Check for errored processes and auto-restart them
    if (erroredProcesses.length > 0) {
      const names = erroredProcesses.map(p => p.name);
      emitLog('warn', `🔄 ${names.length} errored PM2 process(es) detected: ${names.join(', ')} — attempting restart`);

      const restartResults = await Promise.all(erroredProcesses.map(async (proc) => {
        const name = proc.name;
        // execPm2, not execFileAsync('pm2', …, { shell: true }) — `shell: true`
        // resolves `pm2` to pm2.cmd and rebuilds the cmd.exe → pm2.cmd → node
        // chain that v1.6.7 removed, flashing a console window on every restart.
        const result = await execPm2(['restart', name]).catch(e => ({ stdout: '', stderr: e.message }));
        const failed = result.stderr && !result.stdout;
        if (failed) emitLog('error', `❌ Failed to restart ${name}: ${result.stderr}`);
        return { proc, success: !failed };
      }));

      const failedRestarts = restartResults.filter(r => !r.success);
      if (failedRestarts.length > 0) {
        issues.push({
          type: 'error',
          category: 'processes',
          message: `${failedRestarts.length} errored PM2 process(es) failed to auto-restart: ${failedRestarts.map(r => r.proc.name).join(', ')}`
        });
      }

      // Command acceptance is not recovery: observe process state afresh.
      const accepted = restartResults.filter(r => r.success).map(r => r.proc);
      if (accepted.length > 0) {
        const { processes: fresh, unconfirmed } = await verifyRecovery(accepted);
        const unconfirmedKeys = new Set(unconfirmed.map(u => u.name));
        for (const proc of accepted) {
          if (!unconfirmedKeys.has(proc.name)) emitLog('success', `✅ Auto-restarted errored process (observed online): ${proc.name}`);
        }
        if (unconfirmed.length > 0) {
          const detail = unconfirmed.map(u => `${u.name} (${u.reason})`).join(', ');
          emitLog('error', `❌ Restart accepted but recovery not confirmed: ${detail}`);
          issues.push({
            type: 'error',
            category: 'processes',
            message: `${unconfirmed.length} PM2 process(es) restarted but recovery is unconfirmed: ${detail}`
          });
        }
        // Report fresh post-restart metrics when the observation succeeded.
        if (fresh !== null) metrics.pm2 = (await summarizePm2(fresh)).pm2;
      }
    }
  }

  // Keep memory telemetry without treating expected occupancy as a failure.
  metrics.memory = await getMemoryStats();

  // Store health check result with lock to prevent race conditions
  await withStateLock(async () => {
    const freshState = await loadState();
    freshState.stats.lastHealthCheck = metrics.timestamp;
    freshState.stats.healthIssues = issues;
    await saveState(freshState);
  });

  cosEvents.emit('health:check', { metrics, issues });

  // If there are critical issues, emit for potential automated response
  if (issues.filter(i => i.type === 'error').length > 0) {
    cosEvents.emit('health:critical', issues.filter(i => i.type === 'error'));
  }

  return { metrics, issues };
}

/**
 * Get latest health status
 */
export async function getHealthStatus() {
  const state = await loadState();
  return {
    lastCheck: state.stats.lastHealthCheck,
    // Older snapshots can survive until the next daemon poll.
    issues: (state.stats.healthIssues || []).filter(issue => issue.category !== 'memory'
      && !(issue.category === 'processes' && issue.message?.startsWith('Auto-restarted ')))
  };
}
