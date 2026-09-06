/** Cross-cutting filesystem, time, formatting, and hashing helpers. */
import { access, appendFile, chmod, copyFile, mkdir, readFile, readdir, stat, writeFile, rename, unlink, rm } from 'fs/promises';
import { createReadStream, createWriteStream, existsSync, statSync, watch as watchFileSystem } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { basename, dirname, extname, join } from 'path';
import { promisify } from 'util';
import { execFile } from './childProcess.js';
import { isVitestRunner } from './runtimeEnv.js';

// The #6176 data-root guard is loaded ONLY under an actual Vitest worker —
// `isVitestRunner()`, narrower than `isTestRunner()`, because `scripts/
// smoke-boot.js` sets NODE_ENV=test on the real server boot to select the
// file-backend escape hatch, and that boot's writes into the real data/ tree
// are correct, not a leak (see `isVitestRunner()`'s doc comment). `fileCore` is
// reached by essentially every server suite, so a static import of the guard
// (and its `dataRoot`/`pathContainment` closure) landed on every one of them and
// pushed `importScoping.test.js`'s tree-wide budget over its ceiling. Deferring
// it — the shape server/AGENTS.md prescribes — also means production never
// loads the guard at all, rather than loading it to no-op.
// The module promise is memoized, so the dynamic import resolves once per worker.
let guardModule = null;
const loadGuard = () => (guardModule ??= import('./testDataIsolation.js'));

export const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

// Call-time platform probe. `IS_WIN` above is a module-load snapshot (fine for
// the path-shape helper at the bottom of this file); the Windows retry paths
// below read the platform on every call so a POSIX host never carries a stale
// decision and so the retry behavior is exercisable in tests.
const isWindows = () => process.platform === 'win32';

// Windows-only retry knobs (#4095). A destination lock from a concurrent reader
// or an AV scan clears in milliseconds, so a handful of short retries is enough
// to avoid both the writer's destination-missing backup swap and the reader's
// phantom "nothing here yet".
const WIN_RETRY_ATTEMPTS = 5;
const WIN_RETRY_DELAY_MS = 10;
// rename(2) failures that mean "the destination is momentarily locked", not
// "this rename can never work".
const WIN_RENAME_LOCK_CODES = ['EPERM', 'EACCES', 'EEXIST'];
// read failures with the same transient meaning on the reader side.
const WIN_READ_LOCK_CODES = ['EPERM', 'EACCES', 'EBUSY'];
const FILE_WATCH_FALLBACK_POLL_MS = 5000;

/** Watch for a file to appear without repeatedly stat'ing its parent directory. */
export function watchForFile(filePath, onDetected, { settleMs = 50, pollMs = FILE_WATCH_FALLBACK_POLL_MS } = {}) {
  const targetName = basename(filePath);
  const targetDir = dirname(filePath);
  let closed = false;
  let detected = false;
  let settleTimer = null;
  let pollTimer = null;

  const notify = () => {
    Promise.resolve(onDetected()).catch((err) => {
      console.error(`❌ File watcher callback failed: ${err.message}`);
    });
  };
  const close = (onClosed) => {
    if (closed) return;
    closed = true;
    if (settleTimer) clearTimeout(settleTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (onClosed) watcher.once('close', onClosed);
    watcher.close();
  };
  const detect = (settle = true) => {
    if (closed || detected || !existsSync(filePath)) return;
    detected = true;
    if (!settle) {
      close(notify);
      return;
    }
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (closed) return;
      close(notify);
    }, settleMs);
  };
  const watcher = watchFileSystem(targetDir, (_eventType, changedName) => {
    if (changedName == null || changedName.toString() === targetName) detect();
  });
  // fs.watch is low-latency but best-effort: native backends can miss a file
  // creation or atomic rename. Keep a deliberately relaxed fallback so a
  // missed event cannot strand an agent indefinitely.
  pollTimer = setInterval(() => detect(), pollMs);
  detect(false);
  return close;
}

// Cache __dirname calculation for services importing this module
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
  // #6176 — refuse a NEW dir in the real data/ tree under the runner. Only the
  // CREATE path: `mkdir -p` on an existing directory mutates nothing.
  if (isVitestRunner()) (await loadGuard()).assertNotNewRealDataDir(dir);
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
 * Symlink semantics (design decision, issue #1893): when `filePath` is a
 * symlink, the temp+rename REPLACES the link with a regular file — it does NOT
 * follow the link to update the backing file. This is the standard atomic-write
 * contract (git, dpkg, rsync, `os.replace` all replace the link); following the
 * link would reintroduce the non-atomic in-place truncate this helper exists to
 * eliminate. PortOS ships no symlinked data files, so this is a documented
 * property rather than a supported use case — do not pass a symlink you expect
 * to be followed. Callers that genuinely need follow-the-link semantics must
 * resolve `realpath(filePath)` themselves before calling.
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
  // #6176 — the filesystem analogue of db.js's row-write backstop. Refuses
  // before any bytes are produced, so a leaking suite cannot even leave a temp
  // file behind in the real tree.
  if (isVitestRunner()) (await loadGuard()).assertNotRealDataWrite(filePath, 'atomicWrite');
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
    let err = await rename(tmp, filePath).then(() => null, (e) => e);
    // Retry the ATOMIC rename before resorting to the backup swap (#4095). The
    // swap below renames the destination away and back, so for that instant the
    // destination DOES NOT EXIST — a concurrent read lands on ENOENT and reads
    // it as a trustworthy "nothing here yet", silently handing the caller its
    // default instead of the file's real contents. A transient lock clears in
    // milliseconds, so retrying keeps almost every write on the atomic path and
    // never opens that window.
    if (isWindows()) {
      for (let attempt = 1; err && attempt < WIN_RETRY_ATTEMPTS && WIN_RENAME_LOCK_CODES.includes(err.code); attempt += 1) {
        await sleep(WIN_RETRY_DELAY_MS);
        err = await rename(tmp, filePath).then(() => null, (e) => e);
        if (!err) console.log(`⚠️ atomicWrite rename succeeded after ${attempt} retry(s): ${basename(filePath)}`);
      }
    }
    if (!err) return;
    if (isWindows() && WIN_RENAME_LOCK_CODES.includes(err.code)) {
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
 * `writeFile`, `appendFile` and `copyFile` with the #6176 data-root guard.
 *
 * `atomicWrite` is the primitive almost every writer should use, and it is
 * guarded. These exist for the writers that genuinely cannot: an append (which
 * replaces nothing), an exclusive `{ flag: 'wx' }` create (where the flag IS
 * the mechanism), a byte-for-byte copy, and a destination whose name is already
 * clamped to NAME_MAX (atomicWrite's `.<pid>.<ts>.<uuid>.tmp` suffix would push
 * the temp file past it).
 *
 * Exported as wrappers rather than left as an `assertNotRealDataWrite` call at
 * each site, so the NEXT raw writer inherits the guard instead of having to
 * remember the import.
 */

/** Guarded `fs/promises.writeFile`. Same signature. */
export async function writeFileGuarded(filePath, data, options) {
  if (isVitestRunner()) (await loadGuard()).assertNotRealDataWrite(filePath, 'writeFile');
  return writeFile(filePath, data, options);
}

/** Guarded `fs/promises.appendFile`. Same signature. */
export async function appendFileGuarded(filePath, data, options) {
  if (isVitestRunner()) (await loadGuard()).assertNotRealDataWrite(filePath, 'appendFile');
  return appendFile(filePath, data, options);
}

/** Guarded `fs/promises.copyFile` — the DESTINATION is what gets written. */
export async function copyFileGuarded(src, dest, mode) {
  if (isVitestRunner()) (await loadGuard()).assertNotRealDataWrite(dest, 'copyFile');
  return copyFile(src, dest, mode);
}

/** Guarded `fs/promises.rm`. Same signature. */
export async function rmGuarded(target, options) {
  if (isVitestRunner()) (await loadGuard()).assertNotRealDataWrite(target, 'rm');
  return rm(target, options);
}

/** Guarded `fs/promises.unlink`. Same signature. */
export async function unlinkGuarded(target) {
  if (isVitestRunner()) (await loadGuard()).assertNotRealDataWrite(target, 'unlink');
  return unlink(target);
}

/** Guarded `fs.createWriteStream`. Returns a Promise resolving to the WriteStream. */
export async function createWriteStreamGuarded(filePath, options) {
  if (isVitestRunner()) (await loadGuard()).assertNotRealDataWrite(filePath, 'createWriteStream');
  return createWriteStream(filePath, options);
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
// of throwing and 500ing the whole route. Counted/reporting callers can pass
// `{ strict: true }` to reject instead, preserving failed-vs-legitimately-empty.
export async function dirSize(path, { strict = false } = {}) {
  if (strict) {
    const present = await stat(path).then(
      () => true,
      (err) => {
        if (err?.code === 'ENOENT') return false;
        throw err;
      },
    );
    if (!present) return 0;
  } else if (!existsSync(path)) {
    return 0;
  }
  if (IS_WIN) {
    // Pass the path via an env var so a literal apostrophe in the path can't
    // close the PowerShell string and inject commands.
    const result = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      '(Get-ChildItem -Recurse -File $Env:DIRSIZE_TARGET | Measure-Object -Property Length -Sum).Sum',
    ], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DIRSIZE_TARGET: path } }).catch((err) => ({ error: err }));
    if (result.error) {
      if (strict) throw result.error;
      console.log(`⚠️ dirSize(${path}) failed: ${result.error.message}`);
      return 0;
    }
    const bytes = parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(bytes) || bytes < 0) {
      if (strict) throw new Error(`Could not parse directory size for ${path}`);
      return 0;
    }
    return bytes;
  }
  const result = await execFileAsync('du', ['-sk', path], { encoding: 'utf8', timeout: 60_000 }).catch((err) => ({ error: err }));
  if (result.error) {
    if (strict) throw result.error;
    console.log(`⚠️ dirSize(${path}) failed: ${result.error.message}`);
    return 0;
  }
  const kb = parseInt(result.stdout.split('\t')[0], 10);
  if (!Number.isFinite(kb) || kb < 0) {
    if (strict) throw new Error(`Could not parse directory size for ${path}`);
    return 0;
  }
  return kb * 1024;
}

/** SHA-256 a string or Buffer as hex — `sha256File`'s in-memory twin. */
export const sha256Text = (value) => createHash('sha256').update(value).digest('hex');

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
