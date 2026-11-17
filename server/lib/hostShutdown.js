/**
 * Host-shutdown signal + durable marker.
 *
 * Tells "PortOS was restarted out from under a running agent" apart from "the agent failed" (#3202).
 * An in-process latch (set first thing by the SIGTERM/SIGINT handler) plus a marker at
 * `data/cos/host-shutdown.json` let the NEXT boot's orphan sweep requeue live agents as
 * *interrupted* — no orphan-retry charge, no 30-minute cooldown.
 *
 * pm2's TreeKill signals every descendant of the server, so a CoS TUI agent whose PTY the server
 * owns dies WITH the server while the durable `portos-cos` runner stays up. The marker is written
 * inside the graceful-shutdown window (hard 10s ceiling), so every function is non-throwing and
 * degrades to the ordinary orphan path.
 */

import { join } from 'path';
import { rm } from 'fs/promises';
import { PATHS, atomicWrite, readJSONFile } from './fileUtils.js';
import { isNonBlankStr } from './textUtils.js';

/** Completion reason recorded for a run the host restart tore down. */
export const HOST_SHUTDOWN_REASON = 'host-shutdown';

// Resolved lazily: the TUI spawner's suites stub `fileUtils` with a partial `PATHS`, so import-time `join` would throw.
export const hostShutdownMarkerPath = () => join(PATHS.cos, 'host-shutdown.json');

// Process-local, never persisted: a fresh process is not the one that was shutting down.
let shuttingDown = false;

/** Idempotent; call FIRST in a SIGTERM/SIGINT handler, before any await, so racing teardown sees it. */
export function markHostShuttingDown() {
  shuttingDown = true;
}

/** Is this process on its way down? */
export function isHostShuttingDown() {
  return shuttingDown;
}

/** Preserve for restart recovery instead of finalizing; completion, user termination and pause keep normal handling. */
export function shouldAbandonForHostShutdown({
  sentinelPresent = false,
  terminatedByUser = false,
  paused = false,
} = {}) {
  return shuttingDown && !sentinelPresent && !terminatedByUser && !paused;
}

/** Reset the flag. Test-only. */
export function resetHostShutdownFlagForTests() {
  shuttingDown = false;
}

/**
 * Persist the marker naming the agents live at shutdown; resolves true when it landed on disk.
 *
 * @param {object} params
 * @param {string[]} params.agentIds - ids of agents running when the signal landed
 * @param {string} [params.signal] - the signal that triggered shutdown (diagnostic)
 * @returns {Promise<boolean>} true when the marker landed on disk
 */
export async function writeHostShutdownMarker({ agentIds = [], signal = null } = {}) {
  // UNION with any unconsumed marker: a boot killed before its orphan sweep leaves the prior marker
  // in place, and overwriting it would demote those agents to ordinary orphans.
  const prior = await readHostShutdownMarker();
  const ids = [...new Set([...(prior?.agentIds || []), ...agentIds.filter(isNonBlankStr)])];
  // Nothing running: leave no marker (and don't overwrite a prior one).
  if (ids.length === 0) return false;
  return atomicWrite(hostShutdownMarkerPath(), { at: new Date().toISOString(), signal, agentIds: ids })
    .then(
      () => { console.log(`🛑 Host shutdown marker written for ${ids.length} live agent(s)`); return true; },
      (err) => { console.error(`❌ Failed to write host-shutdown marker: ${err.message}`); return false; },
    );
}

/**
 * Marker left by the previous process, or null; otherwise `{ at, signal, agentIds }`.
 * `agentIds` is ALWAYS an array of non-empty strings: boot recovery runs first, so a garbled marker
 * must degrade to "no agents interrupted" rather than throw. `allowArray: false` does not reject a
 * bare JSON scalar, hence the `typeof raw === 'object'` check.
 */
export async function readHostShutdownMarker() {
  const raw = await readJSONFile(hostShutdownMarkerPath(), null, { logError: false, allowArray: false });
  if (!raw || typeof raw !== 'object') return null;
  return { ...raw, agentIds: Array.isArray(raw.agentIds) ? raw.agentIds.filter(isNonBlankStr) : [] };
}

/** Non-throwing: a leftover marker is tolerated, since the orphan sweep only looks at agents still `running`. */
export async function clearHostShutdownMarker() {
  await rm(hostShutdownMarkerPath(), { force: true }).catch((err) => {
    console.error(`❌ Failed to clear host-shutdown marker: ${err.message}`);
  });
}
