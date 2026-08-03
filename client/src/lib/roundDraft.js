// Pure helpers for the Round editor's in-memory draft (`/rounds/:id`).
//
// Extracted from RoundEditor.jsx (#3389) so the page, its per-concern hooks
// (useRoundDraft / useRoundRows / useRoundPartners), and the edit-form component
// all read the same caps, id rules, and tempo band instead of re-declaring them.
// Pure — no React, no API calls.

// Cap on partner songs — mirrors services/rounds.js PARTNERS_MAX. Used only to
// disable adding more in the editor; the server enforces the real bound.
export const PARTNERS_MAX = 12;
// Cap on harmony parts — mirrors services/rounds.js SCORE_PARTS_MAX. Used only
// to refuse applying an extracted part past the bound; the server enforces it.
export const SCORE_PARTS_MAX = 12;

// In-session-only id for a freshly-added section/layer, used purely as a React
// key until the row is saved. Counter-based (not Math.random, which is
// unavailable in some harnesses and unnecessary here) — uniqueness only needs
// to hold within the editing session. These TEMP ids are stripped on save (see
// stripTempId) so the server assigns a stable `sec-<uuid>`/`layer-<uuid>`; if
// they were persisted, a reload (localSeq → 0) could re-mint `sec-new-0` and
// collide with a saved row, breaking per-id update/remove.
export const TEMP_ID_RE = /-new-\d+$/;
let localSeq = 0;
export const localId = (prefix) => `${prefix}-new-${localSeq++}`;
// Blank a temp id before save so the server re-ids it; keep stable ids
// (preset ids like `lead`, server-assigned uuids) so dedup + matching survive.
export const stripTempId = (row) => (TEMP_ID_RE.test(row.id) ? { ...row, id: '' } : row);

// Mirror the server tempo band (services/rounds.js TEMPO_MIN/MAX). We clamp on
// BLUR, not on every keystroke — clamping each keystroke would turn typing
// "68" into "208" (the lone "6" clamps up to 20 first). While editing we keep
// the raw parsed number; clampTempo runs on blur so the saved value lands in
// band without an opaque server 400. Empty input clears (null).
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 320;
// Parse a number input's value to a number or null, without clamping (used
// on change so intermediate digits aren't mangled).
export const parseTempo = (raw) => {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
// Clamp a tempo into the supported band (used on blur).
export const clampTempo = (n) => {
  if (n == null) return null;
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(n)));
};

/**
 * The PUT body for a round draft: every editable field, with in-session temp
 * ids blanked so the server assigns stable uuids (see stripTempId).
 *
 * @param {object} song The in-memory draft.
 * @returns {object} The patch to send to `updateRound`.
 */
export const buildRoundPatch = (song) => ({
  title: song.title, artist: song.artist, key: song.key,
  tempo: song.tempo ?? null, rhythmShapeId: song.rhythmShapeId,
  notation: song.notation, score: song.score, notes: song.notes, learned: song.learned,
  progress: song.progress ?? null,
  // Strip in-session temp ids so the server assigns stable uuids — keeps
  // them from being persisted and later colliding after a reload.
  sections: (song.sections || []).map(stripTempId),
  layers: (song.layers || []).map(stripTempId),
  scoreParts: (song.scoreParts || []).map(stripTempId),
  recordings: (song.recordings || []).map(stripTempId),
  // References also blank any segment layerId that points at a temp layer
  // id — the server re-mints that layer's id on save, so the link would
  // dangle after reload; an unassigned segment is the honest state.
  references: (song.references || []).map((r) => {
    const ref = stripTempId(r);
    if (!ref.segments?.length) return ref;
    return {
      ...ref,
      segments: ref.segments.map((s) => (
        TEMP_ID_RE.test(s.layerId || '') ? { ...s, layerId: '' } : s
      )),
    };
  }),
  partnerRoundIds: song.partnerRoundIds || [],
});
