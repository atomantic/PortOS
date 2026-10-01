/**
 * Dependency-free `.env` parser — the single owner of PortOS's pre-install
 * `.env` grammar, shared by setup (`scripts/lib/envFile.js`, ESM) and the PM2
 * config (`ecosystem.config.cjs`, CJS).
 *
 * ZERO external dependencies and no imports from server/ — both consumers run
 * before/around `npm install`. CommonJS so `require()` works on every supported
 * Node version and from the PM2 config, while ESM callers import it by default.
 */
'use strict';

const { readFileSync } = require('fs');

/**
 * Parse `.env` text into a key/value map.
 * Tolerates blank lines, # comments, whitespace around keys, `=` and values,
 * CRLF line endings, and optional surrounding single/double quotes around values
 * (quotes are removed; spaces inside them are preserved).
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseEnvContent(content) {
  const result = {};
  for (const line of String(content).split('\n')) {
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
 * Parse a .env file. Returns {} when the file is missing or unreadable.
 *
 * @param {string} filePath - absolute path to the .env file
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
  let content = '';
  try { content = readFileSync(filePath, 'utf8'); } catch { return {}; }
  return parseEnvContent(content);
}

module.exports = { parseEnvContent, parseEnvFile };
