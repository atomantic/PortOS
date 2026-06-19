/**
 * Pipeline — derive a series' cover thumbnail.
 *
 * The pipeline series list (client/src/pages/Pipeline.jsx) shows a small cover
 * thumbnail on each series card, mirroring the reference-image thumbnail on the
 * universe list. Rather than scan every issue at read time, the chosen cover
 * filename is persisted onto `series.coverImage` (see series.setSeriesCoverImage)
 * so the list endpoint stays cheap — this module owns the *recompute*.
 *
 * Priority: the first rendered VOLUME (season) cover, else the earliest rendered
 * ISSUE cover. Volume covers win because they're the trade-paperback "graphic
 * novel" cover; per-issue covers are the fallback for series that haven't
 * assembled a volume yet. Back covers never count — the thumbnail is the front.
 *
 * `refreshSeriesCoverImage` is called from the two cover filename hooks
 * (comicPagesFilenameHook, seasonCoverFilenameHook) on render completion, and
 * from the one-time boot backfill (server/scripts/backfillSeriesCoverImages.js).
 * Season covers live on the series record itself, so a series that has any
 * rendered volume cover never pays the issue scan.
 */

import { pickRenderedFilename } from '../../lib/renderSlot.js';
import { getSeries, setSeriesCoverImage } from './series.js';
import { listIssues } from './issues.js';

/**
 * First rendered volume (season) cover, in season order. Seasons live on the
 * series record, so this needs no extra I/O.
 */
export function pickVolumeCoverFilename(seasons) {
  if (!Array.isArray(seasons)) return null;
  for (const season of seasons) {
    const filename = pickRenderedFilename(season?.cover);
    if (filename) return filename;
  }
  return null;
}

/**
 * Earliest rendered issue cover, by issue number ascending. Deleted issues are
 * skipped. Sorts a copy so callers can pass the list straight from `listIssues`.
 */
export function pickIssueCoverFilename(issues) {
  if (!Array.isArray(issues)) return null;
  const ordered = [...issues]
    .filter((i) => i && !i.deleted)
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
  for (const issue of ordered) {
    const filename = pickRenderedFilename(issue?.stages?.comicPages?.cover);
    if (filename) return filename;
  }
  return null;
}

/**
 * Pure derivation over already-loaded data: volume cover wins, else earliest
 * issue cover, else null. Used by the boot backfill, which loads every issue
 * once and groups by series. The runtime `refreshSeriesCoverImage` does NOT use
 * this — it short-circuits the issue load when a volume cover exists, so it
 * composes the pickers directly.
 */
export function deriveSeriesCoverImage({ seasons, issues } = {}) {
  return pickVolumeCoverFilename(seasons) || pickIssueCoverFilename(issues) || null;
}

/**
 * Recompute and persist a series' cover thumbnail. Cheap when a volume cover
 * exists (no issue scan); otherwise scans the series' issues for the earliest
 * rendered cover. setSeriesCoverImage no-ops when the value is unchanged, so a
 * repeat render on an already-decorated series writes nothing. Best-effort —
 * a cosmetic thumbnail must never fail the user's render.
 */
export async function refreshSeriesCoverImage(seriesId) {
  if (!seriesId) return;
  const series = await getSeries(seriesId).catch(() => null);
  if (!series) return;
  // Volume covers win and are already on the record — skip the issue scan
  // entirely when one exists (keeps the common path cheap).
  let next = pickVolumeCoverFilename(series.seasons);
  if (!next) {
    const issues = await listIssues({ seriesId }).catch(() => []);
    next = pickIssueCoverFilename(issues);
  }
  if ((series.coverImage || null) === (next || null)) return;
  await setSeriesCoverImage(seriesId, next || null).catch((err) => {
    console.error(`❌ refreshSeriesCoverImage failed for series=${String(seriesId).slice(0, 8)}: ${err?.message || err}`);
  });
}
