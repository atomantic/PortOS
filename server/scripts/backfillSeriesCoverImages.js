/**
 * One-time backfill: stamp `series.coverImage` on existing series.
 *
 * `series.coverImage` (the rendered volume/issue cover filename shown as the
 * pipeline list thumbnail) is populated going forward by the cover filename
 * hooks (comicPagesFilenameHook / seasonCoverFilenameHook) as covers render.
 * Series whose covers rendered BEFORE this feature shipped have no pointer yet,
 * so this walk derives it once for every existing series.
 *
 * Derives each series' cover with `deriveSeriesCoverImage` — a rendered volume
 * cover (free; seasons live on the series record) wins, else the earliest issue
 * cover. Volume covers come straight off the records `listSeries` already
 * returned (no per-series re-fetch); the issue fallback loads EVERY issue once
 * via `listAllIssues` and groups by series, instead of a per-series store scan.
 * `setSeriesCoverImage` no-ops when a series already carries the right cover, so
 * a re-run (or a boot after the hooks already decorated a series) writes nothing.
 *
 * Idempotent + marker-gated in `data/series-cover-backfill.applied.json` so the
 * scan doesn't repeat on every boot once done. `force` re-runs the walk (tests /
 * admin re-trigger). Fire-and-forget at boot (see server/index.js) — a cosmetic
 * thumbnail backfill must never delay the server accepting requests.
 *
 * Backend-agnostic: it drives the series/issues SERVICES, so it works under both
 * the PostgreSQL backend (normal installs) and the file escape hatch (tests).
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { listSeries, setSeriesCoverImage } from '../services/pipeline/series.js';
import { listAllIssues } from '../services/pipeline/issues.js';
import { deriveSeriesCoverImage, pickVolumeCoverFilename } from '../services/pipeline/seriesCoverImage.js';

const MARKER_VERSION = 1;
const MARKER_FILENAME = 'series-cover-backfill.applied.json';

async function readMarker() {
  const path = join(PATHS.data, MARKER_FILENAME);
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeMarker(payload) {
  const path = join(PATHS.data, MARKER_FILENAME);
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

/**
 * Public entry point. Runs once, then no-ops on every subsequent boot via the
 * marker file. `force` re-runs the walk regardless of the marker.
 */
export async function backfillSeriesCoverImages({ force = false } = {}) {
  const marker = await readMarker();
  if (marker?.version === MARKER_VERSION && !force) {
    return { skipped: true, marker };
  }

  const series = await listSeries().catch((err) => {
    console.error(`❌ series cover backfill: listSeries failed: ${err?.message || err}`);
    return [];
  });

  // Only fall back to an issue scan when at least one series lacks a volume
  // cover — and load every issue just ONCE, grouped by series, rather than a
  // per-series store scan. Drop run history (not needed to read a cover slot).
  const issuesBySeries = new Map();
  if (series.some((s) => !pickVolumeCoverFilename(s?.seasons))) {
    const all = await listAllIssues({ withHistory: false }).catch((err) => {
      console.error(`❌ series cover backfill: listAllIssues failed: ${err?.message || err}`);
      return [];
    });
    for (const issue of all) {
      if (!issue?.seriesId) continue;
      const list = issuesBySeries.get(issue.seriesId);
      if (list) list.push(issue);
      else issuesBySeries.set(issue.seriesId, [issue]);
    }
  }

  let scanned = 0;
  let decorated = 0;
  for (const s of series) {
    if (!s?.id) continue;
    scanned += 1;
    const next = deriveSeriesCoverImage({ seasons: s.seasons, issues: issuesBySeries.get(s.id) });
    if (next) decorated += 1;
    if ((s.coverImage || null) === (next || null)) continue; // already correct
    await setSeriesCoverImage(s.id, next).catch((err) => {
      console.error(`❌ series cover backfill: setSeriesCoverImage failed for ${String(s.id).slice(0, 8)}: ${err?.message || err}`);
    });
  }

  await writeMarker({ version: MARKER_VERSION, appliedAt: new Date().toISOString(), scanned });
  console.log(`🖼️  series cover backfill: scanned ${scanned} series, ${decorated} have a cover`);
  return { skipped: false, scanned, decorated };
}
