// Realtime (speech-to-speech) Voice runtime: finds a local Sophon-Realtime Mac install and runs the PortOS sidecar
// (scripts/ml/sophon/portos_sophon.py) on demand, one process at a time, stopping it after a quiet period.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { expandHome } from '../../lib/fileUtils.js';
import { scrubHomePath } from '../../lib/homePath.js';
import { PATHS } from '../../lib/paths.js';
import { PORTS } from '../../lib/ports.js';
import { safeChildProcessOptions, withoutServerSecretsEnv } from '../../lib/processEnv.js';

export const SIDECAR_SCRIPT = join(PATHS.root, 'scripts', 'ml', 'sophon', 'portos_sophon.py');
export const REALTIME_SIZES = Object.freeze({ '32B': 'models', '4B': 'models-4b' });
const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 5_000;
const IDLE_STOP_MS = 10 * 60_000;

const realtimeError = (message, status = 409) => new ServerError(message, { status, code: 'VOICE_REALTIME' });

/** Where a Sophon Mac install keeps its interpreter, engine and weights, and whether each part is present. */
export const describeInstall = (realtime = {}) => {
  const home = expandHome(realtime.home || '~/.portos/sophon-mac');
  const size = REALTIME_SIZES[realtime.size] ? realtime.size : '32B';
  const python = join(home, '.venv', 'bin', 'python');
  const app = join(home, 'app');
  const models = join(home, REALTIME_SIZES[size]);
  const parts = {
    python: existsSync(python),
    engine: existsSync(join(app, 'engine.py')) && existsSync(join(app, 'adapt.py')),
    weights: existsSync(join(models, '.complete')),
  };
  return { home, size, python, app, models, parts, installed: Object.values(parts).every(Boolean) };
};

let current = null; // { child, port, token, key, ready: Promise, exited: Promise, idleTimer }
let pendingStop = null;

const trackPendingStop = (proc, { escalate = false } = {}) => {
  const waitExit = new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = escalate
      ? setTimeout(() => { proc.child.kill('SIGKILL'); }, STOP_TIMEOUT_MS)
      : null;
    killTimer?.unref?.();
    proc.exited.then(done, done);
  });
  const stopPromise = waitExit.finally(() => {
    if (pendingStop === stopPromise) pendingStop = null;
  });
  pendingStop = stopPromise;
  return stopPromise;
};

const stopCurrent = (reason = 'stop') => {
  const proc = current;
  current = null;
  if (!proc) return Promise.resolve();
  clearTimeout(proc.idleTimer);
  console.log(`🗣️ voice.realtime.stop reason=${reason}`);
  proc.child.kill('SIGTERM');
  return trackPendingStop(proc, { escalate: true });
};

/**
 * Start (or reuse) the sidecar for this install and resolve its loopback endpoint and bearer token once loaded.
 * @returns {Promise<{ url: string, token: string }>}
 */
export const ensureRealtimeSidecar = async (realtime = {}, { persona = '', launch = spawn } = {}) => {
  const install = describeInstall(realtime);
  if (!install.installed) {
    const missing = Object.entries(install.parts).filter(([, ok]) => !ok).map(([part]) => part).join(', ');
    throw realtimeError(`Realtime voice is not installed at ${scrubHomePath(install.home)} (missing ${missing}).`, 503);
  }
  const key = JSON.stringify([install.home, install.size, persona]);
  while ((current && current.key !== key) || pendingStop) {
    if (current && current.key !== key) await stopCurrent('config-changed');
    else if (pendingStop) await pendingStop;
  }
  if (!current) {
    const token = randomBytes(18).toString('hex');
    const port = PORTS.VOICE_REALTIME;
    // Strip server secrets before spawning third-party Python code, and pass the
    // bearer token and custom persona via child env (cleared after startup) instead of argv.
    const child = launch(
      install.python,
      ['-u', SIDECAR_SCRIPT, '--app', install.app, '--models', install.models,
        '--port', String(port), '--lang', 'en'],
      safeChildProcessOptions({
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...withoutServerSecretsEnv(process.env), PORTOS_REALTIME_TOKEN: token, PORTOS_REALTIME_PERSONA: persona },
      }),
    );
    let resolveExited;
    const exited = new Promise((resolve) => { resolveExited = resolve; });
    const proc = { child, port, token, key, exited, idleTimer: null };
    proc.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (current === proc) current = null;
        child.kill('SIGKILL');
        trackPendingStop(proc);
        reject(realtimeError('Realtime voice did not finish loading.', 503));
      }, START_TIMEOUT_MS);
      timer.unref?.();
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
        if (line.startsWith('{"ready"')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.resume(); // Model diagnostics stay out of the server log.
      child.on('error', (err) => {
        clearTimeout(timer);
        if (current === proc) current = null;
        if (!child.pid) resolveExited();
        reject(realtimeError(`Could not launch realtime voice: ${scrubHomePath(err.message)}`, 503));
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (current === proc) current = null;
        resolveExited();
        reject(realtimeError(`Realtime voice stopped (exit ${code}).`, 503));
      });
    });
    // Prevent an unhandledRejection crash if the sidecar exits while no caller is awaiting startup.
    proc.ready.catch(() => {});
    current = proc;
    console.log(`🗣️ voice.realtime.start size=${install.size} port=${port}`);
  }
  const proc = current;
  await proc.ready;
  clearTimeout(proc.idleTimer);
  return { url: `ws://127.0.0.1:${proc.port}/`, token: proc.token };
};

/** Keep the model loaded between calls, then free its ~26 GB once nobody has called for a while. */
export const scheduleRealtimeIdleStop = (ms = IDLE_STOP_MS) => {
  if (!current) return;
  clearTimeout(current.idleTimer);
  current.idleTimer = setTimeout(() => stopCurrent('idle'), ms);
  current.idleTimer.unref?.();
};

export const stopRealtimeSidecar = () => stopCurrent('shutdown');

export const realtimeStatus = (realtime = {}) => {
  const install = describeInstall(realtime);
  return {
    ...install,
    home: scrubHomePath(install.home),
    python: scrubHomePath(install.python),
    app: scrubHomePath(install.app),
    models: scrubHomePath(install.models),
    running: Boolean(current),
  };
};
