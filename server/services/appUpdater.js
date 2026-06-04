import { existsSync } from 'fs';
import { join } from 'path';
import { readFile } from 'fs/promises';
import * as gitService from './git.js';
import * as pm2Service from './pm2.js';
import { bufferedSpawnOrThrow } from '../lib/bufferedSpawn.js';

const CMD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run a command in `cwd`, throwing on timeout, spawn error, or non-zero exit.
 * Thin wrapper over the shared `bufferedSpawnOrThrow` adapter.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runCommand(cmd, args, cwd) {
  return bufferedSpawnOrThrow(cmd, args, { cwd, timeoutMs: CMD_TIMEOUT_MS });
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
