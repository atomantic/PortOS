import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { readFile } from 'fs/promises';
import * as gitService from './git.js';
import * as pm2Service from './pm2.js';

/**
 * Run a command and return stdout/stderr
 */
const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB tail per stream

function runCommand(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on('data', d => {
      stderr += d;
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    child.on('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
      else resolve({ stdout, stderr });
    });
    child.on('error', reject);
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

  // Step 1: Git pull
  emit('git-pull', 'running', 'Pulling latest changes...');
  const pullResult = await gitService.pull(dir);
  const pullMsg = pullResult.output?.trim() || 'Up to date';
  emit('git-pull', 'done', pullMsg);
  steps.push({ step: 'git-pull', success: true, message: pullMsg });

  // Step 2: Install deps for each subdir that has package.json
  for (const sub of ['', 'client', 'server']) {
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

  // Step 3: Run setup if available
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

  // Step 4: Restart PM2 processes
  const processNames = app.pm2ProcessNames || [];
  if (processNames.length > 0) {
    emit('restart', 'running', 'Restarting app...');
    for (const name of processNames) {
      await pm2Service.restartApp(name, app.pm2Home);
    }
    emit('restart', 'done', `Restarted ${processNames.length} process(es)`);
    steps.push({ step: 'restart', success: true });
  }

  return { success: true, steps };
}
