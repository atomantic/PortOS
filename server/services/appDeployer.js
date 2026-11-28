import { bufferedSpawn, MAX_OUTPUT_BYTES } from '../lib/bufferedSpawn.js';
import { existsSync } from 'fs';
import { join } from 'path';
import { NON_PM2_TYPES } from './appProcessTypes.js';
import { getAppById } from './apps.js';
import { resolveBashBinary } from '../lib/bashResolver.js';
import { withoutServerSecretsEnv } from '../lib/processEnv.js';
import { DEPLOY_FLAGS } from '../lib/appDeployFlags.js';
import { maintenance } from '../lib/maintenanceAdmission.js';

export { DEPLOY_FLAGS };
const VALID_FLAGS = new Set(DEPLOY_FLAGS);
const FLUSH_INTERVAL_MS = 80;
// Maximum time (ms) a deploy.sh may run before the child is killed and the
// lock released. Escalates from SIGTERM → SIGKILL after DEPLOY_KILL_DELAY_MS.
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEPLOY_KILL_DELAY_MS = 10 * 1000;   // 10 seconds after SIGTERM

// Per-app lock to prevent concurrent deploys
const deployingApps = new Map();

/** @typedef {{success: boolean, code: number | null, cancelled: boolean, timedOut: boolean, error?: string}} DeployResult */

/**
 * Check whether an app has a deploy.sh script
 */
export function hasDeployScript(app) {
  if (process.platform === 'win32') return false;
  if (!app?.repoPath) return false;
  if (!NON_PM2_TYPES.has(app.type)) return false;
  return existsSync(join(app.repoPath, 'deploy.sh'));
}

/**
 * Run deploy.sh for an Xcode app with real-time output streaming.
 *
 * @param {object} app - App object with repoPath, type, name
 * @param {string[]} flags - CLI flags (--ios, --macos, --watch, --all, --skip-tests)
 * @param {function} emit - Callback (type, data) for streaming output
 * @returns {Promise<DeployResult>}
 */
export async function deployApp(app, flags, emit) {
  const dir = app.repoPath;
  const send = (type, payload) => {
    try { emit(type, payload); }
    catch (err) { console.error(`❌ Deploy output hook failed: ${err.message}`); }
  };
  if (deployingApps.has(dir)) {
    const error = 'Deploy already in progress for this app';
    send('error', { message: error });
    return { success: false, code: -1, cancelled: false, timedOut: false, error };
  }

  const safeFlags = flags.filter(f => VALID_FLAGS.has(f));
  const controller = new AbortController();
  deployingApps.set(dir, { appId: app.id, controller });
  send('status', { message: 'Starting deploy...', phase: 'start' });

  // Batch socket output and retain only a bounded tail between flushes.
  const output = { stdout: '', stderr: '' };
  const flushOutput = () => {
    for (const stream of ['stdout', 'stderr']) {
      if (!output[stream]) continue;
      send('output', { text: output[stream], stream });
      output[stream] = '';
    }
  };
  const flushTimer = setInterval(flushOutput, FLUSH_INTERVAL_MS);

  let result;
  try {
    // Avoid resolving a Windows PM2 deploy to WSL's Linux toolchain.
    result = await bufferedSpawn(resolveBashBinary(), ['deploy.sh', ...safeFlags], {
      cwd: dir,
      shell: false,
      env: { ...withoutServerSecretsEnv(process.env), FORCE_COLOR: '0' },
      timeoutMs: DEPLOY_TIMEOUT_MS,
      killGraceMs: DEPLOY_KILL_DELAY_MS,
      processGroup: true,
      signal: controller.signal,
      onOutput: (chunk, stream) => { output[stream] = (output[stream] + chunk.toString()).slice(-MAX_OUTPUT_BYTES); },
    });
  } finally {
    clearInterval(flushTimer);
    flushOutput();
    deployingApps.delete(dir);
  }

  const { success, code } = result;
  const cancelled = Boolean(result.aborted);
  const timedOut = Boolean(result.timedOut);
  const reason = cancelled ? 'Deploy cancelled' : timedOut ? 'Deploy timed out' : result.error?.message;
  if (reason) send('error', { message: reason });
  send('status', {
    message: reason || (success ? 'Deploy complete' : `Deploy failed (exit code ${code})`),
    phase: 'complete',
    success,
    code
  });
  return { success, code, cancelled, timedOut, ...(reason ? { error: reason } : {}) };
}

/** Request teardown of the active deploy for this app, if any. */
export function cancelDeploy(appId) {
  if (!appId) return false;
  for (const deploy of deployingApps.values()) {
    if (deploy.appId !== appId || deploy.controller.signal.aborted) continue;
    deploy.controller.abort();
    return true;
  }
  return false;
}

/**
 * Resolve an app by id, validate it has a deploy script, and run the deploy —
 * the orchestration the `app:deploy` socket handler used to do inline. Pulling
 * it into the service makes it unit-testable and HTTP-callable; the caller only
 * supplies a streaming-output callback and consumes the terminal outcome.
 *
 * Returns a discriminated outcome so the caller can map it to the right event:
 *   - `{ ok: false, error }` — the request was invalid (app not found, or no
 *     deploy.sh) and never started a deploy (caller emits `app:deploy:error`).
 *   - `{ ok: true, ...DeployResult }` — the deploy settled (caller emits
 *     `app:deploy:complete`).
 *
 * @param {string} appId - Id of the app to deploy
 * @param {string[]} flags - CLI flags forwarded to deploy.sh
 * @param {object} [opts]
 * @param {(type: string, payload: object) => void} [opts.onOutput] - Streaming
 *   deploy output/status/error frames (same `(type, data)` shape `deployApp` emits)
 * @param {Function} [opts.resolveApp] - Injectable app lookup (defaults to getAppById);
 *   a test seam so the orchestration is unit-testable without a real app store.
 * @param {Function} [opts.checkScript] - Injectable deploy-script check (defaults to hasDeployScript).
 * @param {Function} [opts.runDeploy] - Injectable deploy runner (defaults to deployApp).
 * @returns {Promise<{ok: false, error: string} | ({ok: true} & DeployResult)>}
 */
export async function runDeployFlow(
  appId,
  flags = [],
  { onOutput, resolveApp = getAppById, checkScript = hasDeployScript, runDeploy = deployApp } = {}
) {
  const app = await resolveApp(appId);
  if (!app) return { ok: false, error: 'App not found' };
  if (!checkScript(app)) return { ok: false, error: 'No deploy.sh found for this app' };

  console.log(`🚀 Deploy started for ${app.name} [${flags.join(', ') || 'default'}]`);
  const result = await maintenance.run('app-operation', String(app.id).slice(0, 256),
    () => runDeploy(app, flags, onOutput || (() => {})));
  if (result.cancelled) console.log(`⏹️ Deploy cancelled for ${app.name}`);
  else if (result.success) console.log(`✅ Deploy complete for ${app.name}`);
  else console.error(`❌ ${result.timedOut ? 'Deploy timed out' : 'Deploy failed'} for ${app.name}`);

  return { ok: true, ...result };
}

/**
 * Check if an app is currently deploying
 */
export function isDeploying(appRepoPath) {
  return deployingApps.has(appRepoPath);
}
