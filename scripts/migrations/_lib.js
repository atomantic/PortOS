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

import { readFile, writeFile, unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { createHash } from 'crypto';

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

  let updated = 0;
  let alreadyCurrent = 0;
  let skipped = 0;
  let created = 0;
  let retired = 0;

  for (const filename of Object.keys(accepted)) {
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
          await writeFile(dataPath, sampleContent);
          console.log(`📄 created ${label}: ${filename}`);
          created++;
          continue;
        }
      }
      console.log(`📄 ${label} ${filename}: not present in data/, will be created by setup-data.js`);
      continue;
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
          await unlink(dataPath);
          console.log(`🗑️  ${label} ${filename} was renamed/retired upstream — removed unmodified copy from data/`);
          retired++;
        } else {
          console.warn(
            `⚠️  ${label} ${filename} was renamed/retired upstream but your local copy has been customized.\n` +
            `   Check data.reference/prompts/stages/ for the replacement file and merge any custom edits manually.`,
          );
          skipped++;
        }
        continue;
      }
    }

    if (matchesCurrent) {
      alreadyCurrent++;
      continue;
    }

    if (!matchesAcceptedOld) {
      console.warn(
        `⚠️  ${label} ${filename} has been customized — skipping auto-update.\n` +
        customizedHint(filename),
      );
      skipped++;
      continue;
    }

    const sampleContent = await readFile(samplePath, 'utf-8');
    await writeFile(dataPath, sampleContent);
    console.log(`✅ updated ${label}: ${filename}`);
    updated++;
  }

  return { updated, alreadyCurrent, skipped, created, retired };
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
