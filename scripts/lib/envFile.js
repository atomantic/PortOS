/**
 * Minimal .env parse/upsert helpers for setup scripts.
 *
 * ZERO external dependencies — these run before/around `npm install`.
 * Do NOT import from server/lib or any installed package.
 */

import { randomBytes } from 'crypto';
import { chmodSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import envFileParser from './envFile.cjs';

// The grammar lives in envFile.cjs so ecosystem.config.cjs (PM2) parses `.env`
// exactly as setup does; see that file for the supported syntax.
export const { parseEnvContent, parseEnvFile, resolveHttpMirrorPort } = envFileParser;

/** Mirror port for a repo root, from exported env then that root's saved `.env`. */
export function resolveHttpMirrorPortForRoot(root) {
  return resolveHttpMirrorPort({ dotenv: parseEnvFile(join(root, '.env')) });
}

/**
 * Set (or add) a single key in a .env file without touching other lines.
 * Existing active declarations converge to one updated line in-place.
 * If it doesn't exist, `KEY=value` is prepended so the file starts with the
 * new entry. Creates the file if it doesn't exist yet.
 *
 * @param {string} filePath - absolute path to the .env file
 * @param {string} key      - env var name (e.g. 'PGMODE')
 * @param {string} value    - unquoted value to write
 */
export function upsertEnvKey(filePath, key, value) {
  let content = '';
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=`);
  let replaced = false;
  const lines = content.split('\n').flatMap(line => {
    if (!pattern.test(line)) return [line];
    if (replaced) return [];
    replaced = true;
    // Construct directly so dollar sequences in the value stay literal.
    return [`${key}=${value}${line.endsWith('\r') ? '\r' : ''}`];
  });
  content = replaced ? lines.join('\n') : `${key}=${value}\n${content}`;
  // Follow an existing symlink so a symlinked .env updates its target on the
  // same filesystem instead of replacing the link, then stage into a fresh
  // 0600 temp file and atomically replace it.
  let targetPath = filePath;
  try {
    targetPath = realpathSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tmpPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmpPath, content, { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
