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
import { runtimeUpdateEvents } from './runtimeUpdateEvents.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { processAbsent } from '../lib/maintenanceDeferredUpdate.js';
import { spawnHarnessActionSupervisor } from './harnessActionSupervisor.js';
import { isSupervisorOnly } from './harnessProcessGroup.js';
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
const CAN_SUPERVISE = process.platform === 'darwin' || process.platform === 'linux';

async function waitForGroup(pid, onWaiting) {
  if (!pid) return;
  let notified = false;
  while (!processAbsent(-pid)) {
    if (!notified) { notified = true; onWaiting(); }
    await new Promise(resolve => { const timer = setTimeout(resolve, 500); timer.unref?.(); });
  }
}

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
export async function streamHarnessAction(req, res, { runtime: runtimeId, action = 'install', requireIdle = false,
  expectedVersion = null, reviewed = null, preflightTimeoutMs = 15_000 }) {
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
  // An exact PATH executable is internal review evidence and may include the
  // account name. Do not echo that path through spawn error messages.
  const startError = (err) => reviewed
    ? (/^[A-Z0-9_]+$/.test(err?.code || '') ? err.code : 'The reviewed updater could not be started.')
    : err.message;
  let child = null;
  let finished = false;
  let clientGone = false;
  let supervisorExited = false;
  let reservation = null;
  let owner = null;
  let overlapDetected = false;
  let cancelPending = null;
  const boundedRead = promise => new Promise(resolve => {
    let active = true;
    const done = value => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      cancelPending = null;
      resolve(value);
    };
    const timer = setTimeout(() => done(null), preflightTimeoutMs);
    timer.unref?.();
    cancelPending = () => done(null);
    promise.then(done, () => done(null));
    if (clientGone) done(null);
  });
  const releaseOwner = async pid => {
    if (!owner) return true;
    let result;
    try {
      result = maintenance.harnessActions.finish(owner.id, pid || null);
    } catch (err) {
      console.error(`❌ Harness action settlement needs recovery: ${err.message}`);
      return false;
    }
    overlapDetected ||= result.overlap === true;
    owner = null;
    if (result.held) void import('./harnessActionRecovery.js').then(({ checkHarnessActionRecovery }) => checkHarnessActionRecovery())
      .catch(err => console.error(`❌ Harness update could not wake deferred work: ${err.message}`));
    return true;
  };
  const releaseOrRetry = async pid => {
    const released = await releaseOwner(pid);
    if (!released) {
      const retry = () => {
        const timer = setTimeout(() => {
          void releaseOwner(pid).then(done => {
            if (!done) retry();
            else {
              if (actionInFlight === child || actionInFlight === reservation) actionInFlight = null;
              runtimeUpdateEvents.emit('changed');
            }
          });
        }, 5000);
        timer.unref?.();
      };
      retry();
    }
    return released;
  };
  const holdIsIdle = view => {
    try {
      const current = maintenance.harnessActions.operation();
      return current?.id === owner?.id && current.invalidated !== true && view.state !== 'unavailable' && view.hold?.id === owner?.holdId
        && view.hold?.revision === owner?.holdRevision && Array.isArray(view.blockers)
        && view.blockers.length === 1 && view.blockers[0].kind === 'harness-action';
    } catch { return false; }
  };

  // Register before the availability probe. If the modal closes while the probe
  // is resolving, do not start work nobody can observe.
  onClientDisconnect(req, res, () => {
    clientGone = true;
    cancelPending?.();
    installLog.cancel();
    if (finished) return;
    if (child && !supervisorExited && child.exitCode == null && child.signalCode == null) stopRuntimeInstaller(child);
    safeEnd();
  });

  // Un-cached: the user may have just installed (or removed) this CLI in a
  // terminal, and a stale answer would run redundant or impossible work.
  const status = await getProviderRuntimeStatus(row.id, { fresh: true });
  if (clientGone) return safeEnd();
  if (expectedVersion && status.version !== expectedVersion) {
    send({ type: 'error', message: 'The installed harness version changed. Refresh the update card before retrying.' });
    runtimeUpdateEvents.emit('changed');
    return safeEnd();
  }
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
  const protectWork = CAN_SUPERVISE && action === 'update';
  if (requireIdle && !CAN_SUPERVISE) {
    actionInFlight = null;
    send({ type: 'error', message: 'Protected inline harness updates are unavailable on this platform.' });
    return safeEnd();
  }
  if (CAN_SUPERVISE) {
    try { owner = maintenance.harnessActions.reserve({ runtime: row.id, action, exclusive: protectWork }); }
    catch (err) {
      if (actionInFlight === reservation) actionInFlight = null;
      send({ type: 'error', message: err?.code === 'MAINTENANCE_HELD'
        ? 'PortOS work or another maintenance action is active. Wait for it to finish before retrying.'
        : 'Maintenance state is unavailable or changed. Review maintenance status and recovery before retrying.' });
      return safeEnd();
    }
  }
  if (protectWork) {
    send({ type: 'stage', stage: 'preflight', message: 'Checking known PortOS work before updating. New PortOS work is held during the update.' });
    const preflight = await boundedRead(Promise.all([
      import('./updatePreflight.js').then(({ countActiveCosAgents }) => countActiveCosAgents()).catch(() => null),
      import('./cosState.js').then(({ readAgentsStateForSafetyCheck }) => readAgentsStateForSafetyCheck()).catch(() => null),
      import('./cosAgentLifecycle.js').then(module => module.isLiveAgentRecord).catch(() => null),
      import('./cosRunnerClient.js').then(({ getActiveAgentsFromRunner }) => getActiveAgentsFromRunner()).catch(() => null),
    ]));
    const [count, records, isLiveAgentRecord, runner] = preflight || [];
    const view = maintenance.status();
    const trusted = records?.trusted === true && records.agents && typeof records.agents === 'object' && !Array.isArray(records.agents)
      && typeof isLiveAgentRecord === 'function' && Number.isSafeInteger(count) && count >= 0 && Array.isArray(runner)
      && holdIsIdle(view);
    const liveRecord = trusted && Object.values(records.agents).some(agent => !agent || isLiveAgentRecord(agent));
    const pausedRecord = trusted && Object.values(records.agents).some(agent => agent?.status === 'paused');
    const busy = count > 0 || runner?.length > 0 || liveRecord;
    if (clientGone || !trusted || busy) {
      const released = await releaseOrRetry(null);
      if (actionInFlight === reservation) actionInFlight = null;
      if (!clientGone) send({ type: 'error', message: !released
        ? 'The harness action could not release its maintenance hold. Review maintenance status before continuing.'
        : !preflight ? 'Checking PortOS work timed out. Try again when its status is available.'
          : !Array.isArray(runner) ? 'The CoS runner could not be checked. Restore the runner before retrying; it may still have active agents.'
          : !trusted
        ? 'Could not check active PortOS work. Try again when its status is available.'
        : pausedRecord ? 'Paused agents still count as work. Resume and finish them before updating a harness.'
          : 'PortOS work is active or starting. Wait for it to finish before updating a harness.' });
      return safeEnd();
    }
    const proof = reviewed ? await boundedRead(Promise.all([
      import('./harnessUpdateReference.js').then(({ matchesHarnessUpdateTicket }) => matchesHarnessUpdateTicket(row, reviewed)).catch(() => false),
      import('./runtimeUpdateReview.js').then(({ getRuntimeUpdateReviewSnapshot }) => getRuntimeUpdateReviewSnapshot()).catch(() => null),
    ])) : [true, null];
    const [matches, current] = proof || [];
    const currentRow = current?.items?.find(item => item.id === `harness:${row.id}` && !item.unverified);
    const finalView = maintenance.status();
    if (clientGone || !matches || (reviewed && (!currentRow?.harnessUpdate?.updatable
      || currentRow.harnessUpdate.installedVersion !== expectedVersion
      || currentRow.harnessUpdate.candidateVersion !== reviewed.candidate)) || !holdIsIdle(finalView)) {
      const released = await releaseOrRetry(null);
      if (actionInFlight === reservation) actionInFlight = null;
      if (!clientGone) send({ type: 'error', message: released
        ? !proof && reviewed ? 'The harness review could not be checked in time. Refresh the update card before retrying.'
          : 'The harness review, executable, or active work changed. Refresh the update card before retrying.'
        : 'The harness action could not release its maintenance hold. Review maintenance status before continuing.' });
      return safeEnd();
    }
  }
  if (clientGone) {
    await releaseOrRetry(null);
    if (actionInFlight === reservation) actionInFlight = null;
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
    child = CAN_SUPERVISE
      ? spawnHarnessActionSupervisor({ ownerId: owner.id, runtime: row.id, action, ...(reviewed ? { reviewed } : {}) })
      : spawnRuntimeInstaller(row.id, { action });
  } catch (err) {
    await releaseOrRetry(null);
    finished = true;
    if (actionInFlight === reservation) actionInFlight = null;
    emit({ type: 'error', message: `${status.label} ${copy.noun} failed to start: ${startError(err)}` });
    return safeEnd();
  }
  actionInFlight = child;
  child.once('exit', () => { supervisorExited = true; });

  if (CAN_SUPERVISE) {
    let readySeen = false;
    let draining = false;
    let workWatch = null;
    child.once('close', () => { if (workWatch) clearInterval(workWatch); });
    const refuse = () => {
      if (!supervisorExited && child.exitCode == null && child.signalCode == null) stopRuntimeInstaller(child);
      if (!clientGone && !finished) {
        finished = true;
        emit({ type: 'error', message: 'The harness review or active work changed before launch. Refresh the update card before retrying.' });
        safeEnd();
      }
    };
    child.on('message', message => {
      void (async () => {
        if (message?.type === 'harness-action-draining' && message.ownerId === owner?.id && readySeen && !draining) {
          draining = true;
          let notified = false;
          while (!clientGone && !finished && !supervisorExited && child.connected && actionInFlight === child) {
            const alone = await isSupervisorOnly(child.pid);
            if (alone === true) {
              if (!clientGone && !finished && !supervisorExited && child.connected && actionInFlight === child)
                child.send({ type: 'harness-action-finish', ownerId: owner.id }, error => { if (error) refuse(); });
              return;
            }
            if (!notified) {
              notified = true;
              send({ type: 'log', message: alone === null
                ? 'Process inspection is unavailable. Cancel to terminate the supervised updater group, or wait for inspection to recover.'
                : 'Waiting for updater processes to stop. Cancel to terminate the supervised group.' });
            }
            await new Promise(resolve => { const timer = setTimeout(resolve, 1000); timer.unref?.(); });
          }
          return;
        }
        if (readySeen || message?.type !== 'harness-action-ready' || message.ownerId !== owner?.id) return refuse();
        readySeen = true;
        if (reviewed) {
          const [matches, current] = await Promise.all([
            import('./harnessUpdateReference.js').then(({ matchesHarnessUpdateTicket }) => matchesHarnessUpdateTicket(row, reviewed)).catch(() => false),
            import('./runtimeUpdateReview.js').then(({ getRuntimeUpdateReviewSnapshot }) => getRuntimeUpdateReviewSnapshot()).catch(() => null),
          ]);
          const item = current?.items?.find(entry => entry.id === `harness:${row.id}` && !entry.unverified);
          if (!matches || !item?.harnessUpdate?.updatable || item.harnessUpdate.installedVersion !== expectedVersion
            || item.harnessUpdate.candidateVersion !== reviewed.candidate) return refuse();
        }
        if (clientGone || finished || actionInFlight !== child || !owner || !child.connected
          || (protectWork && !holdIsIdle(maintenance.status()))) return refuse();
        if (protectWork) {
          workWatch = setInterval(() => {
            if (clientGone || finished || supervisorExited || !owner) return;
            let current;
            try { current = maintenance.harnessActions.operation(); } catch { current = null; }
            if (current?.id === owner.id && !current.invalidated) return;
            overlapDetected ||= current?.overlap === true;
            if (child.exitCode == null && child.signalCode == null) stopRuntimeInstaller(child);
            finished = true;
            emit({ type: 'error', message: current?.overlap
              ? 'PortOS recovered existing work during the update. The updater is stopping; check that work before retrying.'
              : current?.invalidated ? 'PortOS recovered existing work before the updater could start. Wait for that work before retrying.'
                : 'Maintenance state became unavailable or changed. The updater is stopping; review maintenance status before retrying.' });
            safeEnd();
          }, 500);
          workWatch.unref?.();
        }
        child.send({ type: 'harness-action-go', ownerId: owner.id }, error => { if (error) refuse(); });
      })().catch(refuse);
    });
  }

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
    emit({ type: 'error', message: `${status.label} ${copy.noun} failed to start: ${startError(err)}` });
    safeEnd();
  });
  child.on('close', async (code) => {
    supervisorExited = true;
    let removedHarness = null;
    try {
      stdoutReader.flush();
      stderrReader.flush();
      if (CAN_SUPERVISE) await waitForGroup(child.pid, () => {
        if (!clientGone && !finished) send({ type: 'log', message: 'Waiting for the updater processes to finish before releasing PortOS work.' });
      });
      const released = await releaseOrRetry(child.pid);
      if (!released) {
        if (!clientGone && !finished) emit({ type: 'error', message: 'The harness action needs maintenance recovery before new work can resume.' });
        finished = true;
        return safeEnd();
      }
      if (actionInFlight === child) actionInFlight = null;
      if (finished || clientGone) return;
      if (overlapDetected) {
        finished = true;
        emit({ type: 'error', message: 'PortOS recovered existing work during the update. Check that work before retrying.' });
        return safeEnd();
      }
      finished = true;
      // The post-action PATH check is deliberately stronger than the exit code.
      // A successful write whose bin directory is absent from PM2's PATH would
      // otherwise recreate the same opaque agent-start failure — and for a
      // removal, "npm said ok" is not the same as "PortOS can no longer run it".
      //
      // `fresh` is load-bearing: the pre-action probe cached this runtime's
      // availability seconds ago, and re-reading it would report the state the
      // action just changed.
      const after = await getProviderRuntimeStatus(row.id, { fresh: true });
      if (action === 'uninstall' && code === 0 && after?.probeState === 'missing') removedHarness = row.id;
      emit(terminalFrame({ action, code, status: after, copy, command: row.command, before: status.version }));
      safeEnd();
    } catch (err) {
      // Child-process completion runs outside Express's request lifecycle.
      console.error(`❌ ${status.label} ${action} completion check failed: ${err.message}`);
      emit({ type: 'error', message: `${status.label} ${action} completion check failed: ${err.message}` });
      safeEnd();
    } finally {
      runtimeUpdateEvents.emit('changed', { removedHarness });
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
    ? { type: 'complete', message: `${status.label} updater finished; PortOS still observes version ${before}.` }
    : { type: 'complete', message: `${status.label} updated: ${before} → ${status.version}.` };
}
