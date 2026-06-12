/**
 * Cross-platform "open folder in system file manager" helper.
 *
 * Extracted from routes/brain.js POST /links/:id/open-folder.
 * The child process is detached and unref'd so the spawned file manager
 * outlives the Node process without blocking it. The child 'error' handler
 * is wired so a spawn failure (e.g. missing xdg-open on a headless server)
 * logs rather than crashing the Node process.
 */

import { spawn } from 'child_process';

/**
 * Open a local path in the system file manager (Finder / Explorer / Nautilus).
 *
 * @param {string} localPath - Absolute path to open.
 * @returns {void}
 */
export function openFolderInSystemExplorer(localPath) {
  let cmd, args;
  const platform = process.platform;

  if (platform === 'darwin') {
    cmd = 'open';
    args = [localPath];
  } else if (platform === 'win32') {
    cmd = 'explorer';
    args = [localPath];
  } else {
    cmd = 'xdg-open';
    args = [localPath];
  }

  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => {
    console.error(`❌ openFolderInSystemExplorer spawn failed (${cmd}): ${err.message}`);
  });
  child.unref();
  console.log(`📂 Opened folder: ${localPath}`);
}
