import { existsSync } from 'fs';
import { join } from 'path';
import { readFile } from 'fs/promises';
import * as gitService from './git.js';
import * as pm2Service from './pm2.js';
import { bufferedSpawnOrThrow } from '../lib/bufferedSpawn.js';
import { parseCommandArgs } from '../lib/commandSecurity.js';

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
 * 2. install dependencies in each package directory (Bun apps use their
 *    frozen lockfile; existing apps retain npm install)
 * 3. run setup with the same package manager when the script exists
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
  const packageManager = app.type === 'bun' ? 'bun' : 'npm';
  const configuredRuntime = parseCommandArgs(app.startCommands?.[0] || '')[0];
  const packageManagerCommand = packageManager === 'bun' && configuredRuntime
    ? configuredRuntime
    : packageManager;
  const installArgs = packageManager === 'bun' ? ['install', '--frozen-lockfile'] : ['install'];

  emit('git-pull', 'running', 'Pulling latest changes...');
  const pullResult = await gitService.pull(dir);
  const pullMsg = pullResult.output?.trim() || 'Up to date';
  emit('git-pull', 'done', pullMsg);
  steps.push({ step: 'git-pull', success: true, message: pullMsg });

  const companionRepoPaths = Array.isArray(app.companionRepoPaths)
    ? [...new Set(app.companionRepoPaths)].filter((path) => path && path !== dir)
    : [];
  for (let index = 0; index < companionRepoPaths.length; index += 1) {
    const companionPath = companionRepoPaths[index];
    const stepId = `git-pull:companion-${index + 1}`;
    emit(stepId, 'running', `Pulling companion repository ${index + 1}/${companionRepoPaths.length}...`);
    const companionPull = await gitService.pull(companionPath);
    const companionMessage = companionPull.output?.trim() || 'Up to date';
    emit(stepId, 'done', companionMessage);
    steps.push({ step: stepId, success: true, message: companionMessage });
  }

  for (const sub of ['', 'client', 'server', 'admin']) {
    const subDir = sub ? join(dir, sub) : dir;
    if (existsSync(join(subDir, 'package.json'))) {
      const label = sub || 'root';
      const stepId = `${packageManager}-install:${label}`;
      emit(stepId, 'running', `Installing ${label} dependencies...`);
      await runCommand(packageManagerCommand, installArgs, subDir);
      emit(stepId, 'done', `${label} dependencies installed`);
      steps.push({ step: stepId, success: true });
    }
  }

  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    if (pkg.scripts?.setup) {
      emit('setup', 'running', 'Running setup...');
      await runCommand(packageManagerCommand, ['run', 'setup'], dir);
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
