import { killProcessTree } from '../lib/bufferedSpawn.js';
import { armForceKill } from './forceKill.js';

// Owns processes until their actual exit AND asynchronous finalization, even
// when a terminate route has already removed them from the public agent map.
export function createRunnerShutdown({
  stopIntake, closeTransports, drainState, exit, logError = console.error,
  deadlineMs = 25_000, graceMs = 5000,
}) {
  const owned = new Set();
  const pending = new Set();
  let stopping = false;
  let failed = false;
  let shutdownPromise;

  const reportFailure = (err) => {
    failed = true;
    logError(`❌ Runner drain failed: ${err.message}`);
  };

  const trackWork = (work) => {
    // Invoke synchronously: admission and registration happen before the next
    // signal can run. Keep a separate settled promise to avoid orphan rejections.
    const promise = (async () => work())();
    const settled = promise.then(() => {}, reportFailure).finally(() => pending.delete(settled));
    pending.add(settled);
    return promise;
  };

  const rejectSpawn = (res) => {
    if (!stopping) return false;
    res.status(503).json({ error: 'Runner is shutting down', code: 'SHUTTING_DOWN' });
    return true;
  };

  const spawnRoute = (handler) => (req, res) => {
    if (rejectSpawn(res)) return;
    return trackWork(() => handler(req, res));
  };

  const agentExit = (agentId, agent, finalize) => {
    const ownership = { agentId, agent };
    owned.add(ownership);
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    pending.add(completed);
    let finalization;
    return (...args) => {
      if (finalization) return finalization;
      owned.delete(ownership);
      if (agent.killTimer) clearTimeout(agent.killTimer);
      agent.killTimer = null;
      finalization = trackWork(() => finalize(...args)).catch(() => {}).finally(() => {
        pending.delete(completed);
        finish();
      });
      return finalization;
    };
  };

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    // Establish the hard deadline before calling any dependency. No stalled
    // preparation, persistence write or upgraded socket can extend it.
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    });
    let intake;
    try {
      intake = stopIntake(deadlineMs);
    } catch (err) {
      reportFailure(err);
    }
    for (const { agentId, agent } of owned) {
      // Arm first so a synchronous exit from a process double can cancel it.
      armForceKill(new Map([[agentId, agent]]), agentId, agent, { graceMs });
      try {
        killProcessTree(agent.process, 'SIGTERM');
      } catch (err) {
        reportFailure(err);
      }
    }
    const drain = async () => {
      while (pending.size) await Promise.all([...pending]);
      await drainState();
      await closeTransports();
      await intake;
      return !failed;
    };
    shutdownPromise = Promise.race([drain().catch(err => {
      reportFailure(err);
      return false;
    }), deadline]).then(clean => {
      clearTimeout(timer);
      if (!clean) {
        logError('❌ Runner shutdown interrupted; preserving unfinished recovery records');
        // Best effort only: the deadline also bounds Socket.IO's close callback.
        try {
          Promise.resolve(closeTransports()).catch(reportFailure);
        } catch (err) {
          reportFailure(err);
        }
      }
      exit(clean ? 0 : 1);
      return clean;
    });
    return shutdownPromise;
  };

  return { isStopping: () => stopping, rejectSpawn, spawnRoute, agentExit, trackWork, reportFailure, shutdown };
}

export function registerRunnerShutdownSignals(process, lifecycle) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void lifecycle.shutdown(); });
  }
}
