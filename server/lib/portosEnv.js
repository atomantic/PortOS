/**
 * Single server-side helper for reading/writing PortOS's own `.env`.
 *
 * PortOS records machine-local runtime state (e.g. `LLM_BACKEND`,
 * `VLLM_QWEN_PROJECT_DIR`) in the install's `.env` so it survives restarts
 * without a dotenv loader. The file lives at the **install root**, not the
 * executing checkout's root: a server booted from a CoS agent worktree
 * (`PORTOS_DATA_ROOT` pinned, #1947) has no `.env` in its own checkout, and
 * anchoring to `PATHS.root` there would write a throwaway file the real
 * install never reads.
 *
 * **Precedence (settled here, once):** an exported `process.env` value is this
 * run's decision and wins; the `.env` record is durable memory and loses. A
 * stale/invalid `.env` marker must never mask a valid `process.env` override —
 * validate each source before falling through, don't `||` on mere presence.
 * See `localLlm.js#getBackend` and `vllmQwenProject.js#resolveVllmProjectDir`
 * for the two call sites that apply this rule.
 *
 * `scripts/lib/envFile.js` stays as is — its header states it must have zero
 * dependencies and must not import from `server/lib`, because it runs
 * before/around `npm install`. Two implementations across that boundary is the
 * correct number; four is not.
 *
 * Values containing `$&` / `$`` / `$'` are written via a replacer *function*
 * so `String.replace` does not expand them.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { PATHS, atomicWrite } from './fileUtils.js';
import { escapeRegExp } from './textUtils.js';

/**
 * PortOS's own `.env` — where machine-local state is recorded.
 *
 * Anchored to `installRoot`, not `root` (#1947). What is recorded here is
 * machine-local runtime state, so it belongs to the install and not to
 * whichever checkout loaded the code.
 */
export const PORTOS_ENV_PATH = join(PATHS.installRoot || PATHS.root || '', '.env');

function getDefaultEnvPath() {
  return join(PATHS.installRoot || PATHS.root || '', '.env');
}

/**
 * Which keys a `.env` already mentions.
 *
 * Deliberately keyed on *mention*, not on truthiness: a commented-out key is
 * treated as absent (it is not in effect), while a key set to the empty string
 * is treated as present, because an operator who wrote `EXTRA_ARGS=` meant it.
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
 * Add lines to the end of a `.env`, or return it unchanged when there are none.
 *
 * The separator is the whole point: a file not ending in a newline would splice
 * the first new key onto the operator's last line and silently corrupt both.
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
 * Set ONE key, replacing the line that already declares it.
 *
 * The replacement is a FUNCTION, not a string. A value carrying one of
 * String.replace's special $-patterns would otherwise be expanded into the
 * surrounding text instead of written literally.
 *
 * @param {string} contents
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function upsertEnvLine(contents, key, value) {
  const text = String(contents || '');
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
  return pattern.test(text)
    ? text.replace(pattern, () => `${key}=${value}`)
    : appendEnvLines(text, [`${key}=${value}`]);
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
 * Set (or add) a single key in the PortOS `.env` file.
 *
 * Async over `atomicWrite`, with the replacer-function guard for `$`-patterns.
 * If the key already exists, its line is replaced in-place; otherwise it is
 * appended with proper newline handling.
 *
 * @param {string} key - env var name
 * @param {string} value - unquoted value to write
 * @param {string} [envPath] - absolute path to the .env file (injectable for tests)
 * @returns {Promise<void>}
 */
export async function upsertPortosEnvLine(key, value, envPath) {
  const path = envPath ?? getDefaultEnvPath();
  let contents = '';
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    // no .env yet
  }
  const next = upsertEnvLine(contents, key, value);
  await atomicWrite(path, next);
}
