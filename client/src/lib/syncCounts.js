// Directional pending-sync counts for a delta-synced category (brain / memory).
//
// PortOS federation sync is PULL-based — each instance pulls changes from its
// peers — so "push pending" is really "items of ours the peer hasn't pulled yet."
// Two directions, both derived from monotonic change-log sequences:
//
//   toPull = peerMax        - ourCursor        (their items we haven't pulled)
//   toPush = ourLocalMax    - peerCursorForUs  (our items they haven't pulled)
//
// Sequences arrive as numbers (brain) or numeric strings (memory BIGSERIAL),
// so compare as BigInt to stay exact past Number.MAX_SAFE_INTEGER.
//
// Sentinel discipline (see CLAUDE.md): a MISSING input must NOT collapse to 0.
// - For pull, an absent `ourCursor` legitimately means "pulled nothing" → treat
//   as 0 (the caller passes `ourCursor ?? 0`). An absent `peerMax` means the
//   peer hasn't been probed yet → unknown (null).
// - For push, an absent `peerCursorForUs` means the peer is too old to report
//   it (or hasn't probed us) → unknown (null), never a misleading 0.

function toBig(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  return null;
}

// Returns the positive difference `ahead - behind` as a Number, clamped at 0,
// or null when either side is absent/invalid (unknown). A peer that has pulled
// MORE than our reported max (clock skew, mid-sync probe) clamps to 0 rather
// than showing a confusing negative.
export function diffSeq(ahead, behind) {
  const a = toBig(ahead);
  const b = toBig(behind);
  if (a === null || b === null) return null;
  const d = a - b;
  if (d <= 0n) return 0;
  // The seqs themselves can exceed Number.MAX_SAFE_INTEGER (that's why we
  // compare as BigInt), but the DELTA is a pending-item backlog between two
  // syncs — realistically tiny. Should it ever exceed the safe integer range,
  // cap at MAX_SAFE_INTEGER so the count degrades to a still-honest "very large
  // backlog" rather than a precise-looking-but-wrong Number from a lossy cast.
  const MAX = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(d > MAX ? MAX : d);
}

// { toPull, toPush } — each a non-negative Number, or null when unknown.
export function directionalCounts({ localMax, peerMax, ourCursor, peerCursorForUs }) {
  return {
    // Absent cursor = we've pulled nothing yet, so default to 0 (not unknown).
    toPull: diffSeq(peerMax, ourCursor ?? 0),
    // Absent peer-cursor = peer didn't report it (old peer) → genuinely unknown.
    toPush: diffSeq(localMax, peerCursorForUs),
  };
}

// Plain-language one-liner for a directional pair. Used by the badge and easy
// to unit-test independently of React. `null` directions are omitted (unknown);
// when BOTH directions are known and zero, the category is "in sync".
export function describeDirectional({ toPull, toPush }) {
  const bothKnown = toPull !== null && toPush !== null;
  if (bothKnown && toPull === 0 && toPush === 0) {
    return { state: 'synced', text: 'in sync' };
  }
  const parts = [];
  if (toPull) parts.push(`${toPull} to pull`);
  if (toPush) parts.push(`${toPush} to push`);
  if (parts.length === 0) {
    // Either everything known is zero but a direction is unknown, or both
    // unknown. Fall back to a neutral pending label rather than lying "in sync".
    return { state: 'pending', text: bothKnown ? 'in sync' : 'checking…' };
  }
  return { state: 'behind', text: parts.join(' · ') };
}
