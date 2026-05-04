import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { readFile } from 'fs/promises';
import * as gitService from './git.js';
import * as pm2Service from './pm2.js';

const IS_WIN32 = process.platform === 'win32';
const MAX_OUTPUT_BYTES = 64 * 1024;
const CMD_TIMEOUT_MS = 5 * 60 * 1000;

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: IS_WIN32, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (IS_WIN32 && child.pid) {
          spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
        } else {
          child.kill('SIGTERM');
        }
        reject(new Error(`${cmd} timed out after ${CMD_TIMEOUT_MS / 1000}s`));
      }
    }, CMD_TIMEOUT_MS);
    child.stdout.on('data', d => { stdout += d; if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES); });
    child.stderr.on('data', d => { stderr += d; if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES); });
    child.on('close', code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
        else resolve({ stdout, stderr });
      }
    });
    child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
  });
}

// Per-app lock to prevent concurrent updates
const updatingApps = new Set();

/**
 * Run a full update cycle for an app:
 * 1. git pull --rebase --autostash
 * 2. npm install in each subdir that has package.json (root, client, server)
 * 3. npm run setup if the root package.json has a setup script
 * 4. Restart PM2 processes
 *
 * @param {object} app - The app object (must have repoPath, pm2ProcessNames, pm2Home)
 * @param {function} emit - Callback (step, status, message) for progress updates
 * @returns {Promise<{success: boolean, steps: object[]}>}
 */
export async function updateApp(app, emit) {
  const dir = app.repoPath;
  if (updatingApps.has(dir)) {
    return { success: false, steps: [{ step: 'lock', success: false, message: 'Update already in progress' }] };
  }
  updatingApps.add(dir);

  try {
    return await _doUpdate(app, emit);
  } finally {
    updatingApps.delete(dir);
  }
}

async function _doUpdate(app, emit) {
  const dir = app.repoPath;
  const steps = [];

  emit('git-pull', 'running', 'Pulling latest changes...');
  const pullResult = await gitService.pull(dir);
  const pullMsg = pullResult.output?.trim() || 'Up to date';
  emit('git-pull', 'done', pullMsg);
  steps.push({ step: 'git-pull', success: true, message: pullMsg });

  for (const sub of ['', 'client', 'server', 'admin']) {
    const subDir = sub ? join(dir, sub) : dir;
    if (existsSync(join(subDir, 'package.json'))) {
      const label = sub || 'root';
      const stepId = `npm-install:${label}`;
      emit(stepId, 'running', `Installing ${label} dependencies...`);
      await runCommand('npm', ['install'], subDir);
      emit(stepId, 'done', `${label} dependencies installed`);
      steps.push({ step: stepId, success: true });
    }
  }

  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    if (pkg.scripts?.setup) {
      emit('setup', 'running', 'Running setup...');
      await runCommand('npm', ['run', 'setup'], dir);
      emit('setup', 'done', 'Setup complete');
      steps.push({ step: 'setup', success: true });
    }
  }

  const processNames = app.pm2ProcessNames || [];
  if (processNames.length > 0) {
    emit('restart', 'running', 'Restarting app...');
    const restartResults = await Promise.all(
      processNames.map(name =>
        pm2Service.restartApp(name, app.pm2Home).then(() => null, e => e)
      )
    );
    const failures = processNames.filter((_, i) => restartResults[i]);
    if (failures.length > 0) {
      const msg = `${processNames.length - failures.length}/${processNames.length} restarted (failed: ${failures.join(', ')})`;
      emit('restart', 'warning', msg);
      steps.push({ step: 'restart', success: true, warning: msg });
    } else {
      emit('restart', 'done', `Restarted ${processNames.length} process(es)`);
      steps.push({ step: 'restart', success: true });
    }
  }

  return { success: true, steps };
}
