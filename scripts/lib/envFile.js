/**
 * Minimal .env parse/upsert helpers for setup scripts.
 *
 * ZERO external dependencies — these run before/around `npm install`.
 * Do NOT import from server/lib or any installed package.
 */

import { readFileSync, writeFileSync } from 'fs';
import envFileParser from './envFile.cjs';

// The grammar lives in envFile.cjs so ecosystem.config.cjs (PM2) parses `.env`
// exactly as setup does; see that file for the supported syntax.
export const { parseEnvContent, parseEnvFile } = envFileParser;

/**
 * Set (or add) a single key in a .env file without touching other lines.
 * If the key already exists, its line is replaced in-place.
 * If it doesn't exist, `KEY=value` is prepended so the file starts with the
 * new entry. Creates the file if it doesn't exist yet.
 *
 * @param {string} filePath - absolute path to the .env file
 * @param {string} key      - env var name (e.g. 'PGMODE')
 * @param {string} value    - unquoted value to write
 */
export function upsertEnvKey(filePath, key, value) {
  let content = '';
  try { content = readFileSync(filePath, 'utf8'); } catch { /* no .env yet */ }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}=.*`, 'm');
  if (pattern.test(content)) {
    // Replacer FUNCTION (not a string) so `$`-sequences in `value` (e.g. a
    // password like `p$$word` or `$&`) are written literally instead of being
    // interpreted as String.replace special patterns.
    content = content.replace(pattern, () => `${key}=${value}`);
  } else {
    content = `${key}=${value}\n${content}`;
  }
  writeFileSync(filePath, content);
}
