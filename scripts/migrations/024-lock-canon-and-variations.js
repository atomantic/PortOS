/**
 * Universe Builder — lock canon + variations by default, back-fill historical
 * render thumbnails on variations.
 *
 * Why:
 *   PR shipped lock-on-create defaults for canon entries (characters / places /
 *   objects) and category variations + composite sheets. New writes inherit
 *   the lock through the sanitizer; pre-existing records on disk have no
 *   `locked` field. The on-read sanitizer (`sanitizeTemplate` →
 *   `defaultLockCanon` + `sanitizeVariation`) treats absent as locked, so the
 *   UI displays them locked starting on the next read. This script
 *   materializes that state to disk so callers that bypass the sanitizer
 *   (sharing/export, raw JSON diff tools, future migrations) see the locked
 *   shape too. It also gives each variation a stable `id` — historically only
 *   minted on read — so going-forward `entryRef` render jobs can attach
 *   imageRefs back to the right row.
 *
 *   The second pass back-fills `imageRefs` on variations from surviving
 *   `media-jobs.json` entries: completed image jobs tagged
 *   `params.universeRun.{category, label}` are matched to the corresponding
 *   variation and their `result.filename` is appended to `imageRefs[]`. Best-
 *   effort — most historical jobs have already been purged from the queue
 *   file, so this only resurrects a handful of thumbnails. New renders
 *   continue to attach via the `appendEntryImageRef` collection hook.
 *
 * What this does to each universe in data/universe-builder.json:
 *   - Stamp `locked: true` on every `characters[]` / `places[]` / `objects[]`
 *     entry that has no `locked` field. Explicit `locked: false` is preserved
 *     so a user who already unlocked an entry stays unlocked.
 *   - Stamp `locked: true` on every variation in every
 *     `categories[bucket].variations[]` that has no `locked` field. Mint a
 *     UUID `id` for any variation that lacks one (key for future entryRef
 *     stamping). Same for `compositeSheets[]`.
 *   - For each completed media job in data/media-jobs.json whose
 *     `params.universeRun.{universeId, category, label}` matches a variation
 *     in this universe, append `result.filename` to that variation's
 *     `imageRefs[]` (deduped, oldest-first preserved, capped at 12 — mirrors
 *     the runtime cap in `appendEntryImageRef`).
 *
 * Idempotent: re-runs skip entries that already have an explicit `locked`
 * field AND already include the candidate filename in `imageRefs[]`.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Mirrors sanitizeImageRefs cap in server/services/universeBuilder.js
const IMAGE_REFS_PER_ENTRY_MAX = 12;

const readJson = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  return JSON.parse(raw);
};

const writeJson = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + '\n');

// Same normalization the runtime `normalizeCategoryKey` produces. Inlined so
// this migration's contract is frozen against future renames.
const normalizeCategoryKey = (raw) => {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .slice(0, 64);
};

const labelKey = (label) =>
  typeof label === 'string' ? label.trim().toLowerCase() : '';

const ensureLocked = (entry) => {
  if (!entry || typeof entry !== 'object') return entry;
  if (entry.locked === true || entry.locked === false) return entry;
  return { ...entry, locked: true };
};

const ensureIdOnVariation = (entry, prefix) => {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.id === 'string' && entry.id.trim()) return entry;
  return { ...entry, id: `${prefix}${randomUUID()}` };
};

// Merge candidate filenames (in deterministic job-file order) with the
// variation's existing imageRefs, dedupe, and apply the cap exactly once.
// Candidates lead the combined list so that on a rerun the dedup order is
// driven by the (deterministic) jobs file, not by where previous runs
// happened to leave imageRefs after capping — that arrangement is the
// idempotency contract: same jobs + same existing imageRefs ⇒ same output.
//
// A per-job append+cap loop would NOT be idempotent when a variation has
// more than IMAGE_REFS_PER_ENTRY_MAX matching historical jobs: the first
// run prunes older filenames out of imageRefs[], the second run sees them
// as missing, re-appends and re-rotates, and reports changes every run.
const mergeAndCap = (existing, candidates) => {
  const seen = new Set();
  const out = [];
  for (const f of candidates) {
    if (typeof f !== 'string' || !f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  for (const f of existing) {
    if (typeof f !== 'string' || !f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out.length > IMAGE_REFS_PER_ENTRY_MAX
    ? out.slice(-IMAGE_REFS_PER_ENTRY_MAX)
    : out;
};

const sameRefs = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export default {
  async up({ rootDir }) {
    const universesPath = join(rootDir, 'data', 'universe-builder.json');
    const jobsPath = join(rootDir, 'data', 'media-jobs.json');

    const universesDoc = await readJson(universesPath);
    if (!universesDoc || !Array.isArray(universesDoc.universes)) {
      return { reason: 'no-universes' };
    }

    let lockedCanon = 0;
    let lockedVariations = 0;
    let lockedSheets = 0;
    let mintedVariationIds = 0;
    let mintedSheetIds = 0;

    for (const universe of universesDoc.universes) {
      for (const kindKey of ['characters', 'places', 'objects']) {
        const list = Array.isArray(universe[kindKey]) ? universe[kindKey] : [];
        const before = list.filter((e) => e?.locked === true).length;
        universe[kindKey] = list.map(ensureLocked);
        const after = universe[kindKey].filter((e) => e?.locked === true).length;
        lockedCanon += Math.max(0, after - before);
      }

      const categories = universe.categories && typeof universe.categories === 'object'
        ? universe.categories
        : null;
      if (categories) {
        for (const [bucketKey, bucket] of Object.entries(categories)) {
          if (!bucket || !Array.isArray(bucket.variations)) continue;
          bucket.variations = bucket.variations.map((v) => {
            if (!v || typeof v !== 'object') return v;
            let next = v;
            if (typeof next.id !== 'string' || !next.id.trim()) {
              next = ensureIdOnVariation(next, 'var-');
              mintedVariationIds += 1;
            }
            if (next.locked !== true && next.locked !== false) {
              next = { ...next, locked: true };
              lockedVariations += 1;
            }
            return next;
          });
          categories[bucketKey] = bucket;
        }
      }

      if (Array.isArray(universe.compositeSheets)) {
        universe.compositeSheets = universe.compositeSheets.map((s) => {
          if (!s || typeof s !== 'object') return s;
          let next = s;
          if (typeof next.id !== 'string' || !next.id.trim()) {
            next = ensureIdOnVariation(next, 'sheet-');
            mintedSheetIds += 1;
          }
          if (next.locked !== true && next.locked !== false) {
            next = { ...next, locked: true };
            lockedSheets += 1;
          }
          return next;
        });
      }
    }

    // Best-effort imageRefs back-fill from surviving media jobs. Index variations
    // by `${universeId}|${normalizedCategoryKey}|${lowercaseLabel}` so the
    // lookup is one hash hit per matching job.
    let appendedRefs = 0;
    const jobsDoc = await readJson(jobsPath);
    const jobs = Array.isArray(jobsDoc?.jobs) ? jobsDoc.jobs : [];
    if (jobs.length > 0) {
      const variationIndex = new Map();
      for (const universe of universesDoc.universes) {
        const categories = universe.categories && typeof universe.categories === 'object'
          ? universe.categories
          : null;
        if (!categories) continue;
        for (const [bucketKey, bucket] of Object.entries(categories)) {
          if (!bucket || !Array.isArray(bucket.variations)) continue;
          const catKey = normalizeCategoryKey(bucketKey);
          bucket.variations.forEach((v, idx) => {
            if (!v || typeof v.label !== 'string') return;
            const key = `${universe.id}|${catKey}|${labelKey(v.label)}`;
            const existing = variationIndex.get(key);
            // If two variations in the same bucket share a label, prefer
            // the first — matches the dedupe behavior in sanitizeCategories.
            if (!existing) variationIndex.set(key, { universe, bucketKey, idx });
          });
        }
      }

      // Pass 1: gather candidate filenames per variation in deterministic
      // job-file order (dedup so a job that emitted the same filename twice
      // doesn't double-count).
      const candidatesByKey = new Map();
      for (const job of jobs) {
        if (!job || job.kind !== 'image' || job.status !== 'completed') continue;
        const tag = job.params?.universeRun;
        const filename = job.result?.filename;
        if (!tag || !filename || typeof filename !== 'string') continue;
        const universeId = tag.universeId;
        const category = normalizeCategoryKey(tag.category);
        const label = labelKey(tag.label);
        if (!universeId || !category || !label) continue;
        const key = `${universeId}|${category}|${label}`;
        if (!variationIndex.has(key)) continue;
        let arr = candidatesByKey.get(key);
        if (!arr) { arr = []; candidatesByKey.set(key, arr); }
        if (!arr.includes(filename)) arr.push(filename);
      }

      // Pass 2: merge each variation's full candidate set with its existing
      // imageRefs in one shot, so the cap is applied to the merged whole
      // (idempotency — see mergeAndCap comment).
      for (const [key, candidates] of candidatesByKey) {
        const hit = variationIndex.get(key);
        const bucket = hit.universe.categories[hit.bucketKey];
        const variations = Array.isArray(bucket.variations) ? bucket.variations : [];
        const current = variations[hit.idx];
        const existing = Array.isArray(current?.imageRefs) ? current.imageRefs : [];
        const merged = mergeAndCap(existing, candidates);
        if (sameRefs(merged, existing)) continue;
        const existingSet = new Set(existing);
        let addedCount = 0;
        for (const f of merged) if (!existingSet.has(f)) addedCount += 1;
        variations[hit.idx] = { ...current, imageRefs: merged };
        bucket.variations = variations;
        hit.universe.categories[hit.bucketKey] = bucket;
        appendedRefs += addedCount;
      }
    }

    await writeJson(universesPath, universesDoc);
    console.log(
      `🔒 migration 024: locked ${lockedCanon} canon entr${lockedCanon === 1 ? 'y' : 'ies'}, `
      + `${lockedVariations} variation${lockedVariations === 1 ? '' : 's'}, `
      + `${lockedSheets} composite sheet${lockedSheets === 1 ? '' : 's'}.`,
    );
    if (mintedVariationIds > 0 || mintedSheetIds > 0) {
      console.log(
        `🆔 migration 024: minted stable ids for ${mintedVariationIds} variation${mintedVariationIds === 1 ? '' : 's'} `
        + `and ${mintedSheetIds} composite sheet${mintedSheetIds === 1 ? '' : 's'} `
        + '(future renders can now attach imageRefs by id).',
      );
    }
    if (appendedRefs > 0) {
      console.log(
        `🖼️ migration 024: back-filled ${appendedRefs} historical render thumbnail${appendedRefs === 1 ? '' : 's'} `
        + 'on variations from surviving media-jobs.json entries.',
      );
    }
    return { lockedCanon, lockedVariations, lockedSheets, mintedVariationIds, mintedSheetIds, appendedRefs };
  },
};
