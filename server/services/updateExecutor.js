import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { recordUpdateResult } from './updateChecker.js';

const UPDATE_SH = join(PATHS.root, 'update.sh');
const UPDATE_PS1 = join(PATHS.root, 'update.ps1');

/**
 * Execute the PortOS update script (git pull to latest).
 * Spawns update.sh (or update.ps1 on Windows) detached so it survives
 * the Node process dying during the PM2 restart phase.
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
export async function executeUpdate(tag, emit) {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'powershell' : 'bash';
  const args = isWindows
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UPDATE_PS1]
    : [UPDATE_SH];

  emit('starting', 'running', `Starting update (target: ${tag})...`);

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: PATHS.root
    });

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

    // Unref so the parent process doesn't wait for the detached child
    child.unref();
  });
}
