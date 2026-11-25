/**
 * Snapshot file restore: preflight inventory and integrity verification, the
 * instance-identity and live-owner fences, legacy ledger/config adoption, the
 * rsync transfer and post-restore reconciliation.
 */

import { lstat, readdir, rename, stat } from 'fs/promises';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'path';
import { PATHS, readJSONFileStrict, sha256File } from '../../lib/fileUtils.js';
import { acquireBackupSnapshotCut } from '../../lib/backupSnapshotBoundary.js';
import { APPLIED_LEDGER_RELPATH, LEGACY_APPLIED_LEDGER_RELPATH } from '../../../scripts/lib/migrationLedger.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isSafeSubdirFilter } from '../../lib/sharedSchemas.js';
import { reloadSettings, withLiveSettingsRestore } from '../settings.js';
import { invalidateAllCaches as invalidateBrainCaches } from '../brainStorage.js';
import {
  convertRestoredLegacySplitStores, describeLegacySplitStores, snapshotLegacySplitStores,
} from '../backupLegacyStores.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { resetInstanceIdCache } from '../instanceIdentity.js';
import {
  MANIFEST_ABSENT, assertExplicitSnapshotSourceSafe, assertSnapshotRestorable, legacyDbMetadataDomains,
  legacyDbMetadataMessage, manifestDataEntries, resolveSnapshotPath, usesFileEscapeHatch, withSnapshotRead,
} from './snapshots.js';
import {
  IDENTITY_FILE, IDENTITY_RSYNC_EXCLUDE, OS_METADATA_RSYNC_EXCLUDES, RESTORE_PRESERVED_RSYNC_EXCLUDES, isIdentityPath,
  isOsMetadataFile, isRestorePreservedPath, restoreScopeIsPreservedFile,
} from './excludes.js';
import { BACKUP_PROCESS_IDLE_TIMEOUT_MS, runRsync } from './rsync.js';

// `-ii` heartbeats once per file rsync finishes deciding about, so a single
// file whose `--checksum` digest outlasts the idle deadline still emits
// nothing for its whole duration (#7302). The digest reads BOTH copies — the
// snapshot side and the live side — so a restore floors its idle timeout at
// 2x the largest in-scope file over this throughput. Sized near the bottom of
// a healthy network/iCloud destination (~25 MB/s observed), the floor keeps
// the tight default for small trees and relaxes only where a long silence is
// explainable.
const RESTORE_DIGEST_WORST_CASE_BPS = 10 * 1024 * 1024;

// pg rejects an unreachable database with an AggregateError whose own message
// is empty; the useful text (e.g. ECONNREFUSED) lives on the nested errors.
function describeReconcileFailure(reason) {
  if (reason?.message) return reason.message;
  if (Array.isArray(reason?.errors)) {
    const parts = [...new Set(reason.errors.map(err => err?.code || err?.message).filter(Boolean))];
    if (parts.length > 0) return parts.join(', ');
  }
  return reason?.code || String(reason);
}

const restoresMediaScope = (subdirFilter) => !subdirFilter || ['images', 'videos', 'video-thumbnails', 'video-history.json']
  .some(path => subdirFilter === path || subdirFilter.startsWith(`${path}/`));

// A restored gallery image's `restoredAt` stamp is a sidecar write under the
// backup asset-publication lease, which would wait out the snapshot cut the
// restore holds while it reconciles, so this pass runs once the owners release.
async function clearRestoredImageTombstones(subdirFilter) {
  if (!restoresMediaScope(subdirFilter)) return;
  const { clearRestoredMediaTombstones } = await import('../mediaRestoreTombstones.js');
  await clearRestoredMediaTombstones().catch((error) => {
    throw new Error(`Live restore cache reconciliation failed (restored image delete records: ${describeReconcileFailure(error)}). Restart PortOS before relying on restored media.`, { cause: error });
  });
}

async function reconcileLiveFileRestore(subdirFilter) {
  const restoresMedia = restoresMediaScope(subdirFilter);
  const refreshes = [
    ...(!subdirFilter || subdirFilter === 'brain' || subdirFilter.startsWith('brain/')
      ? [{ label: 'Brain cache invalidation', run: invalidateBrainCaches }]
      : []),
    { label: 'settings reload', run: reloadSettings },
    ...(restoresMedia && !usesFileEscapeHatch()
      ? [{ label: 'media index rebuild', run: async () => {
        const { reconcileMediaAssets } = await import('../mediaAssetIndex/db.js');
        await reconcileMediaAssets({ rebuild: true });
      } }] : []),
    // A restored item keeps the delete record left by its earlier delete;
    // locally owned ones are un-deleted and re-announced to peers. Images wait
    // for clearRestoredImageTombstones: their stamp needs the snapshot cut released.
    ...(restoresMedia
      ? [{ label: 'restored media delete records', run: async () => {
        const { clearRestoredMediaTombstones } = await import('../mediaRestoreTombstones.js');
        await clearRestoredMediaTombstones({ images: false });
      } }] : []),
    // Migration 359 converts this plan once, at boot, so a plan restored from a
    // pre-359 snapshot would otherwise stay legacy and unrunnable: a folder
    // restore keeps the live ledger (359 never re-runs), and a full restore's
    // ledger only re-runs it on the next boot.
    ...(!subdirFilter || subdirFilter === 'cos' || subdirFilter === 'cos/quota-burn.json'
      ? [{ label: 'quota-burn plan conversion', run: async () => {
        const { reconcileRestoredQuotaBurnPlan } = await import('../quotaBurnConversion.js');
        await reconcileRestoredQuotaBurnPlan();
      } }] : []),
  ];
  const results = await Promise.allSettled(
    refreshes.map(({ run }) => Promise.resolve().then(run)),
  );
  const failures = results.flatMap((result, index) => result.status === 'rejected'
    ? [`${refreshes[index].label}: ${describeReconcileFailure(result.reason)}`]
    : []);

  if (failures.length > 0) {
    throw new Error(
      `Live restore cache reconciliation failed (${failures.join('; ')}). Restart PortOS before relying on restored settings, Brain data or media.`,
      { cause: results.find(result => result.status === 'rejected').reason },
    );
  }
}
const IDENTITY_ABSENT = Symbol('identity-absent');

async function readIdentityFile(path) {
  const { ok, value } = await readJSONFileStrict(path, IDENTITY_ABSENT, { logError: false });
  if (ok && value === IDENTITY_ABSENT) return { present: false, readable: true, instanceId: null };
  const instanceId = ok ? value?.self?.instanceId : null;
  return { present: true, readable: ok, instanceId: typeof instanceId === 'string' && instanceId ? instanceId : null };
}

/**
 * Whether this restore installs the snapshot's instances.json. Decided before
 * the integrity preflight so preview and execution exclude the same bytes. An
 * unreadable live file counts as an identity (fail closed): only adoption
 * replaces it, since its owner cannot be known.
 */
async function resolveIdentityRestore(srcDir, subdirFilter, adoptIdentity) {
  const notInstalled = { installs: false, preserved: null, adopted: null };
  if (subdirFilter && !isIdentityPath(subdirFilter)) return notInstalled;
  const snapshot = await readIdentityFile(join(srcDir, IDENTITY_FILE));
  if (!snapshot.present) return notInstalled;
  const live = await readIdentityFile(join(PATHS.data, IDENTITY_FILE));
  const liveHasIdentity = live.present && (live.instanceId !== null || !live.readable);
  if (!liveHasIdentity || (live.instanceId !== null && live.instanceId === snapshot.instanceId)) {
    return { installs: true, preserved: null, adopted: null };
  }
  const ids = { liveInstanceId: live.instanceId, snapshotInstanceId: snapshot.instanceId };
  return adoptIdentity
    ? { installs: true, preserved: null, adopted: ids }
    : { ...notInstalled, preserved: ids };
}

// `beforeTransfer`: nothing was written, so the caller must not report a partial restore.
const identityChangedError = () => Object.assign(new ServerError(
  'This machine\'s federation identity (instances.json) changed after the restore was checked. Nothing was restored; preview the restore again.',
  { status: 409, code: 'BACKUP_RESTORE_IDENTITY_CHANGED' },
), { beforeTransfer: true });

const snapshotFileIntegrityError = (snapshotId, unmanifestedPath = null) => new ServerError(
  // Name the offending entry: without it the operator is told their only backup
  // failed integrity and given nothing to act on.
  `Snapshot file integrity check failed: ${snapshotId}${unmanifestedPath ? ` (unmanifested file: ${unmanifestedPath})` : ''}`,
  { status: 409, code: 'BACKUP_FILE_INTEGRITY_FAILED' },
);

/**
 * Rebuild the in-scope regular-file inventory the manifest describes.
 * `paths` feed the unmanifested-file check; `largestFileBytes` is free here —
 * the same `stat`s produce it — and sizes the restore's idle-deadline floor
 * (rsync `--checksum` digests only regular files in scope, so the largest one
 * bounds the longest explainable silence between `-ii` heartbeats).
 */
async function snapshotScopeInventory(srcDir, subdirFilter, isSkippedPath = isRestorePreservedPath) {
  const scopePath = subdirFilter
    ? resolve(srcDir, ...subdirFilter.split('/'))
    : srcDir;
  const scopeInfo = await lstat(scopePath).catch(err => {
    if (err?.code === 'ENOENT') return null;
    throw err;
  });
  if (!scopeInfo) return { paths: [], largestFileBytes: 0 };

  const candidates = scopeInfo.isDirectory()
    ? (await readdir(scopePath, { recursive: true })).map(entry => join(scopePath, entry))
    : [scopePath];
  const paths = [];
  let largestFileBytes = 0;

  for (const filePath of candidates) {
    const info = await stat(filePath).catch(async err => {
      // Match generateManifest(): dangling links are intentionally outside the
      // manifest, while readable links to regular files are hashed and tracked.
      if (err?.code === 'ENOENT') {
        const entryInfo = await lstat(filePath);
        if (entryInfo.isSymbolicLink()) return null;
      }
      throw err;
    });
    if (!info?.isFile()) continue;
    // OS metadata never reaches rsync (OS_METADATA_RSYNC_EXCLUDES), so it must
    // not inflate the digest floor either.
    if (isOsMetadataFile(basename(filePath))) continue;
    const scopedPath = relative(srcDir, filePath).replaceAll('\\', '/');
    if (isSkippedPath(scopedPath)) continue;
    if (info.size > largestFileBytes) largestFileBytes = info.size;

    const normalized = relative(srcDir, filePath).replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('../') || isAbsolute(normalized)) {
      throw new Error('Snapshot entry escaped the data directory');
    }
    paths.push(normalized);
  }

  return { paths, largestFileBytes };
}

async function assertRestoreStorageCompatible(srcDir, inventory, snapshotId) {
  // Match dumpPostgres: an uninitialized backend still requires PostgreSQL.
  if (usesFileEscapeHatch()) return;
  if (!inventory) throw snapshotFileIntegrityError(snapshotId);
  const domains = await legacyDbMetadataDomains(srcDir, inventory.paths);
  if (domains.length) {
    throw new ServerError(
      legacyDbMetadataMessage(domains),
      { status: 409, code: 'BACKUP_LEGACY_DB_METADATA', context: { domains } },
    );
  }
}

async function verifySnapshotFiles(snapshotDir, srcDir, snapshotId, subdirFilter, { preserveIdentity = false } = {}) {
  const isSkippedPath = preserveIdentity
    ? path => isRestorePreservedPath(path) || isIdentityPath(path)
    : isRestorePreservedPath;
  // A unique fallback distinguishes a genuinely absent legacy manifest from an
  // existing file whose parsed value is JSON null.
  const manifestRead = await readJSONFileStrict(
    join(snapshotDir, 'manifest.json'),
    MANIFEST_ABSENT,
    { logError: false },
  );
  if (!manifestRead.ok) {
    throw new ServerError(`Snapshot integrity manifest is unreadable: ${snapshotId}`, {
      status: 409,
      code: 'BACKUP_MANIFEST_UNREADABLE',
    });
  }
  if (manifestRead.value === MANIFEST_ABSENT) {
    // No manifest to verify against, but the restore's idle-deadline floor
    // still needs the largest in-scope file. PostgreSQL also needs a complete
    // inventory to reject ignored legacy metadata; only the file escape hatch
    // can retain the old best-effort behavior when inventory fails.
    const legacyInventory = await snapshotScopeInventory(srcDir, subdirFilter, isSkippedPath).catch(() => null);
    await assertRestoreStorageCompatible(srcDir, legacyInventory, snapshotId);
    return {
      status: 'unverified',
      reason: 'manifest_absent',
      checkedFiles: 0,
      largestFileBytes: legacyInventory?.largestFileBytes ?? 0,
    };
  }

  const manifestEntries = manifestDataEntries(manifestRead.value, srcDir, subdirFilter, isSkippedPath);
  if (!manifestEntries) {
    throw new ServerError(`Snapshot integrity manifest is invalid: ${snapshotId}`, {
      status: 409,
      code: 'BACKUP_MANIFEST_INVALID',
    });
  }
  const { selected, dataPaths } = manifestEntries;

  // Hash agreement is insufficient if rsync can also copy files the manifest
  // never recorded. Rebuild the same regular-file inventory in the selected
  // scope and reject additions before rsync reads or overwrites anything.
  const inventory = await snapshotScopeInventory(srcDir, subdirFilter, isSkippedPath)
    .catch(() => null);
  if (!inventory) throw snapshotFileIntegrityError(snapshotId);
  await assertRestoreStorageCompatible(srcDir, inventory, snapshotId);
  const { paths: snapshotPaths, largestFileBytes } = inventory;
  const unmanifested = snapshotPaths.find(entry => !dataPaths.has(entry));
  if (unmanifested) throw snapshotFileIntegrityError(snapshotId, unmanifested);

  for (const { filePath, expectedHash } of selected) {
    const info = await lstat(filePath).catch(() => null);
    if (!info || (!info.isFile() && !info.isSymbolicLink())) {
      throw snapshotFileIntegrityError(snapshotId);
    }
    const actualHash = await sha256File(filePath).catch(() => null);
    if (!actualHash || actualHash !== expectedHash) {
      throw snapshotFileIntegrityError(snapshotId);
    }
  }

  return { status: 'verified', checkedFiles: selected.length, largestFileBytes };
}

/**
 * Idle deadline for a restore's rsync. `--checksum` digests BOTH copies of a
 * same-size file before rsync reports the entry, so the largest in-scope file
 * bounds the longest silence a healthy scan can produce: floor the deadline at
 * both copies over a conservative worst-case throughput. A scope holding only
 * small files keeps the default — the relaxed deadline is spent only where a
 * long silence is explainable (#7302).
 */
function restoreIdleTimeoutMs(largestFileBytes = 0) {
  const digestMs = (2 * largestFileBytes * 1000) / RESTORE_DIGEST_WORST_CASE_BPS;
  return Math.max(BACKUP_PROCESS_IDLE_TIMEOUT_MS, Math.ceil(digestMs));
}

/**
 * Restore a snapshot back to PATHS.data using rsync.
 * @param {string} destPath - Path to external drive backup root
 * @param {string} snapshotId - Snapshot ID to restore
 * @param {object} options
 * @param {boolean} [options.dryRun=true] - If true, do not write any files
 * @param {string|null} [options.subdirFilter=null] - Limit restore to a subdirectory
 * @param {boolean} [options.adoptIdentity=false] - Install a snapshot's different
 *   federation identity (instances.json) over the live one; only for replacing a
 *   retired machine. Without it the live identity is preserved (`identityPreserved`).
 */
export async function restoreSnapshot(destPath, snapshotId, { dryRun = true, subdirFilter: requestedFilter = null, source, adoptIdentity = false } = {}) {
  return maintenance.run('backup', `restore:${String(snapshotId).slice(0, 240)}`, () => restoreSnapshotAdmitted(destPath, snapshotId,
    { dryRun, requestedFilter, source, adoptIdentity }));
}

async function restoreSnapshotAdmitted(destPath, snapshotId, { dryRun, requestedFilter, source, adoptIdentity }) {
  // Canonicalize once: manifest selection, the inventory and the rsync include
  // chain each spell the filter differently, so `brain/` or `./brain` would
  // select nothing yet verify clean. An all-dot/empty filter means no filter.
  const subdirFilter = typeof requestedFilter === 'string'
    ? requestedFilter.split('/').filter(part => part && part !== '.').join('/') || null
    : requestedFilter;
  const resolved = resolveSnapshotPath(destPath, snapshotId, source);
  await assertExplicitSnapshotSourceSafe(resolved, snapshotId);

  // Defense-in-depth for non-route callers (the route already validates via
  // subdirFilterSchema). subdirFilter is interpolated into an rsync include arg,
  // so a `*` would override the filter chain (restoring everything) and `..`
  // would traverse out of the snapshot subdir. Reuse the same predicate the
  // schema does so the two can't drift — see issue #1822.
  if (requestedFilter != null && (String(requestedFilter).startsWith('/') || (subdirFilter != null && !isSafeSubdirFilter(subdirFilter)))) {
    throw new Error(`Invalid subdirFilter: ${requestedFilter}`);
  }
  // Refused for previews too, before any verification or transfer, so a preview
  // never promises a restore that execution would silently skip.
  if (restoreScopeIsPreservedFile(subdirFilter)) {
    throw new ServerError(
      'These machine-local authority and recovery records (database-authority.json, database-restore-recovery.json, peer-execution-authority.json, peer-execution-recovery.jsonl, workflow-maintenance, backup-admission and the archive-policy revision) are never restored from a snapshot. Restore application records with a data or database restore; existing local authority and unresolved owners must be reconciled on this machine (see docs/STORAGE_RECOVERY.md).',
      { status: 400, code: 'BACKUP_RESTORE_MACHINE_LOCAL' },
    );
  }

  // Hold the source from before the restorability and integrity preflight
  // until rsync has closed (and, for execution, caches are reconciled), so
  // neither explicit deletion nor retention can remove verified bytes while
  // rsync still reads them (#10898).
  return withSnapshotRead(resolved.snapshotDir, snapshotId,
    () => restoreHeldSnapshot(resolved, snapshotId, { dryRun, subdirFilter, adoptIdentity: adoptIdentity === true }));
}

async function restoreHeldSnapshot({ snapshotDir, currentSource }, snapshotId, { dryRun, subdirFilter, adoptIdentity }) {
  await assertSnapshotRestorable(snapshotDir, snapshotId, currentSource);
  const srcDir = join(snapshotDir, 'data');
  const identity = await resolveIdentityRestore(srcDir, subdirFilter, adoptIdentity);
  // Keyed on the approval, not on a mismatch: a snapshot instances.json that
  // appears after the check must not reach the live file unfenced.
  const preserveIdentity = !identity.installs;

  // Run the preflight independently for preview and execution. A preview is an
  // aid to confirmation, not an integrity lease: snapshot bytes may change
  // between requests, especially on removable or network-backed destinations.
  const verification = await verifySnapshotFiles(snapshotDir, srcDir, snapshotId, subdirFilter, { preserveIdentity });
  // A full restore installs the snapshot's ledger too, so the next boot re-runs
  // whatever it lacks; only a folder restore can leave restored files behind
  // migrations the live ledger already records.
  const ledgerGap = subdirFilter ? await migrationLedgerGap(srcDir) : undefined;
  // Split migrations gate on their output, so neither ledger re-runs them over
  // a restored monolith; restore converts those stores itself (#12626). A full
  // restore installs the snapshot's ledger, so the migrations it lacks before a
  // split are replayed with that split, in order (#12813).
  const legacyStores = await snapshotLegacySplitStores(srcDir, subdirFilter, {
    ledger: subdirFilter ? null : await readSnapshotMigrationLedger(srcDir),
  });
  const legacyLedger = await snapshotLegacyLedger(srcDir, subdirFilter);
  const restoreNotes = (restoredLegacy, restoredLegacyLedger = legacyLedger) => ({
    ...(ledgerGap !== undefined && { ledgerGap }),
    ...(restoredLegacy.stores.length > 0 && { restoredLegacyStores: restoredLegacy.stores }),
    ...(restoredLegacy.migrations && { restoredLegacyMigrations: restoredLegacy.migrations }),
    ...(restoredLegacyLedger && { restoredLegacyLedger }),
    ...(identity.preserved && { identityPreserved: identity.preserved }),
    ...(identity.adopted && { identityAdopted: identity.adopted }),
  });

  // Restore must compare destination bytes even when size and mtime match.
  // Rsync's default quick-check would otherwise report a successful no-op for
  // equal-length edits that retain the snapshot timestamp.
  //
  // `-ii` is what keeps that affordable. `--checksum` makes rsync digest BOTH
  // copies of every file in scope, and a file that turns out to match emits
  // nothing under plain `--itemize-changes`/`--progress` — those report only
  // transferring files. A preview of a large unchanged tree therefore runs
  // silent for as long as the digest takes, and runRsync's idle watchdog
  // (BACKUP_PROCESS_IDLE_TIMEOUT_MS) SIGKILLs a perfectly healthy restore.
  // Doubling itemize makes rsync report unchanged entries too (`.f <path>`),
  // one line per file digested, which is what keeps the watchdog fed. The
  // changed-file count runRsync returns is unaffected: the added lines start
  // with `.`, and runRsync collects only `>`/`<` transfer lines.
  //
  // It must be the SHORT `-ii`, and it is deliberately not `--info=progress2`:
  // macOS ships openrsync, where the long `--itemize-changes` does NOT stack
  // when repeated and `--info=progress2` is rejected outright as an unknown
  // option (it arrived in rsync 3.1). `-ii` behaves identically on openrsync
  // and rsync 3.x, so no version probe is needed. See issue #7299.
  //
  // Before the include chain below: rsync takes the FIRST matching rule, so an
  // exclude placed after `--include=/<filter>/***` would never be consulted.
  // These are the files `snapshotScopeInventory` skips — keeping the two in
  // step is what preserves "everything transferred was verified".
  // Same placement rule: excluded before the include chain, and kept out of the
  // manifest selection and inventory above, so what rsync may write is exactly
  // what the preflight verified.
  const flags = ['-ii', '--checksum', ...OS_METADATA_RSYNC_EXCLUDES, ...RESTORE_PRESERVED_RSYNC_EXCLUDES,
    ...(preserveIdentity ? [IDENTITY_RSYNC_EXCLUDE] : [])];
  if (dryRun) flags.push('--dry-run');
  if (subdirFilter) {
    // Anchored with a leading `/` — rsync matches an unanchored pattern against
    // the END of every path, so a bare `youtube/***` would also restore
    // `data/brain/youtube/**` over live files the user never selected. The
    // integrity preflight above scopes itself to `data/<filter>/**` only, so an
    // unanchored transfer overwrites bytes it never verified.
    // Exact files need their own rule: rsync 3 excludes a file from the directory-only /*** pattern.
    flags.push(`--include=/${subdirFilter}`);
    flags.push(`--include=/${subdirFilter}/***`);
    flags.push('--include=*/');
    flags.push('--exclude=*');
  }

  // The preflight just walked the scope, so its largest file is free — one
  // file whose digest outlasts the default deadline emits no `-ii` heartbeat
  // until it finishes (#7302), so this restore's idle floor scales to it.
  const idleTimeoutMs = restoreIdleTimeoutMs(verification.largestFileBytes);
  const transferFiles = () => runRsync(srcDir, PATHS.data, flags, { idleTimeoutMs });
  // A preview holds no owner, fences no identity and reconciles no cache.
  if (dryRun) {
    const changedFiles = await transferFiles();
    return { dryRun, snapshotId, subdirFilter, changedFiles, verification, ...restoreNotes(describeLegacySplitStores(legacyStores)) };
  }

  const scope = subdirFilter;
  console.log(`💾 Restore starting: snapshot ${snapshotId}${scope ? ` (filter ${scope})` : ''}`);
  let restoredLegacy = { stores: [], migrations: null };
  let restoredLegacyLedger = legacyLedger;
  // Conversion parks live stores, so it runs only after a successful transfer,
  // and before reconciliation so the Brain caches drop the parked records. It
  // follows ledger adoption so a replay reads the ledger the boot would read.
  const changedFiles = await withLiveFileRestoreOwners(scope, srcDir, () => transferAndReconcileLiveFiles({
    subdirFilter,
    transfer: async () => {
      const changed = await transferWithIdentityFence({
        installsIdentity: identity.installs,
        assertIdentityUnchanged: async () => {
          const current = await resolveIdentityRestore(srcDir, subdirFilter, adoptIdentity);
          if (JSON.stringify(current) !== JSON.stringify(identity)) throw identityChangedError();
        },
        transferFiles,
      });
      if (legacyLedger) restoredLegacyLedger = await adoptRestoredLegacyLedger(legacyLedger);
      restoredLegacy = await convertRestoredLegacySplitStores(legacyStores);
      return changed;
    },
  }));
  await clearRestoredImageTombstones(subdirFilter);
  console.log(`💾 Restore complete: snapshot ${snapshotId}, ${changedFiles.length} files changed`);
  return { dryRun, snapshotId, subdirFilter, changedFiles, verification, ...restoreNotes(restoredLegacy, restoredLegacyLedger) };
}

async function readMigrationLedger(path) {
  const { ok, value } = await readJSONFileStrict(path, null, { logError: false });
  return ok && Array.isArray(value) ? value.filter(name => typeof name === 'string') : null;
}

const ledgerPaths = (dataDir) => ({ current: join(dataDir, APPLIED_LEDGER_RELPATH), legacy: join(dataDir, LEGACY_APPLIED_LEDGER_RELPATH) });
const fileExists = (path) => stat(path).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error; });

/**
 * The snapshot's migration ledger: `data/migrations.applied.json`, or the
 * `data/migrations/.applied.json` a snapshot from before the May 2026 move of
 * migrations out of `data/` still carries. Null when neither is readable.
 */
async function readSnapshotMigrationLedger(srcDir) {
  const { current, legacy } = ledgerPaths(srcDir);
  return (await readMigrationLedger(current)) ?? (await readMigrationLedger(legacy));
}

/**
 * Whether a full restore of this snapshot must adopt its ledger by hand: the
 * snapshot carries the ledger only at the legacy path. rsync lands that file
 * beside the live `migrations.applied.json` instead of over it, and the runner
 * then keeps the live ledger (a current ledger is authoritative over a legacy
 * one), so nothing would re-run over the restored records (#12355 assumed the
 * two paths coincide). Null when the snapshot carries a current ledger or none.
 * A legacy ledger that does not parse as a list is reported `unreadable` and
 * never adopted: the live ledger is worth more than a broken one, which the
 * runner would rename aside and rebuild from scratch.
 */
async function snapshotLegacyLedger(srcDir, subdirFilter) {
  if (subdirFilter) return null;
  const { current, legacy } = ledgerPaths(srcDir);
  if (await fileExists(current) || !await fileExists(legacy)) return null;
  return { status: await readMigrationLedger(legacy) ? 'pending' : 'unreadable', parkedAs: null };
}

/**
 * Install the restored legacy ledger as the live one, after the transfer and
 * before cache reconciliation: the live ledger is parked beside it (evidence,
 * like a parked split store), and the next migration run starts from the
 * snapshot's list, exactly as a full restore with a current-path ledger does.
 */
async function adoptRestoredLegacyLedger(legacyLedger) {
  if (legacyLedger.status !== 'pending') {
    console.warn(`⚠️ Restore left the live migration ledger in place: the snapshot's ${LEGACY_APPLIED_LEDGER_RELPATH} is unreadable`);
    return legacyLedger;
  }
  const { current, legacy } = ledgerPaths(PATHS.data);
  // Confirmed on the transferred copy before the live ledger moves: parking it
  // and then failing would leave no ledger (or a broken one), which the next
  // boot reads as a fresh install: every migration re-runs and purge migrations
  // are disarmed.
  if (!await readMigrationLedger(legacy)) {
    throw new Error(`Restore transferred no readable ${LEGACY_APPLIED_LEDGER_RELPATH}; the live migration ledger was left unchanged`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parkedAs = `${basename(current)}.pre-restore-${stamp}`;
  const parked = await rename(current, join(dirname(current), parkedAs)).then(
    () => true,
    error => { if (error.code === 'ENOENT') return false; throw error; },
  );
  await rename(legacy, current);
  console.log(`📦 Restore adopted the snapshot's pre-May-2026 migration ledger${parked ? `; previous ledger parked as ${parkedAs}` : ''}`);
  return { status: 'adopted', parkedAs: parked ? parkedAs : null };
}

/**
 * Migrations the live install has applied that the snapshot's ledger lacks:
 * files a folder restore installs from that snapshot may predate them, and no
 * runner revisits a migration the live ledger already records. `null` means
 * unknown — the snapshot (or the live install) has no readable ledger.
 */
async function migrationLedgerGap(srcDir) {
  const snapshotLedger = await readSnapshotMigrationLedger(srcDir);
  const liveLedger = snapshotLedger && await readMigrationLedger(ledgerPaths(PATHS.data).current);
  if (!snapshotLedger || !liveLedger) return null;
  const recorded = new Set(snapshotLedger);
  const names = liveLedger.filter(name => !recorded.has(name));
  return { count: names.length, names };
}

const COS_RESTORE_SCOPES = ['cos', 'cos/config.json', 'cos/state.json', 'cos/agents'];

/**
 * The CoS config a restore of `scope` installs from a snapshot taken before the
 * #6182 split: such a snapshot has no cos/config.json and keeps the settings in
 * the `config` slice of cos/state.json. Null when the snapshot carries its own
 * config.json or the scope leaves cos/state.json alone.
 */
async function snapshotLegacyCosConfig(srcDir, scope) {
  if (scope && scope !== 'cos' && scope !== 'cos/state.json') return null;
  const carriesConfigFile = await stat(join(srcDir, 'cos', 'config.json')).then(
    info => info.isFile(),
    error => { if (error.code === 'ENOENT') return false; throw error; },
  );
  if (carriesConfigFile) return null;
  const { ok, value } = await readJSONFileStrict(join(srcDir, 'cos', 'state.json'), null, { logError: false });
  const config = ok ? value?.config : null;
  return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
}

/**
 * Owners a live file restore holds, OUTERMOST FIRST — this array order IS the
 * acquisition order, and each owner is released in reverse after everything
 * inside it (transfer plus partial-failure reconciliation) has settled.
 * `appliesTo` receives the normalized scope (`''`/undefined = full restore);
 * `hold(inner, { srcDir, scope })` acquires the owner, runs `inner`, and
 * releases on every exit; `srcDir` is the verified snapshot's data directory. Domain
 * modules are imported only once every outer owner is held.
 *
 * - The snapshot cut drains in-flight asset publications BEFORE any domain
 *   queue they may need to finish, and keeps admission closed throughout.
 * - Schedule mutations can await CoS state, so their queue precedes CoS.
 * - The settings queue stays held through CoS reconciliation.
 * - CoS acquires config then runtime internally (`withLiveCosRestore`) and
 *   refuses a busy daemon/mind/agent with `COS_RESTORE_BUSY`.
 * - The media registry refuses edits for the whole hold and is acquired after
 *   CoS, so its write fence never outlives a refused CoS restore.
 * - Apple Health admission is acquired last, for the same reason: it closes
 *   import/archive admission and drains admitted day cycles (which wait on no
 *   other owner) before the transfer, then reopens after cache invalidation.
 */
const LIVE_FILE_RESTORE_OWNERS = Object.freeze([
  {
    name: 'backup snapshot cut',
    appliesTo: () => true,
    hold: async (inner) => {
      const releaseSnapshotCut = await acquireBackupSnapshotCut();
      try {
        return await inner();
      } finally {
        releaseSnapshotCut();
      }
    },
  },
  {
    name: 'task schedule',
    appliesTo: scope => !scope || scope === 'cos' || scope === 'cos/task-schedule.json',
    hold: async (inner) => {
      const { withLiveTaskScheduleRestore } = await import('../taskScheduleStore.js');
      return withLiveTaskScheduleRestore(inner);
    },
  },
  {
    name: 'settings',
    appliesTo: scope => !scope || scope === 'settings.json',
    hold: inner => withLiveSettingsRestore(inner),
  },
  {
    name: 'CoS config and runtime',
    appliesTo: scope => !scope || COS_RESTORE_SCOPES.includes(scope) || scope.startsWith('cos/agents/'),
    hold: async (inner, { srcDir, scope }) => {
      const snapshotLegacyConfig = await snapshotLegacyCosConfig(srcDir, scope);
      const { withLiveCosRestore } = await import('../cos/cosState.js');
      return withLiveCosRestore(inner, { snapshotLegacyConfig });
    },
  },
  {
    name: 'media model registry',
    appliesTo: scope => !scope || scope === 'media-models.json',
    hold: async (inner) => {
      const { withLiveMediaModelsRestore } = await import('../../lib/mediaModels.js');
      return withLiveMediaModelsRestore(inner);
    },
  },
  {
    name: 'Apple Health day files',
    appliesTo: scope => !scope || scope === 'health' || scope.startsWith('health/'),
    hold: async (inner) => {
      const { withLiveHealthRestore } = await import('../appleHealthIngest.js');
      return withLiveHealthRestore(inner);
    },
  },
]);

/** Run `operation` inside every live-restore owner that applies to `scope`, in table order. */
function withLiveFileRestoreOwners(scope, srcDir, operation) {
  const nested = LIVE_FILE_RESTORE_OWNERS.reduceRight(
    (inner, owner) => (owner.appliesTo(scope) ? () => owner.hold(inner, { srcDir, scope }) : inner),
    operation,
  );
  return nested();
}

/**
 * Peer-execution identity fence: shorter-lived than the owners above. It wraps
 * ONLY the rsync transfer, never reconciliation, and only when this restore
 * installs instances.json (resolveIdentityRestore). The decision was made
 * before verification, so it is re-checked here under the identity writer lock:
 * a live identity written since then (first pairing, ensureSelf) must not be
 * overwritten without adoption. The memoized instance id is dropped even after
 * a partial transfer, so the process never stamps an id the file no longer holds.
 */
async function transferWithIdentityFence({ installsIdentity, assertIdentityUnchanged, transferFiles }) {
  if (!installsIdentity) return transferFiles();
  const [{ withPeerExecutionIdentityRestore }, { resetSelfInstanceIdCache }] = await Promise.all([
    import('../peerExecutionRuntime.js'),
    import('../../lib/peerHttpClient.js'),
  ]);
  return withPeerExecutionIdentityRestore(async () => {
    await assertIdentityUnchanged();
    try {
      return await transferFiles();
    } finally {
      resetInstanceIdCache();
      resetSelfInstanceIdCache();
    }
  });
}

/**
 * Rsync may overwrite live files before reporting failure, so settle the
 * transfer and reconcile caches while the owners are still held. A transfer
 * failure stays the primary error (keeping its code); a reconciliation failure
 * is appended to it, or thrown on its own after a successful transfer.
 */
async function transferAndReconcileLiveFiles({ subdirFilter, transfer }) {
  const [result] = await Promise.allSettled([transfer()]);
  const reconciliationError = await reconcileLiveFileRestore(subdirFilter).then(() => null, error => error);
  if (result.status === 'rejected') {
    if (result.reason?.beforeTransfer) throw result.reason;
    const partialRestoreError = new Error(
      `${result.reason.message}. Some files may already have been overwritten because file restore is not transactional.${reconciliationError ? ` ${reconciliationError.message}` : ''}`,
      { cause: result.reason },
    );
    if (result.reason?.code) partialRestoreError.code = result.reason.code;
    throw partialRestoreError;
  }
  if (reconciliationError) throw reconciliationError;
  return result.value;
}
