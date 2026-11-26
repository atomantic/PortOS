import { readdir, opendir, stat, lstat, statfs, mkdtemp, open, link, readFile } from 'fs/promises';
import { join, relative, resolve, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { assertNotRealDataWrite } from '../lib/testDataIsolation.js';
import { execFile } from '../lib/childProcess.js';
import { promisify } from 'util';
import { parseFilesystemStats, sha256Text } from '../lib/fileCore.js';
import { PATHS, ensureDir, isTopLevelEntryName, rmGuarded, writeFileGuarded } from '../lib/fileUtils.js';
import { isPersistentMindScreenshotEntry } from '../lib/persistent/persistentMindAttachmentOwnership.js';
import { ServerError } from '../lib/errorHandler.js';
import { withBackupAssetPublication } from '../lib/backupSnapshotBoundary.js';
import { ARCHIVE_FILENAME, CATEGORIES, dataCacheEntry } from './dataManagerCategories.js';
import { getEidoversePaths } from './eidoverse.js';
import { getAllApps } from './apps.js';
import { withUpdateControlLock } from './updateControlActivity.js';

export { CATEGORIES } from './dataManagerCategories.js';

const execFileAsync = promisify(execFile);
const DATA_DIR = PATHS.data;

// Shown for a directory with no CATEGORIES entry. Phrased as an outcome ("we
// don't know whether removing this is safe") rather than a mechanism ("unknown
// category") so the absent Archive/Purge buttons read as a deliberate safety
// stance instead of a broken row.
export const UNKNOWN_CATEGORY_DESCRIPTION = "Not classified — PortOS doesn't know if this is safe to remove";

/**
 * Resolve the display/permission metadata for a `data/` directory name.
 * Adds `classified: false` for the unknown fallback so the client can style
 * the row as "deliberately unactionable" instead of guessing from the copy.
 * `purgeScope` is always present in the payload (null on protected categories)
 * so the client never has to distinguish "absent" from "not purgeable".
 * `busyCheck` is stripped — it is server-side behavior, not payload.
 */
function categoryMeta(name) {
  const known = CATEGORIES[name];
  if (known) {
    const { busyCheck: _busyCheck, ...serializable } = known;
    return { purgeScope: null, ...serializable, classified: true };
  }
  return { label: name, description: UNKNOWN_CATEGORY_DESCRIPTION, archivable: false, deletable: false, purgeScope: null, classified: false };
}

/**
 * Run a category's `busyCheck`, if it has one, and shape the answer for both
 * the API payload (`busy` / `busyReason`) and the purge gate (issue #3342).
 * A category with no probe is always `{ busy: false }` — today's behavior.
 *
 * Fails CLOSED. A probe that throws, or hands back a shape we can't read,
 * reports busy: "we could not verify" and "nothing is running" must not
 * collapse into the same answer on a page whose buttons are irreversible.
 */
export async function resolveCategoryBusy(categoryKey) {
  const check = CATEGORIES[categoryKey]?.busyCheck;
  if (typeof check !== 'function') return { busy: false, busyReason: null };
  const result = await check().catch((err) => {
    console.error(`❌ Busy check failed for data/${categoryKey}: ${err.message}`);
    return null;
  });
  if (typeof result?.busy !== 'boolean') {
    return { busy: true, busyReason: `PortOS could not confirm whether anything is using data/${categoryKey} right now, so the purge is withheld.` };
  }
  if (!result.busy) return { busy: false, busyReason: null };
  return { busy: true, busyReason: result.reason || `Something is using data/${categoryKey} right now — purge once it finishes.` };
}

// Managed app checkouts (Eidoverse worlds, its video companion, any registered
// app repo) live under data/repos but hold installed code, .env.portos and local
// commits, so a "Cloned Repos" purge must keep them. Fails closed: if the app
// registry cannot be read, the purge is refused rather than run unprotected.
async function protectedRepoPaths() {
  const reposDir = resolve(PATHS.repos);
  const eidoverse = getEidoversePaths();
  const candidates = [eidoverse.worlds, eidoverse.video];
  for (const app of await getAllApps()) {
    if (typeof app.repoPath === 'string') candidates.push(app.repoPath);
    for (const companion of app.companionRepoPaths || []) {
      if (typeof companion === 'string') candidates.push(companion);
    }
  }
  return candidates.map(p => resolve(p)).filter(p => isInsideDir(reposDir, p));
}

function isInsideDir(parent, child) {
  const rel = relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

// Removes every entry under `dir` that is not protected. An ancestor of a
// protected checkout (e.g. the owner directory holding it) is descended into,
// never removed whole.
async function purgeUnprotectedEntries(dir, protectedPaths) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    const full = resolve(join(dir, entry.name));
    if (protectedPaths.includes(full)) {
      kept++;
      continue;
    }
    if (protectedPaths.some(p => isInsideDir(full, p))) {
      const nested = await purgeUnprotectedEntries(full, protectedPaths);
      removed += nested.removed;
      kept += nested.kept;
      continue;
    }
    await rmGuarded(full, { recursive: true, force: true });
    removed++;
  }
  return { removed, kept };
}

// Validate category key contains only safe characters
const SAFE_NAME = /^[a-z0-9_-]+$/;

// Walk one directory at a time: never buffer an entire tree's path list in a
// child-process stdout pipe. Failed scans stay unknown, distinct from empty.
async function countFiles(dirPath, deadline) {
  if (Date.now() >= deadline) throw new Error('File count timed out');
  let count = 0;
  const directory = await opendir(dirPath);
  for await (const entry of directory) {
    if (Date.now() >= deadline) throw new Error('File count timed out');
    if (entry.isDirectory()) count += await countFiles(join(dirPath, entry.name), deadline);
    else if (entry.isFile()) count++;
  }
  return count;
}

async function getDirSizeAndCount(dirPath, { strict = false } = {}) {
  if (strict) {
    const present = await stat(dirPath).then(
      () => true,
      (err) => {
        if (err?.code === 'ENOENT') return false;
        throw err;
      },
    );
    if (!present) return { size: 0, fileCount: 0 };
  } else if (!existsSync(dirPath)) {
    return { size: 0, fileCount: 0 };
  }
  const [duOut, findOut] = await Promise.all([
    execFileAsync('du', ['-sk', dirPath], { timeout: 30000 })
      .then(r => r.stdout.trim())
      .catch((err) => {
        if (strict) throw err;
        return '0';
      }),
    countFiles(dirPath, Date.now() + 30000).catch((err) => {
      if (strict) throw err;
      return null;
    })
  ]);
  const kb = typeof duOut === 'string' ? parseInt(duOut.split('\t')[0], 10) : NaN;
  if (!Number.isFinite(kb) || kb < 0) {
    if (strict) throw new Error(`Could not parse directory size for ${dirPath}`);
    return { size: 0, fileCount: findOut };
  }
  const fileCount = findOut;
  return { size: kb * 1024, fileCount };
}

// The scan is the multi-second part of the overview (du + a recursive walk per
// category), and the Data page, the resources report and the data-introspection
// harbor all request it. Share one result per `strict` mode for a short window
// after it completes and coalesce concurrent callers while it is pending;
// mutations here invalidate it. Rejections are never
// cached. Busy state and disk capacity are read fresh on every call.
const OVERVIEW_SCAN_TTL_MS = 30_000;
const overviewScans = new Map();

function invalidateOverviewScan() {
  overviewScans.clear();
}

async function scanDataTree(strict) {
  let rootUnreadable = false;
  const entries = await readdir(DATA_DIR, { withFileTypes: true }).catch((err) => {
    if (strict) throw err;
    rootUnreadable = true;
    return [];
  });
  const dirs = entries.filter(e => e.isDirectory());
  const topFiles = entries.filter(e => e.isFile());

  // The root is the sum of its parts: scanning DATA_DIR itself would re-walk
  // every category. Top-level files are sized by allocated blocks to match du.
  // allSettled: a strict failure waits for its sibling scans rather than
  // leaving them running unobserved after the rejection.
  const settled = await Promise.allSettled([
    ...dirs.map(d => getDirSizeAndCount(join(DATA_DIR, d.name), { strict })),
    ...topFiles.map(f => stat(join(DATA_DIR, f.name)).then(
      st => (typeof st.blocks === 'number' ? st.blocks * 512 : st.size),
      (err) => {
        if (strict) throw err;
        return 0;
      },
    )),
  ]);
  const failed = settled.find(r => r.status === 'rejected');
  if (failed) throw failed.reason;
  const values = settled.map(r => r.value);
  const dirResults = values.slice(0, dirs.length);
  const fileSizes = values.slice(dirs.length);

  let totalSize = fileSizes.reduce((sum, n) => sum + n, 0);
  let totalFileCount = rootUnreadable ? null : topFiles.length;
  for (const r of dirResults) {
    totalSize += r.size;
    // A failed non-strict walk or root listing reports a null count; keep the total unknown too.
    totalFileCount = totalFileCount === null || r.fileCount === null ? null : totalFileCount + r.fileCount;
  }
  return { dirs, dirResults, totalSize, totalFileCount };
}

function getCachedOverviewScan(strict) {
  const cached = overviewScans.get(strict);
  // A pending scan is always shared; the TTL starts when it fulfills.
  if (cached && (cached.at === null || Date.now() - cached.at < OVERVIEW_SCAN_TTL_MS)) return cached.promise;
  const promise = scanDataTree(strict);
  const entry = { at: null, promise };
  overviewScans.set(strict, entry);
  promise.then(
    () => { entry.at = Date.now(); },
    () => {
      if (overviewScans.get(strict) === entry) overviewScans.delete(strict);
    },
  );
  return promise;
}

export async function getDataOverview({ strict = false } = {}) {
  // Capacity of the volume holding data/ so the page can show how much room is
  // left, not just what PortOS occupies. Null when the platform can't say.
  // Independent of the scan below, so it runs alongside it.
  const diskPromise = statfs(DATA_DIR).then(parseFilesystemStats).catch(() => null);
  const { dirs, dirResults, totalSize, totalFileCount } = await getCachedOverviewScan(strict);

  // Busy state ships with the overview so the Data Manager can drop the Purge
  // button before the user commits, rather than failing on click (#3342). Only
  // the handful of categories carrying a `busyCheck` cost anything here.
  const busyStates = await Promise.all(dirs.map(d => resolveCategoryBusy(d.name)));

  const categories = dirs.map((d, i) => ({
    key: d.name,
    path: `data/${d.name}`,
    ...categoryMeta(d.name),
    ...busyStates[i],
    ...dirResults[i]
  }));

  categories.sort((a, b) => b.size - a.size);

  const disk = await diskPromise;

  return {
    totalSize,
    totalFileCount,
    categories,
    disk,
    dataDir: 'data'
  };
}

async function describeManagedRuntime(item, dirPath) {
  if (item.type !== 'directory') return;
  const splashDirectory = item.name === 'runtimes'
    && (await lstat(join(dirPath, 'runtimes', 'splash')).catch(() => null))?.isDirectory();
  const read = splashDirectory
    ? async () => (await import('./splashRuntimeStatus.js')).getSplashRuntimeStatus()
    : item.name === 'mkserve'
      ? async () => (await import('./mkserveRuntimeManager.js')).getMkserveRuntimeStatus()
      : null;
  if (!read) return;
  const status = await read().catch(() => null);
  const state = !status ? 'status unavailable'
    : status.supported === false ? 'unsupported on this host'
      : status.state === 'external' ? 'external server running'
        : !status.installed ? 'runtime not installed'
          : status.state === 'stopped' ? 'installed, stopped'
            : status.state === 'running' ? 'running'
              : status.state || 'status unavailable';
  item.description = `${splashDirectory ? 'Splash' : 'mkserve'}: ${state}. ${item.description}`;
}

export async function getCategoryDetail(categoryKey, { measure = false } = {}) {
  if (!SAFE_NAME.test(categoryKey)) return null;
  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) return null;

  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);

  // Parallel: stat files + getDirSizeAndCount for subdirs
  const itemPromises = entries.map(async (entry) => {
    const fullPath = join(dirPath, entry.name);
    const regularType = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
    const cacheEntry = categoryKey === 'cache' ? dataCacheEntry(entry.name, regularType) : null;
    if (entry.isDirectory()) {
      const { size, fileCount } = await getDirSizeAndCount(fullPath);
      return { name: entry.name, type: 'directory', size, fileCount, ...cacheEntry };
    }
    const fileStat = await stat(fullPath).catch(() => null);
    return {
      name: entry.name,
      type: 'file',
      size: fileStat?.size || 0,
      modified: fileStat?.mtime?.toISOString() || null,
      ...cacheEntry
    };
  });

  const items = await Promise.all(itemPromises);
  if (categoryKey === 'cache') await Promise.all(items.map(item => describeManagedRuntime(item, dirPath)));
  // Resolve opaque training-run folders in one bounded-to-the-list
  // lookup, including old runs beyond the training page's recent-run limit.
  if (categoryKey === 'training-runs' && items.length) {
    const { query } = await import('../lib/db.js');
    const result = await query(
      'SELECT data FROM lora_training_runs WHERE id = ANY($1::text[])',
      [items.filter(item => item.type === 'directory').map(item => item.name)],
    ).catch(() => null);
    const runs = new Map((result?.rows || []).map(({ data }) => [data.id, data]));
    for (const item of items) {
      const run = runs.get(item.name);
      if (run) {
        item.label = run.name || run.character?.name || run.baseModelId || item.name;
        item.description = [run.baseModelId, run.status].filter(Boolean).join(' · ');
        if (run.datasetId) item.sourceHref = `/models/training/${encodeURIComponent(run.datasetId)}`;
      }
      item.sourceUnavailable = result === null ? 'Source lookup unavailable' : !run ? 'Run record no longer available' : null;
    }
  }
  if (categoryKey === 'images' || categoryKey === 'videos') {
    for (const item of items) {
      if (item.type === 'file') item.sourceHref = `/data/${categoryKey}/${encodeURIComponent(item.name)}`;
    }
  }
  items.sort((a, b) => b.size - a.size);

  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  const busy = await resolveCategoryBusy(categoryKey);

  const measurement = measure ? {
    ...await getDirSizeAndCount(dirPath, { strict: true }),
    disk: await statfs(DATA_DIR).then(parseFilesystemStats).catch(() => null),
  } : undefined;
  return { key: categoryKey, ...categoryMeta(categoryKey), ...busy, totalSize, items, ...(measurement && { measurement }) };
}

export async function archiveCategory(categoryKey, options = {}) {
  try {
    return await archiveCategoryUncached(categoryKey, options);
  } finally {
    invalidateOverviewScan();
  }
}

async function archiveCategoryUncached(categoryKey, options) {
  if (!SAFE_NAME.test(categoryKey)) throw new ServerError('Invalid category name', { status: 400, code: 'VALIDATION_ERROR' });
  const meta = CATEGORIES[categoryKey];
  if (!meta?.archivable) {
    throw new ServerError(`Category "${categoryKey}" is not archivable`, { status: 403, code: 'CATEGORY_NOT_ARCHIVABLE' });
  }

  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) {
    throw new ServerError(`Category directory not found: ${categoryKey}`, { status: 404, code: 'NOT_FOUND' });
  }

  const backupDir = join(DATA_DIR, 'backup');
  await ensureDir(backupDir);

  // Reserve scratch before selecting inputs: even a fixed clock cannot make
  // separate requests share their file list or partially written archive.
  assertNotRealDataWrite(backupDir, 'archiveCategory');
  const operationDir = await mkdtemp(join(backupDir, '.archive-'));
  const stagedArchive = join(operationDir, 'archive.tar.gz');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archiveName = `${categoryKey}-${timestamp}-${randomUUID()}.tar.gz`;
  const archivePath = join(backupDir, archiveName);

  try {
    const capturedDays = [];
    let queueHealthDayMutation;
    if (categoryKey === 'health') {
      const daysToKeep = options.daysToKeep ?? 365;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysToKeep);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      const files = await readdir(dirPath);
      const oldFiles = files.filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoffStr);
      if (oldFiles.length === 0) return { archived: 0, removed: 0, retained: 0, alreadyAbsent: 0, archivePath: null, message: 'No old files to archive' };

      // Share the importers' admission and day queue for capture and removal,
      // but release both during tar so a large archive blocks neither a
      // historical backfill nor a live health restore (#10899).
      ({ queueHealthDayMutation } = await import('./appleHealthIngest.js'));
      const stagedDays = join(operationDir, 'days');
      await ensureDir(stagedDays);
      for (const file of oldFiles) {
        await queueHealthDayMutation(file.slice(0, 10), async () => {
          const bytes = await readFile(join(dirPath, file));
          await writeFileGuarded(join(stagedDays, file), bytes, { flag: 'wx' });
          capturedDays.push({ file, hash: sha256Text(bytes) });
        });
      }
      const listPath = join(operationDir, 'files.txt');
      await writeFileGuarded(listPath, oldFiles.join('\n'));
      await execFileAsync('tar', ['-czf', stagedArchive, '-C', stagedDays, '-T', listPath], { timeout: 120000 });
    } else {
      const excludes = (meta.archiveExcludes ?? []).map(pattern => `--exclude=${pattern}`);
      await execFileAsync('tar', ['-czf', stagedArchive, ...excludes, '-C', DATA_DIR, categoryKey], { timeout: 120000 });
    }

    // A hard link publishes complete bytes atomically and refuses an existing
    // destination. Sync bytes first, then the published directory entry before
    // deleting health sources. Both paths live on the same filesystem.
    // Windows requires write access for FlushFileBuffers; r+ preserves existing bytes.
    const archiveFile = await open(stagedArchive, 'r+');
    try { await archiveFile.sync(); } finally { await archiveFile.close(); }
    await link(stagedArchive, archivePath);
    // Node does not expose directory fsync on Windows.
    if (process.platform !== 'win32') {
      const directory = await open(backupDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    const archiveStat = await stat(archivePath);

    let removed = 0;
    let retained = 0;
    let alreadyAbsent = 0;
    for (const { file, hash } of capturedDays) {
      await queueHealthDayMutation(file.slice(0, 10), async () => {
        const livePath = join(dirPath, file);
        const bytes = await readFile(livePath).catch(error => {
          // Another archive may already have removed this exact day.
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (bytes === null) {
          alreadyAbsent++;
        } else if (sha256Text(bytes) !== hash) {
          retained++;
        } else {
          await rmGuarded(livePath);
          removed++;
        }
      });
    }
    if (categoryKey === 'health') {
      console.log(`📦 Archived data/health to ${archiveName}: ${capturedDays.length} days, ${removed} removed, ${retained} retained, ${alreadyAbsent} already absent`);
      return { archived: capturedDays.length, removed, retained, alreadyAbsent, archivePath: relative(process.cwd(), archivePath), size: archiveStat.size };
    }
    console.log(`📦 Archived data/${categoryKey} to ${archiveName}`);
    return { archived: 0, archivePath: relative(process.cwd(), archivePath), archiveSize: archiveStat.size };
  } finally {
    await rmGuarded(operationDir, { recursive: true, force: true });
  }
}

export async function purgeCategory(categoryKey, options = {}) {
  try {
    const purge = () => purgeCategoryUncached(categoryKey, options);
    return await (categoryKey === 'update-detached' ? withUpdateControlLock(purge) : purge());
  } finally {
    invalidateOverviewScan();
  }
}

async function purgeCategoryUncached(categoryKey, options) {
  // A purge may retain external record references by explicit operator choice,
  // but its deletions must never interleave with a snapshot's copy and dump.
  return withBackupAssetPublication(async () => {
    if (!SAFE_NAME.test(categoryKey)) throw new ServerError('Invalid category name', { status: 400, code: 'VALIDATION_ERROR' });
    const meta = CATEGORIES[categoryKey];
    if (!meta?.deletable) {
      throw new ServerError(`Category "${categoryKey}" is not purgeable`, { status: 403, code: 'CATEGORY_NOT_PURGEABLE' });
    }
    // "Caller asked for one entry" is keyed on the option being PRESENT, not on
    // it being truthy: `{ subPath: '' }` is a caller that meant to name something
    // and produced nothing, and must 400 — not fall through to the branch that
    // empties the whole directory (#3327).
    const wantsItem = options.subPath !== undefined && options.subPath !== null;
    if (wantsItem && !isTopLevelEntryName(options.subPath)) {
      // Refusing separators outright means no traversal segment can form and, more
      // importantly, no *intermediate* component can be a symlink for `rm` to
      // follow out of the category — the lexical containment check below never
      // touches the filesystem, so it cannot see that.
      throw new ServerError('subPath must name a single entry in the category', { status: 400, code: 'VALIDATION_ERROR' });
    }
    // Item-scoped categories only ever lose one entry at a time. Written as
    // "must be exactly 'category'" so an absent or misspelled scope refuses the
    // wipe instead of inheriting the old all-or-nothing behavior (#3327).
    if (!wantsItem && meta.purgeScope !== 'category') {
      throw new ServerError(
        `Category "${categoryKey}" only supports per-item purge — pass a subPath`,
        { status: 400, code: 'CATEGORY_ITEM_PURGE_ONLY' }
      );
    }

    const dirPath = join(DATA_DIR, categoryKey);
    if (!existsSync(dirPath)) {
      throw new ServerError(`Category directory not found: ${categoryKey}`, { status: 404, code: 'NOT_FOUND' });
    }

    // A named directory can still contain a live job's working state. Apply
    // the same fail-closed busy probe to both deletion scopes.
    const { busy, busyReason } = await resolveCategoryBusy(categoryKey);
    if (busy) throw new ServerError(busyReason, { status: 409, code: 'CATEGORY_BUSY' });
    const protectedPaths = categoryKey === 'repos' ? await protectedRepoPaths() : [];

    if (wantsItem) {
      if (meta.purgeFilter && !meta.purgeFilter(options.subPath)) {
        if (categoryKey === 'screenshots' && isPersistentMindScreenshotEntry(options.subPath)) {
          throw new ServerError('Persistent Mind owns this attachment or upload recovery marker; manage it through Mind', {
            status: 409, code: 'SCREENSHOT_OWNED_BY_MIND',
          });
        }
        throw new ServerError(`"${options.subPath}" is kept by the ${categoryKey} category`, {
          status: 409, code: 'CATEGORY_ITEM_PROTECTED',
        });
      }
      const resolvedRoot = resolve(dirPath);
      const resolvedTarget = resolve(join(dirPath, options.subPath));
      // Boundary-aware containment check: use path.relative so a prefix like
      // `/data/cat` cannot satisfy containment for `/data/cat2`.
      const rel = relative(resolvedRoot, resolvedTarget);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new ServerError('Invalid subPath', { status: 400, code: 'VALIDATION_ERROR' });
      }
      // Ancestor (holds a checkout) or descendant (lies inside one) — both would destroy it.
      if (protectedPaths.some(p => p === resolvedTarget || isInsideDir(resolvedTarget, p) || isInsideDir(p, resolvedTarget))) {
        throw new ServerError(`"${options.subPath}" is a managed app checkout and is kept`, { status: 409, code: 'PROTECTED_CHECKOUT' });
      }
      // Item-scoped categories are flat directories of assets; their only
      // subdirectories are working state for other features (`data/videos/.detached`
      // holds the control files of in-flight renders). A one-click recursive
      // delete next to those on a cleanup page is a foot-gun, so an item purge
      // removes a single file and never recurses. `lstat`, not `stat`, so a
      // symlinked entry is judged as the link it is and simply unlinked.
      const itemScoped = meta.purgeScope === 'items';
      if (categoryKey === 'cache') return await purgeDataCacheEntry(dirPath, resolvedTarget, options.subPath);
      if (itemScoped) {
        const entryStat = await lstat(resolvedTarget).catch(() => null);
        if (!entryStat) {
          throw new ServerError(`Item not found in "${categoryKey}"`, { status: 404, code: 'NOT_FOUND' });
        }
        if (entryStat.isDirectory()) {
          throw new ServerError(
            `"${options.subPath}" is a directory — per-item purge in "${categoryKey}" only removes files`,
            { status: 400, code: 'ITEM_PURGE_FILE_ONLY' }
          );
        }
      }
      await rmGuarded(resolvedTarget, { recursive: !itemScoped, force: true });
      console.log(`🗑️ Purged item from data/${categoryKey}`);
    } else if (categoryKey === 'repos') {
      const { removed, kept } = await purgeUnprotectedEntries(dirPath, protectedPaths);
      console.log(`🗑️ Purged ${removed} entries from data/repos, kept ${kept} managed app checkout(s)`);
    } else {
      const allEntries = await readdir(dirPath).catch(() => []);
      const entries = meta.purgeFilter ? allEntries.filter(meta.purgeFilter) : allEntries;
      const removals = await Promise.allSettled(entries.map(entry => rmGuarded(join(dirPath, entry), { recursive: true, force: true })));
      const failed = removals.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      console.log(`🗑️ Purged ${entries.length} of ${allEntries.length} entries from data/${categoryKey}`);
    }

    return { category: categoryKey, subPath: wantsItem ? options.subPath : null };
  });
}

async function purgeDataCacheEntry(dirPath, target, name) {
  const dir = await lstat(dirPath);
  if (!dir.isDirectory()) {
    throw new ServerError('Data Manager will not purge a redirected cache directory.', { status: 409, code: 'CATEGORY_ITEM_PROTECTED' });
  }
  const entry = await lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) throw new ServerError('Item not found in "cache"', { status: 404, code: 'NOT_FOUND' });
  const type = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
  if (!dataCacheEntry(name, type).canPurge) {
    throw new ServerError('This entry is not a rebuildable cache that Data Manager can purge.', { status: 409, code: 'CATEGORY_ITEM_PROTECTED' });
  }
  await rmGuarded(target, { recursive: type === 'directory', force: true });
  console.log('🗑️ Purged a rebuildable entry from data/cache');
  return { category: 'cache', subPath: name };
}

export async function getBackups() {
  const backupDir = join(DATA_DIR, 'backup');
  if (!existsSync(backupDir)) return [];

  const entries = await readdir(backupDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter(e => e.isFile() && ARCHIVE_FILENAME.test(e.name));

  const backups = await Promise.all(files.map(async (entry) => {
    const fileStat = await stat(join(backupDir, entry.name)).catch(() => null);
    return {
      name: entry.name,
      size: fileStat?.size || 0,
      created: fileStat?.birthtime?.toISOString() || fileStat?.mtime?.toISOString() || null
    };
  }));

  backups.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  return backups;
}

export async function deleteBackup(filename) {
  if (!ARCHIVE_FILENAME.test(filename)) {
    throw new ServerError('Invalid filename', { status: 400, code: 'INVALID_FILENAME' });
  }
  const backupDir = join(DATA_DIR, 'backup');
  const fullPath = join(backupDir, filename);
  if (!fullPath.startsWith(backupDir)) {
    throw new ServerError('Path traversal not allowed', { status: 400, code: 'VALIDATION_ERROR' });
  }
  await rmGuarded(fullPath);
  invalidateOverviewScan();
  console.log(`🗑️ Deleted backup archive ${filename}`);
  return { deleted: filename };
}
