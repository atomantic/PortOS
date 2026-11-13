/**
 * Video Gen — BYOV runtime status and streamed installation.
 *
 * Routes supply the SSE transport callbacks; this service owns runtime
 * validation, single-flight installation, process lifecycle, and post-install
 * readiness checks.
 */

import { existsSync } from 'fs';
import { createInstallLogger } from '../../lib/installLogger.js';
import { createLineReader } from '../../lib/streamLines.js';
import {
  SETUP_IMAGE_VIDEO_SCRIPT,
  spawnSetupScript,
  stopSetupScript,
} from '../../lib/setupScriptRunner.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  BYOV_RUNTIME_INFO,
  invalidateByovLoraCapabilityCache,
  invalidateByovReadyCache,
  invalidateRuntimeFingerprintCache,
  isByovRuntimeCurrent,
  isByovRuntimeInstalled,
  isByovRuntimeReady,
} from './runtimes.js';

// In-flight singleton per runtime. A rapid double-click of the install button
// must not race two setup scripts against the same checkout and venv.
const runtimeInstallInFlight = new Map();

export async function getVideoRuntimeStatus(runtime) {
  const info = BYOV_RUNTIME_INFO[runtime];
  if (!info) {
    throw new ServerError(
      `Unknown runtime: ${runtime}. Expected one of: ${Object.keys(BYOV_RUNTIME_INFO).join(', ')}`,
      { status: 400, code: 'UNKNOWN_BYOV_RUNTIME' },
    );
  }

  const binaryPresent = isByovRuntimeInstalled(info.id);
  // Source-only runtimes execute checkout code during the import probe, so an
  // outdated or dirty checkout must be rejected before anything imports it.
  const current = binaryPresent ? await isByovRuntimeCurrent(info.id) : false;
  const packagesReady = current ? await isByovRuntimeReady(info.id) : false;
  return {
    runtime: info.id,
    label: info.label,
    installed: binaryPresent && packagesReady && current,
    binaryPresent,
    packagesReady,
    current,
    upgradeAvailable: binaryPresent && !current,
    venvPath: info.venvPython,
    repoDir: info.repoDir,
    repoUrl: info.repoUrl,
    installSourceLabel: info.installSourceLabel,
    installEnvVar: info.installEnvVar,
  };
}

/**
 * Stream one runtime installation through caller-owned transport callbacks.
 *
 * @param {object} options
 * @param {string} options.runtime
 * @param {(event: object) => void} options.send
 * @param {() => void} options.safeEnd
 * @param {(handler: () => void) => void} options.onDisconnect
 * @param {() => boolean} options.isResponseEnded
 */
export async function streamVideoRuntimeInstall({
  runtime,
  send,
  safeEnd,
  onDisconnect,
  isResponseEnded,
}) {
  const info = BYOV_RUNTIME_INFO[runtime];
  let child = null;
  let installLog = null;
  let aborted = false;
  let finished = false;
  let installFailure = null;

  // Register before any readiness/revision await. Those probes can take tens
  // of seconds on a damaged venv; closing the modal during one must prevent a
  // multi-gigabyte installer from starting unattended.
  onDisconnect(() => {
    if (isResponseEnded()) return;
    aborted = true;
    installLog?.cancel();
    if (info && runtimeInstallInFlight.get(info.id) === null) {
      runtimeInstallInFlight.delete(info.id);
    }
    stopSetupScript(child);
  });

  if (!info) {
    send({ type: 'error', message: `Unknown runtime: ${runtime}` });
    return safeEnd();
  }

  // Reserve synchronously before any await. The null placeholder is replaced
  // by the child once spawned and released by every early-return path.
  if (runtimeInstallInFlight.has(info.id)) {
    send({ type: 'error', message: `Another ${info.label} install is already running. Wait for it to finish or restart PortOS.` });
    return safeEnd();
  }
  runtimeInstallInFlight.set(info.id, null);

  const alreadyInstalled = isByovRuntimeInstalled(info.id);
  const alreadyCurrent = alreadyInstalled && await isByovRuntimeCurrent(info.id);
  if (aborted) return safeEnd();
  const alreadyReady = alreadyCurrent && await isByovRuntimeReady(info.id);
  if (aborted) return safeEnd();
  if (alreadyInstalled && alreadyReady && alreadyCurrent) {
    runtimeInstallInFlight.delete(info.id);
    send({ type: 'log', message: `${info.label} already installed at ${info.venvPython}` });
    send({ type: 'complete', message: 'Already installed — nothing to do.' });
    return safeEnd();
  }

  // An install can add/remove packages or update a checkout. Invalidate every
  // runtime-derived cache before spawning so later status reads re-probe it.
  invalidateByovReadyCache(info.id);
  invalidateByovLoraCapabilityCache(info.id);
  invalidateRuntimeFingerprintCache(info.id);

  if (!existsSync(SETUP_IMAGE_VIDEO_SCRIPT)) {
    runtimeInstallInFlight.delete(info.id);
    send({ type: 'error', message: `Installer script not found at ${SETUP_IMAGE_VIDEO_SCRIPT}` });
    return safeEnd();
  }

  send({ type: 'log', message: `▸ Starting ${info.label} install via ${info.installEnvVar}=1 bash scripts/setup-image-video.sh` });
  installLog = createInstallLogger({ installer: info.label, target: info.venvPython });
  const emit = (event) => { installLog.onEvent(event); send(event); };
  installLog.start();
  const installEnv = {
    [info.installEnvVar]: '1',
    ...(info.pinEnvVar && info.expectedRevision ? { [info.pinEnvVar]: info.expectedRevision } : {}),
  };

  try {
    child = spawnSetupScript(installEnv);
  } catch (err) {
    finished = true;
    runtimeInstallInFlight.delete(info.id);
    emit({ type: 'error', message: `Installer failed to spawn: ${err.message}` });
    return safeEnd();
  }
  runtimeInstallInFlight.set(info.id, child);

  // Bare carriage returns are progress redraws. Surface each as a log line,
  // while createLineReader still stitches chunks split mid-line.
  const onLine = (line) => {
    const text = line.trimEnd();
    if (text.startsWith(`📦 Syncing ${info.label} wheels from `)) {
      emit({ type: 'stage', stage: 'dependencies', message: text });
      return;
    }
    if (text.startsWith(`📦 Building pinned ${info.label} source `)) {
      emit({ type: 'stage', stage: 'build', message: text });
      return;
    }
    // Retain the installer's actionable summary without interpreting arbitrary
    // dependency output as an error event that would close the stream early.
    if (text.startsWith(`❌ ${info.label} dependency sync failed (exit `)) {
      installFailure = text.slice('❌ '.length);
    }
    if (text) emit({ type: 'log', message: text });
  };
  const stdoutReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  const stderrReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  child.stdout.on('data', stdoutReader.push);
  child.stderr.on('data', stderrReader.push);
  child.on('error', (err) => {
    if (finished) return;
    finished = true;
    runtimeInstallInFlight.delete(info.id);
    emit({ type: 'error', message: `Installer failed to spawn: ${err.message}` });
    safeEnd();
  });
  child.on('close', async (code) => {
    if (finished) return;
    try {
      stdoutReader.flush();
      stderrReader.flush();
      finished = true;
      runtimeInstallInFlight.delete(info.id);
      // Exit 0 is not proof of a usable install: network failures and partial
      // package writes can still leave a binary with a broken import surface.
      const binaryPresent = isByovRuntimeInstalled(info.id);
      const current = binaryPresent && await isByovRuntimeCurrent(info.id);
      const packagesReady = current && await isByovRuntimeReady(info.id);
      if (code === 0 && binaryPresent && packagesReady && current) {
        emit({ type: 'complete', message: `${info.label} ready: ${info.venvPython}` });
      } else if (code === 0 && !binaryPresent) {
        emit({ type: 'error', message: 'Installer exited 0 but the runtime is still missing. Review the log above, then use Repair in this panel.' });
      } else if (code === 0) {
        emit({ type: 'error', message: packagesReady
          ? 'Installer exited 0 but the runtime is still on an outdated revision. Review the source-update log above, then use Repair in this panel.'
          : `Installer exited 0 but the runtime can't import its core packages. Review the package errors above, then use Repair in this panel.` });
      } else {
        emit({ type: 'error', message: installFailure || `Installer exited with code ${code}.` });
      }
      safeEnd();
    } catch (err) {
      console.error(`❌ ${info.label} install completion check failed: ${err.message}`);
      emit({ type: 'error', message: `${info.label} install completion check failed: ${err.message}` });
      safeEnd();
    }
  });
}
