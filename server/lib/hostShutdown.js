/**
 * Host-shutdown signal + durable marker.
 *
 * `portos-server` is restarted routinely — pm2's memory ceiling, a manual
 * `pm2 restart`, a code deploy. pm2's TreeKill signals every descendant of the
 * server, so a CoS TUI agent whose PTY the server owns dies WITH the server
 * even though the durable `portos-cos` runner never went down (issue #3202).
 *
 * That teardown is an INTERRUPTION, not an outcome, and PortOS has to be able to
 * tell the two apart later — after the process that witnessed it is gone. Two
 * signals do that:
 *
 *   1. **In-process flag** (`markHostShuttingDown` / `isHostShuttingDown`) —
 *      read by the TUI spawner's PTY-exit handler so a PTY that vanishes mid
 *      shutdown is never finalized as a completed run. Sync, allocation-free,
 *      and safe to set first thing inside a signal handler.
 *   2. **Durable marker** (`writeHostShutdownMarker`) — a small JSON file naming
 *      the agents that were live when the signal arrived. The next boot's orphan
 *      sweep reads it to classify those agents as *interrupted by a host
 *      restart* rather than as ordinary orphans, so they don't burn orphan-retry
 *      budget or trip the 30-minute orphan cooldown for a fault they didn't
 *      cause.
 *
 * The marker is deliberately tiny and best-effort: it is written inside the
 * graceful-shutdown window (which has a hard 10s ceiling), so every function
 * here is non-throwing and returns a falsy/empty result rather than propagating
 * an I/O failure into shutdown. A missing marker simply degrades recovery to the
 * pre-existing orphan path — the old, safe behavior.
 */

import { join } from 'path';
import { rm } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile } from './fileUtils.js';

/** Completion reason recorded for a run the host restart tore down. */
export const HOST_SHUTDOWN_REASON = 'host-shutdown';

/**
 * Marker file. Lives beside the other CoS state so a data wipe clears it too.
 *
 * Resolved lazily rather than as a module-level constant: this module is
 * imported by the TUI spawner, whose suites stub `fileUtils` with a partial
 * `PATHS`. A `join(PATHS.cos, …)` evaluated at import time throws there and
 * takes the whole suite down with it — for a path most callers never touch.
 */
export const hostShutdownMarkerPath = () => join(PATHS.cos, 'host-shutdown.json');

const isNonEmptyString = (value) => typeof value === 'string' && !!value;

// Process-local. Never persisted — a fresh process is by definition not the one
// that was shutting down, so this always starts false.
let shuttingDown = false;

/**
 * Latch the in-process shutdown flag. Idempotent; call it as the FIRST thing in
 * a SIGTERM/SIGINT handler, before any await, so anything that races the
 * teardown (a PTY exiting, a finalize hook firing) already sees it.
 */
export function markHostShuttingDown() {
  shuttingDown = true;
}

/** Is this process on its way down? */
export function isHostShuttingDown() {
  return shuttingDown;
}

/**
 * Should an agent exit be preserved for restart recovery instead of finalized?
 *
 * Completion, user termination, and pause are all authoritative outcomes that
 * retain their normal handling even when the host shutdown latch is set. Keep
 * this policy shared by every spawn path so their recovery behavior cannot
 * drift independently.
 */
export function shouldAbandonForHostShutdown({
  sentinelPresent = false,
  terminatedByUser = false,
  paused = false,
} = {}) {
  return shuttingDown && !sentinelPresent && !terminatedByUser && !paused;
}

/**
 * Reset the flag. Test-only — production never un-shuts-down.
 */
export function resetHostShutdownFlagForTests() {
  shuttingDown = false;
}

/**
 * Persist the marker naming the agents that were live at shutdown.
 *
 * @param {object} params
 * @param {string[]} params.agentIds - ids of agents running when the signal landed
 * @param {string} [params.signal] - the signal that triggered shutdown (diagnostic)
 * @returns {Promise<boolean>} true when the marker landed on disk
 */
export async function writeHostShutdownMarker({ agentIds = [], signal = null } = {}) {
  // UNION with any marker the previous shutdown left unconsumed, rather than
  // replacing it. A boot that is killed before its orphan sweep runs (the sweep
  // is a couple of seconds in) leaves the prior marker in place; a plain
  // overwrite would drop those agents and silently demote them to ordinary
  // orphans — the exact penalty this marker exists to prevent. Consuming the
  // marker is the sweep's job, so anything still here has not been recovered yet.
  const prior = await readHostShutdownMarker();
  const ids = [...new Set([...(prior?.agentIds || []), ...agentIds.filter(isNonEmptyString)])];
  // Nothing was running — don't leave a marker the next boot has to reason
  // about (and don't overwrite a prior one; a marker with no agents is noise).
  if (ids.length === 0) return false;
  return atomicWrite(hostShutdownMarkerPath(), { at: new Date().toISOString(), signal, agentIds: ids })
    .then(
      () => { console.log(`🛑 Host shutdown marker written for ${ids.length} live agent(s)`); return true; },
      (err) => { console.error(`❌ Failed to write host-shutdown marker: ${err.message}`); return false; },
    );
}

/**
 * Read the marker left by the previous process. Returns null when there is
 * none, otherwise `{ at, signal, agentIds }`.
 *
 * `agentIds` is ALWAYS an array of non-empty strings — that's the one field
 * with a production consumer, and boot recovery runs before everything else, so
 * a truncated/garbled marker has to degrade to "no agents were interrupted"
 * rather than throw. `allowArray: false` does the rest of the shape check:
 * `readJSONFile` already rejects an unparseable file AND any root that isn't a
 * `{…}` object, so a falsy result is the only failure left to test for.
 */
export async function readHostShutdownMarker() {
  const raw = await readJSONFile(hostShutdownMarkerPath(), null, { logError: false, allowArray: false });
  if (!raw) return null;
  return { ...raw, agentIds: Array.isArray(raw.agentIds) ? raw.agentIds.filter(isNonEmptyString) : [] };
}

/**
 * Remove the marker once boot recovery has consumed it. Non-throwing: a marker
 * that can't be removed would only cause the NEXT boot to re-classify agents
 * that are already settled, which the orphan sweep tolerates (it only ever looks
 * at agents still marked `running`).
 */
export async function clearHostShutdownMarker() {
  await rm(hostShutdownMarkerPath(), { force: true }).catch((err) => {
    console.error(`❌ Failed to clear host-shutdown marker: ${err.message}`);
  });
}
