/**
 * Pipeline — derive a series' cover thumbnail.
 *
 * The pipeline series list shows a cover thumbnail per series card. The chosen
 * filename is persisted onto `series.coverImage` (see series.setSeriesCoverImage) so
 * the list stays cheap; this module owns the *recompute*.
 *
 * Priority: first rendered VOLUME (season) cover (the trade-paperback front, already
 * on the series record), else earliest rendered ISSUE cover. Back covers never count.
 * Called from the cover filename hooks (comicPagesFilenameHook,
 * seasonCoverFilenameHook) and the boot backfill (server/scripts/backfillSeriesCoverImages.js).
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
 * Pure derivation over loaded data: volume cover, else earliest issue cover, else
 * null. Used by the boot backfill; the runtime refresh composes the pickers directly
 * to skip the issue load.
 */
export function deriveSeriesCoverImage({ seasons, issues } = {}) {
  return pickVolumeCoverFilename(seasons) || pickIssueCoverFilename(issues) || null;
}

/**
 * Recompute and persist a series' cover thumbnail; skips the issue scan when a
 * volume cover exists. setSeriesCoverImage no-ops on an unchanged value.
 * Best-effort: a cosmetic thumbnail must never fail the user's render.
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
