/**
 * yt-dlp discovery — mirrors `findFfmpeg()` in `./ffmpeg.js`. yt-dlp is a
 * system binary (not an npm dependency), same "install it yourself" posture
 * as ffmpeg: a Python-based downloader isn't something PortOS should vendor
 * or auto-install.
 */

import { existsSync } from 'fs';
import { whichFirst } from './processEnv.js';

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
  cachedYtDlpPath = await whichFirst('yt-dlp');
  return cachedYtDlpPath;
};

/**
 * Forget the resolved path so the next `findYtDlp()` probes disk again.
 *
 * An in-place update can relink the keg under a different prefix, and an
 * install performed while the server is running has to become visible without a
 * restart — both would otherwise keep serving the cached answer (including the
 * cached `null` from before the install).
 */
export const resetYtDlpCache = () => { cachedYtDlpPath = undefined; };
