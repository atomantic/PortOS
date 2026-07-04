import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { spawnDetached, isDetachedRunning } from '../lib/detachedSpawn.js';
import { recordUpdateResult } from './updateChecker.js';

const UPDATE_SH = join(PATHS.root, 'update.sh');
const UPDATE_PS1 = join(PATHS.root, 'update.ps1');

/**
 * Execute the PortOS update script (git pull to latest).
 *
 * On POSIX the script is launched via spawnDetached's double-fork so it
 * reparents to init and SURVIVES pm2's TreeKill. A plain
 * `spawn(..., { detached: true })` does NOT survive: pm2 walks PPID
 * (`ps -e -o pid=,ppid=`), not the process group, so when update.sh reaches
 * its `pm2-stop` step (`pm2 delete ecosystem.config.cjs`) the script itself —
 * still a PPID-child of portos-server — was tree-killed with the server,
 * leaving every app stopped with nothing alive to run the final `pm2 start`
 * (the reconcile/update "shuts down but never comes back" failure). See the
 * rationale in `server/lib/detachedSpawn.js`.
 *
 * Windows keeps the prior plain-spawn behavior (pm2 there is taskkill-based;
 * detached survival is a POSIX-only guarantee — same trade-off as
 * spawnDetached's own win32 fallback).
 *
 * The scripts pull the latest code via `git pull --rebase --autostash` and
 * write the actual resulting version to `data/update-complete.json`.
 * The `tag` parameter is used only for logging and the initial API response;
 * the true post-update version is determined by the script from package.json.
 *
 * @param {string} tag - The release tag that triggered the update (for logging)
 * @param {function} emit - Callback (step, status, message) for progress
 * @returns {Promise<{success: boolean, version?: string, failedStep?: string, errorMessage?: string}>}
 */
// Workspaces update.sh / update.ps1 know how to clean-reinstall — the env
// passthrough is allowlisted to these so nothing arbitrary reaches the scripts.
const CLEANABLE_WORKSPACES = new Set(['.', 'client', 'server', 'autofixer']);

export async function executeUpdate(tag, emit, { forceCleanWorkspaces } = {}) {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'powershell' : 'bash';
  const args = isWindows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UPDATE_PS1]
    : [UPDATE_SH];

  emit('starting', 'running', `Starting update (target: ${tag})...`);

  // For a reconcile (issue #1779), a bare `git pull` left stale node_modules
  // even though HEAD already advanced — so the scripts' commit-diff dependency
  // detection finds nothing to reinstall. Pass the workspaces whose deps are
  // actually stale (per installState's receipt check) so update.sh/update.ps1
  // force a from-scratch reinstall of exactly those, regardless of the diff.
  const cleanList = Array.isArray(forceCleanWorkspaces)
    ? forceCleanWorkspaces.filter(w => CLEANABLE_WORKSPACES.has(w))
    : [];
  const childEnv = cleanList.length
    ? { ...process.env, PORTOS_FORCE_CLEAN_WORKSPACES: cleanList.join(',') }
    : process.env;

  // POSIX: double-fork via spawnDetached so the script reparents to init and
  // survives the pm2 TreeKill its own `pm2 delete`/`pm2 start` steps trigger.
  // The returned handle is ChildProcess-like (stdout/stderr 'data', 'close',
  // 'error'), streamed by tailing the control dir's log files — so the STEP:
  // progress parsing below works unchanged. The control dir is reused across
  // updates (spawnDetached truncates stale files) and kept afterward as the
  // post-mortem record of the launch.
  const controlDir = join(PATHS.data, 'update-detached');

  // Refuse to reuse the control dir while a prior update script is still
  // running (survival path: the old script outlives the server restart it
  // triggers, and its supervisor's late `exit` write into a truncated control
  // dir would prematurely close the new handle with the OLD script's status).
  // A still-running script also means a second update is wrong regardless.
  if (!isWindows && await isDetachedRunning(controlDir)) {
    const errorMessage = 'A previous update script is still running — wait for it to finish before starting another update';
    await recordUpdateResult({
      version: tag.replace(/^v/, ''),
      success: false,
      completedAt: new Date().toISOString(),
      log: errorMessage
    }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
    emit('starting', 'error', errorMessage);
    return { success: false, failedStep: 'starting', errorMessage };
  }

  const child = isWindows
    ? spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: PATHS.root,
        env: childEnv
      })
    : await spawnDetached(cmd, args, {
        cwd: PATHS.root,
        env: childEnv,
        controlDir
      });

  return new Promise((resolve) => {
    let lastStep = 'starting';

    // Parse STEP:name:status:message lines from stdout/stderr streams
    const makeLineHandler = () => {
      let buffer = '';
      return (data) => {
        buffer += data.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, '');
          buffer = buffer.slice(newlineIdx + 1);
          const match = line.match(/STEP:([^:]+):([^:]+):(.+)/);
          if (match) {
            const [, name, status, message] = match;
            lastStep = name;
            emit(name, status, message);
          }
        }
      };
    };

    // Pipe stdout/stderr for progress tracking, with EPIPE guards
    // in case the parent process exits before the detached child finishes writing
    if (child.stdout) {
      child.stdout.on('error', (err) => { if (err.code !== 'EPIPE') console.error(`⚠️ stdout stream error: ${err.message}`); });
      child.stdout.on('data', makeLineHandler());
    }
    if (child.stderr) {
      child.stderr.on('error', (err) => { if (err.code !== 'EPIPE') console.error(`⚠️ stderr stream error: ${err.message}`); });
      child.stderr.on('data', makeLineHandler());
    }

    child.on('close', async (code, signal) => {
      const success = code === 0;
      const exitDetail = signal ? `killed by ${signal}` : `exit code ${code}`;
      // Record result for both success and failure so updateInProgress gets
      // cleared even if PM2 restart doesn't kill this process.
      if (!success) {
        await recordUpdateResult({
          version: tag.replace(/^v/, ''),
          success: false,
          completedAt: new Date().toISOString(),
          log: `Process ${exitDetail}`
        }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      }
      if (success) {
        // Read the actual version from the completion marker written by the script.
        // Always record a success result so updateInProgress gets cleared even if
        // PM2 restart doesn't kill this process. Falls back to the triggering tag
        // when the marker isn't readable yet.
        let actualVersion = tag.replace(/^v/, '');
        let completedAt = new Date().toISOString();
        const markerPath = join(PATHS.data, 'update-complete.json');
        try {
          const marker = JSON.parse(await readFile(markerPath, 'utf-8'));
          actualVersion = marker.version || actualVersion;
          completedAt = marker.completedAt || completedAt;
        } catch { /* marker may not be readable yet — fall back to triggering tag */ }
        let recorded = false;
        try {
          await recordUpdateResult({
            version: actualVersion,
            success: true,
            completedAt,
            log: ''
          });
          recorded = true;
        } catch (e) {
          console.error(`❌ Failed to record update result: ${e.message}`);
        }
        // Remove marker only after result is persisted so boot-time processing
        // can still recover if this process is killed before recordUpdateResult
        if (recorded) {
          await unlink(markerPath).catch(() => {});
        }
        emit('complete', 'done', 'Update complete — restarting');
        resolve({ success: true, version: actualVersion });
      } else {
        emit(lastStep, 'error', `Update failed at step "${lastStep}" (${exitDetail})`);
        resolve({ success: false, failedStep: lastStep, errorMessage: `Update failed at step "${lastStep}" (${exitDetail})` });
      }
    });

    child.on('error', async (err) => {
      await recordUpdateResult({
        version: tag.replace(/^v/, ''),
        success: false,
        completedAt: new Date().toISOString(),
        log: err.message
      }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      const errorMessage = `Failed to start update: ${err.message}`;
      emit('starting', 'error', errorMessage);
      resolve({ success: false, failedStep: 'starting', errorMessage });
    });

    // Unref so the parent process doesn't wait for the detached child.
    // The spawnDetached handle has no unref (its launcher already unref'd);
    // only the Windows plain-spawn child needs it.
    child.unref?.();
  });
}
