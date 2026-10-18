#!/usr/bin/env node
import { readdir, readFile, mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveInstallRoot, isWorktreeRoot } from '../server/lib/dataRoot.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer an explicit PORTOS_DATA_ROOT env var over the executing-file location
// so a process booted from inside a CoS agent git worktree still resolves to
// the real install (#1947). resolveInstallRoot refuses the pin when the derived
// path is itself a worktree, so a worktree launch falls through to its own path
// and the isWorktreeRoot backstop below skips. Falls back to the derived path
// when the env var is unset.
const DEFAULT_ROOT_DIR = resolveInstallRoot(join(__dirname, '..'));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

const appliedFilePath = (rootDir) => join(rootDir, 'data', 'migrations.applied.json');

// ---- purge-class probe (#12049) ----
//
// The empty-ledger guard below has to know which PENDING migrations are purge
// migrations before any of them runs. Importing each module to read its
// `purge` export loaded every pending migration's import graph up front — on a
// fresh install that is every migration, dozens of which pull in live server
// services before the toolkit has booted. The marker is read from the source
// text instead: a `purge: true` property at the two-space indentation of the
// default export's own properties (how every purge migration writes it), or
// an `export const purge = true`. Comments are stripped first so the rationale
// block every purge migration carries cannot match. A `purge: true` nested
// deeper inside a data literal is data, not the marker.
// `migrationConventions.guard.test.js` checks every shipped migration's module
// against this probe so the two cannot drift.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const PURGE_PROPERTY = /^ {2}purge\s*:\s*true\s*,?\s*$/m;
const PURGE_EXPORT = /^export\s+const\s+purge\s*=\s*true\b/m;

/** Whether a migration's source text opts into the runner's purge class. */
export const sourceDeclaresPurge = (source) => {
  const code = stripComments(source);
  return PURGE_PROPERTY.test(code) || PURGE_EXPORT.test(code);
};

// ---- runner lock (#12046) ----
//
// The ledger is read-then-written by every runner: the booting server
// (bootstrap.js) and the documented manual `npm run migrations` both call
// runMigrations, and a PM2 restart can start a second server mid-run. Two
// runners that both read the ledger before either persists it each apply the
// same non-idempotent migration. A `mkdir` is atomic on every filesystem, so
// the lock is a directory; `owner.json` inside it carries the holder's pid and
// start time so a runner that died (SIGKILL, power loss) can be recognised and
// its lock reclaimed instead of blocking every later boot.
const lockDirPath = (rootDir) => join(rootDir, 'data', 'migrations.lock');
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_WAIT_MS = 60 * 1000;
const LOCK_POLL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Signal 0 probes existence without delivering anything. EPERM means the pid
// exists but belongs to another user, which still counts as alive.
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

const readLockOwner = (lockDir) => readFile(join(lockDir, LOCK_OWNER_FILE), 'utf-8')
  .then((raw) => JSON.parse(raw), () => null)
  .then((owner) => (owner && typeof owner === 'object' ? owner : null));

/**
 * Why a held lock can be reclaimed, or null while its holder may still be
 * running. The holder's own pid is never judged dead (an in-process second
 * caller must wait, not steal), and a lock with no readable owner yet — the
 * window between the holder's mkdir and its owner.json write — is judged by
 * the directory's age alone.
 */
async function lockStaleReason(lockDir) {
  const owner = await readLockOwner(lockDir);
  const pid = Number.isInteger(owner?.pid) ? owner.pid : null;
  if (pid !== null && pid !== process.pid && !pidAlive(pid)) return `holder pid ${pid} is no longer running`;
  const startedAt = Number.isFinite(owner?.startedAt)
    ? owner.startedAt
    : (await stat(lockDir).then((s) => s.mtimeMs, () => null));
  if (startedAt !== null && Date.now() - startedAt > LOCK_STALE_MS) return `held for over ${LOCK_STALE_MS / 60000} minutes`;
  return null;
}

/**
 * Take `data/migrations.lock`; resolves to the release function. A second
 * runner waits up to `waitMs` for the holder to finish, reclaims a stale lock
 * on sight, and otherwise rejects with the holder's identity so the operator
 * knows what to wait for rather than racing it.
 */
async function acquireMigrationLock(lockDir, { waitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS } = {}) {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const taken = await mkdir(lockDir).then(() => true, (err) => {
      if (err.code === 'EEXIST') return false;
      throw err;
    });
    if (taken) {
      await writeFile(join(lockDir, LOCK_OWNER_FILE), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      return () => rm(lockDir, { recursive: true, force: true });
    }
    const stale = await lockStaleReason(lockDir);
    if (stale) {
      console.warn(`⚠️ Reclaiming stale migration lock ${lockDir}: ${stale}`);
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const owner = await readLockOwner(lockDir);
      throw new Error(
        `Another migration run (pid ${owner?.pid ?? 'unknown'}) holds ${lockDir} — wait for it to finish (or stop the PortOS server) and retry; `
        + `remove the directory by hand only if no migration runner is still alive`,
      );
    }
    if (!announced) {
      console.log(`⏳ Waiting for another migration run holding ${lockDir}`);
      announced = true;
    }
    await sleep(pollMs);
  }
}

/**
 * Scan for migration files (*.js, sorted by filename). Co-located vitest
 * files (*.test.js) are excluded — they don't export `up()` and would
 * throw the runner if imported as migrations. The vitest config picks
 * them up via its own scripts test glob in server/vitest.config.js.
 * `_`-prefixed files (e.g. `_lib.js`, `_testHelpers.js`) are shared
 * helpers consumed by migration files and their tests — they're never
 * migrations themselves.
 */
async function scanMigrationFiles(migrationsDir) {
  return (await readdir(migrationsDir))
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js') && !f.startsWith('_'))
    .sort();
}

/**
 * Read the applied-migrations list. A missing file defaults to [].
 *
 * When `repair` is true and the file is corrupt (mid-write truncation, bad
 * JSON, wrong shape), rename it aside and rebuild the ledger from scratch so
 * corruption does not brick future boots. Non-ENOENT read errors
 * propagate in repair mode: treating an unreadable ledger as empty could rerun
 * migrations against live data. When `repair` is false (read-only callers like
 * listPendingMigrations), read errors and corrupt content are treated as `[]`
 * WITHOUT mutating anything on disk.
 */
async function readAppliedList(appliedFile, { repair = false } = {}) {
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
  const applied = await readAppliedList(appliedFilePath(rootDir), { repair: false });
  const appliedSet = new Set(applied);
  const files = await scanMigrationFiles(migrationsDir).catch(() => []);
  return files.filter(f => !appliedSet.has(f));
}

export async function runMigrations({
  rootDir = DEFAULT_ROOT_DIR,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  lockWaitMs = LOCK_WAIT_MS,
  lockPollMs = LOCK_POLL_MS,
} = {}) {
  // Backstop for #1947: a process booted from inside a CoS agent git worktree
  // (data/cos/worktrees/agent-*) has no gitignored data/ runtime tree, so
  // migrations that read/write data/ or data.reference/ crash on ENOENT. A
  // worktree checkout has no business running its own migration pass — skip it
  // with a clear warning instead of crashing boot.
  if (isWorktreeRoot(rootDir)) {
    console.warn(`⚠️ Skipping migrations: rootDir is a CoS agent worktree checkout (${rootDir}) — no data/ tree to migrate`);
    return 0;
  }

  const appliedFile = appliedFilePath(rootDir);

  // Ensure data/ exists so we can persist applied state (migrationsDir
  // ships in the repo and always exists).
  await mkdir(dirname(appliedFile), { recursive: true });

  // Everything from the ledger read to its last persist runs under the lock:
  // the read is only trustworthy while no other runner can append to it.
  const releaseLock = await acquireMigrationLock(lockDirPath(rootDir), { waitMs: lockWaitMs, pollMs: lockPollMs });
  try {
    return await runPendingMigrations({ rootDir, migrationsDir, appliedFile });
  } finally {
    await releaseLock();
  }
}

async function runPendingMigrations({ rootDir, migrationsDir, appliedFile }) {
  // Load applied migrations list (repairing a corrupt file aside — see
  // readAppliedList).
  const applied = await readAppliedList(appliedFile, { repair: true });

  // Guard for #2770: when the applied-list started EMPTY — missing, corrupt and
  // rebuilt from [], or a genuinely fresh install — we cannot prove that a
  // non-idempotent PURGE migration hasn't already run. Rerunning one (they
  // identify their targets by PRESENCE, e.g. a learning bucket) would delete
  // legitimately-earned data accumulated since the purge first ran. So a
  // migration that opts into the purge class (`export default { purge: true }`)
  // is recorded as applied WITHOUT executing whenever the ledger started empty:
  // on a fresh install there is nothing to purge anyway, and on a lost/corrupt
  // ledger this protects post-fix data. The rare install that has genuine
  // poisoned data AND lost its ledger before the purge ran keeps that stale data
  // rather than losing real data — the deliberately safer trade. This is the
  // single shared guard for every purge migration (197, 198, …) — no per-migration
  // marker to drift out of sync.
  const ledgerStartedEmpty = applied.length === 0;

  const files = await scanMigrationFiles(migrationsDir);

  // The migration helper also carries prompt-drift and provider-seed
  // machinery. Boot/status callers import this runner widely, but only an
  // actual migration write needs the atomic writer, so keep that subtree off
  // the runner's normal static closure.
  const persistAppliedList = async () => {
    const { writeJsonAtomic } = await import('./migrations/_lib.js');
    await writeJsonAtomic(appliedFile, applied);
  };

  // Disarm EVERY pending purge migration up front, not as each is reached in
  // the run loop: if this rebuilt-from-empty run aborted on an earlier
  // throwing migration (the documented repair-and-reboot flow), the partial
  // ledger would no longer "start empty" on the next boot — and the purge
  // would then execute destructively against the rebuilt install. The probe
  // reads source text, never importing a module before its turn in the loop.
  if (ledgerStartedEmpty) {
    let disarmed = 0;
    for (const file of files) {
      if (applied.includes(file)) continue;
      if (!sourceDeclaresPurge(await readFile(join(migrationsDir, file), 'utf-8'))) continue;
      console.warn(`⏭️ Skipping purge migration ${file}: applied-list started empty/rebuilt — recorded as applied without running to avoid a destructive rerun (#2770)`);
      applied.push(file);
      disarmed++;
    }
    if (disarmed > 0) await persistAppliedList();
  }

  let ran = 0;
  for (const file of files) {
    if (applied.includes(file)) continue;

    const mod = await import(pathToFileURL(join(migrationsDir, file)).href);
    const migration = (mod?.default && typeof mod.default.up === 'function') ? mod.default : mod;
    if (!migration || typeof migration.up !== 'function') {
      throw new Error(`Migration "${file}" does not export an up() function`);
    }

    console.log(`🔄 Running migration: ${file}`);
    await migration.up({ rootDir, migrationsDir });
    applied.push(file);
    await persistAppliedList();
    ran++;
    console.log(`✅ Migration applied: ${file}`);
  }

  if (ran === 0) {
    console.log('✅ No pending migrations');
  } else {
    console.log(`✅ ${ran} migration(s) applied`);
  }
  return ran;
}

if (isDirectlyInvoked(import.meta.url)) {
  runMigrations().catch(err => {
    console.error(`❌ Migration failed: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
