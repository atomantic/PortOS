/**
 * CoS Runner agent liveness — presence in GET /agents is not proof of life.
 *
 * CoS Runner GET /agents liveness. Presence in the runner's handle map is not proof of life:
 * `runnerAgentLivenessFields` produces `processActive` + `liveness` (`pty` from TUI onExit
 * bookkeeping, `pid` from a CLI probe) so Windows ConPTY `pid: 0` no longer reports every TUI as dead;
 * `runnerEntryShieldsRunningRecord` is the corroboration gate the orphan sweep uses before a
 * listing can keep a durable `running` record.
 *
 * The runner's map is a list of PTY/child handles it has not seen exit. A
 * failed kill (or a Windows ConPTY pid of 0) leaves a handle advertised after
 * the process is gone. Sweeps must corroborate a listing with either a live
 * pid or a liveness field that means more than "registered".
 *
 * `liveness: 'pty'` — TUI rows, from the runner's own onExit bookkeeping.
 * `liveness: 'pid'` — CLI rows, from a pid probe.
 * Older runners omit `liveness`; a TUI row's processActive is then a pid-0
 * artifact and must not be read as dead.
 */

export const RUNNER_LIVENESS_PID = 'pid';
export const RUNNER_LIVENESS_PTY = 'pty';

export function usableAgentPid(pid) {
  const n = Number.parseInt(pid, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Fields a GET /agents row should carry for one in-memory runner handle.
 * `stats` is a getProcessStats result when the pid was usable; otherwise null.
 */
export function runnerAgentLivenessFields(agent, stats) {
  if (agent?.kind === 'tui') {
    const active = agent.exited !== true;
    return {
      processActive: active,
      state: active
        ? (stats?.state && stats.state !== 'invalid' && stats.state !== 'dead' ? stats.state : 'running')
        : 'dead',
      cpu: stats?.cpu ?? 0,
      memoryMb: stats?.memoryMb ?? 0,
      liveness: RUNNER_LIVENESS_PTY,
    };
  }
  return {
    processActive: stats?.active === true,
    state: stats?.state ?? 'unknown',
    cpu: stats?.cpu ?? 0,
    memoryMb: stats?.memoryMb ?? 0,
    liveness: RUNNER_LIVENESS_PID,
  };
}

/**
 * Should a runner listing shield a durable `running` record from a sweep?
 * A usable pid that is gone means the listing is stale even if the handle
 * remains. TUI rows with no usable pid (Windows ConPTY) fall back to the
 * onExit-backed processActive flag.
 *
 * `pidIsAlive` is injected so callers reuse their existing probe; awaited so
 * both sync and async probes work.
 */
const defaultPidIsAlive = (pid) => {
  const n = Number.parseInt(pid, 10);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

export async function runnerEntryShieldsRunningRecord(entry, pidIsAlive = defaultPidIsAlive) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.liveness === RUNNER_LIVENESS_PTY) {
    return entry.processActive === true;
  }
  const pid = usableAgentPid(entry.pid);
  if (entry.liveness === RUNNER_LIVENESS_PID) {
    if (entry.processActive === true) return true;
    return pid ? Boolean(await pidIsAlive(pid)) : false;
  }
  if (entry.processActive === true) return true;
  if (entry.kind === 'tui' && !pid) return true;
  return pid ? Boolean(await pidIsAlive(pid)) : false;
}
