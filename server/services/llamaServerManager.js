/**
 * llama-server process manager
 *
 * Provides lifecycle management (status probe, start, stop, recent logs)
 * for a local `llama-server` instance running speculative decoding (e.g. DFlash 2).
 */

import { spawn } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { killProcessTree } from '../lib/bufferedSpawn.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { sleep } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';

const IS_WIN = process.platform === 'win32';
const MAX_LOG_LINES = 100;
const PROBE_TIMEOUT_MS = 1500;
const STARTUP_WAIT_TIMEOUT_MS = 4000;

let managedChild = null;
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
 */
async function probeEndpoint(endpoint) {
  try {
    const url = `${endpoint.replace(/\/+$/, '')}/models`;
    const res = await fetchWithTimeout(url, { method: 'GET', timeout: PROBE_TIMEOUT_MS });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Returns current status of llama-server (binary availability, running state, config, logs).
 */
export async function getLlamaServerStatus() {
  const binaryPath = await findCommandOnPath('llama-server');
  const installed = Boolean(binaryPath) && await commandExists(binaryPath);

  const host = currentConfig?.host || '127.0.0.1';
  const port = currentConfig?.port || 8080;
  const endpoint = `http://${host}:${port}/v1`;

  const isManagedActive = Boolean(managedChild && !managedChild.killed && managedChild.exitCode === null);
  const reachable = await probeEndpoint(endpoint);

  return {
    installed,
    running: isManagedActive || reachable,
    managed: isManagedActive,
    pid: isManagedActive ? managedChild.pid : null,
    host,
    port,
    endpoint,
    config: isManagedActive ? currentConfig : null,
    recentLogs: [...recentLogs],
    lastExitError,
  };
}

/**
 * Starts llama-server with the specified model and options.
 */
export async function startLlamaServer(options = {}) {
  const binaryPath = await findCommandOnPath('llama-server');
  if (!binaryPath || !(await commandExists(binaryPath))) {
    throw new ServerError(
      'llama-server binary was not found on PATH. Install it via Homebrew (`brew install llama.cpp`) or build from source.',
      { status: 400 }
    );
  }

  if (managedChild && !managedChild.killed && managedChild.exitCode === null) {
    throw new ServerError(`llama-server is already running with PID ${managedChild.pid}`, { status: 409 });
  }

  const {
    model,
    draftModel,
    specType = 'draft-dflash',
    port = 8080,
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

  const args = ['-m', model.trim()];
  if (draftModel && typeof draftModel === 'string' && draftModel.trim()) {
    args.push('--draft-model', draftModel.trim());
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

  const env = safeChildProcessEnv();
  const spawnOpts = safeChildProcessOptions({
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !IS_WIN,
  });

  const child = spawn(binaryPath, args, spawnOpts);
  managedChild = child;
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

  child.stdout?.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) appendLog(line);
  });

  child.stderr?.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) appendLog(line);
  });

  child.on('error', (err) => {
    appendLog(`Process error: ${err.message}`);
    lastExitError = err.message;
    if (managedChild === child) managedChild = null;
  });

  child.on('exit', (code, signal) => {
    appendLog(`Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}`);
    if (code !== 0 && code !== null) {
      lastExitError = `Exited with code ${code}`;
    }
    if (managedChild === child) managedChild = null;
  });

  // Wait a short beat and verify probe
  const startTime = Date.now();
  let online = false;
  while (Date.now() - startTime < STARTUP_WAIT_TIMEOUT_MS) {
    if (child.exitCode !== null) break;
    await sleep(500);
    online = await probeEndpoint(endpoint);
    if (online) break;
  }

  return {
    success: true,
    running: true,
    managed: true,
    pid: child.pid,
    endpoint,
    online,
    config: currentConfig,
  };
}

/**
 * Stops the managed llama-server process.
 */
export async function stopLlamaServer() {
  if (!managedChild || managedChild.killed || managedChild.exitCode !== null) {
    const host = currentConfig?.host || '127.0.0.1';
    const port = currentConfig?.port || 8080;
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

  const childToKill = managedChild;
  managedChild = null;
  currentConfig = null;

  appendLog(`Stopping llama-server (PID ${childToKill.pid})`);
  killProcessTree(childToKill, 'SIGTERM', { processGroup: !IS_WIN });

  await sleep(600);
  if (!childToKill.killed && childToKill.exitCode === null) {
    killProcessTree(childToKill, 'SIGKILL', { processGroup: !IS_WIN });
  }

  return { success: true, message: 'llama-server stopped' };
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
    child.on('error', (err) => {
      reject(new ServerError(`Failed to run brew: ${err.message}`, { status: 500 }));
    });
    child.on('exit', async (code) => {
      const binaryPath = await findCommandOnPath('llama-server');
      const installed = Boolean(binaryPath) && await commandExists(binaryPath);
      if (installed) {
        onProgress({ event: 'complete', message: 'llama.cpp installed successfully' });
        resolve({ success: true, message: 'llama.cpp installed successfully' });
      } else {
        const msg = code === 0 ? 'brew completed but llama-server was not found on PATH' : `brew install llama.cpp failed (exit code ${code})`;
        reject(new ServerError(msg, { status: 500 }));
      }
    });
  });
}

/**
 * Clears in-memory test state (used by test suites).
 */
export function _resetLlamaServerStateForTests() {
  if (managedChild && !managedChild.killed && managedChild.exitCode === null) {
    try { managedChild.kill('SIGKILL'); } catch {}
  }
  managedChild = null;
  currentConfig = null;
  recentLogs = [];
  lastExitError = null;
}
