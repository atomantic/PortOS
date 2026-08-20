/**
 * llama-server process manager
 *
 * Provides lifecycle management (status probe, start, stop, recent logs)
 * for a local `llama-server` instance running speculative decoding (e.g. DFlash 2)
 * managed as an optional PM2 process (`portos-llama-server`).
 */

import { stat } from 'fs/promises';
import { spawn } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { expandHome, sleep } from '../lib/fileUtils.js';
import { resolveSpecModelPath } from './specDecodeModels.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { isPortInUse } from '../lib/platform.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { execPm2, getAppStatusStrict, clearJlistCache } from './pm2.js';

export const LLAMA_APP = 'portos-llama-server';

const MAX_LOG_LINES = 100;
const PROBE_TIMEOUT_MS = 1500;
const STARTUP_WAIT_TIMEOUT_MS = 4000;

let currentConfig = null;
let recentLogs = [];
let lastExitError = null;

function appendLog(line) {
  if (!line) return;
  const text = String(line).trimEnd();
  if (!text) return;
  recentLogs.push(`[${new Date().toISOString()}] ${text}`);
  if (recentLogs.length > MAX_LOG_LINES) {
    recentLogs = recentLogs.slice(-MAX_LOG_LINES);
  }
}

/**
 * Probes whether an OpenAI-compatible endpoint responds at the given host/port.
 * Shares one implementation with the readiness checklist.
 */
const probeEndpoint = async (endpoint) =>
  (await probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS })).reachable;

/**
 * Resolves the `llama-server` executable on the child-process PATH.
 *
 * Deliberately a filesystem probe only — `findCommandOnPath` already requires a
 * regular file carrying the execute bit, which is all "is it installed?" means.
 * Do NOT re-add a `commandExists`-style `llama-server --version` probe on top.
 *
 * @returns {string|null} absolute path, or null when it is not on PATH
 */
function resolveLlamaServerBinary() {
  return findCommandOnPath('llama-server');
}

/**
 * Fails the start request when a GGUF the launch line names is not on disk.
 */
async function assertModelFileExists(label, modelPath) {
  const stats = await stat(resolveSpecModelPath(modelPath)).catch(() => null);
  if (stats?.isFile()) return;
  throw new ServerError(
    `${label} was not found at \`${modelPath}\`. Use the Download button next to this preset in the Speculative Decoding card to fetch it, or point this field at a file you already have.`,
    { status: 400, code: 'LLAMA_MODEL_FILE_MISSING' }
  );
}

/**
 * Reconstructs the launch config from PM2 process args if PortOS restarted
 * while the PM2 process remained online.
 */
function parseConfigFromArgs(args) {
  if (!args) return null;
  const list = Array.isArray(args) ? args : String(args).split(' ');
  const getArg = (flag) => {
    const idx = list.indexOf(flag);
    return idx !== -1 && idx + 1 < list.length ? list[idx + 1] : null;
  };

  const model = getArg('-m') || getArg('--model');
  if (!model) return null;

  const draftModel = getArg('--model-draft') || getArg('--spec-draft-model') || getArg('-md');
  const specType = getArg('--spec-type') || 'draft-dflash';
  const port = getArg('--port') ? Number(getArg('--port')) : PORTS.LLAMA_SERVER;
  const host = getArg('--host') || '127.0.0.1';
  const ctxSize = getArg('--ctx-size') ? Number(getArg('--ctx-size')) : 32768;
  const nGpuLayers = getArg('-ngl') !== null ? Number(getArg('-ngl')) : 99;
  const alias = getArg('--alias') || 'dflash';

  return {
    model,
    draftModel,
    specType,
    port,
    host,
    ctxSize,
    nGpuLayers,
    alias,
  };
}

/**
 * Returns current status of llama-server (binary availability, running state, config, logs).
 */
export async function getLlamaServerStatus() {
  const binaryPath = resolveLlamaServerBinary();
  const installed = Boolean(binaryPath);

  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  const isReadFailed = pm2Status === null;
  const isManagedActive = Boolean(pm2Status && pm2Status.status === 'online');

  if (!currentConfig && isManagedActive && pm2Status?.args) {
    currentConfig = parseConfigFromArgs(pm2Status.args);
  }

  const host = currentConfig?.host || '127.0.0.1';
  const port = currentConfig?.port ?? PORTS.LLAMA_SERVER;
  const endpoint = `http://${host}:${port}/v1`;

  const reachable = await probeEndpoint(endpoint);

  let logs = [...recentLogs];
  if (isManagedActive || (pm2Status && pm2Status.status !== 'not_found')) {
    try {
      const pm2LogsResult = await execPm2(['logs', LLAMA_APP, '--nostream', '--lines', String(MAX_LOG_LINES)]);
      const combined = (pm2LogsResult.stdout || '') + '\n' + (pm2LogsResult.stderr || '');
      const parsedLines = combined.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      if (parsedLines.length > 0) {
        const seen = new Set(logs);
        for (const line of parsedLines) {
          if (!seen.has(line)) {
            logs.push(line);
            seen.add(line);
          }
        }
        if (logs.length > MAX_LOG_LINES) {
          logs = logs.slice(-MAX_LOG_LINES);
        }
      }
    } catch {
      // Ignore PM2 log retrieval errors
    }
  }

  return {
    installed,
    running: isManagedActive || reachable,
    managed: isReadFailed ? null : isManagedActive,
    pid: isManagedActive ? (pm2Status?.pid || null) : null,
    host,
    port,
    endpoint,
    config: isManagedActive ? currentConfig : null,
    recentLogs: logs,
    lastExitError: isReadFailed ? 'Failed to read PM2 status' : lastExitError,
  };
}

/**
 * Starts llama-server with the specified model and options under PM2.
 */
export async function startLlamaServer(options = {}) {
  const binaryPath = resolveLlamaServerBinary();
  if (!binaryPath) {
    throw new ServerError(
      'llama-server binary was not found on PATH. Install it via Homebrew (`brew install llama.cpp`) or build from source.',
      { status: 400 }
    );
  }

  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  if (pm2Status && pm2Status.status === 'online') {
    throw new ServerError(`llama-server is already running with PID ${pm2Status.pid}`, { status: 409 });
  }

  const {
    model,
    draftModel,
    specType = 'draft-dflash',
    port = PORTS.LLAMA_SERVER,
    host = '127.0.0.1',
    ctxSize = 32768,
    nGpuLayers = 99,
    alias = 'dflash',
  } = options;

  if (!model || typeof model !== 'string') {
    throw new ServerError('model path is required to start llama-server', { status: 400 });
  }

  const endpoint = `http://${host}:${port}/v1`;
  const reachable = await probeEndpoint(endpoint);
  if (reachable) {
    throw new ServerError(`Port ${port} is already in use by an active server at ${endpoint}`, { status: 409 });
  }
  if (await isPortInUse(port)) {
    throw new ServerError(
      `Port ${port} is already in use on ${host}. Choose a different port under Advanced options before starting llama-server.`,
      { status: 409, code: 'LLAMA_SERVER_PORT_IN_USE' }
    );
  }

  // Validate the weights before building the launch line
  await assertModelFileExists('The base model', model.trim());
  const draftPath = typeof draftModel === 'string' && draftModel.trim()
    ? draftModel.trim()
    : null;
  if (draftPath) await assertModelFileExists('The drafter model', draftPath);

  const args = ['-m', expandHome(model.trim())];
  if (draftPath) {
    args.push('--model-draft', expandHome(draftPath));
    if (specType) args.push('--spec-type', specType.trim());
  }
  if (port) args.push('--port', String(port));
  if (host) args.push('--host', host);
  if (ctxSize) args.push('--ctx-size', String(ctxSize));
  if (nGpuLayers !== undefined && nGpuLayers !== null) args.push('-ngl', String(nGpuLayers));
  if (alias) args.push('--alias', alias);

  lastExitError = null;
  recentLogs = [];
  appendLog(`Starting: llama-server ${args.join(' ')}`);

  currentConfig = {
    model,
    draftModel: draftModel || null,
    specType,
    port,
    host,
    ctxSize,
    nGpuLayers,
    alias,
  };

  // Delete stale PM2 entry so our own previous instance doesn't count as a collision
  await execPm2(['delete', LLAMA_APP]).catch(() => {});
  clearJlistCache();

  await execPm2([
    'start', binaryPath,
    '--name', LLAMA_APP,
    '--interpreter', 'none',
    '--no-autorestart',
    '--',
    ...args,
  ]);
  clearJlistCache();

  // Wait a short beat and verify probe
  const startTime = Date.now();
  let online = false;
  let currentProc = null;
  while (Date.now() - startTime < STARTUP_WAIT_TIMEOUT_MS) {
    await sleep(500);
    clearJlistCache();
    currentProc = await getAppStatusStrict(LLAMA_APP);
    if (currentProc && (currentProc.status === 'errored' || currentProc.status === 'stopped' || currentProc.status === 'not_found')) {
      break;
    }
    online = await probeEndpoint(endpoint);
    if (online) break;
  }

  if (currentProc && (currentProc.status === 'errored' || currentProc.status === 'stopped' || currentProc.status === 'not_found')) {
    let tail = '';
    try {
      const pm2Logs = await execPm2(['logs', LLAMA_APP, '--nostream', '--lines', '15']);
      const combined = (pm2Logs.stderr || pm2Logs.stdout || '').trim();
      const lines = combined.split('\n').map((l) => l.trimEnd()).filter(Boolean);
      for (const line of lines) appendLog(line);
      tail = lines.slice(-4).join(' | ');
    } catch {
      tail = recentLogs.slice(-4).join(' | ');
    }

    lastExitError = `PM2 status: ${currentProc.status}`;

    await execPm2(['delete', LLAMA_APP]).catch(() => {});
    clearJlistCache();
    throw new ServerError(
      `llama-server exited immediately${lastExitError ? ` (${lastExitError})` : ''}.${tail ? ` Last output: ${tail}` : ''}`,
      { status: 500, code: 'LLAMA_SERVER_EXITED' }
    );
  }

  const finalProc = await getAppStatusStrict(LLAMA_APP);

  return {
    success: true,
    running: true,
    managed: true,
    pid: finalProc?.pid || null,
    endpoint,
    online,
    config: currentConfig,
  };
}

/**
 * Stops the managed llama-server process.
 */
export async function stopLlamaServer() {
  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  const isManaged = Boolean(pm2Status && pm2Status.status === 'online');

  if (!isManaged) {
    const host = currentConfig?.host || '127.0.0.1';
    const port = currentConfig?.port ?? PORTS.LLAMA_SERVER;
    const endpoint = `http://${host}:${port}/v1`;
    const reachable = await probeEndpoint(endpoint);
    if (reachable) {
      return {
        success: false,
        message: `An external process is listening on ${endpoint}. It was not started by PortOS and cannot be stopped here.`,
      };
    }
    return { success: true, message: 'llama-server is not running' };
  }

  appendLog(`Stopping ${LLAMA_APP}`);
  try {
    await execPm2(['delete', LLAMA_APP]);
    clearJlistCache();
  } catch (err) {
    throw new ServerError(`Failed to stop llama-server: ${err.message}`, { status: 500 });
  }
  currentConfig = null;

  return { success: true, message: 'llama-server stopped' };
}

/**
 * Runs `brew link --overwrite llama.cpp`, resolving `{ linked, output }` on exit
 * rather than rejecting — a failed link attempt should fall through to the
 * caller's own error message, not replace it with a `brew link` failure. The
 * captured output is what makes a failure diagnosable ("Could not symlink…",
 * a permissions error on the prefix); discarding it left the caller guessing.
 */
function linkLlamaCpp(env) {
  return new Promise((resolve) => {
    const spawnOpts = safeChildProcessOptions({
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = spawn('brew', ['link', '--overwrite', 'llama.cpp'], spawnOpts);
    let output = '';
    const collect = (chunk) => { output += chunk.toString(); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => resolve({ linked: false, output: err.message }));
    // 'close' rather than 'exit': 'exit' fires the moment the process ends, with
    // stdio possibly still buffered, which would hand back a truncated (often
    // empty) `output` exactly when a failure needs explaining. `brew link` is a
    // short, single-process command, so waiting for the pipes to close is safe.
    child.on('close', (code) => resolve({ linked: code === 0, output: output.trim() }));
  });
}

/**
 * Installs llama.cpp via Homebrew.
 */
export async function installLlamaServer({ onProgress = () => {} } = {}) {
  const brewExists = await commandExists('brew', ['--version']);
  if (!brewExists) {
    throw new ServerError(
      'Homebrew was not found. Please install Homebrew from https://brew.sh or build llama.cpp from source.',
      { status: 400 }
    );
  }

  onProgress({ event: 'start', message: 'Installing llama.cpp via Homebrew…' });
  const env = safeChildProcessEnv();
  const spawnOpts = safeChildProcessOptions({
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const child = spawn('brew', ['install', 'llama.cpp'], spawnOpts);

  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (d) => {
      onProgress({ event: 'progress', message: d.toString().trim() });
    });
    child.stderr?.on('data', (d) => {
      onProgress({ event: 'progress', message: d.toString().trim() });
    });
    // `error` and `exit` can both fire for one child (an `error` raised after a
    // successful spawn is followed by the process's own exit). Without this
    // guard the exit path would still emit a `complete` progress event to the
    // UI after the request had already been rejected — the client would render
    // "installed successfully" alongside a 500.
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new ServerError(`Failed to run brew: ${err.message}`, { status: 500 }));
    });
    // Async listener on a child-process event: it runs outside the Express
    // lifecycle AND outside this Promise executor's own throw path, so an
    // unguarded throw here would surface as an unhandled rejection while the
    // install request hung forever. Route every failure to `reject`.
    child.on('exit', async (code) => {
      if (settled) return;
      settled = true;
      try {
        let binaryPath = resolveLlamaServerBinary();
        let linkOutput = '';

        // `brew install` exits 0 without linking when the keg is already
        // installed but unlinked ("Warning: llama.cpp X is already installed,
        // it's just not linked."). Link it explicitly rather than leaving that
        // warning as a dead end for the caller.
        if (!binaryPath && code === 0) {
          onProgress({ event: 'progress', message: 'llama.cpp keg is installed but not linked — linking…' });
          const { linked, output } = await linkLlamaCpp(env);
          linkOutput = output;
          if (linked) binaryPath = resolveLlamaServerBinary();
        }

        if (binaryPath) {
          onProgress({ event: 'complete', message: `llama.cpp installed successfully (${binaryPath})` });
          resolve({ success: true, message: 'llama.cpp installed successfully' });
          return;
        }

        // A `brew link` conflict can list every clashing file, so cap what
        // rides along into the error message.
        const hint = linkOutput
          ? `brew link said: ${linkOutput.slice(0, 500)}`
          : 'try running `brew link --overwrite llama.cpp` manually';
        const msg = code === 0
          ? `brew completed but llama-server was not found on PATH — ${hint}`
          : `brew install llama.cpp failed (exit code ${code})`;
        reject(new ServerError(msg, { status: 500 }));
      } catch (err) {
        reject(new ServerError(`Failed to verify the llama.cpp install: ${err.message}`, { status: 500 }));
      }
    });
  });
}

/**
 * Clears in-memory test state (used by test suites).
 */
export function _resetLlamaServerStateForTests() {
  currentConfig = null;
  recentLogs = [];
  lastExitError = null;
}

