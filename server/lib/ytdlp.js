/**
 * Discover the system yt-dlp binary for video downloads and imports. Reset the
 * cached lookup after a package change so it takes effect without a restart.
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

/** Forget the resolved path so the next `findYtDlp()` probes disk again: an in-place update can relink the keg under another prefix and an install while running must become visible, else the cached answer (including a cached `null`) keeps serving. */
export const resetYtDlpCache = () => { cachedYtDlpPath = undefined; };
