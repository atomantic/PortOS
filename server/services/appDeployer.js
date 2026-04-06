import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { NON_PM2_TYPES } from './streamingDetect.js';

export const DEPLOY_FLAGS = ['--ios', '--macos', '--watch', '--all', '--skip-tests'];
const VALID_FLAGS = new Set(DEPLOY_FLAGS);
const FLUSH_INTERVAL_MS = 80;

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
 * @param {string[]} flags - CLI flags (--ios, --macos, --all, --skip-tests)
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

    child.stdout.on('data', (data) => { stdoutBuf += data.toString(); });
    child.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    child.on('close', (code) => {
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
      const result = finish(false, -1);
      emit('error', { message: err.message });
      resolve(result);
    });
  });
}

/**
 * Check if an app is currently deploying
 */
export function isDeploying(appRepoPath) {
  return deployingApps.has(appRepoPath);
}
