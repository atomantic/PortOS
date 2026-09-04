/** JSON, JSONL, and cached-store file IO helpers. */
import { existsSync } from 'fs';
import { open, readFile, readdir, stat } from 'fs/promises';
import { basename, dirname } from 'path';
import { appendFileGuarded, atomicWrite, ensureDir, sleep } from './fileCore.js';
import { createFileWriteQueue } from './fileWriteQueue.js';

const isWindows = () => process.platform === 'win32';
const WIN_RETRY_ATTEMPTS = 5;
const WIN_RETRY_DELAY_MS = 10;
const WIN_READ_LOCK_CODES = ['EPERM', 'EACCES', 'EBUSY'];

/**
 * Index of the first JSON array token in `str`, or -1 when it holds none.
 *
 * Split out of `extractJSONArray` so a caller can tell "found an array" from "found
 * nothing" — a distinction `extractJSONArray` erases by design (it manufactures a
 * literal '[]' for the not-found case). `readJSONFileStrict` needs it: for a
 * swallowing caller a manufactured '[]' is just the default, but for a strict one it
 * would forge a trustworthy-looking EMPTY out of unreadable bytes.
 *
 * @param {string} str
 * @returns {number} Index of the array start, or -1
 */
function findJSONArrayStart(str) {
  if (!str) return -1;
  // Look for '[{' (array with objects) first
  const objectStart = str.indexOf('[{');
  if (objectStart >= 0) return objectStart;
  // Check for empty array - find '[]' that's not part of ANSI codes like [31m
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

  if (!str || !str.trim()) {
    if (logError && str) {
      console.warn(`Invalid JSON${context ? ` in ${context}` : ''}: empty or malformed content`);
    }
    return defaultValue;
  }

  try {
    const parsed = JSON.parse(str);
    if (!allowArray && Array.isArray(parsed)) {
      if (logError) {
        console.warn(`Invalid JSON${context ? ` in ${context}` : ''}: array not allowed`);
      }
      return defaultValue;
    }
    return parsed;
  } catch (err) {
    if (logError) {
      console.warn(`Failed to parse JSON${context ? ` in ${context}` : ''}: ${err.message}`);
    }
    return defaultValue;
  }
}

/**
 * Read a file, returning null on any error (missing file, permission denied, etc.).
 *
 * Collapses the inlined `readFile(path, encoding).catch(() => null)` pattern used
 * across services for "optional file — fall through if absent." For Buffer reads,
 * pass `encoding: null` (or omit when calling with no second arg, default 'utf8').
 *
 * NOTE: like `readJSONFile`, this conflates "absent" with "unreadable" — both
 * return null. When the caller derives a user-visible stat from the result (where
 * a fake empty is a lie, not a default), reach for `tryReadFileStrict` (raw bytes)
 * or `readJSONFileStrict` (parsed JSON) instead.
 *
 * @param {string} filePath - Path to read
 * @param {string|null} [encoding='utf8'] - Encoding (null for Buffer)
 * @returns {Promise<string|Buffer|null>} File contents or null on any read error
 */
export async function tryReadFile(filePath, encoding = 'utf8') {
  return readFile(filePath, encoding).catch(() => null);
}

/**
 * `tryReadFile` that reports whether the read is TRUSTWORTHY — the raw-bytes
 * counterpart to `readJSONFileStrict`, for callers that parse (or count, or
 * display) the contents themselves rather than handing the file to JSON.parse.
 *
 *   - ENOENT (never written) → `{ ok: true,  value: null }` — a genuine "nothing
 *     here yet". Safe to treat as a real empty.
 *   - any other read error   → `{ ok: false, value: null }` — EACCES, EIO,
 *     EISDIR, a transient FS failure. We do NOT know the file is absent.
 *   - read                   → `{ ok: true,  value: contents }`
 *
 * So the three states `tryReadFile` collapses into one `null` stay separable:
 * `ok && value !== null` = read, `ok && value === null` = absent, `!ok` =
 * present-but-unreadable. Windows swap-window retries are shared with
 * `readJSONFileStrict`, so an `atomicWrite` in flight can't masquerade as ENOENT.
 *
 * @param {string} filePath - Path to read
 * @param {string|null} [encoding='utf8'] - Encoding (null for Buffer)
 * @returns {Promise<{ ok: boolean, value: string|Buffer|null }>}
 *
 * @example
 * const { ok, value } = await tryReadFileStrict(LEDGER_FILE);
 * if (!ok) throw new Error('ledger unreadable'); // never report a fake 0
 */
export async function tryReadFileStrict(filePath, encoding = 'utf8') {
  return readWithSwapRetry(filePath, encoding).then(
    (value) => ({ ok: true, value }),
    // ENOENT is the ONLY errno that proves absence. Everything else — EACCES on
    // the file or a parent dir, ENOTDIR, EIO — means we could not confirm it,
    // which must stay distinct from "confirmed empty".
    (err) => ({ ok: err?.code === 'ENOENT', value: null })
  );
}

/**
 * Read at most `maxBytes` from the END of a file, as UTF-8.
 *
 * The bounded-memory counterpart to `tryReadFile` for append-only logs and
 * spools that have no upper size bound (agent transcripts, PTY spools, CLI
 * rollout JSONL). `readFile` on one of those loads the whole thing into heap;
 * this reads only the trailing window.
 *
 * Non-throwing, with the sentinel distinction the AGENTS.md rule demands:
 *   - missing / unopenable / read error → `null`
 *   - zero-byte file                    → `''`
 * so a caller can tell "nothing to read" from "couldn't read".
 *
 * The window starts at a BYTE offset, so when the file is larger than
 * `maxBytes` the first line comes back partial (and can begin mid-multibyte
 * character). Callers that split on newlines should drop that leading fragment.
 *
 * @param {string} path - File to read
 * @param {number} maxBytes - Maximum trailing bytes to read
 * @returns {Promise<string|null>} Trailing text, `''` for an empty file, or null on error
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
    // Honour bytesRead — the file can shrink between stat and read, or the OS
    // can return a short read; decoding the whole `buffer` would append NULs.
    // A read failure surfaces as null so callers keep the ''-vs-null contract.
    const result = await handle.read(buffer, 0, length, start).catch(() => null);
    if (result === null) return null;
    return buffer.toString('utf8', 0, result.bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

// Private sentinel for "the parse produced nothing usable". A unique Symbol, NOT
// null/undefined — a file whose real contents parse to the caller's defaultValue
// must stay distinguishable from a file that failed to parse at all, and any
// in-band marker could legitimately BE the parsed value.
const PARSE_FAILED = Symbol('json-parse-failed');

/**
 * True when a `<filePath>.*.bak` sibling is on disk — the signature of an
 * `atomicWrite` backup swap that is mid-flight for THIS file, i.e. the only
 * window in which the destination legitimately vanishes.
 *
 * Deliberately does NOT match `.tmp`: `atomicWrite` writes its temp file on
 * EVERY write, including the first-ever create of a file that has no
 * destination yet. Treating a `.tmp` sibling as evidence of a swap would turn a
 * plain "not written yet" read into a retry that waits for the in-flight write
 * and returns its brand-new contents — a different value than the read was
 * entitled to, and a behavior change on POSIX-shaped callers. The `.bak` only
 * exists between the swap's two renames.
 *
 * Non-throwing: an unreadable parent directory just means "no evidence of a
 * swap". Only consulted on win32, and only after a read already failed with
 * ENOENT, so the directory listing never lands on a POSIX read or a successful
 * one. A `.bak` orphaned by a crash mid-swap costs the bounded retry budget
 * (~50ms) on subsequent ENOENT reads of that path, never an incorrect answer.
 *
 * Matching is case-INSENSITIVE: NTFS/FAT are case-insensitive, so the reader's
 * `filePath` casing need not match the casing the writer used to create the
 * file (and therefore the casing `readdir` reports). A case-sensitive compare
 * would miss the sibling and let the phantom-empty through.
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
 * `readFile(filePath, encoding)` with the Windows-only retries that keep a read
 * racing `atomicWrite` from being mistaken for an empty/absent file (#4095).
 *
 * On POSIX this is a straight delegate — zero extra syscalls, zero delay.
 *
 * On win32 two transient failures are retried with a short backoff:
 *   - EPERM/EACCES/EBUSY — the destination is momentarily locked (AV scan, the
 *     writer's own open handle).
 *   - ENOENT, but ONLY when `hasSwapSibling` shows a backup swap is mid-flight.
 *     A file that was simply never written — or one whose first-ever write is
 *     still in its temp stage — stays a silent "nothing here yet": one failed
 *     read, no retry, no sleep.
 *
 * Rejects with the last error once the attempts are exhausted, so the caller's
 * existing errno handling is unchanged.
 *
 * @param {string} filePath
 * @param {string|null} [encoding='utf-8'] - Encoding (null for Buffer)
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
    const retriable = WIN_READ_LOCK_CODES.includes(outcome.err.code)
      || (outcome.err.code === 'ENOENT' && !last && await hasSwapSibling(filePath));
    if (last || !retriable) throw outcome.err;
    await sleep(WIN_RETRY_DELAY_MS);
  }
}

/**
 * Read a JSON file, reporting whether the read is TRUSTWORTHY rather than
 * collapsing every failure into the default (the `readJSONFile` behavior below).
 *
 * The absent-vs-unreadable distinction (see AGENTS.md's "Sentinel + validate"):
 *
 *   - ENOENT (never written)      → `{ ok: true,  value: defaultValue }` — a genuine
 *     empty. A caller counting records may trust this as a real zero.
 *   - any other read error        → `{ ok: false, value: defaultValue }` — EACCES,
 *     EIO, EISDIR, a transient FS failure. We do NOT know the file is empty.
 *   - unparseable / truncated     → `{ ok: false, value: defaultValue }` — corrupt
 *     bytes are not an empty collection.
 *   - parsed                      → `{ ok: true,  value: parsed }`
 *
 * `value` is always populated so an `ok`-indifferent caller can ignore the flag and
 * behave exactly like `readJSONFile` — which is how `readJSONFile` is implemented.
 *
 * Generalizes the local `{ ok, list }` precedent in
 * `services/mediaAssetIndex/db.js#readVideoHistoryStrict`, written because "corrupt
 * history" reading as "no videos exist" would have pruned every still-on-disk video
 * from the index. Same bug class, shared helper (#2726).
 *
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Value returned whenever the file yields no parsed value
 * @param {Object} options - Options
 * @param {boolean} [options.allowArray=true] - Allow array JSON
 * @param {boolean} [options.logError=true] - Log read/parse errors
 * @returns {Promise<{ ok: boolean, value: * }>}
 *
 * @example
 * const { ok, value } = await readJSONFileStrict('./sessions.json', { sessions: [] });
 * if (!ok) throw new Error('sessions unreadable'); // never report a fake 0
 */
export async function readJSONFileStrict(filePath, defaultValue = null, { allowArray = true, logError = true } = {}) {
  let content;
  try {
    content = await readWithSwapRetry(filePath);
  } catch (err) {
    // ENOENT = file doesn't exist → a trustworthy "nothing here yet", silently.
    // On win32 an ENOENT that was really an `atomicWrite` swap window has
    // already been retried above, so reaching here means genuinely absent.
    if (err.code === 'ENOENT') {
      return { ok: true, value: defaultValue };
    }
    if (logError) {
      console.warn(`Failed to read file ${filePath}: ${err.message}`);
    }
    return { ok: false, value: defaultValue };
  }

  // Mirror safeJSONParse's noisy-output affordance BEFORE delegating: it keys the
  // extraction off `Array.isArray(defaultValue)`, and the sentinel we pass as its
  // fallback below is not an array — so an array-defaulted caller (e.g. pm2 jlist
  // with ANSI codes) would silently lose the extraction if we left it to that call.
  //
  // Deliberately NOT via `extractJSONArray`: it returns a literal '[]' when the text
  // holds no array at all, which would parse cleanly and report `ok: true` — forging
  // a trustworthy empty out of unreadable bytes, the exact lie this function exists
  // to prevent. Only a real find rewrites `text`; otherwise the parse below fails and
  // the read is correctly reported as untrustworthy.
  let text = content;
  if (allowArray && Array.isArray(defaultValue) && text && !text.trim().startsWith('[')) {
    const arrayStart = findJSONArrayStart(text);
    if (arrayStart >= 0) text = text.slice(arrayStart);
  }

  const parsed = safeJSONParse(text, PARSE_FAILED, { allowArray, logError, context: filePath });
  if (parsed === PARSE_FAILED) return { ok: false, value: defaultValue };

  // An array `defaultValue` is the caller declaring "I expect a list" — every such
  // caller in-tree goes straight to `.filter`/`.find`/`.findIndex` on the result. A
  // parsed object root therefore isn't a usable read: swallowing callers must still
  // get their list back (a hand-edited or legacy-shaped file used to degrade to `[]`
  // here, via the manufactured-'[]' path above, and would now TypeError instead), and
  // a strict caller must refuse to count a shape it cannot count.
  if (allowArray && Array.isArray(defaultValue) && !Array.isArray(parsed)) {
    if (logError) {
      console.warn(`Expected a JSON array in ${filePath}, got ${parsed === null ? 'null' : typeof parsed}`);
    }
    return { ok: false, value: defaultValue };
  }

  return { ok: true, value: parsed };
}

/**
 * Read a JSON file safely with validation and default fallback.
 * Combines file reading with safe JSON parsing.
 *
 * By default this SWALLOWS every failure — a missing file, an unreadable one, and
 * corrupt JSON all return `defaultValue`. That is the right shape for config-ish
 * reads with a sensible fallback, and is the long-standing behavior of every
 * existing caller.
 *
 * It is the WRONG shape when the value is counted or shown to the user, because a
 * fake empty then reads as fact ("0 sessions logged" when the truth is "we could not
 * read your sessions"). Those callers pass `{ strict: true }` to convert an
 * untrustworthy read into a throw, or use `readJSONFileStrict` for the `{ ok, value }`
 * pair directly.
 *
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Default value if file doesn't exist or is invalid
 * @param {Object} options - Options
 * @param {boolean} [options.allowArray=true] - Allow array JSON
 * @param {boolean} [options.logError=true] - Log errors
 * @param {boolean} [options.strict=false] - Throw instead of returning `defaultValue`
 *   when the file exists but could not be read or parsed. A genuinely absent file
 *   (ENOENT) still returns `defaultValue` — absent is a trustworthy empty.
 * @returns {Promise<*>} Parsed JSON or default value
 * @throws {Error} Only when `strict` and the file is present-but-unreadable/corrupt
 *
 * @example
 * const config = await readJSONFile('./config.json', { port: 3000 });
 * const items = await readJSONFile('./items.json', []);
 * const real = await readJSONFile('./sessions.json', [], { strict: true }); // throws if corrupt
 */
export async function readJSONFile(filePath, defaultValue = null, { allowArray = true, logError = true, strict = false } = {}) {
  const { ok, value } = await readJSONFileStrict(filePath, defaultValue, { allowArray, logError });
  if (!ok && strict) {
    throw new Error(`Unreadable JSON file: ${filePath}`);
  }
  return value;
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
 * @returns {{ load, save, mutate, invalidateCache }}
 *
 * Writes are serialized through a single-tail `createFileWriteQueue` so two
 * concurrent `save()` calls can't interleave their `atomicWrite` + cache
 * assignment. For read-modify-write, use `mutate(fn)` — it runs the whole
 * `load → fn → persist` cycle under the same tail, so a `load` always sees the
 * previous cycle's committed result and one writer can't clobber the other
 * (AGENTS.md: "serialize writes server-side… a single tail per shared file").
 * A bare `load()` + `save()` pair does NOT get that guarantee; reach for
 * `mutate()` whenever the new value depends on the current one.
 */
export function createCachedStore(filePath, defaultValue, { ttl = 2000, context = '' } = {}) {
  let cache = null;
  let cacheTimestamp = 0;
  const dir = dirname(filePath);
  const queueWrite = createFileWriteQueue();
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

  // Persist `data` and refresh the cache — the shared write body. Callers reach
  // it via the serialized `save`/`mutate`, never directly.
  const persist = async (data) => {
    await atomicWrite(filePath, data);
    cache = data;
    cacheTimestamp = Date.now();
    return data;
  };

  const save = (data) => queueWrite(() => persist(data));

  // Serialized read-modify-write: load the freshest state under the tail, apply
  // `fn`, then persist. `fn` may mutate the loaded object in place and/or return
  // the value to write (returning `undefined` persists the mutated input).
  const mutate = (fn) => queueWrite(async () => {
    const data = await load();
    const result = await fn(data);
    return persist(result === undefined ? data : result);
  });

  const invalidateCache = () => {
    cache = null;
    cacheTimestamp = 0;
  };

  return { load, save, mutate, invalidateCache };
}
