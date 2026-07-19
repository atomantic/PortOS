/**
 * Shared scaffolding for migrations. Two families live here:
 *
 *   1. Hash-driven prompt-replace migrations — every one from 003 onward uses
 *      `makePromptReplaceMigration` to collapse onto ~50 lines (hash table +
 *      label + customized-skip hint).
 *   2. Dashboard-layout seeding migrations — `readLayoutsDoc` /
 *      `writeLayoutsDoc` collapse the read → JSON.parse → `Array.isArray`
 *      guard → write shell shared by every migration that mutates built-in
 *      layouts in `data/dashboard-layouts.json` (029, 030, 033, …).
 *
 * The runner (`scripts/run-migrations.js`) explicitly skips `_`-prefixed
 * files so this module is never imported as a migration.
 */

import { readFile, writeFile, unlink, readdir, rename, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';

// ---- monolithic → per-record split-migration family ----
//
// Migrations 034 / 035 / 036 / 059 all split a single `data/<legacy>.json`
// (`{ [recordsKey]: [...] }`) into per-record `data/<typeDir>/<id>/index.json`
// files plus a type-level `data/<typeDir>/index.json` that stamps the storage
// `schemaVersion`. They share the same gate1 (already-applied) / gate2
// (fresh-install) / recovery / split / stamp / backup skeleton and differ only
// in a handful of config values. `makeSplitMigration` collapses that skeleton;
// see `server/lib/collectionStore.js` for the on-disk layout it targets.
//
// Behavioral divergences across the four are PRESERVED via flags, not
// homogenized — they were deliberate (a split that silently changed what an
// applied migration did to existing data would be a corruption bug):
//
//   - `onUnreadable: 'return' | 'throw'` — 034/035/036 return
//     `{ ok:false, reason:'unreadable' }` (the runner marks them applied; a
//     repaired file is NOT re-split). 059 THROWS so the runner leaves it
//     pending and a repaired file re-splits on the next boot.
//   - `dedupe` — 059 claims each id as it writes so a duplicate id later in the
//     legacy array is skipped (first-wins, mirroring the old monolithic
//     `listCollections` dedup). 034/035/036 never had duplicate-id concerns.
//   - `extraValid(record)` — 059 additionally rejects a blank/missing `name`
//     (mirroring `sanitizeCollection`'s read-time drop) so an unsanitizable
//     leading row can't shadow a later valid duplicate. The others validate id
//     only.
//   - `buildConfig(doc)` — 034 moves the legacy cross-record `runs[]` into
//     `config.runs`; the others stamp `config: {}`.
//   - `idPattern` / `invalidWarn` / `recordNoun` — per-kind id shape + log copy.
//   - `recordsShape: 'array' | 'map'` — the legacy container shape. 034/035/036/
//     059 store `{ [recordsKey]: [ {id, …}, … ] }` (an ARRAY; id comes from
//     `record.id`) — the default `'array'`. Brain entity stores (migration 200)
//     store `{ [recordsKey]: { <id>: record } }` (an object MAP; id is the KEY,
//     the record value carries no id field). `'map'` iterates `Object.entries`,
//     derives the id from the key, and — because the value is written verbatim —
//     PRESERVES in-place tombstones (`{ _deleted: true, updatedAt, … }`) so a
//     split can't drop the last-writer-wins markers federation depends on. Map
//     mode also skips the reserved keys `__proto__` / `constructor` / `prototype`
//     (a legacy JSON map can carry them as own keys; the collectionStore id
//     allowlist would accept them, so guard here) — left in the backup.

const splitFileExists = (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

// Two read variants so we distinguish "missing file" from "present but
// unparseable" — the latter is a recovery-required state reported through the
// migration's return value (or a throw) rather than crashing the boot.
const splitReadJsonStrict = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  return JSON.parse(raw);
};

const splitReadJsonTolerant = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return { __unreadable: true }; }
};

// Atomic write (temp + rename) so a crash mid-write can't leave a truncated
// `<id>/index.json`. Without it, a retry's `splitExistingRecordIds` scan would
// see the partial file, trust it as already-split, skip re-splitting from the
// authoritative legacy value, then stamp + rename the legacy store — and the
// truncated record would forever load as null. rename() is atomic within one
// filesystem, and tmp sits in the same dir as its target, so the swap is safe.
const splitWriteJson = async (path, value) => {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
};

// Reserved keys a legacy `map`-shape doc can carry as own properties (JSON.parse
// surfaces a literal `"__proto__"` key as an own property). They pass a typical
// `idPattern`, so a map split must drop them explicitly rather than write a
// `__proto__/index.json` record dir — left in the backup for manual recovery.
const RESERVED_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Scan the type dir for records already split in a prior partial run. Uses
// `withFileTypes` so stray non-directory entries (user `.bak` files, editor
// swap files) are skipped without statting INTO them — `stat('foo.bak/index.json')`
// would raise ENOTDIR and crash the migration.
async function splitExistingRecordIds(typeDir) {
  const ids = new Set();
  if (!await splitFileExists(typeDir)) return ids;
  const entries = await readdir(typeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === 'index.json' || entry.name.startsWith('.') || !entry.isDirectory()) continue;
    if (await splitFileExists(join(typeDir, entry.name, 'index.json'))) ids.add(entry.name);
  }
  return ids;
}

/**
 * Build a monolithic→per-record split migration's `up()`. Returns `{ up }`.
 *
 * Required config:
 *   - `migrationLabel`   — log tag, e.g. `'migration 034'`
 *   - `typeDirName`      — `data/<typeDirName>/` (e.g. `'universes'`)
 *   - `legacyFilename`   — `data/<legacyFilename>` (e.g. `'universe-builder.json'`)
 *   - `backupSuffix`     — appended to the legacy path on backup (e.g. `'.bak-034'`)
 *   - `typeSchemaVersion`— the type-level layout version this migration stamps
 *   - `typeLabel`        — the `type` field written into the type index
 *   - `recordsKey`       — array key in the legacy doc (e.g. `'universes'`)
 *   - `idPattern`        — RegExp a record id must match to be split
 *   - `recordNoun`       — singular noun for the split-count log (e.g. `'universe'`)
 *
 * Optional:
 *   - `buildConfig(doc)` — returns the type index `config`; default `() => ({})`
 *   - `extraValid(record)`— extra per-record validity gate beyond id (059's name check)
 *   - `dedupe`           — claim ids as written so later duplicates skip (059); default false
 *   - `onUnreadable`     — `'return'` (default) or `'throw'`
 *   - `recordsShape`     — `'array'` (default; id from `record.id`) or `'map'`
 *                          (legacy `{ [recordsKey]: { <id>: record } }`; id is the
 *                          object key, tombstones preserved, reserved keys skipped)
 */
export function makeSplitMigration({
  migrationLabel,
  typeDirName,
  legacyFilename,
  backupSuffix,
  typeSchemaVersion,
  typeLabel,
  recordsKey,
  idPattern,
  recordNoun,
  buildConfig = () => ({}),
  extraValid = null,
  dedupe = false,
  onUnreadable = 'return',
  recordsShape = 'array',
}) {
  const up = async ({ rootDir }) => {
    const dataDir = join(rootDir, 'data');
    const typeDir = join(dataDir, typeDirName);
    const typeIndexPath = join(typeDir, 'index.json');
    const legacyPath = join(dataDir, legacyFilename);
    const backupPath = legacyPath + backupSuffix;

    // Gate 1: type index already at/above target → no-op (a re-run after full
    // success lands here). Strict read — a corrupted index.json should throw.
    const typeIndex = await splitReadJsonStrict(typeIndexPath);
    if (typeIndex && typeIndex.schemaVersion >= typeSchemaVersion) {
      console.log(`📦 ${migrationLabel}: ${typeLabel} already at schemaVersion=${typeIndex.schemaVersion} — no-op`);
      return { ok: true, reason: 'already-applied' };
    }

    const legacyExists = await splitFileExists(legacyPath);
    const backupExists = await splitFileExists(backupPath);

    // Gate 2: fresh install — no legacy, no backup. Stamp the type index so the
    // boot-time verifyCollectionVersions doesn't flag it missing.
    if (!legacyExists && !backupExists) {
      await mkdir(typeDir, { recursive: true });
      await splitWriteJson(typeIndexPath, {
        schemaVersion: typeSchemaVersion,
        type: typeLabel,
        updatedAt: new Date().toISOString(),
        config: buildConfig(null),
      });
      console.log(`📦 ${migrationLabel}: fresh install — stamped data/${typeDirName}/index.json @ v${typeSchemaVersion}`);
      return { ok: true, reason: 'fresh-install' };
    }

    // Recovery gate: a prior run split records but didn't finish renaming the
    // legacy file. Use whichever file is present — prefer the live file if both
    // somehow exist (the split must not have happened).
    const sourcePath = legacyExists ? legacyPath : backupPath;
    const doc = await splitReadJsonTolerant(sourcePath);
    if (!doc || typeof doc !== 'object' || doc.__unreadable) {
      if (onUnreadable === 'throw') {
        // THROW (don't return) so the runner does NOT mark this migration applied
        // (run-migrations.js records any migration whose up() resolves) — keeps it
        // pending so a repaired file re-splits on the next boot. Server boot itself
        // survives via the runMigrations().catch() in server/index.js.
        throw new Error(`${migrationLabel}: ${sourcePath} is unreadable — repair or remove it, then reboot to retry the split`);
      }
      console.warn(`⚠️ ${migrationLabel}: ${sourcePath} unreadable — skipping. Resolve manually before next boot.`);
      return { ok: false, reason: 'unreadable' };
    }

    // Normalize both container shapes into `[id, record]` pairs so the split
    // loop below is shape-agnostic. Array: id from `record.id` (034/035/036/059).
    // Map: id from the object KEY, value written verbatim (migration 200 — brain
    // `{ records: { <id>: record } }`, tombstones and all). Both feed the same
    // downstream object/id/idPattern validation, so a null/non-string id or a
    // non-object record is rejected there, not here.
    let pairs;
    if (recordsShape === 'map') {
      const container = doc[recordsKey];
      // Distinguish "records key absent" (a legitimately empty store → 0 records)
      // from "records present but NOT an object map" (corruption). Silently
      // emptying the latter would stamp v1, rename the legacy file to backup, and
      // mark the migration applied while the real data sits stranded and unread in
      // the backup — so honor `onUnreadable` for a malformed container exactly as
      // for unparseable JSON.
      if (container != null && !(typeof container === 'object' && !Array.isArray(container))) {
        if (onUnreadable === 'throw') {
          throw new Error(`${migrationLabel}: ${sourcePath} has a malformed "${recordsKey}" container (expected an object map) — repair or remove it, then reboot to retry the split`);
        }
        console.warn(`⚠️ ${migrationLabel}: ${sourcePath} has a malformed "${recordsKey}" container — skipping. Resolve manually before next boot.`);
        return { ok: false, reason: 'unreadable' };
      }
      pairs = Object.entries(container ?? {}).filter(([key]) => !RESERVED_MAP_KEYS.has(key));
    } else {
      const records = Array.isArray(doc[recordsKey]) ? doc[recordsKey] : [];
      pairs = records.map((record) => [record?.id, record]);
    }
    const existingIds = await splitExistingRecordIds(typeDir);
    await mkdir(typeDir, { recursive: true });

    let written = 0;
    let skipped = 0;
    let invalid = 0;
    for (const [rawId, record] of pairs) {
      if (!record || typeof record !== 'object') {
        invalid += 1;
        console.warn(`⚠️ ${migrationLabel}: skipping non-object ${recordNoun} record (left in backup for manual recovery)`);
        continue;
      }
      const id = typeof rawId === 'string' ? rawId : null;
      if (!id || !idPattern.test(id)) {
        invalid += 1;
        console.warn(`⚠️ ${migrationLabel}: skipping ${recordNoun} with invalid id "${id}" (left in backup for manual recovery)`);
        continue;
      }
      if (extraValid && !extraValid(record)) {
        invalid += 1;
        console.warn(`⚠️ ${migrationLabel}: skipping ${recordNoun} id "${id}" — failed validity check (left in backup for manual recovery)`);
        continue;
      }
      if (existingIds.has(id)) {
        // Already split — in a prior partial run (trust the on-disk per-record
        // file, which may hold fresher post-crash state) OR, when `dedupe` is
        // on, earlier in THIS loop (a duplicate id within the legacy array →
        // first-wins, matching the old monolithic reader's dedup).
        skipped += 1;
        continue;
      }
      const recordDir = join(typeDir, id);
      await mkdir(recordDir, { recursive: true });
      await splitWriteJson(join(recordDir, 'index.json'), record);
      if (dedupe) existingIds.add(id); // first-wins: later duplicates skip above
      written += 1;
    }

    // Stamp the type index AFTER all records land so a crash mid-split leaves
    // it missing — the next boot's gate 1 won't trip and gate 2/recovery re-runs.
    await splitWriteJson(typeIndexPath, {
      schemaVersion: typeSchemaVersion,
      type: typeLabel,
      updatedAt: new Date().toISOString(),
      config: buildConfig(doc),
    });

    // Backup the legacy file (skip when the recovery path was driven from the
    // backup). Renaming preserves data; manual restore is
    // `mv <legacy>${backupSuffix} <legacy>`.
    if (legacyExists) await rename(legacyPath, backupPath);

    console.log(
      `📦 ${migrationLabel}: split ${written} ${recordNoun}(s) into data/${typeDirName}/<id>/index.json ` +
      `(${skipped} already split, ${invalid} invalid); stamped index.json @ v${typeSchemaVersion}; ` +
      `legacy file backed up as ${legacyFilename}${backupSuffix}`,
    );

    return { ok: true, reason: 'split', written, skipped, invalid };
  };

  return { up };
}

/**
 * Newline-normalized MD5. Both `\r\n` and bare `\r` collapse to `\n` before
 * hashing so Windows checkouts of the same template hash identically.
 */
export const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

/**
 * Core scan — exposed so tests can pass synthetic `accepted` / `current`
 * tables to exercise the OLD→NEW branch without pinning to a real shipped
 * hash.
 *
 * Per-migration opt-ins (both default `false`):
 *
 * - `createIfMissing` — when the data-side file is absent, copy the sample
 *   file in. Used by migration 005, whose `pipeline-arc-resolve.md` may not
 *   have shipped in `data.reference/` yet at the time it was authored.
 *
 * - `retireOnSampleMissing` — when the sample-side file is absent (the prompt
 *   was renamed or retired by a later commit), treat it as a soft delete:
 *   unlink the data-side file when it still matches an accepted-old hash,
 *   and warn (counting as `skipped`) when it's been customized. Without this
 *   flag, a missing sample raises an ENOENT at read time. Used by migration
 *   003 to handle the `pipeline-tv-script.md` → `pipeline-teleplay.md`
 *   rename.
 */
export async function applyPromptReplaceMigration({
  rootDir,
  accepted,
  current,
  label,
  customizedHint,
  createIfMissing = false,
  retireOnSampleMissing = false,
}) {
  const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
  const sampleDir = join(rootDir, 'data.reference', 'prompts', 'stages');
  const filenames = Object.keys(accepted);

  // Two phases so parallelism never changes the migration's failure semantics:
  //
  //   1. PLAN (parallel) — every file's reads + hash compares run concurrently
  //      (that's the dominant cost, and they share no state). Each yields a
  //      side-effect-free descriptor: which write/unlink to perform, which
  //      counter to bump, and any deferred log line. A read rejection here
  //      rejects the whole migration BEFORE any file has been mutated — so a
  //      fail-stop on a missing/unreadable file leaves data/ untouched (a
  //      stricter guarantee than the old serial loop, which could leave an
  //      already-processed prefix mutated).
  //   2. APPLY (ordered) — perform the planned writes/unlinks in Object.keys
  //      order so log output and the on-disk result are deterministic, exactly
  //      as the serial loop produced them.
  const plans = await Promise.all(filenames.map(async (filename) => {
    const dataPath = join(stagesDir, filename);
    const samplePath = join(sampleDir, filename);

    const existing = await readFile(dataPath, 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });

    if (existing === null) {
      if (createIfMissing) {
        const sampleContent = await readFile(samplePath, 'utf-8').catch(() => null);
        if (sampleContent != null) {
          return { write: { path: dataPath, content: sampleContent }, counter: 'created', log: `📄 created ${label}: ${filename}` };
        }
      }
      return { log: `📄 ${label} ${filename}: not present in data/, will be created by setup-data.js` };
    }

    const existingMd5 = md5(existing);
    const acceptedOld = accepted[filename];
    const matchesAcceptedOld = acceptedOld.includes(existingMd5);
    const matchesCurrent = existingMd5 === current[filename];

    if (retireOnSampleMissing) {
      // Peek at the sample before any other branch: a missing sample means
      // the prompt was renamed or retired upstream, so the on-disk file is
      // obsolete regardless of which shipped version it matches. Unmodified
      // copies (either accepted-old or current hash) are unlinked; customized
      // copies warn and skip.
      const sampleExists = await readFile(samplePath, 'utf-8').then(() => true, (err) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      });
      if (!sampleExists) {
        if (matchesAcceptedOld || matchesCurrent) {
          return { unlink: dataPath, counter: 'retired', log: `🗑️  ${label} ${filename} was renamed/retired upstream — removed unmodified copy from data/` };
        }
        return {
          counter: 'skipped',
          warn: `⚠️  ${label} ${filename} was renamed/retired upstream but your local copy has been customized.\n` +
            `   Check data.reference/prompts/stages/ for the replacement file and merge any custom edits manually.`,
        };
      }
    }

    if (matchesCurrent) {
      return { counter: 'alreadyCurrent' };
    }

    if (!matchesAcceptedOld) {
      return {
        counter: 'skipped',
        warn: `⚠️  ${label} ${filename} has been customized — skipping auto-update.\n` + customizedHint(filename),
      };
    }

    // Sample read stays in the plan phase: a missing sample for an accepted-old
    // file is the migration-author error the old loop surfaced by throwing, so
    // it must still abort before any write lands.
    const sampleContent = await readFile(samplePath, 'utf-8');
    return { write: { path: dataPath, content: sampleContent }, counter: 'updated', log: `✅ updated ${label}: ${filename}` };
  }));

  const counts = { updated: 0, alreadyCurrent: 0, skipped: 0, created: 0, retired: 0 };
  for (const plan of plans) {
    if (plan.unlink) await unlink(plan.unlink);
    if (plan.write) await writeFile(plan.write.path, plan.write.content);
    if (plan.warn) console.warn(plan.warn);
    if (plan.log) console.log(plan.log);
    if (plan.counter) counts[plan.counter]++;
  }

  return counts;
}

/**
 * Factory: returns `{ applyMigration, up }`. `skipFooter(count)` is optional
 * — when provided, the wrapped `up()` logs it after the per-file pass if any
 * file was skipped (user-facing guidance about what the customized files miss).
 */
export function makePromptReplaceMigration({
  accepted,
  current,
  label,
  customizedHint,
  skipFooter,
  createIfMissing = false,
  retireOnSampleMissing = false,
}) {
  const applyMigration = (opts = {}) =>
    applyPromptReplaceMigration({
      accepted,
      current,
      label,
      customizedHint,
      createIfMissing,
      retireOnSampleMissing,
      ...opts,
    });

  const up = async ({ rootDir }) => {
    const { updated, alreadyCurrent, skipped, created, retired } = await applyMigration({ rootDir });

    if (updated > 0 || created > 0 || retired > 0) {
      console.log(`📝 ${label} migration: ${updated} updated, ${created} created, ${retired} retired, ${alreadyCurrent} already current, ${skipped} skipped (customized)`);
    } else if (skipped > 0) {
      console.log(`📝 ${label} migration: all files either current or customized (${skipped} skipped)`);
    } else {
      console.log(`📝 ${label} migration: all files already up to date`);
    }

    if (skipped > 0 && skipFooter) {
      console.warn('\n' + skipFooter(skipped));
    }
  };

  return { applyMigration, up };
}

/**
 * Read + parse + guard `data/dashboard-layouts.json` for a layout-seeding
 * migration. Collapses the preamble every such migration repeats: resolve the
 * path, read the file (absent → fresh install, nothing to do), JSON-parse it
 * (unreadable → skip), and verify `doc.layouts` is an array.
 *
 * Returns a discriminated result:
 * - `{ ok: false, reason: 'no-state' | 'unreadable' | 'no-layouts-array', path }`
 *   — the caller short-circuits with `return { updated: 0, reason: result.reason }`.
 * - `{ ok: true, doc, path }` — mutate `doc.layouts` in place, then persist
 *   with `writeLayoutsDoc(path, doc)`.
 *
 * `label` is the migration's human tag (e.g. `'migration 029'`); it keeps the
 * no-state / unreadable log lines per-migration identifiable.
 */
export async function readLayoutsDoc({ rootDir, label }) {
  const path = join(rootDir, 'data', 'dashboard-layouts.json');
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) {
    console.log(`📦 ${label}: no dashboard-layouts.json yet — fresh install will seed from defaults.`);
    return { ok: false, reason: 'no-state', path };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    console.log(`📦 ${label}: dashboard-layouts.json unreadable — skipping.`);
    return { ok: false, reason: 'unreadable', path };
  }
  if (!doc || !Array.isArray(doc.layouts)) {
    return { ok: false, reason: 'no-layouts-array', path };
  }
  return { ok: true, doc, path };
}

/** Persist a layouts doc with the canonical 2-space indentation. */
export async function writeLayoutsDoc(path, doc) {
  await writeFile(path, JSON.stringify(doc, null, 2));
}

/**
 * Build the per-subdir prompt-drift tables that `scripts/setup-data.js` uses
 * for its "pending migration" warning by sweeping every numbered migration's
 * exported drift constants — instead of hand-mirroring them in setup-data.js
 * (the spot most likely to drift out of sync with the migrations).
 *
 * Each prompt-touching migration exports:
 *   - `ACCEPTED_OLD_MD5` — `{ 'file.md': hash | [hash, …] }` (the shipped
 *     hashes a still-unmodified installed copy may carry before this migration)
 *   - `NEW_SHIPPED_MD5`  — `{ 'file.md': hash }` (the hash this migration ships)
 *   - `DRIFT_SUBDIRS`    — (optional) `{ 'file.md': '_partials' }` for prompt
 *     fragments under `data/prompts/_partials/` rather than the default
 *     `data/prompts/stages/`.
 *
 * Merge rules across a file's migration lineage. Migrations sort numerically by
 * filename, so the highest-numbered one that ships a file defines its current
 * shape:
 *   - current/new hash  = the LAST `NEW_SHIPPED_MD5` entry for the file.
 *   - accepted-old set  = union of every `ACCEPTED_OLD_MD5` entry PLUS every
 *     intermediate `NEW_SHIPPED_MD5` (each earlier shipped hash is itself
 *     auto-updatable to the latest), minus the current hash.
 *
 * Only migration files whose source text mentions the export names are
 * imported — this skips the heavier split/seed migrations (which pull in
 * server-side modules) and keeps the sweep a cheap, side-effect-free read.
 * `_`-prefixed files (this module) are excluded by the numeric-prefix filter.
 * Specialist prompt lineages that manage their own drift inline without
 * exporting these constants (e.g. the importer-stage migrations 015/016/020)
 * are intentionally not swept — they were never in setup-data.js's tables.
 *
 * Returns `{ [subdir]: { oldMap, newMap, files } }` keyed by `'stages'` /
 * `'_partials'`, matching the shape `collectDrift` in setup-data.js consumes.
 */
export async function buildPromptDriftTables(migrationsDir) {
  // Sort by the leading migration number, not lexicographically — so the
  // `current` (latest) hash selection holds even if a future migration name
  // isn't zero-padded (e.g. `7-foo.js` must order before `60-foo.js`).
  const candidates = (await readdir(migrationsDir))
    .filter((f) => /^\d.*\.js$/.test(f) && !f.endsWith('.test.js'))
    .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b));

  // key = `${subdir}/${filename}` so stages + _partials never collide.
  const merged = new Map();
  for (const file of candidates) {
    const filePath = join(migrationsDir, file);
    const source = await readFile(filePath, 'utf-8');
    if (!source.includes('ACCEPTED_OLD_MD5') && !source.includes('NEW_SHIPPED_MD5')) continue;
    const mod = await import(pathToFileURL(filePath).href);
    const oldMap = mod.ACCEPTED_OLD_MD5 || {};
    const newMap = mod.NEW_SHIPPED_MD5 || {};
    const subdirs = mod.DRIFT_SUBDIRS || {};
    const names = new Set([...Object.keys(oldMap), ...Object.keys(newMap)]);
    for (const name of names) {
      const subdir = subdirs[name] || 'stages';
      const key = `${subdir}/${name}`;
      const entry = merged.get(key) || { subdir, name, old: new Set(), newSeq: [] };
      const ov = oldMap[name];
      if (ov != null) (Array.isArray(ov) ? ov : [ov]).forEach((h) => entry.old.add(h));
      if (newMap[name]) entry.newSeq.push(newMap[name]);
      merged.set(key, entry);
    }
  }

  const tables = {};
  for (const { subdir, name, old, newSeq } of merged.values()) {
    // A file with only accepted-old hashes and no shipped current has nothing
    // to update *to* — skip it rather than emit a half table.
    if (newSeq.length === 0) continue;
    const current = newSeq[newSeq.length - 1];
    const olds = new Set([...old, ...newSeq.slice(0, -1)]);
    olds.delete(current);
    const table = (tables[subdir] ||= { oldMap: {}, newMap: {}, files: [] });
    table.oldMap[name] = [...olds];
    table.newMap[name] = current;
    table.files.push(name);
  }
  return tables;
}
