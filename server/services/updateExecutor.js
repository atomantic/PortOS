import { spawn } from 'child_process';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { recordUpdateResult } from './updateChecker.js';

const UPDATE_SH = join(PATHS.root, 'update.sh');
const UPDATE_PS1 = join(PATHS.root, 'update.ps1');

/**
 * Execute the PortOS update script for a given release tag.
 * Spawns update.sh (or update.ps1 on Windows) detached so it survives
 * the Node process dying during the PM2 restart phase.
 *
 * @param {string} tag - The git tag to update to (e.g. "v1.27.0")
 * @param {function} emit - Callback (step, status, message) for progress
 * @returns {Promise<{success: boolean, failedStep?: string, errorMessage?: string}>}
 */
export async function executeUpdate(tag, emit) {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'powershell' : 'bash';
  const args = isWindows ? ['-ExecutionPolicy', 'Bypass', '-File', UPDATE_PS1] : [UPDATE_SH];

  emit('starting', 'running', `Starting update to ${tag}...`);

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
          const line = buffer.slice(0, newlineIdx);
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
      await recordUpdateResult({
        version: tag.replace(/^v/, ''),
        success,
        completedAt: new Date().toISOString(),
        log: success ? '' : `Process ${exitDetail}`
      }).catch(e => console.error(`❌ Failed to record update result: ${e.message}`));
      if (success) {
        emit('complete', 'done', `Update to ${tag} complete`);
      } else {
        emit(lastStep, 'error', `Update failed at step "${lastStep}" (${exitDetail})`);
      }
      resolve(success
        ? { success: true }
        : { success: false, failedStep: lastStep, errorMessage: `Update failed at step "${lastStep}" (${exitDetail})` }
      );
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
