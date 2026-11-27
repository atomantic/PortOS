/**
 *  JSON, JSONL, and cached-store file IO helpers.
 *
 * JSON/JSONL parsing and file IO, strict read sentinels, append/read/write helpers, and
 * `createCachedStore` — a TTL-cached mutable JSON document with serialized `save`/`mutate`; its
 * `load()` is strict (#4115) so a corrupt file rejects instead of being overwritten by the next
 * `mutate`.
 */
import { open, readFile, readdir, stat } from 'fs/promises';
import { basename, dirname } from 'path';
import { appendFileGuarded, atomicWrite, ensureDir, sleep } from './fileCore.js';
import { createFileWriteQueue } from './fileWriteQueue.js';

const isWindows = () => process.platform === 'win32';
const WIN_RETRY_ATTEMPTS = 5;
const WIN_RETRY_DELAY_MS = 10;
const WIN_READ_LOCK_CODES = ['EPERM', 'EACCES', 'EBUSY'];

/**
 * Index of the first JSON array token in `str`, or -1. Split out of
 * `extractJSONArray` because that erases "found nothing" into a manufactured
 * '[]', which would forge a trustworthy EMPTY for `readJSONFileStrict`.
 *
 * @param {string} str
 * @returns {number} Index of the array start, or -1
 */
function findJSONArrayStart(str) {
  if (!str) return -1;
  const objectStart = str.indexOf('[{');
  if (objectStart >= 0) return objectStart;
  const emptyMatch = str.match(/\[\](?![0-9])/);
  return emptyMatch ? str.indexOf(emptyMatch[0]) : -1;
}

/**
 * Extract JSON array from string that may contain ANSI codes or other noise.
 * Useful for parsing pm2 jlist output which may include warnings before the JSON.
 *
 * @param {string} str - String potentially containing JSON array
 * @returns {string} Extracted JSON or '[]' if not found
 */
export function extractJSONArray(str) {
  const jsonStart = findJSONArrayStart(str);
  return jsonStart >= 0 ? str.slice(jsonStart) : '[]';
}

/**
 * Safely parse JSON with fallback. For array defaults, extracts the JSON from
 * noisy strings (e.g. pm2 output with ANSI codes).
 *
 * @param {string} str - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails (default: null)
 * @param {Object} options - Parse options
 * @param {boolean} [options.allowArray=true] - Allow array JSON
 * @param {boolean} [options.logError=false] - Log parsing errors
 * @param {string} [options.context=''] - Context for error logging
 * @returns {*} Parsed JSON or default value
 *
 */
export function safeJSONParse(str, defaultValue = null, { allowArray = true, logError = false, context = '' } = {}) {
  if (allowArray && Array.isArray(defaultValue) && str && !str.trim().startsWith('[')) {
    str = extractJSONArray(str);
  }

  if (!str || !str.trim()) {
    if (logError && str) {
      console.warn(`⚠️ Invalid JSON${context ? ` in ${context}` : ''}: empty or malformed content`);
    }
    return defaultValue;
  }

  try {
    const parsed = JSON.parse(str);
    if (!allowArray && Array.isArray(parsed)) {
      if (logError) {
        console.warn(`⚠️ Invalid JSON${context ? ` in ${context}` : ''}: array not allowed`);
      }
      return defaultValue;
    }
    return parsed;
  } catch (err) {
    if (logError) {
      console.warn(`⚠️ Failed to parse JSON${context ? ` in ${context}` : ''}: ${err.message}`);
    }
    return defaultValue;
  }
}

/**
 * Read a file, returning null on any error. Like `readJSONFile` this conflates
 * "absent" with "unreadable"; when a fake empty would be a lie, use
 * `tryReadFileStrict` (bytes) or `readJSONFileStrict` (JSON).
 *
 * @param {string} filePath - Path to read
 * @param {string|null} [encoding='utf8'] - Encoding (null for Buffer)
 * @returns {Promise<string|Buffer|null>} File contents or null on any read error
 */
export async function tryReadFile(filePath, encoding = 'utf8') {
  return readFile(filePath, encoding).catch(() => null);
}

/**
 * `tryReadFile` that reports whether the read is TRUSTWORTHY, for callers that
 * parse or count the contents themselves.
 *
 * - ENOENT -> `{ ok: true, value: null }` (nothing here yet)
 * - other read error (EACCES, EIO, EISDIR) -> `{ ok: false, value: null }`
 * - read -> `{ ok: true, value: contents }`
 *
 * Shares the Windows swap-window retries with `readJSONFileStrict`.
 *
 * @param {string} filePath
 * @param {string|null} [encoding='utf8'] - null for Buffer
 * @returns {Promise<{ ok: boolean, value: string|Buffer|null }>}
 */
export async function tryReadFileStrict(filePath, encoding = 'utf8') {
  return readWithSwapRetry(filePath, encoding).then(
    (value) => ({ ok: true, value }),
      // Only ENOENT proves absence; anything else could not be confirmed.
    (err) => ({ ok: err?.code === 'ENOENT', value: null })
  );
}

/**
 * Read at most `maxBytes` from the END of a file, as UTF-8: the bounded-memory
 * counterpart to `tryReadFile` for unbounded append-only logs and spools.
 *
 * Non-throwing: missing / unopenable / read error -> `null`; zero-byte file -> `''`.
 *
 * The window starts at a BYTE offset, so the first line may be partial (even
 * mid-multibyte character); callers splitting on newlines should drop it.
 *
 * @param {string} path
 * @param {number} maxBytes - Maximum trailing bytes to read
 * @returns {Promise<string|null>}
 */
export async function readFileTail(path, maxBytes) {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  if (info.size === 0) return '';
  const start = Math.max(0, info.size - maxBytes);
  const length = info.size - start;
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(length);
    // Honour bytesRead: a shrunk file or short read would otherwise append NULs; failure stays null.
    const result = await handle.read(buffer, 0, length, start).catch(() => null);
    if (result === null) return null;
    return buffer.toString('utf8', 0, result.bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

// Unique Symbol for "the parse produced nothing usable": any in-band marker
// could legitimately BE the parsed value.
const PARSE_FAILED = Symbol('json-parse-failed');

/**
 * True when a `<filePath>.*.bak` sibling exists: an `atomicWrite` backup swap is
 * mid-flight, the only window in which the destination legitimately vanishes.
 *
 * Does NOT match `.tmp`: it exists on every write including a first-ever create,
 * so treating it as a swap would turn "not written yet" into a retry returning
 * brand-new contents. Non-throwing; only consulted on win32 after an ENOENT. An
 * orphaned `.bak` costs the bounded retry budget (~50ms), never a wrong answer.
 *
 * Matching is case-INSENSITIVE because NTFS/FAT casing may differ from what
 * `readdir` reports.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function hasSwapSibling(filePath) {
  const entries = await readdir(dirname(filePath)).catch(() => null);
  if (!entries) return false;
  const prefix = `${basename(filePath).toLowerCase()}.`;
  return entries.some((entry) => {
    const name = entry.toLowerCase();
    return name.startsWith(prefix) && name.endsWith('.bak');
  });
}

/**
 * Error for a missing canonical file that has a legacy `.bak` sibling: the only
 * copy of the data may live at the backup path. Deliberately NOT ENOENT, so both
 * strict readers report it as unreadable/recovery-required instead of absent.
 * Carries no file contents; the guide is docs/TROUBLESHOOTING.md.
 */
function orphanedBackupError(filePath, cause) {
  const err = new Error(`${basename(filePath)} is missing but a ${basename(filePath)}.*.bak backup sibling exists — recovery required; stop writers and restore it manually (see docs/TROUBLESHOOTING.md "Recovering a store with an orphaned .bak file")`, { cause });
  err.code = 'EBACKUP_ORPHANED';
  return err;
}

/**
 * `readFile` with Windows-only retries so a read racing `atomicWrite` is not
 * mistaken for an empty/absent file. POSIX is a straight delegate.
 *
 * On win32, retried with short backoff:
 * - EPERM/EACCES/EBUSY: momentarily locked destination (AV scan, writer's handle).
 * - ENOENT, only when `hasSwapSibling` shows a backup swap in flight; a
 *   never-written file stays one failed read, no retry.
 *
 * Rejects with the last error once attempts are exhausted.
 *
 * @param {string} filePath
 * @param {string|null} [encoding='utf-8'] - null for Buffer
 * @returns {Promise<string|Buffer>}
 */
async function readWithSwapRetry(filePath, encoding = 'utf-8') {
  if (!isWindows()) return readFile(filePath, encoding);
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await readFile(filePath, encoding).then((content) => ({ content }), (err) => ({ err }));
    if (!outcome.err) {
      if (attempt > 0) console.log(`⚠️ read succeeded after ${attempt} retry(s) — write swap in flight: ${basename(filePath)}`);
      return outcome.content;
    }
    const last = attempt >= WIN_RETRY_ATTEMPTS - 1;
    // Retries exhausted on a vanished file with a `.bak` sibling: the canonical copy was lost; never report absent.
    if (last && outcome.err.code === 'ENOENT' && await hasSwapSibling(filePath)) throw orphanedBackupError(filePath, outcome.err);
    const retriable = WIN_READ_LOCK_CODES.includes(outcome.err.code)
      || (outcome.err.code === 'ENOENT' && !last && await hasSwapSibling(filePath));
    if (last || !retriable) throw outcome.err;
    await sleep(WIN_RETRY_DELAY_MS);
  }
}

/**
 * Read a JSON file, reporting whether the read is TRUSTWORTHY instead of
 * collapsing every failure into the default.
 *
 * - ENOENT -> `{ ok: true, value: defaultValue }` (a genuine empty)
 * - other read error (EACCES, EIO, EISDIR) -> `{ ok: false, value: defaultValue }`
 * - unparseable / truncated -> `{ ok: false, value: defaultValue }`
 * - parsed -> `{ ok: true, value: parsed }`
 *
 * `value` is always populated so an `ok`-indifferent caller behaves like
 * `readJSONFile`, which is implemented on top of this.
 *
 * @param {string} filePath
 * @param {*} defaultValue - Returned whenever the file yields no parsed value
 * @param {Object} options
 * @param {boolean} [options.allowArray=true]
 * @param {boolean} [options.logError=true]
 * @returns {Promise<{ ok: boolean, value: * }>}
 */
export async function readJSONFileStrict(filePath, defaultValue = null, { allowArray = true, logError = true } = {}) {
  let content;
  try {
    content = await readWithSwapRetry(filePath);
  } catch (err) {
    // ENOENT is a trustworthy "nothing here yet" (win32 swap windows were retried above).
    if (err.code === 'ENOENT') {
      return { ok: true, value: defaultValue };
    }
    if (logError) {
      console.warn(`⚠️ Failed to read file ${filePath}: ${err.message}`);
    }
    return { ok: false, value: defaultValue };
  }

  // Mirror safeJSONParse's noisy-output extraction here (its array check keys off
  // `defaultValue`, but we pass a non-array sentinel). Not via `extractJSONArray`:
  // its manufactured '[]' would forge a trustworthy empty out of unreadable bytes.
  let text = content;
  if (allowArray && Array.isArray(defaultValue) && text && !text.trim().startsWith('[')) {
    const arrayStart = findJSONArrayStart(text);
    if (arrayStart >= 0) text = text.slice(arrayStart);
  }

  const parsed = safeJSONParse(text, PARSE_FAILED, { allowArray, logError, context: filePath });
  if (parsed === PARSE_FAILED) return { ok: false, value: defaultValue };

  // An array default means the caller expects a list and calls `.filter`/`.find` on it, so an object root is not a usable read.
  if (allowArray && Array.isArray(defaultValue) && !Array.isArray(parsed)) {
    if (logError) {
      console.warn(`⚠️ Expected a JSON array in ${filePath}, got ${parsed === null ? 'null' : typeof parsed}`);
    }
    return { ok: false, value: defaultValue };
  }

  return { ok: true, value: parsed };
}

/**
 * Stable request-facing error for a durable JSON store whose bytes could not
 * be trusted. Callers may surface the code without exposing the local path;
 * the message keeps the path for server logs and direct service diagnostics.
 */
export function unreadableStoreError(filePath) {
  return Object.assign(new Error(`Unreadable JSON file: ${filePath}`), {
    status: 500,
    code: 'UNREADABLE_STORE',
    responseMessage: 'Durable data store is unreadable',
  });
}

/**
 * Read a JSON file with default fallback.
 *
 * By default this SWALLOWS every failure (missing, unreadable, corrupt) and
 * returns `defaultValue`. That is wrong when the value is counted or shown to
 * the user, where a fake empty reads as fact; those callers pass
 * `{ strict: true }` or use `readJSONFileStrict`.
 *
 * @param {string} filePath
 * @param {*} defaultValue
 * @param {Object} options
 * @param {boolean} [options.allowArray=true]
 * @param {boolean} [options.logError=true]
 * @param {boolean} [options.strict=false] - Throw when the file exists but is unreadable or corrupt; ENOENT still returns `defaultValue`.
 * @returns {Promise<*>}
 * @throws {Error} Only when `strict` and the file is present-but-unreadable/corrupt
 */
export async function readJSONFile(filePath, defaultValue = null, { allowArray = true, logError = true, strict = false } = {}) {
  const { ok, value } = await readJSONFileStrict(filePath, defaultValue, { allowArray, logError });
  if (!ok && strict) {
    throw unreadableStoreError(filePath);
  }
  return value;
}

/**
 * Parse JSONL content safely; empty and malformed lines are skipped.
 * @param {string} content
 * @param {Object} options
 * @param {boolean} [options.logErrors=false]
 * @param {string} [options.context='']
 * @returns {Array}
 */
export function safeJSONLParse(content, { logErrors = false, context = '' } = {}) {
  if (!content || !content.trim()) return [];

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

/** Read a JSONL file safely; missing or unreadable files yield []. */
export async function readJSONLFile(filePath, { logErrors = false } = {}) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    // ENOENT: empty silently
    if (err.code === 'ENOENT') {
      return [];
    }
    // Log other I/O errors if requested
    if (logErrors) {
      console.warn(`⚠️ Failed to read file ${filePath}: ${err.message}`);
    }
    return [];
  }
  return safeJSONLParse(content, { logErrors, context: filePath });
}

/**
 * Append one JSON-serializable value to a JSON Lines file, creating the parent
 * directory and writing exactly one trailing newline.
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
  await appendFileGuarded(filePath, serialized + '\n');
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
 * Replace a JSON Lines file with the supplied records (compaction/clear flows;
 * hot append paths use appendJSONLine()).
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
 * Create a cached JSON file store with TTL-based invalidation.
 * Eliminates the repeated cache/load/save/invalidate pattern across services.
 *
 * @param {string} filePath - Path to the JSON file
 * @param {*} defaultValue - Default value when file doesn't exist
 * @param {Object} options
 * @param {number} [options.ttl=2000] - Cache TTL in milliseconds
 * @param {string} [options.context=''] - Context label for error logging
 * @param {number} [options.mode] - POSIX mode for atomic writes (e.g. 0o600)
 * @param {number} [options.dirMode] - POSIX mode for the store directory (e.g. 0o700)
 * @returns {{ load, save, mutate, invalidateCache, withLiveRestore }}
 *
 * `load()` is STRICT: a present-but-unreadable or corrupt file rejects, because
 * `mutate` persists whatever `load` returned and a swallowed default would
 * overwrite the real file. Only ENOENT yields the default. For flat settings
 * with shipped defaults and a PATCH surface, use `createSettingsStore`.
 *
 * Writes serialize through a single-tail `createFileWriteQueue`. `mutate(fn)`
 * runs `load -> fn -> persist` under that tail on a private clone, publishing to
 * the cache only after the atomic write succeeds. A bare `load()` + `save()`
 * pair has no such guarantee; use `mutate()` when the new value depends on the
 * current one.
 */
export function createCachedStore(filePath, defaultValue, { ttl = 2000, context = '', mode, dirMode } = {}) {
  let cache = null;
  let cacheTimestamp = 0;
  let writeSeq = 0;
  const dir = dirname(filePath);
  const queueWrite = createFileWriteQueue();
  const cloneDefault = () => JSON.parse(JSON.stringify(defaultValue));

  const load = async () => {
    const now = Date.now();
    if (cache && (now - cacheTimestamp) < ttl) return cache;
    const readSeq = writeSeq;
    await ensureDir(dir, { mode: dirMode });
    // Strict: a present-but-unreadable file must reject, not read as the default and be overwritten by the next write.
    const { ok, value } = await readJSONFileStrict(filePath, null, { logError: true });
    if (!ok) {
      throw new Error(`Unreadable JSON file: ${filePath}${context ? ` (${context})` : ''}`);
    }
    // A serialized write may have landed mid-read; keep the newer cache.
    if (readSeq !== writeSeq) return cache === null ? load() : cache;
    cache = value === null ? cloneDefault() : value;
    cacheTimestamp = now;
    return cache;
  };

  // Shared write body; callers go through the serialized `save`/`mutate`.
  const persist = async (data) => {
    await atomicWrite(filePath, data, { mode, dirMode });
    writeSeq += 1;
    cache = data;
    cacheTimestamp = Date.now();
    return data;
  };

  const save = (data) => queueWrite(() => persist(data));

  // Serialized read-modify-write; `fn` may mutate in place and/or return the value (undefined persists the mutated input).
  const mutate = (fn) => queueWrite(async () => {
    const data = structuredClone(await load());
    const result = await fn(data);
    return persist(result === undefined ? data : result);
  });

  const invalidateCache = () => {
    writeSeq += 1;
    cache = null;
    cacheTimestamp = 0;
  };

  // Hold mutations until the restore has reconciled the cache, even if the
  // transfer only replaced some files before failing.
  const withLiveRestore = (restore) => queueWrite(() => restore(invalidateCache));

  return { load, save, mutate, invalidateCache, withLiveRestore };
}
