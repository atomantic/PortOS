/** Track bounded child process stops through replacement or host shutdown. */
import { killWithEscalation } from './killWithEscalation.js';

const CHILD_STOP_GRACE_MS = 1000;

export function createChildStopTracker() {
  const pending = new Set();

  function stop(proc, label) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const { promise, resolve } = Promise.withResolvers();
    pending.add(promise);
    let escalationTimer;
    let deadlineTimer;
    const finish = () => {
      clearTimeout(escalationTimer);
      clearTimeout(deadlineTimer);
      proc.off('close', finish);
      pending.delete(promise);
      resolve();
    };
    proc.once('close', finish);
    try {
      escalationTimer = killWithEscalation(proc, { label, stillRunning: () => true, delayMs: CHILD_STOP_GRACE_MS });
    } catch (err) {
      finish();
      throw err;
    }
    if (!pending.has(promise)) {
      clearTimeout(escalationTimer);
      return;
    }
    // This timer is queued after escalation at the same deadline. Once SIGKILL
    // has been attempted, no further wait on the child's close event is needed.
    deadlineTimer = setTimeout(finish, CHILD_STOP_GRACE_MS);
    deadlineTimer.unref?.();
  }

  return { stop, drain: () => Promise.all(pending) };
}
