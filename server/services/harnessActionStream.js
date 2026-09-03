/**
 * The SSE runner behind every harness lifecycle action — install, update,
 * remove.
 *
 * Extracted from `routes/providers.js`, which owned the install stream inline,
 * so the Harnesses page can drive update and remove through the SAME single
 * child, single-flight guard, and disconnect-cancels contract. Two copies of
 * that loop would mean two independent guards, and npm's global prefix plus the
 * vendor install scripts all write ONE bin directory — an update racing an
 * install there is exactly the corruption the guard exists to prevent.
 *
 * Installing, updating, or removing a global CLI mutates host state, so every
 * caller is a POST even though the response is SSE-encoded, and the browser
 * reads it with fetch rather than EventSource (which auto-reconnects and would
 * relaunch non-idempotent work on a dropped stream).
 *
 * The request names a runtime *id* and an *action*, both table lookups. The
 * command, package and URL come from `providerRuntimeInstaller.js`'s fixed
 * table, so no request input ever reaches a shell word.
 */

import { createLineReader } from '../lib/streamLines.js';
import { onClientDisconnect, openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  buildRuntimeActionCommand,
  describeRuntimeInstall,
  getProviderRuntime,
  getProviderRuntimeStatus,
  RUNTIME_ACTIONS,
  spawnRuntimeInstaller,
  stopRuntimeInstaller,
} from './providerRuntimeInstaller.js';

/**
 * One global CLI action at a time — npm's global prefix and the vendor install
 * scripts all write the same bin directory. A lightweight re-entrancy guard for
 * a double-click or a second browser tab, shared by every action so an update
 * cannot start while an install is mid-write. The child stays owned by the
 * request so a client disconnect can terminate it.
 */
let actionInFlight = null;

/** Test-only: clear a guard left set by an aborted run. */
export function __resetHarnessActionGuard() {
  actionInFlight = null;
}

/**
 * Per-action copy. `skipWhenInstalled` carries both the short-circuit message
 * AND, by its absence, the "this action needs the harness present" rule — the
 * two are the same fact stated once: an action that has nothing to do when the
 * CLI is there is exactly the one that has something to do when it isn't.
 *
 * Install is the only action with that short-circuit. Update deliberately has
 * none: "you are on the latest" is the vendor updater's answer to give, not
 * ours to guess from a registry read that may be stale or unavailable.
 *
 * Keyed by the same strings as `RUNTIME_ACTIONS`; `providerRuntimeInstaller.test.js`
 * pins the two together, because a fourth action would otherwise reach
 * `ACTION_COPY[action]` as `undefined` and crash mid-stream.
 */
export const HARNESS_ACTION_COPY = Object.freeze({
  install: { verb: 'Installing', noun: 'installer', skipWhenInstalled: 'Already installed — nothing to do.' },
  update: { verb: 'Updating', noun: 'updater', skipWhenInstalled: null },
  uninstall: { verb: 'Removing', noun: 'uninstaller', skipWhenInstalled: null },
});

/**
 * Run one harness action, streaming the child's output to the browser as SSE.
 *
 * Resolves once the stream has ended. Throws only BEFORE the headers are
 * flushed (unknown id, unsupported action) — after that point every failure is
 * reported as a terminal SSE frame, because the error middleware can no longer
 * send a JSON body to this response.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{runtime: unknown, action?: string}} params
 */
export async function streamHarnessAction(req, res, { runtime: runtimeId, action = 'install' }) {
  if (!RUNTIME_ACTIONS.includes(action)) {
    throw new ServerError('Unknown harness action', { status: 400, code: 'UNKNOWN_HARNESS_ACTION', context: { action: String(action || '') } });
  }
  // Table lookups only (no I/O), so a bad request is a plain 400 instead of a
  // stream that only says "no" once the modal is up. The real probe waits until
  // the disconnect handler is registered below.
  const row = getProviderRuntime(runtimeId);
  if (!row) {
    throw new ServerError('Unknown provider runtime', { status: 400, code: 'UNKNOWN_RUNTIME', context: { runtime: String(runtimeId || '') } });
  }
  if (!buildRuntimeActionCommand(row.id, action)) {
    throw new ServerError(
      `PortOS cannot ${action} ${row.label} — it was not installed from a package manager PortOS drives. Follow the vendor instructions instead.`,
      { status: 400, code: 'UNSUPPORTED_HARNESS_ACTION', context: { runtime: row.id, action } },
    );
  }

  const copy = HARNESS_ACTION_COPY[action];
  const { send, safeEnd } = openSseStream(res);
  // The ledger line names the ACTION, not just the harness — three lanes share
  // this logger, and a bare label would file every removal as an install.
  const installLog = createInstallLogger({
    installer: action === 'install' ? row.label : `${row.label} ${action}`,
    target: `${row.command} on PortOS's PATH`,
  });
  const emit = (event) => { installLog.onEvent(event); send(event); };
  let child = null;
  let finished = false;
  let clientGone = false;
  let reservation = null;

  // Register before the availability probe. If the modal closes while the probe
  // is resolving, do not start work nobody can observe.
  onClientDisconnect(req, res, () => {
    clientGone = true;
    installLog.cancel();
    if (finished) return;
    if (child) stopRuntimeInstaller(child);
    if (reservation && actionInFlight === reservation) actionInFlight = null;
    safeEnd();
  });

  // Un-cached: the user may have just installed (or removed) this CLI in a
  // terminal, and a stale answer would run redundant or impossible work.
  const status = await getProviderRuntimeStatus(row.id, { fresh: true });
  if (clientGone) return safeEnd();
  if (status.installed && copy.skipWhenInstalled) {
    send({ type: 'log', message: `${status.label} is already available to PortOS.` });
    send({ type: 'complete', message: copy.skipWhenInstalled });
    return safeEnd();
  }
  if (!status.installed && !copy.skipWhenInstalled) {
    send({ type: 'error', message: `${status.label} is not installed on this host, so there is nothing to ${action}.` });
    return safeEnd();
  }
  // `installable` gates the tool an install/uninstall shells THROUGH (npm,
  // curl). A vendor self-updater runs the harness's own binary, which the
  // installed check above already proved runnable.
  const needsHostTool = action !== 'update' || !row.selfUpdate;
  if (needsHostTool && !status.installable) {
    send({ type: 'error', message: status.blockedReason || `PortOS cannot ${action} ${status.label} on this host.` });
    return safeEnd();
  }
  if (actionInFlight) {
    send({ type: 'error', message: 'Another harness install is already running. Wait for it to finish or restart PortOS.' });
    return safeEnd();
  }

  // Reserve synchronously before spawning so two requests that finish their
  // status probe together cannot launch competing writes into the same bin
  // directory.
  reservation = {};
  actionInFlight = reservation;
  if (clientGone) {
    actionInFlight = null;
    return safeEnd();
  }

  send({ type: 'stage', stage: action, message: `${copy.verb} ${status.label}.` });
  emit({ type: 'log', message: `Running ${describeRuntimeInstall(row.id, action)}.` });
  installLog.start();
  // `spawn` can throw synchronously (a rejected argv shape, an OS-level spawn
  // refusal). Two things must happen here that letting it bubble would not do:
  // release the reservation — or every later action answers "another install is
  // already running" until PortOS restarts — and report the failure as a
  // terminal SSE frame, since the headers are already flushed and the error
  // middleware can no longer send JSON to this response.
  try {
    child = spawnRuntimeInstaller(row.id, { action });
  } catch (err) {
    finished = true;
    if (actionInFlight === reservation) actionInFlight = null;
    emit({ type: 'error', message: `${status.label} ${copy.noun} failed to start: ${err.message}` });
    return safeEnd();
  }
  actionInFlight = child;

  const onLine = (line) => {
    const text = line.trimEnd();
    if (text) emit({ type: 'log', message: text });
  };
  // npm runs with `--no-progress`, which suppresses its usual redraws. Keep the
  // default newline-only reader as a defensive second layer: a lifecycle child
  // (or a vendor script's own progress bar) that still writes bare carriage
  // returns cannot turn every redraw into a browser log frame and a full modal
  // re-render.
  const stdoutReader = createLineReader(onLine);
  const stderrReader = createLineReader(onLine);
  child.stdout.on('data', stdoutReader.push);
  child.stderr.on('data', stderrReader.push);
  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    if (actionInFlight === child) actionInFlight = null;
    emit({ type: 'error', message: `${status.label} ${copy.noun} failed to start: ${err.message}` });
    safeEnd();
  });
  child.on('close', async (code) => {
    if (finished) return;
    try {
      stdoutReader.flush();
      stderrReader.flush();
      finished = true;
      if (actionInFlight === child) actionInFlight = null;
      // The post-action PATH check is deliberately stronger than the exit code.
      // A successful write whose bin directory is absent from PM2's PATH would
      // otherwise recreate the same opaque agent-start failure — and for a
      // removal, "npm said ok" is not the same as "PortOS can no longer run it".
      //
      // `fresh` is load-bearing: the pre-action probe cached this runtime's
      // availability seconds ago, and re-reading it would report the state the
      // action just changed.
      const after = await getProviderRuntimeStatus(row.id, { fresh: true });
      emit(terminalFrame({ action, code, status: after, copy, command: row.command, before: status.version }));
      safeEnd();
    } catch (err) {
      // Child-process completion runs outside Express's request lifecycle.
      console.error(`❌ ${status.label} ${action} completion check failed: ${err.message}`);
      emit({ type: 'error', message: `${status.label} ${action} completion check failed: ${err.message}` });
      safeEnd();
    }
  });
}

/**
 * The one terminal SSE frame an action ends on, decided from the exit code AND
 * the re-probed availability.
 */
function terminalFrame({ action, code, status, copy, command, before }) {
  if (code !== 0) {
    return { type: 'error', message: `${status.label} ${copy.noun} exited with code ${code}.` };
  }
  if (action === 'uninstall') {
    return status.installed
      ? { type: 'error', message: `The uninstall finished, but PortOS can still run \`${command}\`. Another copy is on this machine's PATH — one installed by Homebrew or a vendor script, which PortOS did not write and will not delete.` }
      : { type: 'complete', message: `${status.label} has been removed. Providers that used it will show as needing setup.` };
  }
  if (!status.installed) {
    return { type: 'error', message: `The ${copy.noun} finished, but PortOS still cannot run \`${command}\`. npm wrote it to a bin directory that is not on this machine's PATH — run \`npm prefix -g\` in a terminal, add that directory (plus \`/bin\` off Windows) to your PATH, then restart PortOS.` };
  }
  const version = status.version ? ` (${status.version})` : '';
  if (action !== 'update') {
    return { type: 'complete', message: `${status.label} is installed and available to PortOS${version}.` };
  }
  // Report what the version actually DID, never "up to date" from an exit code
  // alone. A vendor updater that exits 0 without touching the copy on PATH would
  // otherwise claim currency in the modal while the row behind it still shows
  // the Update-available badge against the published version — two contradictory
  // claims on one screen. A version we could not read on either side says so.
  if (!status.version || !before) {
    return { type: 'complete', message: `${status.label} updater finished. PortOS could not read a version to compare.` };
  }
  return status.version === before
    ? { type: 'complete', message: `${status.label} updater finished and left it on ${before} — that is the newest ${command} can reach itself. If a newer release exists, install it the way this copy was installed.` }
    : { type: 'complete', message: `${status.label} updated: ${before} → ${status.version}.` };
}
