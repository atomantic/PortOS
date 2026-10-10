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

const DEFAULT_HTTP_MIRROR_PORT = 5553;

/**
 * Effective loopback HTTP-mirror port (`PORTOS_HTTP_PORT`). Precedence matches
 * the other machine-local settings: NONEMPTY exported value, then saved `.env`,
 * then the canonical default. A value that is not an integer TCP port (1-65535)
 * is skipped (falls through to the next source), so every consumer — PM2 config,
 * setup/access/browser helpers — resolves the same port (#10950).
 *
 * @param {{ env?: Record<string, string|undefined>, dotenv?: Record<string, string> }} [sources]
 * @returns {number}
 */
function resolveHttpMirrorPort({ env = process.env, dotenv = {} } = {}) {
  for (const raw of [env.PORTOS_HTTP_PORT, dotenv.PORTOS_HTTP_PORT]) {
    const text = String(raw ?? '').trim();
    if (!/^\d+$/.test(text)) continue;
    const port = Number(text);
    if (port >= 1 && port <= 65535) return port;
  }
  return DEFAULT_HTTP_MIRROR_PORT;
}

module.exports = { parseEnvContent, parseEnvFile, resolveHttpMirrorPort, DEFAULT_HTTP_MIRROR_PORT };
