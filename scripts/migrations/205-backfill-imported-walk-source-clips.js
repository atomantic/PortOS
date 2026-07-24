/**
 * Migration 205 — backfill the source clip (`generated/source-video.mp4`) for
 * walk runs that were IMPORTED before the importer started copying it (#2984).
 *
 * Background:
 *   The source-pipeline importer (#2895) deliberately left every run's i2v
 *   clip behind — with the frame count fixed at 8 it was a spent intermediate.
 *   Authorable frame counts (#2970) changed that: the packer only ever
 *   resamples DOWN, so re-deriving a direction at a HIGHER frame count means
 *   re-extracting frames from the clip. An imported run with no clip is
 *   permanently stuck at whatever count it arrived with. The importer now
 *   brings the clip across; runs already on disk need this one-time backfill.
 *
 * What it does (per imported run record under data/sprites/<id>/):
 *   Determine where the clip belongs — the run record's `sourceVideoPath`
 *   re-anchored to record-relative, else `<runDir>/generated/source-video.mp4`
 *   — and, when nothing is there, look for it under the run's twin directory
 *   prefix (`runs/` ⇄ `grok/`, the same dual-root tolerance the read layer
 *   applies) INSIDE the record's own directory, copying it into place if found.
 *
 * The common outcome is "not found": the clip usually only exists in the
 * external source tree the record was imported from, which a migration cannot
 * reach (it must stay inside data/). That is not a bug, and the summary log
 * says so plainly — re-running the sprite import against that source tree, now
 * that the importer copies clips, is the actual remedy.
 *
 * NOT touched: run records and manifests (never rewritten — they are
 * hash-pinned and the read layer re-anchors their paths in memory); native
 * PortOS runs (their clip already sits beside the run); raw frame directories
 * (~5× the bytes, re-extracted on demand from the clip).
 *
 * Idempotency: a run that already has its clip is skipped, so a second pass
 * copies nothing.
 */

import { readdir, readFile, copyFile, mkdir, stat } from 'fs/promises';
import { dirname, join } from 'path';

const RUN_DIRS = ['runs', 'grok'];
const CLIP_NAME = 'source-video.mp4';
const RUN_RECORD_NAME = 'animation-run.json';

const exists = (abs) => stat(abs).then(() => true, () => false);
const readJson = async (abs) => { try { return JSON.parse(await readFile(abs, 'utf8')); } catch { return null; } };

// Mirrors server's toRecordRelativeAssetPath, kept inline so the migration
// keeps its minimal fs-only dependency surface. Returns null for a value that
// doesn't resolve inside this record.
const recordRelative = (id, p) => {
  if (typeof p !== 'string' || !p) return null;
  const marker = `art-source/sprites/${id}/`;
  const idx = p.indexOf(marker);
  const rel = idx >= 0 ? p.slice(idx + marker.length) : p.replace(/^\/+/, '');
  if (idx < 0 && /^(art-pipeline|art-source|game)\//.test(rel)) return null;
  if (!rel || rel.split(/[\\/]/).some((seg) => seg === '..' || seg === '')) return null;
  return rel;
};

// The twin of a record-relative run path under the other run-dir prefix.
const altRunLayoutRel = (rel) => {
  const match = /^(grok|runs)(\/.+)$/.exec(rel);
  return match ? `${match[1] === 'grok' ? 'runs' : 'grok'}${match[2]}` : null;
};

// An IMPORTED run record, as distinct from one PortOS generated itself: the
// importer copies source-pipeline records verbatim, and those carry no `id`
// (that field is stamped by approveWalkDirection) and repo-anchored paths.
// Only imported runs belong in the "re-import to get the clip" tally — a native
// run still rendering, or one whose render errored before writing a clip, has
// no clip for reasons a re-import would not fix.
const looksImported = (record) => !record.id
  || (typeof record.sourceVideoPath === 'string' && record.sourceVideoPath.includes('art-source/sprites/'));

/**
 * Backfill one run. Returns 'copied' when the clip was placed, 'missing' when
 * an imported run's clip is not reachable inside the record, or null when there
 * is nothing to do (the clip is already in place, the directory holds no run
 * record at all, or the run is a native one that simply has no clip yet) —
 * none of which should inflate the "needs a re-import" count.
 */
async function backfillRun(recDir, recordId, runDirRel) {
  const record = await readJson(join(recDir, runDirRel, RUN_RECORD_NAME));
  if (!record) return null;
  // Where the clip belongs: what the record declares (re-anchored), else the
  // conventional spot inside the run directory.
  const conventionalRel = `${runDirRel}/generated/${CLIP_NAME}`;
  const destRel = recordRelative(recordId, record.sourceVideoPath) || conventionalRel;
  if (await exists(join(recDir, destRel))) return null;

  // Everywhere the clip could still be sitting inside this record: the
  // conventional spot, and either path's twin under the other run layout.
  const candidates = [...new Set([conventionalRel, altRunLayoutRel(destRel), altRunLayoutRel(conventionalRel)])]
    .filter((rel) => rel && rel !== destRel);
  for (const rel of candidates) {
    // eslint-disable-next-line no-await-in-loop -- ordered probe, stops at the first hit
    if (!await exists(join(recDir, rel))) continue;
    // eslint-disable-next-line no-await-in-loop
    await mkdir(dirname(join(recDir, destRel)), { recursive: true });
    // eslint-disable-next-line no-await-in-loop
    await copyFile(join(recDir, rel), join(recDir, destRel));
    return 'copied';
  }
  return looksImported(record) ? 'missing' : null;
}

async function migrateRecord(recDir, recordId) {
  const tally = { copied: 0, missing: 0 };
  for (const base of RUN_DIRS) {
    const entries = await readdir(join(recDir, base), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // eslint-disable-next-line no-await-in-loop -- per-run sequential is fine (≤8 runs/record)
      const outcome = await backfillRun(recDir, recordId, `${base}/${entry.name}`);
      if (outcome) tally[outcome] += 1;
    }
  }
  return tally;
}

export default {
  up: async ({ rootDir }) => {
    const spritesDir = join(rootDir, 'data', 'sprites');
    let records;
    try {
      records = await readdir(spritesDir, { withFileTypes: true });
    } catch {
      return { ok: true, migrated: 0 }; // no sprites tree on this install
    }

    let copied = 0;
    let missing = 0;
    for (const rec of records) {
      if (!rec.isDirectory()) continue;
      // eslint-disable-next-line no-await-in-loop -- sequential per record, small N
      const tally = await migrateRecord(join(spritesDir, rec.name), rec.name);
      if (tally.copied > 0) console.log(`🧭 migration 205: backfilled ${tally.copied} source clip(s) for sprite ${rec.name}`);
      copied += tally.copied;
      missing += tally.missing;
    }
    if (missing > 0) {
      console.log(`🎞️ migration 205: ${missing} walk run(s) still have no source clip on disk — their clips only exist in the source tree they were imported from. Re-run the sprite import against that tree to bring them across (the importer now copies clips); until then those directions cannot be re-derived at a new frame count.`);
    }
    // `missing` rides in the result (not just the log) so the imported-vs-native
    // classification above is assertable rather than log-only.
    return { ok: true, migrated: copied, missing };
  },
};
