/**
 * CoS Health Monitor Module
 *
 * Daemon health checks extracted from cos.js. Inspects PM2 process state and
 * memory usage, auto-restarts errored processes, records the latest health
 * snapshot to CoS state, and emits health events for downstream consumers.
 */

import { execPm2, listProcessesStrict } from './pm2.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import { loadState, saveState, withStateLock, isDaemonRunning } from './cosState.js';
import { cosEvents, emitLog } from './cosEvents.js';
import { annotateExpectedExit } from './appProcessStatus.js';

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
    const annotated = await annotateExpectedExit(pm2Processes);
    const supervised = annotated.filter(p => !p.expectedExit);

    const erroredProcesses = supervised.filter(p => p.status === 'errored');
    // Reported on its own rather than folded into `errored` (which would
    // degrade health for a normal user action) or dropped from the totals.
    // Counted from the expected-exit processes only, so it never overlaps
    // `errored`/`stopped` below — those now count supervised processes
    // exclusively.
    const desktopExited = annotated.filter(
      p => p.expectedExit && ['errored', 'stopped'].includes(p.status)
    ).length;
    // `online` counts EVERY process, exempt or not: the exemption is about
    // exit semantics, not liveness, so a running desktop app must still report
    // as online (otherwise it lands in `total` and in no bucket, and the
    // metric reads the same whether the game is running or quit).
    metrics.pm2 = {
      total: pm2Processes.length,
      online: annotated.filter(p => p.status === 'online').length,
      errored: erroredProcesses.length,
      stopped: supervised.filter(p => p.status === 'stopped').length,
      desktopExited
    };

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

      const restartResults = await Promise.all(names.map(async (name) => {
        // execPm2, not execFileAsync('pm2', …, { shell: true }) — `shell: true`
        // resolves `pm2` to pm2.cmd and rebuilds the cmd.exe → pm2.cmd → node
        // chain that v1.6.7 removed, flashing a console window on every restart.
        const result = await execPm2(['restart', name]).catch(e => ({ stdout: '', stderr: e.message }));
        const failed = result.stderr && !result.stdout;
        if (failed) {
          emitLog('error', `❌ Failed to restart ${name}: ${result.stderr}`);
        } else {
          emitLog('success', `✅ Auto-restarted errored process: ${name}`);
        }
        return { name, success: !failed };
      }));

      const failedRestarts = restartResults.filter(r => !r.success);
      if (failedRestarts.length > 0) {
        issues.push({
          type: 'error',
          category: 'processes',
          message: `${failedRestarts.length} errored PM2 process(es) failed to auto-restart: ${failedRestarts.map(r => r.name).join(', ')}`
        });
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
