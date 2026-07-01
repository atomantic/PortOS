/**
 * yt-dlp discovery — mirrors `findFfmpeg()` in `./ffmpeg.js`. yt-dlp is a
 * system binary (not an npm dependency), same "install it yourself" posture
 * as ffmpeg: a Python-based downloader isn't something PortOS should vendor
 * or auto-install.
 */

import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';
import { safeChildProcessEnv } from './processEnv.js';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

let cachedYtDlpPath;
export const findYtDlp = async () => {
  if (cachedYtDlpPath !== undefined) return cachedYtDlpPath;
  const candidates = IS_WIN
    ? ['C:\\Program Files\\yt-dlp\\yt-dlp.exe']
    : ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  for (const p of candidates) {
    if (existsSync(p)) { cachedYtDlpPath = p; return p; }
  }
  const cmd = IS_WIN ? 'where' : 'which';
  const { stdout } = await execFileAsync(cmd, ['yt-dlp'], { env: safeChildProcessEnv(), timeout: 5000 }).catch(() => ({ stdout: '' }));
  cachedYtDlpPath = stdout.trim().split(/\r?\n/)[0] || null;
  return cachedYtDlpPath;
};
