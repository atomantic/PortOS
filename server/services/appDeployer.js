import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { NON_PM2_TYPES } from './streamingDetect.js';
import { getAppById } from './apps.js';

export const DEPLOY_FLAGS = ['--ios', '--macos', '--watch', '--all', '--skip-tests'];
const VALID_FLAGS = new Set(DEPLOY_FLAGS);
const FLUSH_INTERVAL_MS = 80;
// Maximum time (ms) a deploy.sh may run before the child is killed and the
// lock released. Escalates from SIGTERM → SIGKILL after DEPLOY_KILL_DELAY_MS.
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEPLOY_KILL_DELAY_MS = 10 * 1000;   // 10 seconds after SIGTERM

// Per-app lock to prevent concurrent deploys
const deployingApps = new Set();

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
 * @returns {Promise<{success: boolean, code: number}>}
 */
export function deployApp(app, flags, emit) {
  const dir = app.repoPath;

  if (deployingApps.has(dir)) {
    emit('error', { message: 'Deploy already in progress for this app' });
    return Promise.resolve({ success: false, code: -1 });
  }

  const safeFlags = flags.filter(f => VALID_FLAGS.has(f));

  deployingApps.add(dir);
  emit('status', { message: 'Starting deploy...', phase: 'start' });

  // Buffer output and flush periodically to reduce socket message volume
  let stdoutBuf = '';
  let stderrBuf = '';
  const flushOutput = () => {
    if (stdoutBuf) { emit('output', { text: stdoutBuf, stream: 'stdout' }); stdoutBuf = ''; }
    if (stderrBuf) { emit('output', { text: stderrBuf, stream: 'stderr' }); stderrBuf = ''; }
  };
  const flushTimer = setInterval(flushOutput, FLUSH_INTERVAL_MS);

  const finish = (success, code) => {
    clearInterval(flushTimer);
    flushOutput();
    deployingApps.delete(dir);
    return { success, code };
  };

  return new Promise((resolve) => {
    const child = spawn('bash', ['deploy.sh', ...safeFlags], {
      cwd: dir,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' }
    });

    // Guard against a hung deploy.sh holding the lock forever.
    // After DEPLOY_TIMEOUT_MS: SIGTERM the child; escalate to SIGKILL after
    // DEPLOY_KILL_DELAY_MS if it hasn't exited. The 'close' handler below
    // handles lock release and result resolution for both normal and timed-out
    // exits, so we only need to kill here.
    let killTimer = null;
    const deployTimer = setTimeout(() => {
      console.error(`❌ Deploy timed out after ${DEPLOY_TIMEOUT_MS / 1000}s — killing child process`);
      emit('error', { message: 'Deploy timed out' });
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, DEPLOY_KILL_DELAY_MS);
    }, DEPLOY_TIMEOUT_MS);

    child.stdout.on('data', (data) => { stdoutBuf += data.toString(); });
    child.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(deployTimer);
      clearTimeout(killTimer);
      const success = code === 0;
      const result = finish(success, code);
      emit('status', {
        message: success ? 'Deploy complete' : `Deploy failed (exit code ${code})`,
        phase: 'complete',
        success,
        code
      });
      resolve(result);
    });

    child.on('error', (err) => {
      clearTimeout(deployTimer);
      clearTimeout(killTimer);
      const result = finish(false, -1);
      emit('error', { message: err.message });
      resolve(result);
    });
  });
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
 *   - `{ ok: true, success, code }` — the deploy ran to completion (caller emits
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
 * @returns {Promise<{ok: false, error: string} | {ok: true, success: boolean, code: number}>}
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
  const result = await runDeploy(app, flags, onOutput || (() => {}));
  console.log(`${result.success ? '✅' : '❌'} Deploy ${result.success ? 'complete' : 'failed'} for ${app.name}`);

  return { ok: true, success: result.success, code: result.code };
}

/**
 * Check if an app is currently deploying
 */
export function isDeploying(appRepoPath) {
  return deployingApps.has(appRepoPath);
}
