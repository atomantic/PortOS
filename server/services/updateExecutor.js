import { readFile, unlink } from 'fs/promises';
import { createHash } from 'node:crypto';
import { canonicalStringify } from '../lib/objects.js';
import { assertPeerExecutionCapability } from '../lib/maintenanceExclusive.js';
import { basename, join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { NODE_INTERPRETER_ENV_KEY, resolvePinnedNodeInterpreter, withNodeBinOnPath } from '../lib/nodeInterpreterPin.js';
import { spawnDetached, isDetachedRunning } from '../lib/detachedSpawn.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { processAbsent, reconcileReusedLaunch } from '../lib/maintenanceDeferredUpdate.js';
import { isSettledProcessState } from '../lib/processSettledState.js';
import { escapeRegExp } from '../lib/textUtils.js';
import { getCurrentVersion, recordUpdateResult } from './updateChecker.js';
import { isUpdateControlTracked, trackUpdateControl, withUpdateControlLock } from './updateControlActivity.js';

const UPDATE_SH = join(PATHS.root, 'update.sh');
const UPDATE_PS1 = join(PATHS.root, 'update.ps1');

// Workspaces update.sh / update.ps1 know how to clean-reinstall — the env
// passthrough is allowlisted to these so nothing arbitrary reaches the scripts.
const CLEANABLE_WORKSPACES = new Set(['.', 'client', 'server']);
const supersededUpdates = new Set();

function verifyPeerUpdateCapability(peerExecution, digest) {
  return assertPeerExecutionCapability(peerExecution.capability, { action: 'portos.update' }, digest);
}

function buildUpdateChildEnv({ pinnedNode, forceCleanWorkspaces, acknowledgePersistentMindImageBackup, peerOperation, peerTarget }) {
  // For a reconcile (issue #1779), a bare `git pull` left stale node_modules
  // even though HEAD already advanced — so the scripts' commit-diff dependency
  // detection finds nothing to reinstall. Pass the workspaces whose deps are
  // actually stale (per installState's receipt check) so update.sh/update.ps1
  // force a from-scratch reinstall of exactly those, regardless of the diff.
  const cleanList = Array.isArray(forceCleanWorkspaces)
    ? forceCleanWorkspaces.filter(w => CLEANABLE_WORKSPACES.has(w))
    : [];
  // The script's bare `node`/`npm` must be the pinned runtime pm2 will launch:
  // its npm install and native rebuilds target whichever Node runs them.
  // Exporting the pin also tells pm2-daemon-refresh.js to move the daemon onto
  // it when the daemon still runs an older Node.
  const childEnv = withNodeBinOnPath({ ...process.env }, pinnedNode);
  if (pinnedNode) childEnv[NODE_INTERPRETER_ENV_KEY] = pinnedNode;
  // Never inherit peer-only pinning from an operator's ambient environment.
  if (acknowledgePersistentMindImageBackup) childEnv.PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED = '1';
  else delete childEnv.PORTOS_UPDATE_IMAGE_BACKUP_ACKNOWLEDGED;
  delete childEnv.PORTOS_DEFERRED_UPDATE_ID;
  delete childEnv.PORTOS_UPDATE_INTERRUPT;
  delete childEnv.PORTOS_UPDATE_STOP_FIRST;
  delete childEnv.PORTOS_DEFERRED_UPDATE_LAUNCH_ID;
  delete childEnv.PORTOS_PEER_UPDATE_OPERATION_ID;
  delete childEnv.PORTOS_PEER_UPDATE_TARGET_SHA;
  delete childEnv.PORTOS_PEER_UPDATE_EXPECTED_SHA;
  if (peerOperation) {
    childEnv.PORTOS_PEER_UPDATE_OPERATION_ID = peerOperation.operationId;
    childEnv.PORTOS_PEER_UPDATE_TARGET_SHA = peerTarget.targetSha;
    childEnv.PORTOS_PEER_UPDATE_EXPECTED_SHA = peerTarget.headSha;
  }
  if (cleanList.length) {
    childEnv.PORTOS_FORCE_CLEAN_WORKSPACES = cleanList.join(',');
  } else {
    delete childEnv.PORTOS_FORCE_CLEAN_WORKSPACES;
  }
  return childEnv;
}

/**
 * Launch the PortOS update script (git pull to latest).
 *
 * The script is launched via spawnDetached so it leaves this process's tree and
 * SURVIVES pm2's TreeKill. A plain `spawn(..., { detached: true })` does NOT
 * survive: pm2 walks PPID (`ps -e -o pid=,ppid=`), not the process group, so
 * when update.sh reaches its `pm2-stop` step (`pm2 delete ecosystem.config.cjs`)
 * the script itself — still a PPID-child of portos-server — was tree-killed with
 * the server, leaving every app stopped with nothing alive to run the final
 * `pm2 start` (the reconcile/update "shuts down but never comes back" failure).
 * See the rationale in `server/lib/detachedSpawn.js`.
 *
 * Windows escapes the same way for the same reason (pm2 kills there with
 * `taskkill /T`, which walks the identical tree), and CANNOT use a plain
 * `detached: true`: on Windows that flag means DETACHED_PROCESS, which denies
 * the child a console — powershell then exits 0 within ~100ms without running a
 * single line of update.ps1, and this function used to report that as a
 * successful update to the target release (#6169). spawnDetached's Windows
 * supervisor handles that internally, so no option is needed here.
 *
 * The scripts pull the latest code via `git pull --rebase --autostash` and
 * write the actual resulting version to `data/update-complete.json`.
 * The `tag` parameter is used only for logging and the initial API response;
 * the true post-update version is determined by the script from package.json.
 *
 * @param {string} tag - The release tag that triggered the update (for logging)
 * @param {function} emit - Callback (step, status, message) for progress
 * @param {object} [options]
 * @param {string[]} [options.forceCleanWorkspaces] - workspaces to reinstall from scratch
 * @returns {Promise<{started: false, result: object} | {started: true, completion: Promise<object>}>}
 *   Refusal returns its recorded result; spawn failures reject. A successful
 *   launch returns separately from completion, which may outlive this server.
 */
export const launchUpdate = (tag, emit, options = {}) => withUpdateControlLock(() => launchUpdateLocked(tag, emit, options));

async function launchUpdateLocked(tag, report, { forceCleanWorkspaces, peerExecution, acknowledgePersistentMindImageBackup = false,
  automatic = false, acknowledgeInterruption = false,
  expectedRefusalId,
  admission = maintenance, supervisorAbsent = processAbsent, monitorIntervalMs = 5000,
  supervisorSnapshot = async () => (await import('./maintenanceProcessInventory.js')).snapshotMaintenanceProcesses() } = {}) {
  let ticket = null;
  const emit = (...args) => { if (!ticket || !supersededUpdates.has(ticket)) report(...args); };
  const targetVersion = tag.replace(/^v/, '');
  const isWindows = process.platform === 'win32';
  const pinnedNode = resolvePinnedNodeInterpreter();
  const cmd = peerExecution ? (isWindows ? 'powershell' : 'bash') : (pinnedNode || process.execPath);
  const args = peerExecution
    ? (isWindows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UPDATE_PS1] : [UPDATE_SH])
    : [join(PATHS.root, 'scripts', 'deferred-update.mjs'), ...(automatic ? ['--automatic'] : acknowledgeInterruption ? ['--interrupt'] : [])];

  emit('starting', 'running', `Starting update (target: ${tag})...`);

  // The receiver supplies frozen evidence. The environment takes its verified
  // revisions now, while capability ownership must still be current after the process check.
  const peerDigest = peerExecution && createHash('sha256').update(canonicalStringify(peerExecution.evidence)).digest('hex');
  const peerOperation = peerExecution && verifyPeerUpdateCapability(peerExecution, peerDigest);
  const peerTarget = peerExecution?.evidence.target;
  if (peerOperation && (!/^[a-f0-9]{40}$/.test(peerTarget.targetSha) || !/^[a-f0-9]{40}$/.test(peerTarget.headSha)))
    throw new Error('Invalid peer update revision.');
  const childEnv = buildUpdateChildEnv({ pinnedNode, forceCleanWorkspaces, acknowledgePersistentMindImageBackup, peerOperation, peerTarget });

  // spawnDetached launches the script outside this process's tree (POSIX
  // double-fork, Windows supervisor) so it survives the pm2 TreeKill its own
  // `pm2 delete`/`pm2 start` steps trigger. The returned handle is
  // ChildProcess-like (stdout/stderr 'data', 'close', 'error'), streamed by
  // tailing the control dir's log files — so the STEP: progress parsing below
  // works unchanged. The control dir is reused across updates (spawnDetached
  // keeps the files as the post-mortem record of the launch).
  const legacyControlDir = peerOperation
    ? join(PATHS.data, 'peer-execution', peerOperation.operationId)
    : join(PATHS.data, 'update-detached');

  // Refuse to reuse the control dir while a prior update script is still
  // running (survival path: the old script outlives the server restart it
  // triggers, and its supervisor's late `exit` write into a truncated control
  // dir would prematurely close the new handle with the OLD script's status).
  // A still-running script also means a second update is wrong regardless.
  const legacyArgs = isWindows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UPDATE_PS1] : [UPDATE_SH];
  const previousRunning = await isDetachedRunning(legacyControlDir, { executable: cmd, args })
    || (!peerExecution && await isDetachedRunning(legacyControlDir, { executable: isWindows ? 'powershell' : 'bash', args: legacyArgs }));
  const previous = admission.deferredUpdate.operation();
  const waiting = previous?.phase === 'waiting' && !previous.childPid && !previous.holdId;
  const alreadyObserved = previous && isUpdateControlTracked(join(legacyControlDir, previous.id));
  if ((previousRunning && !waiting) || (alreadyObserved && (!waiting || automatic))) {
    const errorMessage = 'A previous update script is still running — wait for it to finish before starting another update';
    await recordUpdateResult({
      version: targetVersion,
      success: false,
      completedAt: new Date().toISOString(),
      log: errorMessage
    }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
    emit('starting', 'error', errorMessage);
    return { started: false, result: { success: false, failedStep: 'starting', errorMessage } };
  }

  if (peerExecution) verifyPeerUpdateCapability(peerExecution, peerDigest);
  if (!peerExecution && expectedRefusalId === undefined) await reconcileReusedLaunch(admission, supervisorSnapshot);
  try { ticket = peerExecution ? null : admission.deferredUpdate.reserveLaunch({ recoverWaiting: true,
    ...(expectedRefusalId !== undefined ? { expectedRefusalId } : {}) }); }
  catch (error) {
    if (error.code !== 'MAINTENANCE_STALE') throw error;
    const errorMessage = 'A previous update is still running — wait for it to finish before starting another update';
    emit('starting', 'error', errorMessage);
    return { started: false, result: { success: false, failedStep: 'starting', errorMessage } };
  }
  if (previous && waiting && alreadyObserved && !automatic) supersededUpdates.add(previous.id);
  if (ticket) childEnv.PORTOS_DEFERRED_UPDATE_LAUNCH_ID = ticket;
  const cancelLaunch = () => admission.deferredUpdate.cancelLaunch(ticket);
  const controlDir = ticket ? join(legacyControlDir, ticket) : legacyControlDir;
  const untrackControl = trackUpdateControl(controlDir);
  let child;
  try { child = await spawnDetached(cmd, args, {
    cwd: PATHS.root,
    env: childEnv,
    controlDir,
    ...(ticket ? { onLaunchTimeout: cancelLaunch } : {}),
    // The default 250ms cadence is calibrated for trainer/render output; this
    // job emits one human-paced `STEP:` line per multi-second stage, so a
    // quarter of the syscalls buys the same perceived progress.
    pollMs: 1000
  }); } catch (error) {
    untrackControl();
    if (ticket) {
      try { cancelLaunch(); }
      catch { scheduleJournalRetry(cancelLaunch); }
    }
    throw error;
  }
  // spawnDetached can report a deferred error on the next tick even when a
  // journal lookup below fails. Always install a listener before that lookup.
  child.on('error', () => {});
  child.once('error', untrackControl);
  child.once('close', untrackControl);
  const observedAt = Date.now();
  const childPid = child.pid;
  if (ticket && Number.isSafeInteger(childPid) && childPid > 0) {
    const bindLaunch = () => admission.deferredUpdate.bindLaunch(ticket, childPid);
    try { bindLaunch(); }
    catch { scheduleJournalRetry(bindLaunch); }
  }

  if (ticket && (!Number.isSafeInteger(child.pid) || child.pid <= 0)) {
    let outcome;
    try {
      if (child.launchTimeoutError) throw child.launchTimeoutError;
      outcome = child.launchTimeoutResult ?? cancelLaunch();
    }
    catch (error) {
      scheduleJournalRetry(cancelLaunch);
      throw Object.assign(new Error(`Update launch status is uncertain: ${error.message}`), { code: 'UPDATE_LAUNCH_UNCERTAIN' });
    }
    if (outcome.state === 'unknown') return { started: false, result: { success: false, uncertain: true,
      failedStep: 'starting', errorMessage: 'Update outcome is unavailable' } };
    if (outcome.state === 'claimed' || outcome.state === 'finished') {
      // The supervisor won the claim before the launcher timed out. The
      // launcher's error is not a completed-update result; observe the claimed
      // journal operation until its own supervisor settles it.
      if (outcome.state === 'finished') {
        const result = await waitForClaimedUpdate(admission, ticket, outcome.result, targetVersion, emit);
        if (!result.success) return { started: false, result };
        return { started: true, completion: Promise.resolve(result), supervisorPid: null, completed: true };
      }
      child.pid = outcome.ownerPid;
      const completion = watchSupervisor({ admission, ticket, child, completion: new Promise(() => {}), emit, targetVersion, observedAt, expectedExecutable: cmd,
        absent: supervisorAbsent, snapshot: supervisorSnapshot, intervalMs: monitorIntervalMs,
        beginFinalization: () => true, untrackControl });
      return { started: true, completion: completion.finally(() => supersededUpdates.delete(ticket)), supervisorPid: outcome.ownerPid };
    }
  }

  let finalizing = false;
  const completion = new Promise((resolve) => {
    let lastStep = 'starting';
    // Whether the script ever reported a step. A run that exits 0 without one
    // never executed the script — the scripts emit `git-pull:running` before
    // touching anything — so it must not be recorded as a completed update.
    let sawStep = false;

    const settleClaimedTicket = async () => {
      if (!ticket) return false;
      if (supersededUpdates.has(ticket)) {
        finalizing = true;
        resolve({ success: false, superseded: true, interrupted: true });
        return true;
      }
      let outcome;
      try { outcome = cancelLaunch(); }
      catch (error) {
        scheduleJournalRetry(cancelLaunch);
        resolve({ success: false, uncertain: true, failedStep: 'starting', errorMessage: `Update launch status is uncertain: ${error.message}` });
        return true;
      }
      if (outcome.state !== 'claimed' && outcome.state !== 'finished') return false;
      if (finalizing) return true;
      finalizing = true;
      try { resolve(await waitForClaimedUpdate(admission, ticket, outcome.state === 'finished' ? outcome.result : null, targetVersion, emit)); }
      catch (error) { resolve({ success: false, uncertain: true, failedStep: 'starting', errorMessage: `Update status is uncertain: ${error.message}` }); }
      return true;
    };

    attachUpdateLineStreams(child, (name, status, message) => {
      // Close the synthetic starting step once script output proves it ran.
      if (!sawStep) {
        sawStep = true;
        reportUpdateOutcome(emit, 'starting', 'done', 'Update script running');
      }
      lastStep = name;
      reportUpdateOutcome(emit, name, status, message);
    });

    child.on('close', async (code, signal) => {
      if (finalizing) return;
      if (await settleClaimedTicket()) return;
      if (finalizing) return;
      finalizing = true;
      // Exit 0 alone is not proof the update ran. A launch that never executed
      // the script exits 0 with no output at all, and stamping the triggering
      // tag onto that is how a Windows install reported "v2.57.0 — Success"
      // while still sitting on the old version (#6169). Both scripts emit
      // `git-pull:running` before they touch anything, so no step at all means
      // no update — the same absent-vs-empty distinction the LLM-merge rule in
      // AGENTS.md draws, applied to progress output.
      const success = code === 0 && sawStep;
      const errorMessage = code === 0
        ? 'Update script exited 0 without reporting any progress — it never ran'
        : `Update failed at step "${lastStep}" (${signal ? `killed by ${signal}` : `exit code ${code}`})`;
      if (success) {
        resolve(await recordCompletedUpdate({ targetVersion, emit }));
        return;
      }
      await recordUpdateResult({
        version: targetVersion,
        success: false,
        completedAt: new Date().toISOString(),
        log: errorMessage
      }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      reportUpdateOutcome(emit, lastStep, 'error', errorMessage);
      resolve({ success: false, failedStep: lastStep, errorMessage });
    });

    child.on('error', async (err) => {
      if (finalizing) return;
      if (await settleClaimedTicket()) return;
      if (finalizing) return;
      finalizing = true;
      await recordUpdateResult({
        version: targetVersion,
        success: false,
        completedAt: new Date().toISOString(),
        log: err.message
      }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      const errorMessage = `Failed to start update: ${err.message}`;
      reportUpdateOutcome(emit, 'starting', 'error', errorMessage);
      resolve({ success: false, failedStep: 'starting', errorMessage });
    });

    // Nothing to unref: spawnDetached's handle is a plain EventEmitter tailing
    // the control dir, and its launcher already unref'd the process it spawned.
  });
  // spawnDetached may return a handle without a PID and report the failed
  // launch on the next tick. Do not hand a nonexistent supervisor to callers.
  if (ticket && (!Number.isSafeInteger(child.pid) || child.pid <= 0)) return { started: false, result: await completion };
  const observed = ticket ? watchSupervisor({ admission, ticket, child, completion, emit, targetVersion, observedAt, expectedExecutable: cmd,
    absent: supervisorAbsent, snapshot: supervisorSnapshot, intervalMs: monitorIntervalMs, beginFinalization: () => {
      if (finalizing) return false;
      finalizing = true;
      return true;
    }, untrackControl }) : completion;
  return { started: true, completion: observed.finally(() => supersededUpdates.delete(ticket)), supervisorPid: child.pid };
}

function attachUpdateLineStreams(child, onStep) {
  for (const name of ['stdout', 'stderr']) {
    const stream = child[name];
    if (!stream) continue;
    // The detached child can still write after the parent's pipe closes.
    stream.on('error', error => { if (error.code !== 'EPIPE') console.error(`⚠️ ${name} stream error: ${error.message}`); });
    let buffer = '';
    stream.on('data', data => {
      buffer += data.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
        buffer = buffer.slice(newlineIdx + 1);
        const match = line.match(/STEP:([^:]+):([^:]+):(.+)/);
        if (!match) continue;
        const [, step, status, message] = match;
        onStep(step, status, message);
      }
    });
  }
}

function isSupervisorProcessGone(observed, observedAt, expectedExecutable) {
  const raw = String(observed?.command ?? '').trim();
  // ps prints only `(node)` (BSD) or `[node]` (procps) while a process's arguments are
  // unreadable, as during a slow exec. That names no other program.
  const command = /^(?:\([^()]*\)|\[[^[\]]*\])$/.test(raw) ? '' : raw;
  const node = /(?:^|[\s"'/\\])node(?:js|\.exe)?(?=$|[\s"'])/i.test(command);
  const expected = join(PATHS.root, 'scripts', 'deferred-update.mjs').replaceAll('\\', '/');
  const escaped = escapeRegExp(expected);
  const exact = new RegExp(`(?:^|[\\s"'=])${escaped}(?=$|[\\s"'])`, process.platform === 'win32' ? 'i' : '')
    .test(command.replaceAll('\\', '/'));
  const first = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const executable = basename((first?.[1] ?? first?.[2] ?? first?.[3] ?? '').replaceAll('\\', '/')).toLowerCase();
  const expectedName = basename(expectedExecutable.replaceAll('\\', '/')).toLowerCase();
  const bothNode = /^node(?:js|\.exe)?$/.test(executable) && /^node(?:js|\.exe)?$/.test(expectedName);
  const differentExecutable = executable && expectedName && executable !== expectedName && !bothNode;
  const explicitOther = command && !exact && (differentExecutable || (/\s/.test(command)
    && (!node || /(?:^|\s)(?:-e|--eval|\S+\.(?:m?js|cjs))(?=$|\s)/i.test(command))));
  return Number.isFinite(observed?.startedAt) && (observed.startedAt > observedAt || explicitOther
    || isSettledProcessState(String(observed.state ?? '')));
}

function watchSupervisor({ admission, ticket, child, completion, emit, targetVersion, observedAt, expectedExecutable, absent, snapshot, intervalMs, beginFinalization, untrackControl }) {
  return new Promise((resolve, reject) => {
    let timer, done = false;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const finishSuperseded = async () => {
      if (!beginFinalization()) return;
      try { await child.stopTailing?.(); }
      catch (error) { console.warn(`⚠️ Could not stop superseded update log tailing: ${error.message}`); }
      untrackControl();
      finish({ success: false, superseded: true, interrupted: true });
    };
    completion.then(finish, error => { if (!done) { done = true; clearTimeout(timer); reject(error); } });
    const poll = async () => {
      if (done) return;
      try {
        if (supersededUpdates.has(ticket)) {
          await finishSuperseded();
          return;
        }
        const pending = admission.deferredUpdate.launch();
        let gone = absent(child.pid);
        if (!gone) {
          const rows = await snapshot().catch(() => []);
          const observed = rows.find(row => row.pid === child.pid);
          gone = isSupervisorProcessGone(observed, observedAt, expectedExecutable);
        }
        if (done) return;
        if (supersededUpdates.has(ticket)) { await finishSuperseded(); return; }
        if (gone) {
          const absentOwner = pid => pid === child.pid ? true : absent(pid);
          const state = admission.deferredUpdate.reconcile({ absent: absentOwner });
          if (admission.deferredUpdate.launch()?.id !== ticket && state.operation?.id !== ticket) {
            if (!beginFinalization()) return;
            try { await child.stopTailing?.(); }
            catch (error) { console.warn(`⚠️ Could not stop update log tailing: ${error.message}`); }
            untrackControl();
            if (state.result?.id === ticket) {
              finish(await waitForClaimedUpdate(admission, ticket, state.result, targetVersion, emit));
            } else {
              const knownUnclaimed = pending?.id === ticket;
              const errorMessage = knownUnclaimed ? 'Update supervisor exited before starting the update' : 'Update outcome is unavailable';
              if (knownUnclaimed) await recordUpdateResult({ version: targetVersion, success: false, completedAt: new Date().toISOString(),
                log: errorMessage }).catch(() => {});
              reportUpdateOutcome(emit, 'starting', 'error', errorMessage);
              finish({ success: false, ...(knownUnclaimed ? {} : { uncertain: true }), failedStep: 'starting', errorMessage });
            }
            return;
          }
        }
      } catch { /* Retry transient process or journal failures. */ }
      if (!done) { timer = setTimeout(poll, intervalMs); timer.unref?.(); }
    };
    timer = setTimeout(poll, intervalMs);
    timer.unref?.();
  });
}

function scheduleJournalRetry(action) {
  const timer = setTimeout(() => {
    try { action(); }
    catch { scheduleJournalRetry(action); }
  }, 5000);
  timer.unref?.();
}

async function recordCompletedUpdate({ targetVersion, fallbackCompletedAt, emit, isSuperseded }) {
  const markerPath = join(PATHS.data, 'update-complete.json');
  let marker;
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')); }
  catch { /* Boot may have consumed the marker already. */ }
  // The installed version is authoritative when the marker is missing (#6169).
  const version = marker?.version || await getCurrentVersion().catch(() => targetVersion);
  const completedAt = marker?.completedAt || (fallbackCompletedAt ?? new Date().toISOString());
  const recorded = await recordUpdateResult({ version, success: true, completedAt, log: '' }).then(
    () => true,
    error => {
      console.error(`❌ Failed to record update result: ${error.message}`);
      return false;
    }
  );
  if (isSuperseded?.()) return { success: false, superseded: true, interrupted: true };
  // Keep the marker for boot-time recovery until the result has been persisted.
  if (recorded) await unlink(markerPath).catch(() => {});
  reportUpdateOutcome(emit, 'complete', 'done', 'Update complete — restarting');
  return { success: true, version };
}

function reportUpdateOutcome(emit, step, status, message) {
  try { emit(step, status, message); }
  catch (error) { console.error(`❌ Could not report update outcome: ${error.message}`); }
}

async function waitForClaimedUpdate(admission, id, existingResult, targetVersion, emit) {
  if (supersededUpdates.has(id)) return { success: false, superseded: true, interrupted: true };
  let result = existingResult;
  while (!result) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (supersededUpdates.has(id)) return { success: false, superseded: true, interrupted: true };
    let state;
    try { state = admission.deferredUpdate.reconcile(); }
    catch (error) {
      if (['MAINTENANCE_STALE', 'MAINTENANCE_UNAVAILABLE'].includes(error.code)) continue;
      throw error;
    }
    if (state.operation?.id === id) continue;
    if (state.result?.id === id) result = state.result;
    else return { success: false, uncertain: true, failedStep: 'starting', errorMessage: 'Update outcome is unavailable' };
  }
  if (result.success) {
    const isSuperseded = () => supersededUpdates.has(id);
    if (isSuperseded()) return { success: false, superseded: true, interrupted: true };
    return recordCompletedUpdate({ targetVersion, fallbackCompletedAt: result.completedAt, emit, isSuperseded });
  }

  let errorCode;
  try {
    const refusal = JSON.parse(await readFile(join(admission.directory, `update-refusal-${id}.json`), 'utf8'));
    if (refusal.id === id && refusal.code === 'UPDATE_INTERRUPTION_REQUIRED') errorCode = refusal.code;
  } catch { /* Older scripts have no typed refusal metadata. */ }
  const errorMessage = errorCode === 'UPDATE_INTERRUPTION_REQUIRED'
    ? 'Updating restarts PortOS and Chrome. Active work may fail or lose unsaved progress. Save your work, then explicitly continue the update.'
    : 'The update did not finish successfully';
  if (supersededUpdates.has(id)) return { success: false, superseded: true, interrupted: true };
  await recordUpdateResult({ version: targetVersion, success: false, completedAt: result.completedAt, log: errorMessage }).catch(() => {});
  if (supersededUpdates.has(id)) return { success: false, superseded: true, interrupted: true };
  reportUpdateOutcome(emit, 'starting', 'error', errorMessage);
  return { success: false, failedStep: 'starting', errorMessage, ...(errorCode ? { errorCode } : {}) };
}

/**
 * Compatibility adapter for callers awaiting the complete update result.
 * onLaunched fires once after a successful spawn, before awaiting completion;
 * it never fires for a refusal or a rejected spawn.
 */
export async function executeUpdate(tag, emit, { onLaunched, ...options } = {}) {
  const launch = await launchUpdate(tag, emit, options);
  if (!launch.started) return launch.result;
  onLaunched?.();
  return launch.completion;
}
