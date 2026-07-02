/**
 * File System Utilities
 *
 * Shared utilities for file operations used across services.
 */

import { access, appendFile, chmod, mkdir, readFile, readdir, stat, writeFile, rename, unlink } from 'fs/promises';
import { existsSync, statSync, createReadStream } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';
import { join, dirname, basename, extname, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { ServerError } from './errorHandler.js';
import { resolveInstallRoot } from './dataRoot.js';

// Promisified execFile — shared so callers (e.g. backup's pg_dump probing)
// don't each re-wrap it. Returns { stdout, stderr }.
export const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

// Cache __dirname calculation for services importing this module
const __lib_filename = fileURLToPath(import.meta.url);
const __lib_dirname = dirname(__lib_filename);

// The executing checkout's root (where THIS file physically lives). Code/source
// paths — the repo root for git ops, `lib/slashdo` — must stay anchored here so
// they always point at the checkout that loaded the code.
const CODE_ROOT = join(__lib_dirname, '../..');

// The install root that holds the runtime `data/` tree. Prefer an explicit
// PORTOS_DATA_ROOT env var over the executing-file location so a process booted
// from inside a CoS agent git worktree resolves `data/` to the real install
// instead of the worktree's empty checkout (#1947). Falls back to CODE_ROOT
// when the env var is unset (the two coincide for a normal install). Only
// `data/*` paths follow this — source/git paths stay on CODE_ROOT.
const INSTALL_ROOT = resolveInstallRoot(CODE_ROOT);

/**
 * MIME types that could execute scripts when served inline — force Content-Disposition: attachment
 */
export const RISKY_MIME_TYPES = new Set(['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript', 'application/xml']);

/**
 * Base directories relative to project root
 */
export const PATHS = {
  root: CODE_ROOT,
  // The data-bearing install root (parent of `data/`). Equals `root` for a
  // normal install; diverges only when PORTOS_DATA_ROOT pins a different tree
  // (worktree boot, #1947). Use this — not `root` — for anything anchored to
  // the `data/` tree but living one level above it (e.g. the migration ledger
  // `data/migrations.applied.json`), so its reader agrees with where boot wrote it.
  installRoot: INSTALL_ROOT,
  data: join(INSTALL_ROOT, 'data'),
  cos: join(INSTALL_ROOT, 'data/cos'),
  brain: join(INSTALL_ROOT, 'data/brain'),
  digitalTwin: join(INSTALL_ROOT, 'data/digital-twin'),
  health: join(INSTALL_ROOT, 'data/health'),
  runs: join(INSTALL_ROOT, 'data/runs'),
  memory: join(INSTALL_ROOT, 'data/cos/memory'),
  cosAgents: join(INSTALL_ROOT, 'data/cos/agents'),  // CoS sub-agents
  scripts: join(INSTALL_ROOT, 'data/cos/scripts'),
  reports: join(INSTALL_ROOT, 'data/cos/reports'),
  // AI Agent Personalities data
  agentPersonalities: join(INSTALL_ROOT, 'data/agents'),
  meatspace: join(INSTALL_ROOT, 'data/meatspace'),
  calendar: join(INSTALL_ROOT, 'data/calendar'),
  messages: join(INSTALL_ROOT, 'data/messages'),
  screenshots: join(INSTALL_ROOT, 'data/screenshots'),
  uploads: join(INSTALL_ROOT, 'data/uploads'),
  cosAttachments: join(INSTALL_ROOT, 'data/cos/attachments'),
  worktrees: join(INSTALL_ROOT, 'data/cos/worktrees'),
  repos: join(INSTALL_ROOT, 'data/repos'),
  browserProfile: join(INSTALL_ROOT, 'data/browser-profile'),
  browserDownloads: join(homedir(), 'Downloads'),
  digests: join(INSTALL_ROOT, 'data/cos/digests'),
  promptSkills: join(INSTALL_ROOT, 'data/prompts/skills'),
  promptSkillsJobs: join(INSTALL_ROOT, 'data/prompts/skills/jobs'),
  decisions: join(INSTALL_ROOT, 'data/cos/decisions'),
  telegram: join(INSTALL_ROOT, 'data/telegram'),
  templates: join(INSTALL_ROOT, 'data/prompts/templates'),
  // Visual template assets (e.g. the character reference-sheet layout PNG used
  // as the init-image anchor by the universe-builder character sheet renderer).
  // Distinct from `templates` above, which is the legacy prompt-template dir.
  // Files here are shipped via data.reference/templates/ on first install.
  visualTemplates: join(INSTALL_ROOT, 'data/templates'),
  settings: join(INSTALL_ROOT, 'data/settings'),
  missions: join(INSTALL_ROOT, 'data/cos/missions'),
  tools: join(INSTALL_ROOT, 'data/tools'),
  images: join(INSTALL_ROOT, 'data/images'),
  // Uploaded multi-reference inputs for FLUX.2 multi-ref edits. Sibling of
  // `images/` rather than a subdir so the gallery's flat `.png` enumeration
  // never surfaces them, and so a future per-render cleanup pass can drop
  // the whole dir without touching the gallery.
  imageRefs: join(INSTALL_ROOT, 'data/image-refs'),
  loras: join(INSTALL_ROOT, 'data/loras'),
  // Per-character LoRA training datasets (collectionStore layout:
  // lora-datasets/<id>/index.json + lora-datasets/<id>/images/*.png).
  // Machine-local like `loras/` — datasets never federate.
  loraDatasets: join(INSTALL_ROOT, 'data/lora-datasets'),
  // LoRA training run artifacts (checkpoints/samples/cache per run). Run
  // RECORDS live in Postgres (lora_training_runs); only artifacts live here.
  trainingRuns: join(INSTALL_ROOT, 'data/training-runs'),
  videos: join(INSTALL_ROOT, 'data/videos'),
  videoThumbnails: join(INSTALL_ROOT, 'data/video-thumbnails'),
  // Persisted audio renders (voice-over lines). Kept distinct from
  // the in-memory voice-agent synthesis path in services/voice/ — that path
  // streams WAV over Socket.IO without ever touching disk.
  audio: join(INSTALL_ROOT, 'data/audio'),
  // Uploaded + (eventually) generated background music tracks. Separate from
  // `audio/` so the user can browse + reuse a track across issues without
  // walking through the VO-line filenames.
  music: join(INSTALL_ROOT, 'data/music'),
  // Extracted assets from third-party imports (ChatGPT export images/audio/
  // PDFs). Served read-only at `/data/brain-imports/...` so the Memory
  // conversation viewer can render inline `![](url)` images and asset links.
  // Flat per-source dir keyed by the asset's globally-unique id, so the same
  // asset referenced from multiple conversations is stored once. The transcript
  // archive JSON lives one level up (data/brain/imports/<source>/) and is NOT
  // served — only this assets subtree is.
  brainImportAssets: join(INSTALL_ROOT, 'data/brain/imports/assets'),
  slashdo: join(CODE_ROOT, 'lib/slashdo')
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
  // mkdir with recursive: true is idempotent - it succeeds if dir exists.
  // BUT on Windows it can intermittently throw UNKNOWN/EPERM/EEXIST even when
  // the directory already exists or is created concurrently — antivirus locks,
  // OneDrive sync, and network/mapped drives all surface spurious failures that
  // the POSIX-modeled `recursive: true` no-op contract doesn't anticipate.
  // Swallow the error when the path is in fact a directory afterward.
  await mkdir(dir, { recursive: true }).catch((err) => {
    if (err?.code === 'EEXIST') return; // already exists — the intended state
    const s = statSync(dir, { throwIfNoEntry: false });
    if (s && s.isDirectory()) {
      console.log(`⚠️ ensureDir swallowed spurious ${err?.code || 'error'} — dir exists: ${dir}`);
      return;
    }
    throw err;
  });
}

/**
 * Async existence check — the non-blocking replacement for `existsSync` on
 * request/hot paths. Resolves true iff `path` is accessible, false otherwise.
 * Never throws (a missing path, permission error, etc. all resolve false), so
 * it drops in wherever `existsSync` guarded a request handler.
 *
 * @param {string} path - File or directory path to test.
 * @returns {Promise<boolean>}
 *
 * @example
 * if (!(await pathExists(filepath))) throw new ServerError('Not found', { status: 404 });
 */
export async function pathExists(path) {
  return access(path).then(() => true, () => false);
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
  // Buffer must pass through unchanged — JSON.stringify on a Buffer produces
  // `{"type":"Buffer","data":[...]}` which corrupts binary writes (PNG, etc.).
  const payload = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2);
  await ensureDir(dirname(filePath));
  // Preserve the destination's existing permission bits. A plain
  // writeFile(existing) truncated the inode in place and kept its mode, but
  // atomicWrite creates a fresh temp inode and renames it over the target —
  // which would silently widen a hand-restricted file (e.g. a `chmod 600`
  // OAuth tokens.json) to the umask default (typically 0644) on every rewrite.
  // Read the destination's mode FIRST and create the temp file with it from
  // the start, so the secret bytes are never written to a world-readable temp
  // (a crash between write and chmod would otherwise leave a readable copy, and
  // a local user could race-read it during the window). A trailing chmod pins
  // the exact mode in case the umask tightened the create below it. New files
  // (stat fails with ENOENT) keep the umask default, exactly as before.
  const existingMode = await stat(filePath).then((s) => s.mode & 0o777, () => null);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tmp, payload, existingMode !== null ? { mode: existingMode } : undefined);
  if (existingMode !== null) {
    await chmod(tmp, existingMode).catch(() => {});
  }
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

// `path.join(homedir(), '/.foo')` discards the homedir prefix because of
// the leading slash, so strip the leading `~/` (or `~\` on Windows) before
// joining. Only expands a leading `~` — embedded `~` chars in path segments
// (e.g. `iCloud~md~obsidian`) are preserved.
export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
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
/**
 * Read a file, returning null on any error (missing file, permission denied, etc.).
 *
 * Collapses the inlined `readFile(path, encoding).catch(() => null)` pattern used
 * across services for "optional file — fall through if absent." For Buffer reads,
 * pass `encoding: null` (or omit when calling with no second arg, default 'utf8').
 *
 * @param {string} filePath - Path to read
 * @param {string|null} [encoding='utf8'] - Encoding (null for Buffer)
 * @returns {Promise<string|Buffer|null>} File contents or null on any read error
 */
export async function tryReadFile(filePath, encoding = 'utf8') {
  return readFile(filePath, encoding).catch(() => null);
}

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
 * Append one JSON-serializable value to a JSON Lines file.
 * Creates the parent directory as needed and writes exactly one trailing
 * newline so readers can stream or split the file without special-casing the
 * final record.
 *
 * @param {string} filePath - Path to JSONL file
 * @param {*} value - JSON-serializable value to append
 * @returns {Promise<void>}
 */
export async function appendJSONLine(filePath, value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('appendJSONLine value must be JSON-serializable');
  }
  await ensureDir(dirname(filePath));
  await appendFile(filePath, serialized + '\n');
}

/**
 * Read JSON Lines with optional offset/limit slicing.
 *
 * @param {string} filePath - Path to JSONL file
 * @param {Object} options - Options
 * @param {number} [options.from=0] - Zero-based record offset
 * @param {number} [options.limit] - Maximum number of records to return
 * @param {boolean} [options.logErrors=false] - Log malformed JSONL lines
 * @returns {Promise<Array>} Parsed records
 */
export async function readJSONLines(filePath, { from = 0, limit, logErrors = false } = {}) {
  const entries = await readJSONLFile(filePath, { logErrors });
  const start = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
  if (limit === undefined || limit === null) return entries.slice(start);
  const count = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 0;
  return entries.slice(start, start + count);
}

/**
 * Replace a JSON Lines file with the supplied records.
 * Intended for compaction/retention and delete/clear flows; hot append paths
 * should use appendJSONLine().
 *
 * @param {string} filePath - Path to JSONL file
 * @param {Array} values - JSON-serializable records
 * @returns {Promise<void>}
 */
export async function writeJSONLines(filePath, values) {
  if (!Array.isArray(values)) {
    throw new TypeError('writeJSONLines values must be an array');
  }
  const lines = values.map((value) => {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('writeJSONLines values must be JSON-serializable');
    }
    return serialized;
  });
  await atomicWrite(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
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
    await atomicWrite(filePath, data);
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
 * Promise-based delay. Canonical replacement for the per-module
 * `const delay = (ms) => new Promise(...)` one-liners.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Truncate an id to a fixed prefix for human-readable log lines. Null-safe
 * so callers can pass a possibly-missing field directly (`shortId(run?.id)`)
 * without an outer truthiness check.
 *
 * @param {*} id - id-like value; coerced to string
 * @param {number} [n=8] - prefix length
 * @returns {string} prefix of length `n`, or `''` when `id` is null/undefined
 */
export function shortId(id, n = 8) {
  if (id == null) return '';
  return String(id).slice(0, n);
}

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
 *
 * Cached: slashdo files are static within a server lifetime (submodule updates
 * require restart). Cache resets on process restart, which is the right behavior.
 */
const slashdoFileCache = new Map();
export async function loadSlashdoFile(commandName, { stripFrontmatter = false } = {}) {
  const cacheKey = `${commandName}::${stripFrontmatter}`;
  if (slashdoFileCache.has(cacheKey)) return slashdoFileCache.get(cacheKey);

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
  slashdoFileCache.set(cacheKey, content);
  return content;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

// =============================================================================
// FILENAME / MIME HELPERS (shared by uploads, attachments, screenshots routes)
// =============================================================================

/**
 * Full extension→MIME map covering documents, images, audio, video, code, and
 * archives accepted by the generic uploads route. The attachments route uses a
 * strict subset — see ATTACHMENT_ALLOWED_EXTENSIONS below.
 *
 * Exported so routes can serve the correct Content-Type header without keeping
 * their own copy. Unknown extensions fall back to 'application/octet-stream'.
 */
export const EXTENSION_MIME_MAP = {
  // Documents
  '.txt':  'text/plain',
  '.md':   'text/markdown',
  '.json': 'application/json',
  '.csv':  'text/csv',
  '.xml':  'application/xml',
  '.yaml': 'application/x-yaml',
  '.yml':  'application/x-yaml',
  '.pdf':  'application/pdf',
  // Images
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.bmp':  'image/bmp',
  // Audio
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.m4a':  'audio/mp4',
  // Video
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  // Code
  '.js':   'text/javascript',
  '.ts':   'text/typescript',
  '.jsx':  'text/javascript',
  '.tsx':  'text/typescript',
  '.py':   'text/x-python',
  '.sh':   'text/x-shellscript',
  '.sql':  'text/x-sql',
  '.html': 'text/html',
  '.css':  'text/css',
  '.go':   'text/x-go',
  '.rs':   'text/x-rust',
  '.java': 'text/x-java',
  '.c':    'text/x-c',
  '.cpp':  'text/x-c++',
  '.h':    'text/x-c',
  // Archives
  '.zip':  'application/zip',
  '.tar':  'application/x-tar',
  '.gz':   'application/gzip',
  '.7z':   'application/x-7z-compressed',
  '.rar':  'application/vnd.rar',
  // Other
  '.log':  'text/plain',
  '.env':  'text/plain',
  '.conf': 'text/plain',
  '.cfg':  'text/plain',
  '.ini':  'text/plain',
};

/**
 * Strict allowlist for file attachments (task attachments, CoS context files).
 * A subset of EXTENSION_MIME_MAP — excludes audio, video, ICO, BMP, and
 * miscellaneous text/config types that are not meaningful attachment types.
 * The attachments route validates against this set; uploads uses the full map.
 */
export const ATTACHMENT_ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf',
  '.js',  '.ts', '.jsx',  '.tsx', '.py',  '.sh',  '.sql', '.html', '.css',
  '.zip', '.tar', '.gz',
]);

/**
 * Look up the MIME type for a file extension (including the leading dot, e.g.
 * ".png"). Returns 'application/octet-stream' for unknown extensions.
 *
 * @param {string} ext - Lowercased extension with leading dot (e.g. '.png')
 * @returns {string} MIME type string
 */
export function getMimeType(ext) {
  return EXTENSION_MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * Magic-byte sniff of an image buffer. The client-supplied extension / MIME is
 * not trustworthy, so when we persist uploaded image bytes (e.g. an author
 * headshot routed into the gallery) we derive the real format from the leading
 * bytes. Recognises PNG, JPEG, WebP, and GIF.
 *
 * @param {Buffer} buf - Raw decoded image bytes
 * @returns {{ format: 'png'|'jpeg'|'webp'|'gif', ext: string, mime: string } | null}
 *   The detected format with its canonical extension + MIME, or null when the
 *   bytes don't match a known image signature.
 */
export function detectImageFormat(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { format: 'png', ext: '.png', mime: 'image/png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { format: 'jpeg', ext: '.jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { format: 'webp', ext: '.webp', mime: 'image/webp' };
  }
  if (buf.length >= 6 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return { format: 'gif', ext: '.gif', mime: 'image/gif' };
  }
  return null;
}

/**
 * Get a file's extension, normalised to lowercase with a leading dot.
 * Returns null when the filename has no extension.
 *
 * @param {string} filename
 * @returns {string|null}
 */
export function getFileExtension(filename) {
  return extname(filename).toLowerCase() || null;
}

/**
 * Sanitize a user-supplied filename to prevent path traversal and filesystem
 * surprises. Strips any directory component, replaces characters that are not
 * alphanumeric / dot / hyphen / underscore with `_`, and ensures the name
 * does not start with a dot (hidden-file prevention).
 *
 * Identical logic was copy-pasted across uploads.js, attachments.js, and
 * screenshots.js — consolidated here so fixes propagate to all callers.
 *
 * @param {string} filename - User-provided filename (possibly with path components)
 * @returns {string} Safe basename
 */
export function sanitizeFilename(filename) {
  const base = basename(filename);
  const sanitized = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (sanitized.startsWith('.')) {
    return '_' + sanitized.slice(1);
  }
  return sanitized;
}

/**
 * Validate a user-supplied filename is a safe basename with one of the
 * allowed extensions — refuses path-traversal, null bytes, separators, and
 * exact `.` / `..`. Throws a 400 ServerError with code VALIDATION_ERROR
 * so calling routes don't have to repeat the check.
 *
 * Consolidates the two near-identical assertions that used to live in
 * `services/loras.js#assertSafeLoraFilename` (`.safetensors` only) and
 * `services/imageGen/local.js#assertGalleryFilename` (`.png` only).
 *
 * Substring `..` is intentionally allowed (e.g. `foo..bar.png` is fine);
 * only the exact-string traversal cases are rejected. Path separators (`/`
 * and `\`) are rejected on every platform — the same input gets posted
 * from Windows clients too.
 *
 * @param {string} filename
 * @param {{ extensions: string[], subject?: string, requiredMessage?: string }} opts
 *   - `extensions`: list of allowed extensions including the leading dot
 *     (`['.png']`, `['.safetensors']`, etc.). Case-insensitive match. Each
 *     entry MUST be a non-empty string starting with `.` — otherwise a bare
 *     suffix like `'png'` would also match `'not-an-imagepng'` and weaken
 *     the validation, so we treat that as a programmer error and throw.
 *   - `subject`: optional noun for the error message ("LoRA filename" →
 *     "Invalid LoRA filename"). Defaults to "filename".
 *   - `requiredMessage`: optional exact message used when `filename` is
 *     missing/empty — preserves backward-compat for wrappers that used to
 *     throw a specific phrase. The gallery wrapper passes `'Invalid filename'`
 *     (its pre-refactor implementation threw that for every failure, including
 *     missing-input); the LoRA wrapper passes `'Filename required'` to match
 *     its historical wording. When omitted, the message is derived from
 *     `subject` (e.g. `'Filename required'` / `'LoRA filename required'`).
 */
export function assertSafeFilename(filename, { extensions, subject = 'filename', requiredMessage } = {}) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error('assertSafeFilename: extensions allowlist is required');
  }
  for (const ext of extensions) {
    if (typeof ext !== 'string' || ext.length < 2 || !ext.startsWith('.')) {
      throw new Error(`assertSafeFilename: each extension must be a non-empty string starting with "." (got ${JSON.stringify(ext)})`);
    }
  }
  const subjectText = subject || 'filename';
  if (!filename || typeof filename !== 'string') {
    const Subject = `${subjectText[0].toUpperCase()}${subjectText.slice(1)}`;
    const message = typeof requiredMessage === 'string' && requiredMessage.length > 0
      ? requiredMessage
      : `${Subject} required`;
    throw new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
  }
  // Null bytes terminate C strings — some POSIX syscalls treat the prefix
  // as a separate path. Reject up front so it can't reach the FS layer.
  if (filename.includes('\0')) {
    throw new ServerError(`Invalid ${subjectText}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const isExactTraversal = filename === '.' || filename === '..';
  const hasSeparator = filename.includes('/') || filename.includes('\\');
  const isPureBasename = basename(filename) === filename;
  // Leading dot is fine for normal hidden files, but combined with the no-
  // separator rule it's already covered above for `.`/`..`. We keep the
  // basename equality check so e.g. `subdir\foo.png` (which has a `\` and
  // also has basename `foo.png`) is still rejected by hasSeparator.
  const lower = filename.toLowerCase();
  const extOk = extensions.some((ext) => lower.endsWith(String(ext).toLowerCase()));
  if (!extOk || hasSeparator || isExactTraversal || !isPureBasename) {
    throw new ServerError(`Invalid ${subjectText}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
}

/**
 * Build a single-root path resolver that returns a function with the same
 * signature as `resolveGalleryImage` / `resolveImageRef` / `resolveTemplateAsset`.
 *
 * Defense in depth (applied on every call):
 *  1. `basename()` strips dirs (so `../../etc/passwd` → `passwd`).
 *  2. Reject `.`/`..`/empty basenames outright.
 *  3. `resolve` + `startsWith(rootPrefix)` so unicode tricks can't escape.
 *  4. Optional extension allow-list (case-insensitive) before any FS syscall.
 *  5. When `mustExist`, `statSync({ throwIfNoEntry: false }).isFile()` rejects
 *     directories (the root itself would otherwise pass an existsSync check
 *     and flow into ffmpeg / image-gen as an "image path" where it'd fail in
 *     confusing ways). Note: `statSync` follows symlinks, so a symlink under
 *     the root pointing to a regular file outside still passes. PortOS is
 *     single-user (see CLAUDE.md "Security Model") so we accept that — for
 *     symlink rejection, swap to `lstatSync`.
 *
 * Pass `{ mustExist: false }` at call time for code paths that intentionally
 * skip the existence check (e.g. when the path is resolved at request time
 * but read later — TOCTOU between resolve and use isn't worth the extra
 * syscall, and the downstream renderer surfaces a clear error if the file
 * vanished).
 *
 * @param {() => string} getRoot - Thunk returning the absolute directory.
 *   A thunk (not a literal) so tests that mutate `PATHS.x` at mock-eval
 *   time still steer the resolver — the value is captured on first call
 *   and cached thereafter (recomputed only if the thunk later returns a
 *   different value, which production code never does).
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] - allowed extensions WITHOUT the leading
 *   dot (`['png', 'jpg', 'jpeg', 'webp']`). When omitted, all extensions are
 *   accepted (matches the legacy gallery/refs behavior — extension checks
 *   happen elsewhere on those paths).
 * @param {boolean} [opts.cache=false] - Memoize successful resolutions. Only
 *   safe for shipped/stable assets (templates) where the basename → path
 *   binding is stable for the process lifetime; never enable for user-mutable
 *   dirs (gallery, refs) since deletions would be masked.
 * @returns {(name: string, opts?: { mustExist?: boolean }) => string|null}
 */
export function makePathResolver(getRoot, { extensions, cache = false } = {}) {
  if (typeof getRoot !== 'function') {
    throw new Error('makePathResolver: getRoot must be a function returning the root dir');
  }
  // Escape regex metacharacters in each extension before interpolating —
  // current callers pass plain alphanumeric tokens (png/jpg/jpeg/webp), but
  // the exported factory shouldn't behave incorrectly if a future caller
  // passes an extension containing `.`/`+`/etc.
  const extRegex = Array.isArray(extensions) && extensions.length > 0
    ? new RegExp(`\\.(${extensions
      .map((e) => String(e).replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})$`, 'i')
    : null;
  const memo = cache ? new Map() : null;
  // Resolved-root cache so the hot path doesn't re-run `resolvePath(root) +
  // PATH_SEP` per call. Recomputes only when `getRoot()` returns a different
  // value — picks up test-time `PATHS.x = ...` mutation on first call, then
  // stays warm for the rest of the process.
  let _root = null;
  let _rootAbsPrefix = null;

  return (name, { mustExist = true } = {}) => {
    if (typeof name !== 'string' || !name) return null;
    const safe = basename(name);
    if (!safe || safe === '.' || safe === '..') return null;
    if (extRegex && !extRegex.test(safe)) return null;
    // Refresh the root cache BEFORE the memo lookup so a getRoot() that
    // suddenly returns a new value (e.g. a test re-mocks `PATHS.x` mid-run)
    // invalidates the memo too — otherwise the old root's cached
    // resolutions would shadow the new root forever.
    const root = getRoot();
    if (root !== _root) {
      _root = root;
      _rootAbsPrefix = resolvePath(root) + PATH_SEP;
      if (memo) memo.clear();
    }
    const cacheKey = memo ? (mustExist ? `must:${safe}` : `nostat:${safe}`) : null;
    if (memo && memo.has(cacheKey)) return memo.get(cacheKey);
    const localPath = resolvePath(join(root, safe));
    if (!localPath.startsWith(_rootAbsPrefix)) return null;
    if (!mustExist) {
      if (memo) memo.set(cacheKey, localPath);
      return localPath;
    }
    // throwIfNoEntry:false swallows ENOENT but not EACCES / transient I/O —
    // treat those as "not a valid reference" too rather than bubbling a 500
    // out of the route layer.
    let resolved = null;
    try {
      const stat = statSync(localPath, { throwIfNoEntry: false });
      resolved = stat?.isFile() ? localPath : null;
    } catch { /* falls through to null */ }
    // Only cache successful resolutions — a missing-then-installed asset
    // should pick up on the next call (e.g. setup-data.js racing a render).
    if (memo && resolved) memo.set(cacheKey, resolved);
    return resolved;
  };
}

/**
 * Resolve a user-supplied gallery image filename to an absolute path under
 * `PATHS.images`. Returns `null` on any failure so callers can decide whether
 * to throw, log-and-skip, or substitute a fallback. See `makePathResolver`
 * for the defense-in-depth checks. Late-binds via a thunk so tests that
 * mutate `PATHS.images` at mock-eval time still steer the resolver.
 */
export const resolveGalleryImage = makePathResolver(() => PATHS.images);

/**
 * Resolve a user-supplied reference-image filename to an absolute path under
 * `PATHS.imageRefs`. Multi-reference uploads land in a sibling dir to keep
 * them out of the gallery enumeration; same defense-in-depth as the gallery
 * resolver but anchored at the refs root.
 */
export const resolveImageRef = makePathResolver(() => PATHS.imageRefs);

/**
 * Resolve a shipped visual template filename (e.g. character reference-sheet
 * layout PNG) to an absolute path under `PATHS.visualTemplates`. Caches
 * successful resolutions because the template assets are shipped and stable
 * for the lifetime of the process — keeps reference-sheet rendering off the
 * statSync hot path.
 */
export const resolveTemplateAsset = makePathResolver(() => PATHS.visualTemplates, {
  extensions: ['png', 'jpg', 'jpeg', 'webp'],
  cache: true,
});

/**
 * Resolve a user-supplied screenshot filename to an absolute path under
 * `PATHS.screenshots`. Used by the vision-test endpoint, whose `imagePath`
 * comes straight from `req.body` — basenaming the input (and rejecting any
 * non-image extension or missing file) stops `../` traversal and absolute-path
 * escapes from reading arbitrary files off disk and forwarding their contents
 * to an external vision provider. Returns `null` on any failure so the caller
 * can surface a clean error. See `makePathResolver` for the defense-in-depth
 * checks. Late-binds via a thunk so tests that mutate `PATHS.screenshots` still
 * steer the resolver.
 */
export const resolveScreenshot = makePathResolver(() => PATHS.screenshots, {
  extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
});

/**
 * Resolve any user-supplied image input (init image OR multi-reference image)
 * to an absolute path under one of PortOS's approved image roots — the
 * gallery (`PATHS.images`), the multi-ref upload dir (`PATHS.imageRefs`),
 * or the shipped visual-template dir (`PATHS.visualTemplates`). Used by the
 * image-gen runner to re-validate paths that originated from internal
 * features (gallery picks, reference-sheet renders) which may legitimately
 * cross dir boundaries.
 *
 * Accepts both basename input (`"foo.png"`) and already-resolved absolute
 * paths (the local image-gen runner re-validates the same input on every
 * call so we need to accept both shapes).
 *
 * @param {string} rawPath - basename or absolute path
 * @returns {string|null} validated absolute path, or null
 */
// Pairs of (PATHS-key, resolver). Read PATHS at CALL time so tests that
// mutate `PATHS.x` at mock-eval time still steer the prefix dispatch — a
// module-load snapshot would freeze the pre-mock paths.
const IMAGE_INPUT_RESOLVERS = [
  ['images', resolveGalleryImage],
  ['imageRefs', resolveImageRef],
  ['visualTemplates', resolveTemplateAsset],
];

export function resolveImageInputPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return null;
  // For ABSOLUTE inputs, dispatch by prefix. The single-root resolvers
  // basename their input for defense-in-depth, so trying them in order on an
  // absolute path can silently redirect a `/data/templates/foo.png` input
  // to `/data/images/foo.png` whenever a same-named file lives in the gallery.
  // Validate against the matching root only.
  const resolvedInput = resolvePath(rawPath);
  for (const [key, resolver] of IMAGE_INPUT_RESOLVERS) {
    const rootPrefix = resolvePath(PATHS[key]) + PATH_SEP;
    if (resolvedInput.startsWith(rootPrefix)) return resolver(rawPath);
  }
  // For basename / relative input (no matching prefix), fall through the
  // resolvers in order. First match wins; basename collisions across roots
  // are accepted as ambiguous and resolve to the first defined root.
  for (const [, resolver] of IMAGE_INPUT_RESOLVERS) {
    const candidate = resolver(rawPath);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * List a directory, keep entries whose extension matches `extensions`, stat
 * each, and project the survivors through `mapEntry(name, fullPath, stat)`.
 * Three sibling helpers (listLoras / listGallery / listMusicLibrary) used to
 * spell this loop out by hand — collapsed onto one primitive so the dir-
 * missing fallback, extension filter, and stat-failure handling all stay in
 * sync.
 *
 * - `extensions`: array of lowercased extensions including the leading dot
 *   (`['.png']`, `['.mp3', '.wav', ...]`). Matched against `extname(name)`
 *   case-insensitively so `FOO.PNG` and `foo.png` both pass.
 * - `mapEntry`: async/sync `(name, fullPath, stat) => entry|null`. Return
 *   `null` to drop the entry. Final array preserves readdir order minus drops.
 * - `requireRegularFile` (default `true`): when true, entries whose stat
 *   reports `!isFile()` are dropped before `mapEntry` runs (skips directories
 *   with matching extensions). Pass `false` to match the gallery's legacy
 *   behavior (only drops on stat failure).
 *
 * Missing directory → `[]` (no surprise 500 on a fresh install). Stat errors
 * on individual entries → drop that entry (matches the prior per-site
 * `.catch(() => null)` pattern).
 */
export async function listDirectoryByExtension(dir, { extensions, mapEntry, requireRegularFile = true } = {}) {
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error('listDirectoryByExtension: extensions allowlist is required');
  }
  if (typeof mapEntry !== 'function') {
    throw new Error('listDirectoryByExtension: mapEntry must be a function');
  }
  const allowed = new Set(extensions.map((e) => String(e).toLowerCase()));
  const names = await readdir(dir).catch((err) => {
    if (err?.code === 'ENOENT') return [];
    throw err;
  });
  const filtered = names.filter((name) => allowed.has((extname(name) || '').toLowerCase()));
  const entries = await Promise.all(filtered.map(async (name) => {
    const fullPath = join(dir, name);
    const s = await stat(fullPath).catch(() => null);
    if (!s) return null;
    if (requireRegularFile && !s.isFile()) return null;
    return mapEntry(name, fullPath, s);
  }));
  return entries.filter((v) => v != null);
}

// Size in bytes of every file under `path`. Shells out to `du -sk` (or
// PowerShell on Windows) — orders of magnitude faster than walking with
// node's recursive readdir on large trees (hundreds of GB / 200k+ files).
// Returns 0 + logs on failure (missing tool, permission denied, timeout) so
// the Media Models endpoint stays responsive even on unusual systems instead
// of throwing and 500ing the whole route.
export async function dirSize(path) {
  if (!existsSync(path)) return 0;
  if (IS_WIN) {
    // Pass the path via an env var so a literal apostrophe in the path can't
    // close the PowerShell string and inject commands.
    const result = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      '(Get-ChildItem -Recurse -File $Env:DIRSIZE_TARGET | Measure-Object -Property Length -Sum).Sum',
    ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DIRSIZE_TARGET: path } }).catch((err) => ({ error: err }));
    if (result.error) {
      console.log(`⚠️ dirSize(${path}) failed: ${result.error.message}`);
      return 0;
    }
    return parseInt(result.stdout.trim(), 10) || 0;
  }
  const result = await execFileAsync('du', ['-sk', path], { encoding: 'utf8', timeout: 60_000 }).catch((err) => ({ error: err }));
  if (result.error) {
    console.log(`⚠️ dirSize(${path}) failed: ${result.error.message}`);
    return 0;
  }
  const kb = parseInt(result.stdout.split('\t')[0], 10) || 0;
  return kb * 1024;
}

/**
 * SHA-256 a file as hex. One-shot read under 512 KB; streams above so multi-GB
 * videos don't blow heap. Threshold matches `server/services/backup.js`'s
 * snapshot manifest generator.
 */
const SHA256_STREAM_THRESHOLD = 512 * 1024;
export async function sha256File(path) {
  const info = await stat(path);
  if (info.size < SHA256_STREAM_THRESHOLD) {
    const buf = await readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  }
  return new Promise((resolve, reject) => {
    const hasher = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.pipe(hasher);
    hasher.on('finish', () => resolve(hasher.digest('hex')));
    hasher.on('error', reject);
  });
}
