/**
 * Reservations left when the admitting process dies inside the boundary.
 * `run()` finishes in a finally, so only process death leaks a settled row.
 * Boot and the orphan sweep call this. It never throws: a journal that needs
 * recovery must not abort the caller's startup.
 *
 * A dead pid is not proof the work was saved. `settlement` / `Output publication`
 * is stamped unsettled so the operator receipt path can see it, and is never
 * released here. `cli-run` is released only when that run's metadata already
 * has an end time (published before `permit.finish()`). `mind-turn` is released
 * only when the mind record has no active turn. `provider` names a caller
 * label, not a run, so it cannot be matched to a finished call and stays.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { PATHS } from '../lib/paths.js';

const require = createRequire(import.meta.url);

// heavyJobClaim computes its claim path at import. Load it on use so a suite
// that stubs fileUtils without a data root can still import this module.
function defaultPidAlive(pid) {
  return require('../lib/heavyJobClaim.js').isPidAlive(pid);
}

// Run ids are minted as UUIDs. Reject anything that could escape the runs directory.
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

function cliRunRecordEnded(runId, runsDir) {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) return false;
  try {
    const metadata = JSON.parse(readFileSync(join(runsDir, runId, 'metadata.json'), 'utf8'));
    return typeof metadata?.endTime === 'string' && metadata.endTime.length > 0;
  } catch {
    return false;
  }
}

/** True only for a persisted mind object that is not inside a turn. */
function mindRecordHasNoActiveTurn(state) {
  const mind = state?.persistentMind;
  if (!mind || typeof mind !== 'object' || Array.isArray(mind)) return false;
  return mind.activeTurn == null;
}

function readMindIdle(mindStatePath = join(PATHS.cos, 'state.json')) {
  try {
    return mindRecordHasNoActiveTurn(JSON.parse(readFileSync(mindStatePath, 'utf8')));
  } catch {
    return false;
  }
}

/**
 * @param {{ admission?: object, pidAlive?: (pid: number) => boolean, runsDir?: string,
 *   cliRunEnded?: (runId: string) => boolean, mindStatePath?: string,
 *   mindTurnIdle?: () => boolean }} [options]
 * @returns {{ marked: number, released: number }}
 */
export function reconcileDeadOwnerReservations({
  admission = maintenance,
  pidAlive = defaultPidAlive,
  runsDir = PATHS.runs,
  cliRunEnded = (runId) => cliRunRecordEnded(runId, runsDir),
  mindStatePath,
  mindTurnIdle = () => readMindIdle(mindStatePath),
} = {}) {
  try {
    const dead = admission.operations().filter(op => op.unsettled !== true && !pidAlive(op.pid));
    if (dead.length === 0) return { marked: 0, released: 0 };
    const publications = dead.filter(op => op.kind === 'settlement' && op.resource === 'Output publication');
    const marked = publications.length === 0 ? 0 : admission.markOperationsUncertain(publications);
    let mindIdle;
    const proved = (op) => {
      if (op.kind === 'cli-run') {
        try { return cliRunEnded(op.resource) === true; } catch { return false; }
      }
      if (op.kind === 'mind-turn') {
        if (mindIdle === undefined) {
          try { mindIdle = mindTurnIdle() === true; } catch { mindIdle = false; }
        }
        return mindIdle;
      }
      // provider: nothing in the reservation identifies the call that was saved.
      return false;
    };
    const releasable = dead.filter(op => op.kind !== 'settlement' && proved(op));
    const released = releasable.length === 0 ? 0 : admission.releaseOperations(releasable);
    if (marked > 0) console.log(`🧹 Marked ${marked} dead-owner publication reservation(s) unsettled`);
    if (released > 0) console.log(`🧹 Released ${released} dead-owner reservation(s) with proved completion`);
    return { marked, released };
  } catch (err) {
    console.warn(`⚠️ Dead-owner reservation reconcile skipped: ${err.message}`);
    return { marked: 0, released: 0 };
  }
}
