const isStr = (v) => typeof v === 'string';

/**
 * Normalize the `deleted` + `deletedAt` tombstone fields on a raw record.
 * Used by every sanitizer that participates in soft-delete / peer sync
 * (`sanitizeTemplate` for universes, `sanitizeSeries`, `sanitizeIssue`) so
 * the shape of a tombstone is identical regardless of which file owns the
 * record. The invariant is: when `deleted=false`, `deletedAt` is always
 * `null` — never a stray timestamp from a corrupted payload.
 */
export function sanitizeSoftDeleteFields(raw) {
  const deleted = raw?.deleted === true;
  const deletedAt = deleted && isStr(raw?.deletedAt) ? raw.deletedAt : null;
  return { deleted, deletedAt };
}

// Single source of truth for what fields cross the federated-peer wire.
//
// Two transports carry universe / series / issue records between peers:
//
//   1. The 60s snapshot loop in `server/services/dataSync.js` — sends the full
//      per-category state every cycle for LWW reconciliation.
//   2. The per-record push pipeline in `server/services/sharing/peerSync.js` —
//      sends one record (+ asset manifest) when a subscription fires after a
//      local edit.
//
// Both transports MUST agree on which fields are wire-safe and which are
// peer-local (ephemeral state, transcripts, render history that's too large
// to round-trip). The helpers here are the single decision point — change
// them and every transport updates together.

/**
 * Wire-safe projection of a single record. Currently a passthrough — per-record
 * field stripping (e.g. dropping `runHistory` from issue stages once it grows
 * too large for sync) goes here when the time comes. The function exists today
 * so the new push path has the same callsite as the snapshot path, and so the
 * next "should this field cross the wire?" decision lands in one place.
 */
export function sanitizeRecordForWire(kind, record) {
  if (!record || typeof record !== 'object') return null;
  switch (kind) {
    case 'universe':
    case 'series':
    case 'issue':
      return record;
    default:
      return null;
  }
}

/**
 * Wire-safe projection of a top-level state file. The 60s snapshot loop
 * stripped `runs[]` from `universe-builder.json` here inline; centralising it
 * means the per-record push uses the same rule when it bootstraps a peer with
 * the full universe set on first subscribe.
 *
 * Returns `{ kind, data }` so callers can pass the result straight to
 * `computeChecksum` and the receiver-side merge entry points.
 */
export function sanitizeStateForWire(kind, state) {
  if (!state || typeof state !== 'object') return { kind, data: null };
  switch (kind) {
    case 'universe': {
      const universes = Array.isArray(state.universes)
        ? state.universes
            .map((u) => sanitizeRecordForWire('universe', u))
            .filter(Boolean)
        : [];
      // `runs[]` is local LLM run history (transcripts, ephemeral). Each peer
      // keeps its own — never cross the wire.
      return { kind, data: { universes } };
    }
    case 'pipeline': {
      const series = Array.isArray(state.series)
        ? state.series
            .map((s) => sanitizeRecordForWire('series', s))
            .filter(Boolean)
        : [];
      const issues = Array.isArray(state.issues)
        ? state.issues
            .map((i) => sanitizeRecordForWire('issue', i))
            .filter(Boolean)
        : [];
      return { kind, data: { series, issues } };
    }
    default:
      return { kind, data: null };
  }
}
