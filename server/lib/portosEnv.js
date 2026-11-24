/**
 * Single server-side helper for reading and writing PortOS's own `.env`.
 *
 * Single server-side helper for PortOS's own `.env` (`PORTOS_ENV_PATH` anchored to `installRoot`, `parseEnvContents`, `readPortosEnvValue`, `upsertPortosEnvLine` + `upsertEnvLine`, shared per-file `queuePortosEnvWrite`
 * for settings and vault provisioning), with a replacer-function guard so values are written literally (String.replace `$`-patterns included). Machine-local runtime state (`LLM_BACKEND`, `VLLM_QWEN_PROJECT_DIR`) is recorded here
 * to survive restarts without a dotenv loader; the file lives at the **install root**, not the executing checkout's (a server booted from a CoS agent worktree with `PORTOS_DATA_ROOT` pinned, #1947, would write a throwaway file).
 *
 * **Precedence (settled here, once):** an exported `process.env` value is this run's decision and wins; the `.env` record is durable memory and loses. A stale/invalid `.env` marker must never mask a valid `process.env` override:
 * validate each source before falling through, never `||` on mere presence (see `localLlm.js#getBackend`, `vllmQwenProject.js#resolveVllmProjectDir`).
 * `scripts/lib/envFile.js` stays the zero-dependency copy (it runs before/around `npm install` and must not import `server/lib`): two implementations across that boundary is the right number.
 */

import { readFileSync } from 'fs';
import { chmod } from 'fs/promises';
import { join, resolve } from 'path';
import { PATHS, atomicWrite } from './fileUtils.js';
import { escapeRegExp } from './textUtils.js';
import { createKeyedFileWriteQueue } from './fileWriteQueue.js';

/** PortOS's own `.env`, anchored to `installRoot`, not `root` (#1947): machine-local state belongs to the install, not whichever checkout loaded the code. */
export const PORTOS_ENV_PATH = join(PATHS.installRoot || PATHS.root || '', '.env');

const queueEnvWrite = createKeyedFileWriteQueue();

/** Serialize the whole read-modify-write transaction, including vault key provisioning, per file; callers must not re-acquire this queue inside their transaction. Independent files keep independent queues. */
export function queuePortosEnvWrite(envPath, write) {
  return queueEnvWrite(resolve(envPath), write);
}

function getDefaultEnvPath() {
  return join(PATHS.installRoot || PATHS.root || '', '.env');
}

/**
 * Which keys a `.env` already mentions, keyed on *mention* not truthiness: a commented-out key is absent, an empty-string value is present (an operator writing `EXTRA_ARGS=` meant it).
 *
 * @param {string} contents
 * @returns {Map<string, string>} key → value, with surrounding quotes stripped
 */
export function parseEnvContents(contents) {
  const found = new Map();
  for (const line of String(contents || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!found.has(key)) found.set(key, value);
  }
  return found;
}

/**
 * Add lines to the end of a `.env`, or return it unchanged when there are none. A file not ending in a newline would otherwise splice the first new key onto the operator's last line.
 *
 * @param {string} base
 * @param {string[]} lines
 * @returns {string}
 */
function appendEnvLines(base, lines) {
  const text = String(base || '');
  if (lines.length === 0) return text;
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${separator}${lines.join('\n')}\n`;
}

/**
 * Set ONE key, replacing its first active declaration and removing duplicates (whitespace-tolerant like the readers; normalizing only this key makes first- and last-assignment readers agree).
 *
 * @param {string} contents
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function upsertEnvLine(contents, key, value) {
  const text = String(contents || '');
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let replaced = false;
  const lines = text.split('\n').flatMap(line => {
    if (!pattern.test(line)) return [line];
    if (replaced) return [];
    replaced = true;
    return [`${key}=${value}${line.endsWith('\r') ? '\r' : ''}`];
  });
  return replaced ? lines.join('\n') : appendEnvLines(text, [`${key}=${value}`]);
}

/**
 * Read a single key from the PortOS `.env` file.
 *
 * @param {string} key - env var name
 * @param {string} [envPath] - absolute path to the .env file (injectable for tests)
 * @returns {string|null} value, or null when missing/unreadable
 */
export function readPortosEnvValue(key, envPath) {
  const path = envPath ?? getDefaultEnvPath();
  let contents = '';
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const found = parseEnvContents(contents);
  return found.has(key) ? found.get(key) : null;
}

/**
 * Set (or add) a single key in the PortOS `.env` file, async over `atomicWrite`; existing active declarations converge to one line.
 *
 * @param {string} key - env var name
 * @param {string} value - unquoted value to write
 * @param {string} [envPath] - absolute path to the .env file (injectable for tests)
 * @returns {Promise<void>}
 */
export async function upsertPortosEnvLine(key, value, envPath) {
  const path = envPath ?? getDefaultEnvPath();
  return queuePortosEnvWrite(path, async () => {
    let contents = '';
    let isNew = false;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (err) {
      // Only a missing file is an empty start; another read failure (EACCES, EMFILE, EIO) would rewrite .env as this one line, dropping PGPASSWORD, PRIVACY_VAULT_KEY and the rest.
      if (err.code !== 'ENOENT') throw err;
      isNew = true;
    }
    const next = upsertEnvLine(contents, key, value);
    await atomicWrite(path, next);
    if (isNew) {
      await chmod(path, 0o600).catch((err) => {
        if (err?.code !== 'ENOENT') console.log(`⚠️ Could not set permissions on .env (${err?.code || 'error'})`);
      });
    }
  });
}
