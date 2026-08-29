/**
 * Deterministic day-based rotation for POST practice selection (issue #5319).
 *
 * Every POST "what should I practice?" surface used to resolve equivalent
 * candidates by input order, so the same drill won the top slot every day —
 * Elements from the memory tier, digit-span from the heuristic tiers. These
 * helpers replace that fixed order with a rotation keyed by the local day, so
 * the choice varies across days while staying repeatable for the same day and
 * the same inputs (no randomness — the daily routine must be reproducible).
 *
 * Pure, dependency-free, and MIRRORED from `server/lib/postRotation.js` so the
 * client's Quick-session domain picks and the server's recommendation tiers
 * rotate identically. Keep the two files in sync — the server-side
 * `postRotation.mirror.test.js` fails when their code diverges.
 */

/**
 * Days since the epoch for a `YYYY-MM-DD` local day label, as a rotation seed.
 * Returns null when the label isn't parseable, so callers fall back to plain
 * priority order rather than rotating off a garbage seed.
 */
function dayOrdinal(dayKey) {
  if (typeof dayKey !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const at = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(at) ? null : Math.floor(at / 86400000);
}

/**
 * Offset into a list of `length` equivalent candidates for the given local day.
 * Always in range; 0 for an unparseable day or an empty list.
 */
export function dayRotationIndex(dayKey, length) {
  const size = Math.trunc(length) || 0;
  if (size <= 1) return 0;
  const ordinal = dayOrdinal(dayKey);
  if (ordinal === null) return 0;
  return ((ordinal % size) + size) % size;
}

/**
 * Order a priority-ranked candidate list so that:
 *   1. candidates NOT practiced inside the recency window come first,
 *   2. within that, lower `rank` (higher priority) comes first,
 *   3. and genuinely equivalent candidates — same recency bucket, same rank —
 *      rotate by local day instead of resolving to input order.
 *
 * Nothing is dropped, so a caller that wants the whole tier keeps every entry
 * and a caller that wants one pick reads `[0]`. With a single candidate (or no
 * day key) the input order is returned unchanged, which is what makes "fall
 * back to the only available option" free.
 *
 * @param {Array} candidates
 * @param {object} [options]
 * @param {string|null} [options.dayKey] - local `YYYY-MM-DD`
 * @param {(candidate: any) => boolean} [options.isRecent] - practiced in the window
 * @param {(candidate: any) => number} [options.rank] - lower is higher priority
 * @returns {Array} a new, reordered array
 */
export function orderByRecencyRotation(candidates, { dayKey = null, isRecent = () => false, rank = () => 0 } = {}) {
  const list = (candidates || []).filter(Boolean);
  if (list.length <= 1) return list;

  const decorated = list.map((candidate, index) => ({
    candidate,
    index,
    recent: isRecent(candidate) ? 1 : 0,
    rank: Number(rank(candidate)) || 0,
  }));
  decorated.sort((a, b) => (a.recent - b.recent) || (a.rank - b.rank) || (a.index - b.index));

  const out = [];
  let start = 0;
  while (start < decorated.length) {
    let end = start;
    while (
      end < decorated.length
      && decorated[end].recent === decorated[start].recent
      && decorated[end].rank === decorated[start].rank
    ) end += 1;
    const group = decorated.slice(start, end);
    const offset = dayRotationIndex(dayKey, group.length);
    out.push(...group.slice(offset), ...group.slice(0, offset));
    start = end;
  }
  return out.map(entry => entry.candidate);
}
