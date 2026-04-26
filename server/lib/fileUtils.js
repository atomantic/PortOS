/**
 * File System Utilities
 *
 * Shared utilities for file operations used across services.
 */

import { mkdir, readFile, writeFile, rename, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

// Cache __dirname calculation for services importing this module
const __lib_filename = fileURLToPath(import.meta.url);
const __lib_dirname = dirname(__lib_filename);

/**
 * MIME types that could execute scripts when served inline — force Content-Disposition: attachment
 */
export const RISKY_MIME_TYPES = new Set(['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/xml']);

/**
 * Base directories relative to project root
 */
export const PATHS = {
  root: join(__lib_dirname, '../..'),
  data: join(__lib_dirname, '../../data'),
  cos: join(__lib_dirname, '../../data/cos'),
  brain: join(__lib_dirname, '../../data/brain'),
  digitalTwin: join(__lib_dirname, '../../data/digital-twin'),
  health: join(__lib_dirname, '../../data/health'),
  runs: join(__lib_dirname, '../../data/runs'),
  memory: join(__lib_dirname, '../../data/cos/memory'),
  cosAgents: join(__lib_dirname, '../../data/cos/agents'),  // CoS sub-agents
  scripts: join(__lib_dirname, '../../data/cos/scripts'),
  reports: join(__lib_dirname, '../../data/cos/reports'),
  // AI Agent Personalities data
  agentPersonalities: join(__lib_dirname, '../../data/agents'),
  meatspace: join(__lib_dirname, '../../data/meatspace'),
  calendar: join(__lib_dirname, '../../data/calendar'),
  messages: join(__lib_dirname, '../../data/messages'),
  screenshots: join(__lib_dirname, '../../data/screenshots'),
  uploads: join(__lib_dirname, '../../data/uploads'),
  cosAttachments: join(__lib_dirname, '../../data/cos/attachments'),
  worktrees: join(__lib_dirname, '../../data/cos/worktrees'),
  repos: join(__lib_dirname, '../../data/repos'),
  browserProfile: join(__lib_dirname, '../../data/browser-profile'),
  browserDownloads: join(__lib_dirname, '../../data/browser-downloads'),
  digests: join(__lib_dirname, '../../data/cos/digests'),
  promptSkills: join(__lib_dirname, '../../data/prompts/skills'),
  promptSkillsJobs: join(__lib_dirname, '../../data/prompts/skills/jobs'),
  cosEvolution: join(__lib_dirname, '../../data/cos/evolution'),
  decisions: join(__lib_dirname, '../../data/cos/decisions'),
  telegram: join(__lib_dirname, '../../data/telegram'),
  templates: join(__lib_dirname, '../../data/prompts/templates'),
  settings: join(__lib_dirname, '../../data/settings'),
  missions: join(__lib_dirname, '../../data/cos/missions'),
  tools: join(__lib_dirname, '../../data/tools'),
  images: join(__lib_dirname, '../../data/images'),
  loras: join(__lib_dirname, '../../data/loras'),
  videos: join(__lib_dirname, '../../data/videos'),
  videoThumbnails: join(__lib_dirname, '../../data/video-thumbnails'),
  slashdo: join(__lib_dirname, '../../lib/slashdo')
};

/**
 * Ensure a directory exists, creating it recursively if needed.
 * Uses mkdir with recursive: true which is idempotent and avoids TOCTOU races.
 *
 * @param {string} dir - Directory path to ensure exists
 * @returns {Promise<void>}
 *
 * @example
 * await ensureDir(PATHS.data);
 * await ensureDir('/custom/path/to/dir');
 */
export async function ensureDir(dir) {
  // mkdir with recursive: true is idempotent - it succeeds if dir exists
  await mkdir(dir, { recursive: true });
}

/**
 * Ensure multiple directories exist.
 *
 * @param {string[]} dirs - Array of directory paths to ensure exist
 * @returns {Promise<void>}
 *
 * @example
 * await ensureDirs([PATHS.data, PATHS.cos, PATHS.memory]);
 */
export async function ensureDirs(dirs) {
  for (const dir of dirs) {
    await ensureDir(dir);
  }
}

/**
 * Atomically write data to a file via temp-file + rename.
 * Guarantees readers never see a partial write. Accepts a string or any JSON-
 * serializable value (objects are stringified with 2-space indentation).
 *
 * @param {string} filePath - Destination file path
 * @param {string|object} data - String or JSON-serializable value
 * @returns {Promise<void>}
 *
 * @example
 * await atomicWrite(FILE, { version: 1, items: [] });
 * await atomicWrite(LOG_FILE, 'raw string content');
 */
export async function atomicWrite(filePath, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, payload);
  // Node's fs.rename uses MoveFileExW with MOVEFILE_REPLACE_EXISTING on Windows (atomic
  // overwrite), but still fails with EPERM/EACCES if the destination is locked (AV scan,
  // concurrent reader). Fall back to a backup-swap so the original file is never lost.
  const replace = async () => {
    const err = await rename(tmp, filePath).then(() => null, (e) => e);
    if (!err) return;
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EEXIST'].includes(err.code)) {
      const bak = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.bak`;
      const hadExisting = await rename(filePath, bak).then(() => true, (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      });
      const renameErr = await rename(tmp, filePath).then(() => null, (e) => e);
      if (renameErr) {
        if (hadExisting) await rename(bak, filePath).catch(() => {});
        throw renameErr;
      }
      if (hadExisting) await unlink(bak).catch(() => {});
      return;
    }
    throw err;
  };
  try {
    await replace();
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Get a path relative to the data directory.
 *
 * @param {...string} segments - Path segments to join
 * @returns {string} Full path under data directory
 *
 * @example
 * const filePath = dataPath('cos', 'state.json');
 * // Returns: /path/to/project/data/cos/state.json
 */
export function dataPath(...segments) {
  return join(PATHS.data, ...segments);
}

/**
 * Check if a string is potentially valid JSON.
 * Performs quick structural validation before parsing.
 *
 * @param {string} str - String to validate
 * @param {Object} options - Validation options
 * @param {boolean} [options.allowArray=true] - Allow array JSON (default: true)
 * @returns {boolean} True if the string appears to be valid JSON
 *
 * @example
 * isValidJSON('{"key": "value"}') // true
 * isValidJSON('[1, 2, 3]') // true
 * isValidJSON('') // false
 * isValidJSON('{"incomplete":') // false
 */
export function isValidJSON(str, { allowArray = true } = {}) {
  if (!str || !str.trim()) return false;
  const trimmed = str.trim();

  // Check for basic JSON structure (object or array)
  const isObject = trimmed.startsWith('{') && trimmed.endsWith('}');
  const isArray = trimmed.startsWith('[') && trimmed.endsWith(']');

  if (!isObject && !(allowArray && isArray)) return false;

  return true;
}

/**
 * Extract JSON array from string that may contain ANSI codes or other noise.
 * Useful for parsing pm2 jlist output which may include warnings before the JSON.
 *
 * @param {string} str - String potentially containing JSON array
 * @returns {string} Extracted JSON or '[]' if not found
 */
export function extractJSONArray(str) {
  if (!str) return '[]';
  // Look for '[{' (array with objects) first
  let jsonStart = str.indexOf('[{');
  if (jsonStart < 0) {
    // Check for empty array - find '[]' that's not part of ANSI codes like [31m
    const emptyMatch = str.match(/\[\](?![0-9])/);
    jsonStart = emptyMatch ? str.indexOf(emptyMatch[0]) : -1;
  }
  return jsonStart >= 0 ? str.slice(jsonStart) : '[]';
}

/**
 * Safely parse JSON with validation and fallback.
 * Avoids "Unexpected end of JSON input" errors from empty/corrupted files.
 * For arrays, automatically extracts JSON from strings with ANSI codes/noise (e.g., pm2 output).
 *
 * @param {string} str - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails (default: null)
 * @param {Object} options - Parse options
 * @param {boolean} [options.allowArray=true] - Allow array JSON
 * @param {boolean} [options.logError=false] - Log parsing errors
 * @param {string} [options.context=''] - Context for error logging
 * @returns {*} Parsed JSON or default value
 *
 * @example
 * safeJSONParse('{"key": "value"}', {}) // { key: "value" }
 * safeJSONParse('', {}) // {}
 * safeJSONParse('invalid', []) // []
 * safeJSONParse(null, { default: true }) // { default: true }
 */
export function safeJSONParse(str, defaultValue = null, { allowArray = true, logError = false, context = '' } = {}) {
  // For arrays, try to extract JSON from noisy output (e.g., pm2 with ANSI codes)
  if (allowArray && Array.isArray(defaultValue) && str && !str.trim().startsWith('[')) {
    str = extractJSONArray(str);
  }

  if (!isValidJSON(str, { allowArray })) {
    if (logError && str) {
      console.warn(`Invalid JSON${context ? ` in ${context}` : ''}: empty or malformed content`);
    }
    return defaultValue;
  }

  // Attempt actual parse - the validation above catches structural issues
  // but syntax errors like trailing commas still need handling
  try {
    return JSON.parse(str);
  } catch (err) {
    if (logError) {
      console.warn(`Failed to parse JSON${context ? ` in ${context}` : ''}: ${err.message}`);
    }
    return defaultValue;
  }
}

/**
 * Read a JSON file safely with validation and default fallback.
 * Combines file reading with safe JSON parsing.
 *
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Default value if file doesn't exist or is invalid
 * @param {Object} options - Options
 * @param {boolean} [options.allowArray=true] - Allow array JSON
 * @param {boolean} [options.logError=true] - Log errors
 * @returns {Promise<*>} Parsed JSON or default value
 *
 * @example
 * const config = await readJSONFile('./config.json', { port: 3000 });
 * const items = await readJSONFile('./items.json', []);
 */
export async function readJSONFile(filePath, defaultValue = null, { allowArray = true, logError = true } = {}) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    // ENOENT = file doesn't exist, return default silently
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    // Log other I/O errors if requested
    if (logError) {
      console.warn(`Failed to read file ${filePath}: ${err.message}`);
    }
    return defaultValue;
  }
  return safeJSONParse(content, defaultValue, { allowArray, logError, context: filePath });
}

/**
 * Parse JSONL (JSON Lines) content safely.
 * Handles empty lines, whitespace, and malformed lines gracefully.
 *
 * @param {string} content - JSONL content (newline-separated JSON objects)
 * @param {Object} options - Options
 * @param {boolean} [options.logErrors=false] - Log individual line parsing errors
 * @param {string} [options.context=''] - Context for error logging
 * @returns {Array} Array of parsed objects (invalid lines are skipped)
 *
 * @example
 * const lines = safeJSONLParse('{"a":1}\n{"b":2}\n'); // [{ a: 1 }, { b: 2 }]
 * const lines = safeJSONLParse('{"a":1}\ninvalid\n{"b":2}'); // [{ a: 1 }, { b: 2 }]
 */
export function safeJSONLParse(content, { logErrors = false, context = '' } = {}) {
  if (!content || !content.trim()) return [];

  // Split on CRLF or LF to handle both Windows and Unix line endings
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const results = [];

  for (const line of lines) {
    const parsed = safeJSONParse(line, null, { allowArray: false, logError: logErrors, context });
    if (parsed !== null) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Read a JSONL file safely.
 *
 * @param {string} filePath - Path to JSONL file
 * @param {Object} options - Options
 * @param {boolean} [options.logErrors=false] - Log individual line parsing errors
 * @returns {Promise<Array>} Array of parsed objects
 *
 * @example
 * const entries = await readJSONLFile('./logs.jsonl');
 */
export async function readJSONLFile(filePath, { logErrors = false } = {}) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    // ENOENT = file doesn't exist, return empty array silently
    if (err.code === 'ENOENT') {
      return [];
    }
    // Log other I/O errors if requested
    if (logErrors) {
      console.warn(`Failed to read file ${filePath}: ${err.message}`);
    }
    return [];
  }
  return safeJSONLParse(content, { logErrors, context: filePath });
}

/**
 * Time constants in milliseconds.
 * Single source of truth — import these instead of declaring inline.
 */
/**
 * Create a cached JSON file store with TTL-based invalidation.
 * Eliminates the repeated cache/load/save/invalidate pattern across services.
 *
 * @param {string} filePath - Path to the JSON file
 * @param {*} defaultValue - Default value when file doesn't exist
 * @param {Object} options
 * @param {number} [options.ttl=2000] - Cache TTL in milliseconds
 * @param {string} [options.context=''] - Context label for error logging
 * @returns {{ load, save, invalidateCache }}
 */
export function createCachedStore(filePath, defaultValue, { ttl = 2000, context = '' } = {}) {
  let cache = null;
  let cacheTimestamp = 0;
  const dir = dirname(filePath);
  // Safe clone for plain JSON defaults (structuredClone requires Node 17+)
  const cloneDefault = () => JSON.parse(JSON.stringify(defaultValue));

  const load = async () => {
    const now = Date.now();
    if (cache && (now - cacheTimestamp) < ttl) return cache;
    await ensureDir(dir);
    if (!existsSync(filePath)) {
      cache = cloneDefault();
      cacheTimestamp = now;
      return cache;
    }
    const content = await readFile(filePath, 'utf-8');
    cache = safeJSONParse(content, cloneDefault(), { context });
    cacheTimestamp = now;
    return cache;
  };

  const save = async (data) => {
    await ensureDir(dir);
    await writeFile(filePath, JSON.stringify(data, null, 2));
    cache = data;
    cacheTimestamp = Date.now();
  };

  const invalidateCache = () => {
    cache = null;
    cacheTimestamp = 0;
  };

  return { load, save, invalidateCache };
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Format a date as YYYY-MM-DD string.
 *
 * @param {Date} [date=new Date()] - Date to format
 * @returns {string} ISO date string (e.g., "2026-03-05")
 */
export function getDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Outputs the most appropriate unit (minutes, hours, days) based on size.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "5m", "2h 30m", "3d 5h")
 *
 * @example
 * formatDuration(30000)    // "0m"
 * formatDuration(300000)   // "5m"
 * formatDuration(7200000)  // "2h 0m"
 * formatDuration(90000000) // "1d 1h"
 */
/**
 * UUID v4 regex pattern for validating account/entity IDs.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Safely parse a date value to epoch milliseconds.
 * Returns 0 for invalid/missing dates instead of NaN.
 *
 * @param {string|Date|number} d - Date value to parse
 * @returns {number} Epoch milliseconds, or 0 if invalid
 */
export function safeDate(d) {
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Generic search filter — returns items where any of the specified fields
 * contain the search string (case-insensitive).
 *
 * @param {Array<Object>} items - Items to filter
 * @param {string} search - Search query
 * @param {Array<string>} fields - Dot-notation field paths to search (e.g., 'from.name')
 * @returns {Array<Object>} Filtered items
 */
export function filterBySearch(items, search, fields) {
  if (!search) return items;
  const q = search.toLowerCase();
  return items.filter(item =>
    fields.some(field => {
      const val = field.includes('.') ? field.split('.').reduce((o, k) => o?.[k], item) : item[field];
      return val?.toLowerCase?.().includes(q);
    })
  );
}

export function formatDuration(ms) {
  if (!ms) return '0m';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    const remainingMins = mins % 60;
    return `${hours}h ${remainingMins}m`;
  }
  return `${mins}m`;
}

/**
 * Load a slashdo command markdown file, resolving !`cat ~/.claude/lib/...` includes.
 * Optionally strips YAML frontmatter.
 */
export async function loadSlashdoFile(commandName, { stripFrontmatter = false } = {}) {
  const cmdPath = join(PATHS.slashdo, 'commands/do', `${commandName}.md`);
  let content = await readFile(cmdPath, 'utf-8').catch(() => null);
  if (!content) return null;
  if (stripFrontmatter) {
    content = content.replace(/^---[\s\S]*?---\s*/, '');
  }
  const libDir = join(PATHS.slashdo, 'lib');
  const matches = [...content.matchAll(/!`cat ~\/.claude\/lib\/([^`]+)`/g)];
  const replacements = await Promise.all(matches.map(async (match) => {
    const libContent = await readFile(join(libDir, match[1]), 'utf-8').catch(() => null);
    return { pattern: match[0], content: libContent };
  }));
  for (const { pattern, content: libContent } of replacements) {
    if (libContent) content = content.replace(pattern, libContent);
  }
  return content;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

// Size in bytes of every file under `path`. Shells out to `du -sk` (or
// PowerShell on Windows) — orders of magnitude faster than walking with
// node's recursive readdir on large trees (hundreds of GB / 200k+ files).
export async function dirSize(path) {
  if (!existsSync(path)) return 0;
  if (IS_WIN) {
    // Pass the path via an env var so a literal apostrophe in the path can't
    // close the PowerShell string and inject commands.
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      '(Get-ChildItem -Recurse -File $Env:DIRSIZE_TARGET | Measure-Object -Property Length -Sum).Sum',
    ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DIRSIZE_TARGET: path } });
    return parseInt(stdout.trim(), 10) || 0;
  }
  const { stdout } = await execFileAsync('du', ['-sk', path], { encoding: 'utf8', timeout: 60_000 });
  const kb = parseInt(stdout.split('\t')[0], 10) || 0;
  return kb * 1024;
}
