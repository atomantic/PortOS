import { readdir, readFile, rename, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveInstallRoot } from '../../server/lib/dataRoot.js';

// The read side of the migration ledger, split out of scripts/run-migrations.js
// so status callers (server/services/installState.js, reached by ~1,100 suites
// through peerExecutionAdapters' lazy import) do not put the runner in their
// `vitest related` graph: a runner-only change would otherwise select them all.

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer an explicit PORTOS_DATA_ROOT env var over the executing-file location
// so a process booted from inside a CoS agent git worktree still resolves to
// the real install (#1947). resolveInstallRoot refuses the pin when the derived
// path is itself a worktree, so a worktree launch falls through to its own path
// and the runner's isWorktreeRoot backstop skips. Falls back to the derived
// path when the env var is unset.
export const DEFAULT_ROOT_DIR = resolveInstallRoot(join(__dirname, '..', '..'));
export const DEFAULT_MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/** Ledger locations relative to `data/`; restore reads a snapshot's copy by the same names. */
export const APPLIED_LEDGER_RELPATH = 'migrations.applied.json';
export const LEGACY_APPLIED_LEDGER_RELPATH = join('migrations', '.applied.json');

export const appliedFilePath = (rootDir) => join(rootDir, 'data', APPLIED_LEDGER_RELPATH);

// Installs from before the 2026-05-16 move of migrations out of data/ keep the
// ledger here. The booting server runs migrations on a plain pull-and-restart
// without setup-data.js, so every runner adopts it: an unread legacy ledger
// reads as empty, re-runs every applied migration and disarms the purge class.
export const legacyAppliedFilePath = (rootDir) => join(rootDir, 'data', LEGACY_APPLIED_LEDGER_RELPATH);

const pathExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

/**
 * Move a legacy ledger to `appliedFilePath`. A current ledger is authoritative
 * when both exist, so the legacy copy is then left untouched. Returns whether
 * the file moved.
 */
export async function adoptLegacyAppliedList(rootDir) {
  const legacy = legacyAppliedFilePath(rootDir);
  if (!(await pathExists(legacy)) || await pathExists(appliedFilePath(rootDir))) return false;
  return rename(legacy, appliedFilePath(rootDir)).then(() => true, (err) => {
    // Another runner (setup-data has no lock) adopted it first.
    if (err.code === 'ENOENT') return false;
    throw err;
  });
}

/**
 * Scan for numbered migration files (NNN-name.js, sorted by filename). Co-located vitest
 * files (*.test.js) are excluded — they don't export `up()` and would
 * throw the runner if imported as migrations. The vitest config picks
 * them up via its own scripts test glob in server/vitest.config.js.
 * Unnumbered modules include shared helpers and executable tooling; importing
 * them here can run unrelated checks or exit the process before migrations finish.
 */
export async function scanMigrationFiles(migrationsDir) {
  return (await readdir(migrationsDir))
    .filter(f => /^\d+-.*\.js$/.test(f) && !f.endsWith('.test.js'))
    .sort();
}

/**
 * Read the applied-migrations list. A missing file defaults to [].
 *
 * When `repair` is true and the file is corrupt (mid-write truncation, bad
 * JSON, wrong shape or invalid migration filenames), rename it aside and
 * rebuild the ledger from scratch so corruption does not brick future boots. Non-ENOENT read errors
 * propagate in repair mode: treating an unreadable ledger as empty could rerun
 * migrations against live data. When `repair` is false (read-only callers like
 * listPendingMigrations), read errors and corrupt content are treated as `[]`
 * WITHOUT mutating anything on disk.
 */
export async function readAppliedList(appliedFile, { repair = false } = {}) {
  const raw = await readFile(appliedFile, 'utf-8').catch(err => {
    if (err.code !== 'ENOENT' && repair) throw err;
    return null;
  });
  if (raw === null) return [];

  let parsed;
  let corruptReason = null;
  try { parsed = JSON.parse(raw); } catch (err) {
    corruptReason = `invalid JSON: ${err.message}`;
  }
  if (corruptReason === null && !Array.isArray(parsed)) {
    corruptReason = `expected array, got ${typeof parsed}`;
  }
  if (corruptReason === null && parsed.some(file => typeof file !== 'string'
    || !/^\d+-[^/\\]+\.js$/.test(file) || file.endsWith('.test.js'))) {
    // A nonempty array is the runner's evidence that purge migrations may run.
    // Invalid entries cannot supply that evidence, even beside valid filenames.
    corruptReason = 'expected numbered migration filenames';
  }
  if (corruptReason !== null) {
    if (repair) {
      const aside = `${appliedFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await rename(appliedFile, aside);
      console.warn(`⚠️ Corrupt migrations file ${appliedFile} (${corruptReason}); renamed to ${aside} and rebuilding from scratch`);
    }
    return [];
  }
  return parsed;
}

/**
 * List migration files present on disk that are NOT yet in the applied-list —
 * i.e. migrations a boot would run. Pure read: never applies, renames, or
 * writes anything (so it's safe to call from a status endpoint). Returns the
 * pending filenames in sorted (apply) order.
 */
export async function listPendingMigrations({
  rootDir = DEFAULT_ROOT_DIR,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
} = {}) {
  // Read-only: report what the next run sees once it adopts a legacy ledger.
  const useLegacy = await pathExists(appliedFilePath(rootDir))
    .then((exists) => !exists && pathExists(legacyAppliedFilePath(rootDir)))
    .catch(() => false);
  const ledger = useLegacy ? legacyAppliedFilePath(rootDir) : appliedFilePath(rootDir);
  const applied = await readAppliedList(ledger, { repair: false });
  const appliedSet = new Set(applied);
  const files = await scanMigrationFiles(migrationsDir).catch(() => []);
  return files.filter(f => !appliedSet.has(f));
}
