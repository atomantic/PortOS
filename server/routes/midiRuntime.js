/**
 * MuScriptor (audio → MIDI transcription) runtime installer.
 *
 *   GET /api/midi-runtime/install  → SSE stream of the venv install
 *
 * The MIDI transcription feature (Rounds reference audio + Music Video source
 * track) runs in an opt-in venv at ~/.portos/venv-muscriptor. Rather than dead-
 * ending on a "run this shell command" hint the first time a user clicks
 * Transcribe, this endpoint bootstraps that venv in-app — the same
 * `INSTALL_MUSCRIPTOR=1 bash scripts/setup-image-video.sh` path the README
 * documents, streamed line-by-line — so first use auto-installs like the image
 * and video model runtimes do (see server/routes/music.js and videoGen.js for
 * the sibling installers this mirrors). The client opens RuntimeInstallModal on
 * a 503 MIDI_RUNTIME_MISSING and retries the transcription once this completes.
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { asyncHandler } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { createLineReader } from '../lib/streamLines.js';
import { openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';
import {
  resolveMuscriptorPython,
  isMuscriptorRuntimeReady,
  invalidateMuscriptorPython,
  MUSCRIPTOR_VENV_DEFAULT,
} from '../lib/pythonSetup.js';

const router = Router();

const MUSCRIPTOR_LABEL = 'MuScriptor (MIDI transcription)';
const MUSCRIPTOR_INSTALL_ENV = 'INSTALL_MUSCRIPTOR';

// In-flight singleton — a rapid double-open of the install modal would
// otherwise race two `bash setup-image-video.sh` children against the same
// venv dir. The existsSync gate can't help before the venv is created.
let installInFlight = null;

router.get('/install', asyncHandler(async (req, res) => {
  const { send, safeEnd } = openSseStream(res);
  // Server-console visibility for the multi-GB install (start / heartbeat /
  // outcome) — the SSE stream otherwise surfaces progress only in the browser.
  // `start()` isn't called until spawn, so events before then (already-installed
  // short-circuit) and a pre-spawn disconnect no-op through the logger.
  const installLog = createInstallLogger({ installer: MUSCRIPTOR_LABEL, target: MUSCRIPTOR_VENV_DEFAULT });
  const emit = (ev) => { installLog.onEvent(ev); send(ev); };

  if (installInFlight) {
    send({ type: 'error', message: 'A MuScriptor install is already running. Wait for it to finish or restart PortOS.' });
    return safeEnd();
  }
  installInFlight = true;

  let child = null;
  let finished = false;
  let clientGone = false;
  // Register disconnect handling BEFORE the first await (the readiness probe
  // below spawns python and can take up to 30s on a partial venv). Without it, a
  // client that closes the installer during the probe would be missed and we'd
  // then spawn a multi-GB installer nobody is listening to — uncancellable, and
  // holding the singleton until it finished on its own. `child` is a mutable
  // outer var so this handler kills the process group once it exists.
  req.on('close', () => {
    clientGone = true;
    installLog.cancel();
    if (finished) return;
    if (child) {
      if (!child.killed && child.pid) {
        // Negative pid signals the whole process group — setup-image-video.sh
        // shells out to uv / pip / git, and a plain SIGTERM on bash leaves those
        // running. Guard against ESRCH on an already-dead group.
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { child.kill('SIGTERM'); }
      }
      // Do NOT clear installInFlight here — the SIGTERM'd process group is only
      // signalled, not yet reaped, and a mid-download pip child can take seconds
      // to exit. Releasing the singleton now would let an immediate retry spawn a
      // second install against the same half-torn-down venv. child.on('close')
      // clears it once the child has actually exited (mirrors music.js).
    } else {
      // Bailed before spawning (disconnect during the probe / early return) —
      // no child to reap, so release the singleton now.
      installInFlight = null;
    }
    safeEnd();
  });

  // The venv may already exist (another surface installed it) — short-circuit
  // rather than re-running the multi-GB setup. Drop the cached resolve first so
  // this reflects on-disk truth, not a stale value from before a prior install.
  // Gate on the import, not just the binary: a partial venv (cancelled mid-pip)
  // must NOT short-circuit as "already installed" — it needs the repair run.
  invalidateMuscriptorPython();
  if (await isMuscriptorRuntimeReady()) {
    installInFlight = null;
    send({ type: 'log', message: `MuScriptor already installed at ${resolveMuscriptorPython()}` });
    send({ type: 'complete', message: 'Already installed — nothing to do.' });
    return safeEnd();
  }

  // The client may have closed the installer while the probe ran — the close
  // handler above set the flag but had no child to kill. Don't spawn now.
  if (clientGone) {
    installInFlight = null;
    return safeEnd();
  }

  const scriptPath = join(PATHS.root, 'scripts', 'setup-image-video.sh');
  if (!existsSync(scriptPath)) {
    installInFlight = null;
    send({ type: 'error', message: `Installer script not found at ${scriptPath}` });
    return safeEnd();
  }

  send({ type: 'log', message: `Starting MuScriptor install via ${MUSCRIPTOR_INSTALL_ENV}=1 bash scripts/setup-image-video.sh` });
  installLog.start();
  // `detached: true` puts bash in its own process group so a cancel (client
  // closing the SSE stream) can SIGTERM uv / pip / git children too — otherwise
  // a multi-GB download keeps burning bandwidth after the modal closes.
  child = spawn('bash', [scriptPath], {
    env: safeChildProcessEnv({ [MUSCRIPTOR_INSTALL_ENV]: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  installInFlight = child;

  // `splitRe: /[\r\n]+/` so a bash/pip/tqdm progress bar that redraws with a
  // bare `\r` surfaces each redraw as its own log line; the carry buffer
  // stitches a line split across chunk boundaries (flushed on close).
  const onLine = (line) => {
    const t = line.trimEnd();
    if (t) emit({ type: 'log', message: t });
  };
  const stdoutReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  const stderrReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  child.stdout.on('data', stdoutReader.push);
  child.stderr.on('data', stderrReader.push);
  child.on('error', (err) => {
    finished = true;
    installInFlight = null;
    emit({ type: 'error', message: `Installer failed to spawn: ${err.message}` });
    safeEnd();
  });
  child.on('close', async (code) => {
    stdoutReader.flush();
    stderrReader.flush();
    finished = true;
    installInFlight = null;
    // Drop the cached resolve/ready so this probe (and the next transcription)
    // sees the freshly-created venv, then verify the import rather than trusting
    // the exit code alone — the setup script import-verifies MuScriptor and
    // exits non-zero on failure, but a partial venv shouldn't be reported "ready".
    invalidateMuscriptorPython();
    const ready = await isMuscriptorRuntimeReady();
    if (code === 0 && ready) {
      emit({ type: 'complete', message: `MuScriptor ready: ${resolveMuscriptorPython()}` });
    } else if (code === 0) {
      emit({ type: 'error', message: `Installer exited 0 but MuScriptor can't be imported from ${MUSCRIPTOR_VENV_DEFAULT}. Re-run from a terminal to see what happened.` });
    } else {
      emit({ type: 'error', message: `Installer exited with code ${code}.` });
    }
    safeEnd();
  });
}));

export default router;
