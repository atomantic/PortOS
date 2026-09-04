import { existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as gitService from './git.js';
import * as pm2Service from './pm2.js';
import { bufferedSpawnOrThrow } from '../lib/bufferedSpawn.js';
import { parseCommandArgs, validateCommand } from '../lib/commandSecurity.js';
import { isDetachedRunning, spawnDetached } from '../lib/detachedSpawn.js';
import { PATHS } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { startPortosSelfUpdate } from './portosSelfUpdate.js';
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
 * Only the paths that restart PortOS from HERE need it. The delegated
 * self-update does not: update.sh runs `open-ui-in-browser.js` itself once the
 * ecosystem is back up.
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
    // spawnDetached leaves this process's tree on every platform — pm2 kills on
    // Windows with `taskkill /T`, which walks the same parent tree the POSIX
    // double-fork escapes, so without it the handoff dies with portos-server.
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
 * Whether two filesystem paths name the same directory. A trailing slash, a
 * symlinked checkout, or a different case on APFS/NTFS all spell one path more
 * than one way — and the caller below turns "these differ" into "take the
 * ATTACHED spawn", which is exactly the headless failure of #5976. Resolve
 * symlinks where possible, and case-fold on the platforms whose filesystems
 * are case-insensitive by default (mirrors `scripts/lib/directInvocation.js`).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSamePath(a, b) {
  if (!a || !b) return false;
  const caseFold = process.platform === 'win32' || process.platform === 'darwin';
  const normalize = (path) => {
    // realpath throws when the path does not exist yet; resolve() alone still
    // collapses a trailing slash and any '..' segment.
    const absolute = (() => {
      try {
        return realpathSync(resolve(path));
      } catch {
        return resolve(path);
      }
    })();
    return caseFold ? absolute.toLowerCase() : absolute;
  };
  return normalize(a) === normalize(b);
}

/**
 * Run a full update cycle for an app:
 * 1. switch to origin's default branch and fast-forward it
 * 2. run an explicitly declared app update routine, when one exists
 * 3. restart the app's PM2 processes
 *
 * A generic managed app must opt in to dependency installs, migrations, or a
 * build: guessing those steps from a package.json can freeze or break apps
 * whose lifecycle does not resemble PortOS.
 *
 * PortOS itself is a managed app, and its comprehensive update.sh/update.ps1
 * lifecycle is delegated to `portosSelfUpdate` — the same launcher the Update
 * page uses — which owns the restart and the dashboard handoff for that case.
 * That branch resolves as soon as the detached script is RUNNING and reports
 * `selfUpdateStarted`, because this process does not outlive the script's
 * `pm2 delete`.
 *
 * @param {object} app - The app object (must have repoPath, pm2ProcessNames, pm2Home)
 * @param {function} emit - Callback (step, status, message) for progress updates
 * @param {object} [options]
 * @param {boolean} [options.syncFork] - fast-forward the origin fork first
 * @param {boolean} [options.acknowledgeFork] - PortOS preflight acknowledgement
 * @param {boolean} [options.acknowledgePersistentMindImageBackup] - PortOS preflight acknowledgement
 * @returns {Promise<{success: boolean, steps: object[], selfUpdateStarted?: boolean}>}
 */
export async function updateApp(app, emit, options = {}) {
  const dir = app.repoPath;
  if (updatingApps.has(dir)) {
    return { success: false, steps: [{ step: 'lock', success: false, message: 'Update already in progress' }] };
  }
  updatingApps.add(dir);

  try {
    return await _doUpdate(app, emit, options);
  } finally {
    updatingApps.delete(dir);
  }
}

async function _doUpdate(app, emit, {
  syncFork = false,
  acknowledgeFork = false,
  acknowledgePersistentMindImageBackup = false,
}) {
  const dir = app.repoPath;
  const steps = [];
  const packageManager = app.type === 'bun' ? 'bun' : 'npm';
  const configuredRuntime = parseCommandArgs(app.startCommands?.[0] || '')[0];
  const packageManagerCommand = packageManager === 'bun' && configuredRuntime
    ? configuredRuntime
    : packageManager;

  if (syncFork) {
    emit('git-sync-fork', 'running', 'Syncing the origin fork from canonical upstream...');
    const sync = await syncManagedAppFork(app);
    const syncMessage = sync.alreadyUpToDate
      ? `${sync.fullName} is already current`
      : `Synced ${sync.fullName} from ${sync.source}`;
    emit('git-sync-fork', 'done', syncMessage);
    steps.push({ step: 'git-sync-fork', success: true, message: syncMessage });
  }

  emit('git-pull', 'running', 'Updating from origin default branch...');
  const pullResult = await gitService.updateDefaultBranch(dir);
  const pullMsg = pullResult.output?.trim() || `${pullResult.branch} is up to date`;
  emit('git-pull', 'done', pullMsg);
  steps.push({ step: 'git-pull', success: true, message: pullMsg });

  const companionRepoPaths = Array.isArray(app.companionRepoPaths)
    ? [...new Set(app.companionRepoPaths)].filter((path) => path && path !== dir)
    : [];
  for (let index = 0; index < companionRepoPaths.length; index += 1) {
    const companionPath = companionRepoPaths[index];
    const stepId = `git-pull:companion-${index + 1}`;
    emit(stepId, 'running', `Pulling companion repository ${index + 1}/${companionRepoPaths.length}...`);
    const companionPull = await gitService.updateDefaultBranch(companionPath);
    const companionMessage = companionPull.output?.trim() || `${companionPull.branch} is up to date`;
    emit(stepId, 'done', companionMessage);
    steps.push({ step: stepId, success: true, message: companionMessage });
  }

  const pkgPath = join(dir, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(await readFile(pkgPath, 'utf-8')) : null;
  const configuredUpdate = typeof app.updateCommand === 'string' ? app.updateCommand.trim() : '';
  const standardScript = process.platform === 'win32' ? 'update.ps1' : 'update.sh';
  const standardScriptPath = join(dir, standardScript);
  const usesStandardScript = !configuredUpdate && !pkg?.scripts?.['portos:update'] && existsSync(standardScriptPath);
  // PortOS running THIS checkout's own standard update script is the one case
  // whose update routine deletes the process awaiting it — and the only shape
  // updateExecutor knows how to launch, since it resolves update.sh from
  // `PATHS.root` rather than from the app record. Both narrowings matter: a
  // PortOS record carrying a custom `updateCommand`, or pointing somewhere
  // other than this checkout, keeps the ordinary attached path rather than
  // silently running a different script than the one configured.
  const detachSelfUpdate = app.id === PORTOS_APP_ID && usesStandardScript && isSamePath(dir, PATHS.root);
  if (configuredUpdate || pkg?.scripts?.['portos:update'] || usesStandardScript) {
    // A configured runtime may be an absolute Bun path, which is trusted app
    // configuration but not a commandSecurity allowlist token. Only free-form
    // registry commands go through that parser; the package-script form is a
    // fixed argument list selected by PortOS.
    const command = configuredUpdate
      ? validateCommand(configuredUpdate)
      : pkg?.scripts?.['portos:update']
        ? { valid: true, baseCommand: packageManagerCommand, args: ['run', 'portos:update'] }
        : process.platform === 'win32'
          ? { valid: true, baseCommand: 'powershell', args: ['-ExecutionPolicy', 'Bypass', '-File', standardScriptPath] }
          : { valid: true, baseCommand: standardScriptPath, args: [] };
    if (!command.valid) throw new Error(`Update command is not allowed: ${command.error}`);
    if (app.id === PORTOS_APP_ID && !detachSelfUpdate) {
      // Never silent: this is PortOS about to run its update routine ATTACHED,
      // and an attached run is what left the install headless in #5976. Name
      // which of the three narrowings declined it, so an operator debugging the
      // misconfiguration is not sent after the wrong one.
      const reason = configuredUpdate
        ? 'a custom update command is configured'
        : pkg?.scripts?.['portos:update']
          ? 'a portos:update package script is configured'
          : 'repoPath is not this checkout';
      console.log(`⚠️ PortOS update is using the attached path — ${reason}`);
    }
    emit('app-update', 'running', 'Running the app update routine...');
    if (detachSelfUpdate) {
      // PortOS is itself a managed app, so an App Management update reaches
      // update.sh through THIS path. `portosSelfUpdate` owns everything about
      // launching that script — including why nothing may await it — and this
      // returns the moment it is running. Read that module before changing this.
      //
      // `refresh`, not `reconcile`: the git-pull step above already advanced
      // this checkout, so the out-of-sync gate would only be re-asking whether
      // the pull we just did happened.
      //
      // No `io`: App Management renders the run from its own `app:update:step`
      // frames (`onStep`), so mirroring the whole stream onto
      // `portos:update:*` as well would double the fan-out for no new reader.
      await startPortosSelfUpdate({
        acknowledgeFork,
        acknowledgePersistentMindImageBackup,
        preflightAlreadyRun: true,
        mode: 'refresh',
        onStep: emit,
      });
      const launched = 'PortOS update running — this process restarts as part of it';
      emit('app-update', 'running', launched);
      steps.push({ step: 'app-update', success: true, message: launched });
      return { success: true, steps, selfUpdateStarted: true };
    }
    await runCommand(command.baseCommand, command.args, dir);
    emit('app-update', 'done', 'App update routine complete');
    steps.push({ step: 'app-update', success: true });
  }

  // update.sh/update.ps1 close with their own `pm2 start ecosystem.config.cjs`
  // (and their own dashboard handoff), so restarting PortOS on top of the
  // detached script would be redundant and would race it — the script may not
  // have finished re-registering the processes we would be restarting.
  const processNames = detachSelfUpdate ? [] : (app.pm2ProcessNames || []);
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
