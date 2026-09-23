// Host probes and authentication for the iTerm2 scripting API (#8114).
//
// Three tiers, cheapest first:
//   - detectItermInstall(): platform + app bundle + `EnableAPIServer` pref.
//     No AppleScript, no socket — cheap enough for the instance-feature
//     detector, and memoized for 30s.
//   - isItermRunning(): AppleScript `application "iTerm2" is running`, which
//     never launches the app.
//   - requestItermCookie(): AppleScript `request cookie and key`. A bare
//     `tell application` LAUNCHES iTerm2, so this is only ever called after a
//     positive running check. The cookie and key are secrets: never log them.

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { execFile } from '../lib/childProcess.js';

const execFileAsync = promisify(execFile);

export const ITERM_APP_NAME = 'PortOS';
const PROBE_TIMEOUT_MS = 10_000;
const INSTALL_MEMO_MS = 30_000;

export const itermSocketPath = () => join(homedir(), 'Library', 'Application Support', 'iTerm2', 'private', 'socket');

const itermAppPaths = () => ['/Applications/iTerm.app', join(homedir(), 'Applications', 'iTerm.app')];

const readApiServerEnabled = async () => {
  const { stdout } = await execFileAsync('defaults', ['read', 'com.googlecode.iterm2', 'EnableAPIServer'], { timeout: PROBE_TIMEOUT_MS })
    .catch(() => ({ stdout: '' }));
  return stdout.trim() === '1';
};

let installMemo = null;

/**
 * @returns {Promise<{ state: 'unsupported-platform'|'not-installed'|'api-disabled'|'ready' }>}
 */
export async function detectItermInstall({ now = Date.now() } = {}) {
  if (installMemo && now - installMemo.at < INSTALL_MEMO_MS) return installMemo.value;
  let state = 'ready';
  if (process.platform !== 'darwin') state = 'unsupported-platform';
  else if (!itermAppPaths().some((path) => existsSync(path))) state = 'not-installed';
  else if (!await readApiServerEnabled()) state = 'api-disabled';
  installMemo = { at: now, value: { state } };
  return installMemo.value;
}

export const __resetItermInstallMemo = () => { installMemo = null; };

const runAppleScript = async (script) => {
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: PROBE_TIMEOUT_MS });
  return stdout.trim();
};

export async function isItermRunning() {
  if (process.platform !== 'darwin') return false;
  const answer = await runAppleScript('application "iTerm2" is running').catch(() => 'false');
  return answer === 'true';
}

/** Fresh `{ cookie, key }` for one connection attempt. Throws on failure. */
export async function requestItermCookie() {
  const answer = await runAppleScript(`tell application "iTerm2" to request cookie and key for app named "${ITERM_APP_NAME}"`);
  const [cookie, key] = answer.split(/\s+/);
  if (!cookie || !key) throw new Error('iTerm2 returned no cookie');
  return { cookie, key };
}
