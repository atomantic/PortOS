/**
 * Pure deterministic day-based rotation for POST practice selection — `shuffleForDay` supplies a
 * stable pseudorandom daily mix.
 *
 * `orderByRecencyRotation` sorts candidates fresh-before-recently-practiced, then by priority, and
 * rotates equivalent ones by local day so a tier never pins to one drill. Mirrored at
 * `client/src/lib/postRotation.js`.
 */

import { shuffle } from './arrayUtils.js';

/**
 * Deterministic day-based rotation for POST practice selection (#5319): every "what should I practice?" surface resolved equivalent candidates by input order, so the same drill won the top slot daily (Elements from the memory tier, digit-span from the heuristic tiers); a rotation keyed by local day varies across days
 * yet stays repeatable for the same day and inputs (seeded randomness). Pure and dependency-free: `client/src/lib/postRotation.js` re-exports it so the server's recommendation tiers and the client's Quick-session picks rotate identically. Import no Node built-in and nothing outside `server/lib`.
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
 * Order a priority-ranked candidate list: (1) candidates NOT practiced inside the recency window first, (2) then lower `rank` (higher priority), (3) equivalent candidates (same recency bucket and rank) rotate by local day instead of input order.
 * Nothing is dropped (a caller wanting the whole tier keeps every entry, one pick reads `[0]`); with a single candidate or no day key the input order is returned, making "fall back to the only option" free.
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

/** Stable pseudorandom daily order; selection does not move after each answer. */
export function shuffleForDay(candidates, dayKey) {
  let seed = dayOrdinal(dayKey) ?? 0;
  return shuffle(candidates, () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  });
}
