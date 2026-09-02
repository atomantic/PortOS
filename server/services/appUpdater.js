import { existsSync } from 'fs';
import { join } from 'path';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as gitService from './git.js';
import * as pm2Service from './pm2.js';
import { bufferedSpawnOrThrow } from '../lib/bufferedSpawn.js';
import { parseCommandArgs } from '../lib/commandSecurity.js';
import { isDetachedRunning, spawnDetached } from '../lib/detachedSpawn.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { parseBuildCommand } from './appBuilder.js';
import { syncManagedAppFork } from './managedAppRepositories.js';

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
const DASHBOARD_OPEN_SCRIPT = 'scripts/open-ui-in-browser.js';
const DASHBOARD_OPEN_CONTROL_DIR = join(tmpdir(), 'portos-dashboard-open');

/**
 * Start the post-update dashboard handoff before any PortOS process is
 * restarted. The handoff is deliberately detached through the shared
 * double-fork helper: PM2's tree-kill would otherwise take the helper down
 * with portos-server before it can wait for the browser to return.
 *
 * @param {object} app
 * @returns {Promise<void>}
 */
async function startDashboardHandoff(app) {
  if (app.id !== PORTOS_APP_ID) return;

  const scriptPath = join(app.repoPath, DASHBOARD_OPEN_SCRIPT);
  const alreadyRunning = await isDetachedRunning(DASHBOARD_OPEN_CONTROL_DIR, {
    executable: process.execPath,
    args: [scriptPath],
  }).catch((err) => {
    // Do not let an unreadable control dir be mistaken for an idle one: the
    // detached helper clears stale sentinels before launching and could then
    // race a handoff that is still alive after the previous PM2 restart.
    console.error(`⚠️ Dashboard auto-open status check failed: ${err.message}`);
    return true;
  });
  if (alreadyRunning) return;

  const handoff = await spawnDetached(
    process.execPath,
    [scriptPath],
    { cwd: app.repoPath, controlDir: DASHBOARD_OPEN_CONTROL_DIR, cleanup: true },
  ).catch((err) => {
    console.error(`⚠️ Dashboard auto-open could not start: ${err.message}`);
    return null;
  });
  handoff?.on('error', (err) => {
    console.error(`⚠️ Dashboard auto-open failed: ${err.message}`);
  });
}

/**
 * Run a full update cycle for an app:
 * 1. git pull --rebase --autostash
 * 2. install dependencies in each package directory (Bun apps use their
 *    frozen lockfile; existing apps retain npm install)
 * 3. run setup with the same package manager when the script exists
 * 4. rebuild the production UI when a build command or `scripts.build` exists
 *    (a pull that only restarts leaves `client/dist` stale and PortOS then
 *    reports "install out of sync")
 * 5. Restart PM2 processes
 *
 * @param {object} app - The app object (must have repoPath, pm2ProcessNames, pm2Home)
 * @param {function} emit - Callback (step, status, message) for progress updates
 * @param {{syncFork?: boolean}} options
 * @returns {Promise<{success: boolean, steps: object[]}>}
 */
export async function updateApp(app, emit, { syncFork = false } = {}) {
  const dir = app.repoPath;
  if (updatingApps.has(dir)) {
    return { success: false, steps: [{ step: 'lock', success: false, message: 'Update already in progress' }] };
  }
  updatingApps.add(dir);

  try {
    return await _doUpdate(app, emit, { syncFork });
  } finally {
    updatingApps.delete(dir);
  }
}

async function _doUpdate(app, emit, { syncFork }) {
  const dir = app.repoPath;
  const steps = [];
  const packageManager = app.type === 'bun' ? 'bun' : 'npm';
  const configuredRuntime = parseCommandArgs(app.startCommands?.[0] || '')[0];
  const packageManagerCommand = packageManager === 'bun' && configuredRuntime
    ? configuredRuntime
    : packageManager;
  const installArgs = packageManager === 'bun' ? ['install', '--frozen-lockfile'] : ['install'];

  if (syncFork) {
    emit('git-sync-fork', 'running', 'Syncing the origin fork from canonical upstream...');
    const sync = await syncManagedAppFork(app);
    const syncMessage = sync.alreadyUpToDate
      ? `${sync.fullName} is already current`
      : `Synced ${sync.fullName} from ${sync.source}`;
    emit('git-sync-fork', 'done', syncMessage);
    steps.push({ step: 'git-sync-fork', success: true, message: syncMessage });
  }

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
  const pkg = existsSync(pkgPath) ? JSON.parse(await readFile(pkgPath, 'utf-8')) : null;
  if (pkg?.scripts?.setup) {
    emit('setup', 'running', 'Running setup...');
    await runCommand(packageManagerCommand, ['run', 'setup'], dir);
    emit('setup', 'done', 'Setup complete');
    steps.push({ step: 'setup', success: true });
  }

  const configuredBuild = typeof app.buildCommand === 'string' ? app.buildCommand.trim() : '';
  let build;
  if (configuredBuild) {
    const parsed = parseBuildCommand(configuredBuild);
    if (!parsed.ok) throw new Error(parsed.message);
    build = { cmd: parsed.cmd, args: parsed.args };
  } else if (pkg?.scripts?.build) {
    build = { cmd: packageManagerCommand, args: ['run', 'build'] };
  }
  if (build) {
    emit('build', 'running', 'Building production UI...');
    await runCommand(build.cmd, build.args, dir);
    emit('build', 'done', 'Production UI built');
    steps.push({ step: 'build', success: true });
  }

  const processNames = app.pm2ProcessNames || [];
  if (processNames.length > 0) {
    emit('restart', 'running', 'Restarting app...');
    await startDashboardHandoff(app);
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
