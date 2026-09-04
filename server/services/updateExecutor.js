import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { spawnDetached, isDetachedRunning } from '../lib/detachedSpawn.js';
import { getCurrentVersion, recordUpdateResult } from './updateChecker.js';

const UPDATE_SH = join(PATHS.root, 'update.sh');
const UPDATE_PS1 = join(PATHS.root, 'update.ps1');

/**
 * Execute the PortOS update script (git pull to latest).
 *
 * The script is launched via spawnDetached so it leaves this process's tree and
 * SURVIVES pm2's TreeKill. A plain `spawn(..., { detached: true })` does NOT
 * survive: pm2 walks PPID (`ps -e -o pid=,ppid=`), not the process group, so
 * when update.sh reaches its `pm2-stop` step (`pm2 delete ecosystem.config.cjs`)
 * the script itself — still a PPID-child of portos-server — was tree-killed with
 * the server, leaving every app stopped with nothing alive to run the final
 * `pm2 start` (the reconcile/update "shuts down but never comes back" failure).
 * See the rationale in `server/lib/detachedSpawn.js`.
 *
 * Windows escapes the same way for the same reason (pm2 kills there with
 * `taskkill /T`, which walks the identical tree), and CANNOT use a plain
 * `detached: true`: on Windows that flag means DETACHED_PROCESS, which denies
 * the child a console — powershell then exits 0 within ~100ms without running a
 * single line of update.ps1, and this function used to report that as a
 * successful update to the target release (#6169). spawnDetached's Windows
 * supervisor handles that internally, so no option is needed here.
 *
 * The scripts pull the latest code via `git pull --rebase --autostash` and
 * write the actual resulting version to `data/update-complete.json`.
 * The `tag` parameter is used only for logging and the initial API response;
 * the true post-update version is determined by the script from package.json.
 *
 * @param {string} tag - The release tag that triggered the update (for logging)
 * @param {function} emit - Callback (step, status, message) for progress
 * @param {object} [options]
 * @param {string[]} [options.forceCleanWorkspaces] - workspaces to reinstall from scratch
 * @param {function} [options.onLaunched] - called once the script is spawned, before
 *   the returned promise starts tracking its lifetime
 * @returns {Promise<{success: boolean, version?: string, failedStep?: string, errorMessage?: string}>}
 */
// Workspaces update.sh / update.ps1 know how to clean-reinstall — the env
// passthrough is allowlisted to these so nothing arbitrary reaches the scripts.
const CLEANABLE_WORKSPACES = new Set(['.', 'client', 'server', 'autofixer']);

export async function executeUpdate(tag, emit, { forceCleanWorkspaces, onLaunched } = {}) {
  const targetVersion = tag.replace(/^v/, '');
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
  const childEnv = { ...process.env };
  if (cleanList.length) {
    childEnv.PORTOS_FORCE_CLEAN_WORKSPACES = cleanList.join(',');
  } else {
    delete childEnv.PORTOS_FORCE_CLEAN_WORKSPACES;
  }

  // spawnDetached launches the script outside this process's tree (POSIX
  // double-fork, Windows supervisor) so it survives the pm2 TreeKill its own
  // `pm2 delete`/`pm2 start` steps trigger. The returned handle is
  // ChildProcess-like (stdout/stderr 'data', 'close', 'error'), streamed by
  // tailing the control dir's log files — so the STEP: progress parsing below
  // works unchanged. The control dir is reused across updates (spawnDetached
  // truncates stale files) and kept afterward as the post-mortem record of the
  // launch.
  const controlDir = join(PATHS.data, 'update-detached');

  // Refuse to reuse the control dir while a prior update script is still
  // running (survival path: the old script outlives the server restart it
  // triggers, and its supervisor's late `exit` write into a truncated control
  // dir would prematurely close the new handle with the OLD script's status).
  // A still-running script also means a second update is wrong regardless.
  if (await isDetachedRunning(controlDir, { executable: cmd, args })) {
    const errorMessage = 'A previous update script is still running — wait for it to finish before starting another update';
    await recordUpdateResult({
      version: targetVersion,
      success: false,
      completedAt: new Date().toISOString(),
      log: errorMessage
    }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
    emit('starting', 'error', errorMessage);
    return { success: false, failedStep: 'starting', errorMessage };
  }

  const child = await spawnDetached(cmd, args, {
    cwd: PATHS.root,
    env: childEnv,
    controlDir,
    // The default 250ms cadence is calibrated for trainer/render output; this
    // job emits one human-paced `STEP:` line per multi-second stage, so a
    // quarter of the syscalls buys the same perceived progress.
    pollMs: 1000
  });

  // The script is running from here on. Everything ABOVE can still refuse (a
  // prior update script is still alive) or throw (spawn error); nothing below
  // can — the returned promise then tracks the script's whole lifetime. A
  // caller that must tell "the launch failed" from "the update failed" waits on
  // this signal rather than on the promise. See `portosSelfUpdate`'s launch gate.
  onLaunched?.();

  return new Promise((resolve) => {
    let lastStep = 'starting';
    // Whether the script ever reported a step. A run that exits 0 without one
    // never executed the script — the scripts emit `git-pull:running` before
    // touching anything — so it must not be recorded as a completed update.
    let sawStep = false;

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
            // The synthetic 'starting' step means "we launched the script"; the
            // first real step proves that, so close it out instead of leaving
            // it spinning for the rest of the update.
            if (!sawStep) {
              sawStep = true;
              emit('starting', 'done', 'Update script running');
            }
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
      // Exit 0 alone is not proof the update ran. A launch that never executed
      // the script exits 0 with no output at all, and stamping the triggering
      // tag onto that is how a Windows install reported "v2.57.0 — Success"
      // while still sitting on the old version (#6169). Both scripts emit
      // `git-pull:running` before they touch anything, so no step at all means
      // no update — the same absent-vs-empty distinction the LLM-merge rule in
      // AGENTS.md draws, applied to progress output.
      const success = code === 0 && sawStep;
      const errorMessage = code === 0
        ? 'Update script exited 0 without reporting any progress — it never ran'
        : `Update failed at step "${lastStep}" (${signal ? `killed by ${signal}` : `exit code ${code}`})`;
      // Record result for both success and failure so updateInProgress gets
      // cleared even if PM2 restart doesn't kill this process.
      if (!success) {
        await recordUpdateResult({
          version: targetVersion,
          success: false,
          completedAt: new Date().toISOString(),
          log: errorMessage
        }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      }
      if (success) {
        // Read the actual version from the completion marker written by the script.
        // Always record a success result so updateInProgress gets cleared even if
        // PM2 restart doesn't kill this process.
        let actualVersion = null;
        let completedAt = null;
        const markerPath = join(PATHS.data, 'update-complete.json');
        try {
          const marker = JSON.parse(await readFile(markerPath, 'utf-8'));
          actualVersion = marker.version || null;
          completedAt = marker.completedAt || null;
        } catch { /* marker consumed/unreadable — fall back below */ }
        // No marker usually means the restarted server already consumed it, so
        // the version that stands is the one on disk — NOT the triggering tag:
        // package.json is what the install actually runs, while the tag is only
        // what we aimed at (#6169).
        if (!actualVersion) actualVersion = await getCurrentVersion().catch(() => targetVersion);
        if (!completedAt) completedAt = new Date().toISOString();
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
        emit(lastStep, 'error', errorMessage);
        resolve({ success: false, failedStep: lastStep, errorMessage });
      }
    });

    child.on('error', async (err) => {
      await recordUpdateResult({
        version: targetVersion,
        success: false,
        completedAt: new Date().toISOString(),
        log: err.message
      }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      const errorMessage = `Failed to start update: ${err.message}`;
      emit('starting', 'error', errorMessage);
      resolve({ success: false, failedStep: 'starting', errorMessage });
    });

    // Nothing to unref: spawnDetached's handle is a plain EventEmitter tailing
    // the control dir, and its launcher already unref'd the process it spawned.
  });
}
