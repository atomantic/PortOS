/**
 * Minimal .env parse/upsert helpers for setup scripts.
 *
 * ZERO external dependencies — these run before/around `npm install`.
 * Do NOT import from server/lib or any installed package.
 */

import { readFileSync, writeFileSync } from 'fs';

/**
 * Parse a .env file into a key/value map.
 * Tolerates blank lines, # comments, and optional surrounding single/double
 * quotes around values. Returns {} when the file is missing or unreadable.
 *
 * @param {string} filePath - absolute path to the .env file
 * @returns {Record<string, string>}
 */
export function parseEnvFile(filePath) {
  const result = {};
  let content = '';
  try { content = readFileSync(filePath, 'utf8'); } catch { return result; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

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
