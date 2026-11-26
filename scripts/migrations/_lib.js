/**
 * Shared scaffolding for migrations. Several families live here:
 *
 *   1. Hash-driven prompt-replace migrations — `makePromptReplaceMigration`
 *      (hash table + label + customized-skip hint). Only 003 and 005 remain;
 *      a template edit needs no migration (`shippedPromptHashes.js`).
 *   2. Dashboard-layout seeding migrations — `readLayoutsDoc` /
 *      `writeLayoutsDoc` collapse the read → JSON.parse → `Array.isArray`
 *      guard → write shell shared by every migration that mutates built-in
 *      layouts in `data/dashboard-layouts.json` (029, 030, 033, …).
 *   3. Monolithic → per-record split migrations — `makeSplitMigration`.
 *   4. Brain seed-record migrations — `makeBrainSeedMigration`.
 *   5. Provider-seed migrations — `makeProviderSeedMigration` collapses the
 *      read → guard → add-missing-ids → write shell every migration that ships
 *      a new `data/providers.json` entry repeats (149, 152, 185, 195, 201, 231).
 *   6. Media-model-registry migrations — `readMediaRegistry` /
 *      `writeMediaRegistry` collapse the strict-read → absent/unreadable skip →
 *      bucket-array guard shell shared by every migration that patches
 *      `data/media-models.json` (244, 247, …).
 *   7. Additive provider-model inserts — `makeAdditiveProviderInsertMigration`
 *      (337 is the first member) splices `current` in immediately after `retired`
 *      when `retired` is listed and `current` is not, regardless of what else the
 *      list holds. It runs against a list the user may have curated, so it never
 *      rewrites or drops anything, and tier pointers are left alone.
 *   8. CoS config reads — `readCosConfig` resolves the durable CoS settings a
 *      migration needs to honour an install-specific path, across both the
 *      pre- and post-339 layouts (`data/cos/state.json`'s `config` slice and
 *      `data/cos/config.json`).
 *   9. Plain document reads — `readJsonOrNull` is the "absent or unparseable
 *      → null, anything else throws" reader that thirty-odd applied migrations
 *      each declared as a local `readJson`. Those stay frozen;
 *      `server/test/guards/repo/migrations.test.js` stops a new migration from
 *      declaring its own copy of any helper exported here.
 *
 * Families 5, 7, and 7b all target `data/providers.json` and share its
 * read → parse → shape-guard preamble via `readProvidersDoc`; each still owns
 * its own log copy and result shape.
 *
 * The runner (`scripts/run-migrations.js`) explicitly skips `_`-prefixed
 * files so this module is never imported as a migration.
 */

import { readFile, writeFile, unlink, readdir, rename, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { atomicWrite, readJSONFileStrict } from '../../server/lib/fileUtils.js';
import { VIDEO_BUCKET_MLX, resolveVideoBucketKey } from '../../server/lib/mediaModelBuckets.js';

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
// Also used by the provider-seed family, where a truncated `data/providers.json`
// would cost the user every stored apiKey and provider customization, and by
// the prompt-replace family: a half-written stage prompt hashes as neither the
// accepted-old nor the shipped body, so the next pass would classify it as
// user-customized and leave the truncated prompt in place forever.
export const writeTextAtomic = async (path, content) => {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, content);
  await rename(tmp, path);
};

export const writeJsonAtomic = (path, value) =>
  writeTextAtomic(path, JSON.stringify(value, null, 2) + '\n');

/**
 * Read a JSON document, or null when it is absent (ENOENT) or not valid JSON.
 * Any other read error (EACCES, EISDIR, …) propagates: a store that exists
 * but cannot be read is not "nothing to migrate", and treating it so would
 * let a later write replace it. A migration that must tell "absent" from
 * "unreadable" apart (to skip one and warn on the other) reads through
 * `readJSONFileStrict` from `server/lib/fileUtils.js` instead.
 */
export const readJsonOrNull = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

// Reserved keys a legacy `map`-shape doc can carry as own properties (JSON.parse
// surfaces a literal `"__proto__"` key as an own property). They pass a typical
// `idPattern`, so a map split must drop them explicitly rather than write a
// `__proto__/index.json` record dir — left in the backup for manual recovery.
// Shared with the provider-seed family below, which faces the mirror-image
// hazard: these keys are INHERITED on every plain object, so a `map[id]`
// presence probe reads truthy for them even on an empty map.
const RESERVED_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Scan the type dir for records already split in a prior partial run. Uses
// `withFileTypes` so stray non-directory entries (user `.bak` files, editor
// swap files) are skipped without statting INTO them — `stat('foo.bak/index.json')`
// would raise ENOTDIR and crash the migration.
async function splitExistingRecordIds(typeDir) {
  const ids = new Set();
  if (!await splitFileExists(typeDir)) return ids;
  // No catch-to-empty: a failed listing is not proof that no records exist, and
  // an empty set would let the legacy values overwrite fresher split records.
  const entries = await readdir(typeDir, { withFileTypes: true });
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
      await writeJsonAtomic(typeIndexPath, {
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
      await writeJsonAtomic(join(recordDir, 'index.json'), record);
      if (dedupe) existingIds.add(id); // first-wins: later duplicates skip above
      written += 1;
    }

    // Stamp the type index AFTER all records land so a crash mid-split leaves
    // it missing — the next boot's gate 1 won't trip and gate 2/recovery re-runs.
    await writeJsonAtomic(typeIndexPath, {
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
 *
 * Both sides resolve under `prompts/stages/`: 003 and 005 are the only
 * callers left. Every migration that used this for the swap alone was deleted
 * in #16827, because `reconcileShippedPrompts` makes that swap after each full
 * pass; a new one is refused by `server/test/guards/repo/shippedPromptHashes.test.js`.
 *
 * "Current" is the live reference body, not the migration's declared
 * `current` hash (#16090): a later template edit would otherwise make this
 * frozen migration call today's shipped body customized. The declared hash and
 * every retired hash in `data.reference/prompts/shipped-hashes.json` count as
 * untouched shipped bodies, so no shipped migration ever needs re-pointing.
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
  const dataPathFor = (filename) => join(rootDir, 'data', 'prompts', 'stages', filename);
  const samplePathFor = (filename) => join(rootDir, 'data.reference', 'prompts', 'stages', filename);
  const filenames = Object.keys(accepted);
  // Lazy: shippedPromptHashes.js imports this module.
  const { readShippedHashes } = await import('./shippedPromptHashes.js');
  const shippedHashes = await readShippedHashes(rootDir);

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
    const dataPath = dataPathFor(filename);
    const samplePath = samplePathFor(filename);

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
    const sampleContent = await readFile(samplePath, 'utf-8').catch((err) => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    });
    const shipped = new Set([
      ...accepted[filename],
      current[filename],
      ...(shippedHashes[`stages/${filename}`]?.retired || []),
    ]);
    const matchesCurrent = sampleContent === null
      ? existingMd5 === current[filename]
      : existingMd5 === md5(sampleContent);
    const matchesAcceptedOld = !matchesCurrent && shipped.has(existingMd5);

    if (retireOnSampleMissing) {
      // A missing sample means the prompt was renamed or retired upstream, so
      // the on-disk file is obsolete regardless of which shipped version it
      // matches. Unmodified copies (either accepted-old or current hash) are
      // unlinked; customized copies warn and skip.
      if (sampleContent === null) {
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

    // A missing sample for an accepted-old file is the migration-author error
    // the old loop surfaced by throwing; it still aborts in the plan phase,
    // before any write lands.
    if (sampleContent === null) await readFile(samplePath, 'utf-8');
    return { write: { path: dataPath, content: sampleContent }, counter: 'updated', log: `✅ updated ${label}: ${filename}` };
  }));

  const counts = { updated: 0, alreadyCurrent: 0, skipped: 0, created: 0, retired: 0 };
  for (const plan of plans) {
    if (plan.unlink) await unlink(plan.unlink);
    if (plan.write) await writeTextAtomic(plan.write.path, plan.write.content);
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

/** Persist a layouts doc with the canonical 2-space indentation (no trailing newline, matching the store). */
export async function writeLayoutsDoc(path, doc) {
  await writeTextAtomic(path, JSON.stringify(doc, null, 2));
}

// ---- dashboard-grid helpers ----
//
// Two grid shapes exist in `data/dashboard-layouts.json` history. Before
// migration 269 every grid entry was a rectangle (`{ id, x, y, w, h }`) and a
// seed had to find a free slot; 269 converted grids to a packing sequence
// (`{ id, x, w, h, order }`) where a seed appends at `max(order) + 1`. The
// rectangle helpers are kept for a migration that has to read or repair a
// legacy rectangle grid; a new widget seed uses `applyToLayout` (or the
// `makeWidgetSeedMigration` factory around it).

/** Axis-aligned overlap of two `{ x, y, w, h }` rectangles. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether `candidate` overlaps any entry of a rectangle grid. */
export function collidesWith(grid, candidate) {
  return grid.some((item) => rectsOverlap(item, candidate));
}

/**
 * Place `widgetId` at the preferred rectangle `slot` when it is free, else on
 * a clean row below everything in the grid (a user rearranged the layout but
 * kept the built-in id).
 */
export function pickGridEntry(grid, widgetId, slot) {
  const candidate = { id: widgetId, ...slot };
  if (!collidesWith(grid, candidate)) return candidate;
  const bottom = grid.reduce((max, it) => Math.max(max, (it.y ?? 0) + (it.h ?? 0)), 0);
  return { id: widgetId, x: 0, y: bottom, w: slot.w, h: slot.h };
}

/**
 * Seed `widgetId` into one layout of the post-269 (`order`-packed) shape:
 * append it to `widgets` when absent and to the end of the packing sequence
 * when it has no grid entry. Returns whether the layout changed. `targets`
 * (a Set of layout ids) limits the seed to built-in layouts; custom/user
 * layouts are the layout editor's to manage. Idempotent — a rerun heals
 * whichever of the two arrays is missing the widget.
 */
export function applyToLayout(layout, { widgetId, cell, targets }) {
  if (!layout || !targets.has(layout.id) || !Array.isArray(layout.widgets)) return false;
  const hasWidget = layout.widgets.includes(widgetId);
  const hasGridEntry = Array.isArray(layout.grid) && layout.grid.some((item) => item?.id === widgetId);
  if (hasWidget && hasGridEntry) return false;

  if (!hasWidget) layout.widgets = [...layout.widgets, widgetId];
  if (!hasGridEntry) {
    const grid = Array.isArray(layout.grid) ? layout.grid : [];
    const maxOrder = grid.reduce((max, item) => Math.max(max, Number.isFinite(item?.order) ? item.order : -1), -1);
    layout.grid = [...grid, { id: widgetId, x: 0, w: cell.w, order: maxOrder + 1, h: cell.h }];
  }
  return true;
}

/**
 * Factory for the "seed a new dashboard widget into built-in layouts"
 * migration family (327 seeded today-agenda by hand; 329 onward use this).
 *
 * Appends `widgetId` to each targeted built-in layout's `widgets` list and to
 * the end of its `grid` packing sequence (`{ id, x: 0, w, order: max+1, h }`)
 * — a gated widget that gates off leaves only harmless trailing space, so
 * appending is always safe. Custom/user layouts are intentionally untouched:
 * the layout editor is the user's source of truth for those. Idempotent —
 * re-running heals whichever of the two arrays is missing the widget and
 * reports `already-applied` when both carry it.
 *
 * @param {object} opts
 * @param {string} opts.label     Human tag, e.g. `'migration 329'`
 * @param {string} opts.widgetId  Registry id being seeded
 * @param {string[]} [opts.layoutIds] Built-in layout ids to seed (defaults to
 *   the Everything + Morning Review pair every widget seed so far targets)
 * @param {{ w: number, h: number }} opts.cell Grid cell size for the append
 * @param {string} opts.logLine   Success log line (count is appended)
 */
export function makeWidgetSeedMigration({ label, widgetId, layoutIds = ['default', 'morning-review'], cell, logLine }) {
  const targets = new Set(layoutIds);

  return {
    async up({ rootDir }) {
      const result = await readLayoutsDoc({ rootDir, label });
      if (!result.ok) return { updated: 0, reason: result.reason };
      const { doc, path } = result;
      let updated = 0;
      for (const layout of doc.layouts) {
        if (applyToLayout(layout, { widgetId, cell, targets })) updated += 1;
      }
      if (updated === 0) return { updated: 0, reason: 'already-applied' };
      await writeLayoutsDoc(path, doc);
      console.log(`${logLine} ${updated} built-in dashboard layout(s).`);
      return { updated };
    },
  };
}

// ---- media-model-registry migration family ----

const MEDIA_MODELS_REL_PATH = 'data/media-models.json';

/**
 * Read `data/media-models.json` whole, for a migration that patches something
 * other than one bucket's entry array (270 renames the bucket keys themselves).
 *
 * `readJSONFileStrict`'s `ok` flag is what separates "never written" (fresh
 * install — the seed in `data.reference/` already carries the change) from
 * "unreadable or corrupt", where rewriting the file would destroy a registry we
 * couldn't read. Both are skips, but only one of them is a warning.
 */
export async function readMediaRegistryConfig({ rootDir } = {}) {
  const path = join(rootDir, MEDIA_MODELS_REL_PATH);
  const { ok, value: config } = await readJSONFileStrict(path, null);
  if (!ok) {
    console.log(`⚠️ ${MEDIA_MODELS_REL_PATH}: unreadable or invalid JSON, skipping`);
    return { ok: false };
  }
  if (config == null) {
    console.log(`📄 ${MEDIA_MODELS_REL_PATH} not present — skipping (fresh install seeds from data.reference)`);
    return { ok: false };
  }
  return { ok: true, config, path };
}

/**
 * Read `data/media-models.json` for a registry-patching migration. Collapses
 * the preamble every such migration repeats (244, 247, …):
 * `readMediaRegistryConfig` above, plus pulling out one bucket's entry array.
 *
 * Returns `{ ok: false }` when the caller should do nothing, or
 * `{ ok: true, config, entries, bucketKey, path }` — mutate `config` in place,
 * then persist with `writeMediaRegistry(path, config)`. `bucket` selects which
 * video bucket lands in `entries`; `bucketKey` is the key it was actually found
 * under, which a caller that REPLACES the whole array must write back to.
 *
 * The bucket key is resolved canonical-first with a fallback to the pre-#4142
 * `macos` / `windows` spelling (see server/lib/mediaModelBuckets.js). Every
 * member of this family predates the rename and can therefore meet either
 * shape: an install upgrading from an older release still has the legacy keys
 * when they run, while a fresh install seeds `data/media-models.json` from the
 * canonical-keyed `data.reference/` copy before any migration runs.
 */
export async function readMediaRegistry({ rootDir, bucket = VIDEO_BUCKET_MLX } = {}) {
  const { ok, config, path } = await readMediaRegistryConfig({ rootDir });
  if (!ok) return { ok: false };
  const bucketKey = resolveVideoBucketKey(config?.video, bucket);
  const entries = bucketKey === null ? undefined : config.video[bucketKey];
  if (!Array.isArray(entries)) {
    console.log(`⚠️ ${MEDIA_MODELS_REL_PATH}: no video.${bucket}[] array — skipping`);
    return { ok: false };
  }
  return { ok: true, config, entries, bucketKey, path };
}

/** Persist a media-model registry with the canonical trailing-newline shape. */
export async function writeMediaRegistry(path, config) {
  await atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
}

// ---- CoS config readers ----

/**
 * Read the durable CoS user configuration a migration needs to resolve an
 * install-specific path (`userTasksFile` / `cosTasksFile` are the ones that
 * matter today). Returns `{}` when there is nothing usable — every caller
 * already falls back to the shipped defaults.
 *
 * Config moved out of `data/cos/state.json` into `data/cos/config.json` in
 * migration 339. Both are consulted, config file first, so this resolves
 * correctly whether the reading migration runs before or after that split (and
 * on an install restored from a pre-split backup).
 *
 * Deliberately tolerant: a truncated/corrupt file left by a prior crash must
 * not abort the reading migration and every one after it — the state loader
 * owns quarantining and repairing those files.
 */
export async function readCosConfig({ rootDir, label = 'migration' }) {
  for (const relPath of ['data/cos/config.json', 'data/cos/state.json']) {
    const raw = await readFile(join(rootDir, relPath), 'utf-8').catch(() => null);
    if (raw === null) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not necessarily the final answer — the next source in the list may
              // still carry a usable config, so this says only what was skipped.
              console.warn(`⚠️ ${label}: invalid JSON in ${relPath}; ignoring it`);
      continue;
    }
    // config.json IS the config; state.json nests it under `config`.
    const config = relPath.endsWith('config.json') ? parsed : parsed?.config;
    if (config && typeof config === 'object' && !Array.isArray(config)) return config;
  }
  return {};
}

// ---- brain seed-record migration family ----
//
// `scripts/setup-data.js` copies `data.reference/` wholesale, so a FRESH install
// picks up every seed record in `data.reference/brain/<type>.json` for free. But
// setup-data only copies MISSING files — an install whose `data/brain/<type>.json`
// already exists (even empty, from the feature's first boot) never receives a
// seed added later. Each such addition therefore ships a migration that merges
// its own ids in; 209 (the drum-format worked example) and 213 (the House of the
// Rising Sun drum arrangement) are the current members.
//
// They all want the same skeleton, so it lives here once:
//   - Since migration 200, brain stores live per-record at
//     `data/brain/<type>/<id>/index.json` (collectionStore layout) — that's the
//     primary write target.
//   - The legacy monolithic `data/brain/<type>.json` is ALSO topped up when it's
//     still present, so an install whose 200 split hasn't run yet still picks the
//     seed up when it finally does. It is never CREATED — doing so on a split
//     install would resurrect a shape nothing reads.
//   - An id already present — a user-edited copy, a peer-synced copy, or a
//     tombstone from a deliberate delete — is NEVER overwritten, so a deleted
//     seed stays deleted, and a second run is a no-op.
//   - Nothing is written when the existing record (or the legacy file) is
//     unreadable: possibly-recoverable user data beats a cosmetic starter record.
//
// Each migration owns an explicit `seedIds` list rather than "everything in the
// reference file", so a later seed addition gets its own migration instead of
// silently riding along on a re-run of an older one.

// Tagged read: 'missing' (ENOENT — nothing there, safe to create) is NOT the
// same as 'invalid' (exists but won't parse — user data a write would destroy).
// The migration runner executes before the service layer is wired, so this can't
// reach for server/lib helpers.
async function seedReadJsonTagged(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid', error: err?.message };
  }
  try {
    return { state: 'ok', doc: JSON.parse(raw) };
  } catch (err) {
    return { state: 'invalid', error: err?.message };
  }
}

/**
 * Build a brain seed-record migration's `up()`. Returns `{ up }`.
 *
 *   - `logTag`     — emoji-prefixed log tag, e.g. `'🥁 drum-seed'`
 *   - `entityType` — brain entity type, e.g. `'songs'` (names all three paths)
 *   - `seedIds`    — the record ids THIS migration owns
 *   - `seedLabel`  — human phrase for the log lines ("the drum example groove")
 *   - `storeLabel` — where it lands, for the success line ("the SongBook")
 *
 * Resolves to `{ ok: true, reason: 'no-seeds' | 'already-present' | 'seeded',
 * added, legacyAdded, skipped }`.
 */
export function makeBrainSeedMigration({ logTag, entityType, seedIds, seedLabel, storeLabel }) {
  async function up({ rootDir }) {
    const seedPath = join(rootDir, 'data.reference', 'brain', `${entityType}.json`);
    const perRecordDir = join(rootDir, 'data', 'brain', entityType);
    const legacyPath = join(rootDir, 'data', 'brain', `${entityType}.json`);

    const seedRead = await seedReadJsonTagged(seedPath);
    const seedRecords = seedRead.state === 'ok' && seedRead.doc?.records && typeof seedRead.doc.records === 'object'
      ? seedRead.doc.records
      : {};
    const present = seedIds.filter((id) => seedRecords[id] !== undefined);
    if (present.length === 0) {
      console.log(`${logTag}: no ${seedLabel} in data.reference — no-op.`);
      return { ok: true, reason: 'no-seeds' };
    }

    // --- Per-record store (the post-migration-200 layout) -------------------
    let added = 0;
    let skipped = 0;
    for (const id of present) {
      const recordPath = join(perRecordDir, id, 'index.json');
      const read = await seedReadJsonTagged(recordPath);
      if (read.state !== 'missing') {
        // Present (a user-edited copy / peer copy / tombstone) or unreadable —
        // either way, leave it alone.
        if (read.state === 'invalid') {
          console.error(`❌ ${logTag}: ${id}/index.json is unreadable (${read.error}) — leaving it untouched.`);
        }
        skipped += 1;
        continue;
      }
      await mkdir(join(perRecordDir, id), { recursive: true });
      await writeJsonAtomic(recordPath, seedRecords[id]);
      added += 1;
    }

    // --- Legacy monolithic file (only when it still exists) -----------------
    // The tagged read distinguishes all three cases in one syscall: 'missing'
    // means the install is already split, so leave it alone (creating the file
    // would resurrect a shape nothing reads); 'invalid' means user data a write
    // would destroy.
    let legacyAdded = 0;
    const legacyRead = await seedReadJsonTagged(legacyPath);
    if (legacyRead.state === 'invalid') {
      console.error(`❌ ${logTag}: data/brain/${entityType}.json exists but is unreadable (${legacyRead.error}) — leaving it untouched.`);
    } else if (legacyRead.state === 'ok') {
      const live = legacyRead.doc && typeof legacyRead.doc === 'object' ? legacyRead.doc : {};
      if (!live.records || typeof live.records !== 'object') live.records = {};
      for (const id of present) {
        if (live.records[id] !== undefined) continue;
        live.records[id] = seedRecords[id];
        legacyAdded += 1;
      }
      if (legacyAdded > 0) await writeJsonAtomic(legacyPath, live);
    }

    if (added === 0 && legacyAdded === 0) {
      console.log(`${logTag}: ${seedLabel} already present — no-op.`);
      return { ok: true, reason: 'already-present', added: 0, legacyAdded: 0, skipped };
    }

    console.log(`${logTag}: added ${seedLabel} (${added} per-record, ${legacyAdded} legacy) to ${storeLabel}.`);
    return { ok: true, reason: 'seeded', added, legacyAdded, skipped };
  }

  return { up };
}

// ---- provider-seed migration family ----
//
// `scripts/setup-data.js` merges *missing* `data/providers.json` entries from
// data.reference, but only when an install actually re-runs setup. Every
// migration that ships a new provider therefore delivers it on a plain server
// restart too, and each one repeats the identical shell: read
// `data/providers.json` → ENOENT skip (a fresh install seeds from
// data.reference) → JSON.parse guard → shape guard → add each missing id →
// write only when something changed. 149 / 152 / 185 / 195 / 201 / 231 are the
// current members; `makeProviderSeedMigration` is that shell.
//
// What each migration still owns is its `defs` — a FROZEN literal in its own
// file, never read from `data.reference/providers.json` at migration time. A
// migration is the historical record of what it installed; later default
// changes ride their own migrations (precedent: 058/153/206 bumping the Claude
// defaults). Reading the live reference would hand an upgrading install a
// different payload than the migration's own tests assert, and a different one
// than earlier users received.

const PROVIDERS_REL_PATH = 'data/providers.json';

/**
 * Read + parse + shape-guard `data/providers.json` for the two provider
 * migration families below. Returns a discriminated result:
 *
 * - `{ ok: false, reason: 'no-file' | 'unreadable' | 'bad-shape', path }` —
 *   absent (a fresh install seeds from data.reference), unparseable, or missing
 *   its `providers` map. In every case the caller leaves the file untouched: a
 *   migration must never clobber a user's stored apiKeys to "fix" a shape.
 * - `{ ok: true, config, providers, path }` — mutate `providers` in place, then
 *   persist the whole `config` with `writeJsonAtomic(path, config)`.
 *
 * Deliberately silent: each family owns its own log copy (they say different
 * things about what the skip costs the user), so the wording stays per-family
 * while the read shell is shared. `err` carries the parse failure for the
 * `'unreadable'` message.
 */
export async function readProvidersDoc({ rootDir }) {
  const path = join(rootDir, PROVIDERS_REL_PATH);
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return { ok: false, reason: 'no-file', path };

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'unreadable', path, err };
  }

  const providers = config?.providers;
  if (!providers || typeof providers !== 'object') return { ok: false, reason: 'bad-shape', path };

  return { ok: true, config, providers, path };
}

/**
 * Build a provider-seed migration's `up()`. Returns `{ up }`, so a migration is
 * `export default makeProviderSeedMigration({ label, defs })`.
 *
 *   - `label` — human name of the provider family for the log lines
 *     ("Grok", "Cerebras", "OpenCode Ollama TUI").
 *   - `defs`  — the frozen provider objects this migration installs, each with
 *     an `id`. Added only when the id is missing, so an existing entry (user
 *     edits, a stored apiKey, a refreshed model list) is never clobbered and a
 *     second run is a no-op.
 *
 * Each def is installed via `structuredClone`, which fully detaches nested
 * arrays/objects — necessary because sibling defs commonly share one constant
 * (231's two entries both reference `CURSOR_MODELS`), so a shallow spread would
 * leak a later in-memory mutation across both entries and back into the frozen
 * module-level default.
 *
 * Resolves to `{ ok, reason: 'no-file' | 'unreadable' | 'bad-shape' |
 * 'already-present' | 'seeded', added }`.
 */
export function makeProviderSeedMigration({ label, defs }) {
  const noun = defs.length === 1 ? 'provider' : 'providers';

  async function up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds ${label} from data.reference)`);
      else if (doc.reason === 'unreadable') console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${doc.err.message})`);
      else console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return { ok: false, reason: doc.reason, added: 0 };
    }

    const { config, providers, path: providersPath } = doc;
    let added = 0;

    for (const def of defs) {
      // Same guard the split family applies to legacy map keys: `__proto__` /
      // `constructor` / `prototype` are inherited on any plain object, so the
      // `providers[def.id]` presence probe below reads TRUTHY for them even on
      // an empty map — the id would be silently skipped forever — and writing
      // one would mutate the prototype rather than add a provider. A provider
      // id is never one of these; refuse loudly if a def ever carries one.
      if (RESERVED_MAP_KEYS.has(def.id)) {
        console.log(`⚠️ ${PROVIDERS_REL_PATH}: refusing reserved provider id ${def.id}`);
        continue;
      }
      if (!providers[def.id]) {
        providers[def.id] = structuredClone(def);
        added++;
        console.log(`📝 ${PROVIDERS_REL_PATH}: added ${def.id} provider`);
      }
    }

    if (added === 0) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: ${label} ${noun} already present — no change`);
      return { ok: true, reason: 'already-present', added: 0 };
    }

    await writeJsonAtomic(providersPath, config);
    return { ok: true, reason: 'seeded', added };
  }

  return { up };
}

// ---- additive provider-model insert migration family (7) ----
//
// Splices a new id into a list the user may have curated, touching nothing else.
// 337 is the first member and the shell every future "offer a model without
// disturbing what's already listed" migration should reach for instead of
// hand-copying it a fourth time.

/**
 * Build an additive provider-model insert migration's `up()`. Returns `{ up }`,
 * so a migration collapses to
 * `export default makeAdditiveProviderInsertMigration({ targets, label })`
 * over a small data table.
 *
 *   - `targets` — `[{ id, retired, current }, …]`, one entry per provider
 *     record this migration can touch. `retired` and `current` are per-target
 *     (not shared across the table) so sibling records that spell the same
 *     tier differently — e.g. a Bedrock record's region-qualified id versus the
 *     bare CLI id — each get their own exact strings; inserting one target's
 *     `current` onto another target's record would offer an id that record's
 *     environment cannot resolve.
 *   - `label` — the human name of the tier being offered, used in the log
 *     copy (`"offered ${label} on …"`, `"${label} already current"`).
 *
 * For each target: if `retired` is listed in the record's `models` and
 * `current` is not, `current` is spliced in immediately after `retired` —
 * `retired` itself, every other entry, and every tier pointer are left
 * exactly as found. A record already listing `current`, or never listing
 * `retired`, is untouched — which makes a second run, and a fresh install
 * already seeded with `current`, both no-ops.
 *
 * Resolves to `{ ok, reason: 'no-file' | 'unreadable' | 'bad-shape' |
 * 'already-current' | 'updated', updated }`.
 */
export function makeAdditiveProviderInsertMigration({ targets, label }) {
  async function up({ rootDir }) {
    const doc = await readProvidersDoc({ rootDir });
    if (!doc.ok) {
      if (doc.reason === 'no-file') console.log(`📄 ${PROVIDERS_REL_PATH} not present — skipping (fresh install seeds ${label} from data.reference)`);
      else if (doc.reason === 'unreadable') console.log(`⚠️ ${PROVIDERS_REL_PATH}: invalid JSON, skipping (${doc.err.message})`);
      else console.log(`⚠️ ${PROVIDERS_REL_PATH}: unexpected shape, skipping`);
      return { ok: false, reason: doc.reason, updated: 0 };
    }

    const { config, providers, path: providersPath } = doc;
    const touched = [];

    for (const { id, retired, current } of targets) {
      const provider = providers[id];
      if (!provider || !Array.isArray(provider.models)) continue;
      const at = provider.models.indexOf(retired);
      // Nothing to repair unless the retired id is listed AND the current one
      // isn't: an already-current record (seeded, or bumped by a prior run) is
      // a no-op, and a record that never listed the retired tier is not this
      // migration's concern.
      if (at === -1 || provider.models.includes(current)) continue;
      provider.models = [
        ...provider.models.slice(0, at + 1),
        current,
        ...provider.models.slice(at + 1),
      ];
      touched.push(id);
    }

    if (touched.length === 0) {
      console.log(`✅ ${PROVIDERS_REL_PATH}: ${label} already current — no change`);
      return { ok: true, reason: 'already-current', updated: 0 };
    }

    await writeJsonAtomic(providersPath, config);
    console.log(`📝 ${PROVIDERS_REL_PATH}: offered ${label} on ${touched.join(', ')}`);
    return { ok: true, reason: 'updated', updated: touched.length };
  }

  return { up };
}
