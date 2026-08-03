/**
 * Rounds record sanitization — shape bounds + pure sanitize helpers for the
 * a cappella rounds workbench (services/rounds.js). Extracted so the service
 * keeps only seed data + CRUD while the validation vocabulary lives with the
 * other *Validation lib modules.
 *
 * The bounds are shared with routes/rounds.js#roundInputSchema (via the
 * service's re-exports) — sanitize-on-read and validate-at-the-boundary agree
 * by construction. The rhythm-shape and layer id vocabularies mirror
 * client/src/lib/songCraft.js; unknown ids are accepted (free-text fallback)
 * so a client on a newer/older songCraft revision can't 400.
 *
 * Pure/side-effect-free: no I/O, no module state. `sanitizeRound` takes the
 * caller's built-in id set as an argument so this module doesn't depend on the
 * service's seed data.
 */

import { randomUUID } from 'crypto';

// --- Shape bounds (shared with routes/rounds.js#roundInputSchema) -------------
export const TITLE_MAX_LENGTH = 200;
export const ARTIST_MAX_LENGTH = 200;
export const KEY_MAX_LENGTH = 24;
export const FIELD_MAX_LENGTH = 4000;      // lyrics body / general notes
export const SCORE_MAX_LENGTH = 8000;      // sheet-music notation (lead-sheet DSL)
export const SCORE_PARTS_MAX = 12;         // harmony variations of the sheet music
export const LABEL_MAX_LENGTH = 120;       // section + layer labels
export const PART_MAX_LENGTH = 60;         // layer voice (e.g. "Bass")
export const ID_MAX_LENGTH = 60;           // rhythm-shape / layer ids
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 320;
export const SECTIONS_MAX = 60;
export const LAYERS_MAX = 24;
export const RECORDINGS_MAX = 64;      // saved vocal takes for layered playback
export const REFERENCES_MAX = 12;      // reference links/videos (e.g. TikTok)
export const PARTNERS_MAX = 12;        // partner-song ids (rounds sung together)
export const URL_MAX_LENGTH = 512;     // uploaded-file path/url
// Reference-audio analysis (#2106): labeled time ranges on a reference's
// attached audio ("0:00–0:14 melody alone"). Bounded so a hand-edited file
// can't balloon a reference; a layered TikTok build rarely has more than a
// handful of voice entrances.
export const REF_SEGMENTS_MAX = 24;    // labeled time ranges per reference
// Per-take pitch analysis (#1027). The pitch track is a DOWNSAMPLED tuner trace
// kept for replay/training so it isn't recomputed on every open; bound it so a
// long take can't bloat data/rounds.json. `accuracy.perNote` mirrors the
// color-match grade-per-note array (#1025), bounded the same way a score can't
// be arbitrarily long.
export const PITCH_TRACK_MAX = 4000;   // downsampled tuner samples per take
export const PER_NOTE_GRADES_MAX = 2000; // per-note color-match grades per take
// Training progress (#1028). `progress.history` maps a training scope (a
// section id or the whole-song sentinel) to a bounded array of graded attempts.
// Mirrors client/src/lib/songProgress.js HISTORY_MAX (kept window per scope) and
// caps the number of distinct scopes so a hand-edited file can't balloon the
// record. An attempt is `{ percentInTune, graded, at }`.
export const PROGRESS_HISTORY_MAX = 50;   // attempts kept per scope
export const PROGRESS_SCOPES_MAX = 80;    // distinct training scopes tracked
// Valid color-match grades — mirrors client/src/lib/colorMatch.js GRADE. An
// unrecognized grade is dropped (a newer/older client vocabulary can't 400 or
// poison the persisted array).
export const RECORDING_GRADES = ['in-tune', 'close', 'off', 'missed', 'pending'];

// Trim a string field, returning '' for non-strings. Mirrors the
// absent-vs-empty rule in CLAUDE.md: callers decide whether '' clears.
const trimField = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Clamp an integer tempo into the supported band; null when unparseable so a
// song without a tempo stays distinct from one pinned to a bound.
const sanitizeTempo = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(v)));
};

// One lyric/structure section ({ id, label, lyrics }). Label defaults from the
// id when blank so a section card is never headerless. Drops shapeless entries.
const sanitizeSection = (s) => {
  if (!s || typeof s !== 'object') return null;
  const label = trimField(s.label, LABEL_MAX_LENGTH);
  const lyrics = trimField(s.lyrics, FIELD_MAX_LENGTH);
  if (!label && !lyrics) return null;
  return {
    id: trimField(s.id, ID_MAX_LENGTH) || `sec-${randomUUID().slice(0, 8)}`,
    label: label || 'Section',
    lyrics,
  };
};

// One voice layer the user is arranging ({ id, label, part, notes }). `id`
// references a songCraft VOICE_LAYERS entry when known but is free-text-safe.
const sanitizeLayer = (l) => {
  if (!l || typeof l !== 'object') return null;
  const label = trimField(l.label, LABEL_MAX_LENGTH);
  const part = trimField(l.part, PART_MAX_LENGTH);
  const notes = trimField(l.notes, FIELD_MAX_LENGTH);
  if (!label && !part && !notes) return null;
  return {
    id: trimField(l.id, ID_MAX_LENGTH) || `layer-${randomUUID().slice(0, 8)}`,
    label: label || 'Layer',
    part,
    notes,
  };
};

// A finite number or null — used by the pitch-analysis fields so a missing
// sample component (e.g. a silent frame with no detectable pitch) round-trips
// as null rather than NaN/0.
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One downsampled tuner sample ({ tMs, hz, cents, clarity }) from a take's
// pitch trace (#1027). `tMs` is the elapsed time in the take; hz/cents/clarity
// are the detected pitch, cents-from-target, and confidence. Drops shapeless
// entries; a sample with no time and no pitch carries no information.
const sanitizePitchSample = (s) => {
  if (!s || typeof s !== 'object') return null;
  const tMs = finiteOrNull(s.tMs);
  const hz = finiteOrNull(s.hz);
  if (tMs === null && hz === null) return null;
  return {
    tMs: tMs === null ? 0 : Math.max(0, Math.round(tMs)),
    hz,
    cents: finiteOrNull(s.cents),
    clarity: finiteOrNull(s.clarity),
  };
};

// The per-take accuracy summary (#1027), mirroring color-match's
// summarizeAccuracy output ({ percentInTune, graded, counts, perNote }). All
// fields are optional/absent-tolerant — a take recorded before color-match (or
// without scoring) has no accuracy at all, which is distinct from a scored take
// that graded zero notes (graded: 0). Returns null when there's nothing to
// persist so the field stays absent rather than an empty husk.
const sanitizeAccuracy = (a) => {
  if (!a || typeof a !== 'object') return null;
  const counts = a.counts && typeof a.counts === 'object' ? a.counts : {};
  const perNote = (Array.isArray(a.perNote) ? a.perNote : [])
    .map((g) => trimField(g, LABEL_MAX_LENGTH))
    .filter((g) => RECORDING_GRADES.includes(g))
    .slice(0, PER_NOTE_GRADES_MAX);
  const clampPercent = finiteOrNull(a.percentInTune);
  const clampGraded = finiteOrNull(a.graded);
  return {
    percentInTune: clampPercent === null ? 0 : Math.max(0, Math.min(100, Math.round(clampPercent))),
    graded: clampGraded === null ? perNote.length : Math.max(0, Math.round(clampGraded)),
    counts: {
      'in-tune': Math.max(0, Math.round(finiteOrNull(counts['in-tune']) ?? 0)),
      close: Math.max(0, Math.round(finiteOrNull(counts.close) ?? 0)),
      off: Math.max(0, Math.round(finiteOrNull(counts.off) ?? 0)),
      missed: Math.max(0, Math.round(finiteOrNull(counts.missed) ?? 0)),
    },
    perNote,
  };
};

// One training attempt ({ percentInTune, graded, at }) — a graded take of one
// scope (a section or the whole song). Numbers are clamped; an attempt with no
// graded notes carries no signal and is dropped (mirrors songProgress.js, which
// never records a zero-note take). Returns null for a shapeless/empty attempt.
const sanitizeAttempt = (a) => {
  if (!a || typeof a !== 'object') return null;
  const graded = finiteOrNull(a.graded);
  if (graded === null || graded <= 0) return null;
  const pct = finiteOrNull(a.percentInTune);
  return {
    percentInTune: pct === null ? 0 : Math.max(0, Math.min(100, Math.round(pct))),
    graded: Math.max(0, Math.round(graded)),
    at: typeof a.at === 'string' ? a.at : new Date().toISOString(),
  };
};

// Training progress (#1028): `{ history: { <scope>: [attempt…] } }`. Each scope
// (a section id or the whole-song sentinel) keys a bounded, newest-last attempt
// list. Absent on legacy/untrained songs — returns null when there's nothing to
// persist so the field stays off the record (no wave of empty objects). The
// number of scopes and the per-scope history are both bounded so a hand-edited
// file can't grow the record without limit. Derived stats (best/avg/learned)
// are recomputed client-side from this history on read, never stored.
const sanitizeProgress = (p) => {
  if (!p || typeof p !== 'object') return null;
  const rawHistory = p.history && typeof p.history === 'object' ? p.history : {};
  const history = {};
  let scopeCount = 0;
  for (const [scope, attempts] of Object.entries(rawHistory)) {
    if (scopeCount >= PROGRESS_SCOPES_MAX) break;
    const key = trimField(scope, ID_MAX_LENGTH);
    // Skip empty keys and the prototype-pollution-prone keys — a section id is
    // always `sec-N` (or the `__whole__` sentinel), never one of these, so a
    // hand-edited `__proto__`/`constructor` scope is a malformed file, not data.
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const cleaned = sanitizeList(attempts, sanitizeAttempt, PROGRESS_HISTORY_MAX);
    if (!cleaned.length) continue;
    history[key] = cleaned;
    scopeCount += 1;
  }
  return Object.keys(history).length ? { history } : null;
};

// One saved vocal take ({ id, layerId, filename, label, durationMs, peak,
// mutedByDefault }). `filename` is the /api/uploads file name the audio is
// served from; a recording without one is meaningless, so it's dropped.
// `layerId` ties a take to a voice layer for the layered-playback mixer (free
// text — empty means "unassigned"). Numbers are coerced/clamped; bad values
// fall to sensible defaults rather than throwing.
//
// Optional pitch analysis (#1027): `pitchTrack` (a bounded, downsampled tuner
// trace) and `accuracy` (a color-match summary) are persisted so the tuner
// history and grading aren't recomputed on every open. Both are absent on
// legacy takes and on takes recorded without scoring — the fields only appear
// when there's analysis to keep, so a pre-feature record reads back unchanged.
const sanitizeRecording = (r) => {
  if (!r || typeof r !== 'object') return null;
  const filename = trimField(r.filename, URL_MAX_LENGTH);
  if (!filename) return null;
  const durationMs = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)
    ? Math.max(0, Math.round(r.durationMs)) : 0;
  const peak = typeof r.peak === 'number' && Number.isFinite(r.peak)
    ? Math.max(0, Math.min(1, r.peak)) : 0;
  const rec = {
    id: trimField(r.id, ID_MAX_LENGTH) || `rec-${randomUUID().slice(0, 8)}`,
    layerId: trimField(r.layerId, ID_MAX_LENGTH),
    label: trimField(r.label, LABEL_MAX_LENGTH),
    filename,
    durationMs,
    peak,
    muted: r.muted === true,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString(),
  };
  // Absent ⇒ omit (legacy/unscored take); present ⇒ sanitize + bound via the
  // shared sanitizeList. Keeping the keys off the object when there's no
  // analysis avoids a wave of empty arrays in data/rounds.json on every take.
  const pitchTrack = sanitizeList(r.pitchTrack, sanitizePitchSample, PITCH_TRACK_MAX);
  if (pitchTrack.length) rec.pitchTrack = pitchTrack;
  const accuracy = sanitizeAccuracy(r.accuracy);
  if (accuracy) rec.accuracy = accuracy;
  return rec;
};

// One labeled time range on a reference's attached audio (#2106):
// `{ layerId, startMs, endMs }` — "this span is the bass part alone". `layerId`
// ties the span to a voice layer (free text, same convention as recordings);
// times are clamped non-negative integers and a zero/negative-length span is
// dropped (it selects no audio). Used by the client's analysis view to extract
// a per-layer pitch track from the span.
//
// Optional stacked-mix backing window (#2121): `bgStartMs`/`bgEndMs` mark a
// slice just BEFORE the voice enters (the earlier layers alone) so the client
// can spectral-subtract the backing and extract a voice that never appears
// solo. Purely additive — the pair only persists when it forms a valid range
// that ENDS AT OR BEFORE the segment start (`bgEndMs <= startMs`); a window
// overlapping the segment would already contain the new voice, so subtracting
// it would cancel the very part being extracted. A legacy solo segment (no bg
// fields) round-trips unchanged.
const sanitizeRefSegment = (s) => {
  if (!s || typeof s !== 'object') return null;
  const startRaw = finiteOrNull(s.startMs);
  const endRaw = finiteOrNull(s.endMs);
  if (startRaw === null || endRaw === null) return null;
  const startMs = Math.max(0, Math.round(startRaw));
  const endMs = Math.max(0, Math.round(endRaw));
  if (endMs <= startMs) return null;
  const seg = {
    layerId: trimField(s.layerId, ID_MAX_LENGTH),
    startMs,
    endMs,
  };
  const bgStartRaw = finiteOrNull(s.bgStartMs);
  const bgEndRaw = finiteOrNull(s.bgEndMs);
  if (bgStartRaw !== null && bgEndRaw !== null) {
    const bgStartMs = Math.max(0, Math.round(bgStartRaw));
    const bgEndMs = Math.max(0, Math.round(bgEndRaw));
    if (bgEndMs > bgStartMs && bgEndMs <= startMs) {
      seg.bgStartMs = bgStartMs;
      seg.bgEndMs = bgEndMs;
    }
  }
  return seg;
};

// One reference link/video ({ id, url, label, note }) — external study
// material for the song (a TikTok performance, a tutorial, a chord chart).
// `url` is required (a reference without a target is meaningless); label/note
// are free text. The client decides how to render each url (TikTok videos
// embed; everything else is a link).
//
// Optional reference-audio analysis (#2106): `audioFilename` (an /api/uploads
// file, same convention as recordings[].filename) and `segments` (bounded
// labeled time ranges) only appear when set — absent keys stay absent so a
// legacy/pre-feature reference round-trips byte-identical (purely additive,
// no migration).
const sanitizeReference = (r) => {
  if (!r || typeof r !== 'object') return null;
  const url = trimField(r.url, URL_MAX_LENGTH);
  // Require an http(s) scheme — defense-in-depth so a hand-edited file or a
  // non-PortOS writer can't persist a javascript:/data: URL that a renderer
  // might trust (mirrors the client's isHttpUrl guard).
  if (!/^https?:\/\//i.test(url)) return null;
  const ref = {
    id: trimField(r.id, ID_MAX_LENGTH) || `ref-${randomUUID().slice(0, 8)}`,
    url,
    label: trimField(r.label, LABEL_MAX_LENGTH),
    note: trimField(r.note, FIELD_MAX_LENGTH),
  };
  const audioFilename = trimField(r.audioFilename, URL_MAX_LENGTH);
  if (audioFilename) {
    ref.audioFilename = audioFilename;
    // Segments are time ranges INTO the attached audio — meaningless without
    // it. Persisting them only alongside an audioFilename makes the invariant
    // structural: removing the audio clears them, so stale ranges can't
    // resurrect against a later, different recording.
    const segments = sanitizeList(r.segments, sanitizeRefSegment, REF_SEGMENTS_MAX);
    if (segments.length) ref.segments = segments;
    // A MuScriptor transcription OF the attached audio (an /api/uploads .mid
    // pointer) — same structural invariant as segments: derived from this
    // audio, so removing the audio drops it and a stale transcription can't
    // resurrect against a later, different recording.
    const midiFilename = trimField(r.midiFilename, URL_MAX_LENGTH);
    if (midiFilename) ref.midiFilename = midiFilename;
  }
  return ref;
};

// One sheet-music part — a harmony variation of the song's base score
// ({ id, label, role, score }). `score` is the PortOS lead-sheet DSL (same
// format as the base `score`); a part without notation is meaningless, so it's
// dropped. `role` references a songCraft HARMONY_PARTS id when known (bass,
// mid-harmony-1, high-harmony-1 …) but is free-text-safe so a newer/older client
// vocabulary can't 400. `label` defaults from the role/`Part` so a part card is
// never headerless.
const sanitizeScorePart = (p) => {
  if (!p || typeof p !== 'object') return null;
  const score = trimField(p.score, SCORE_MAX_LENGTH);
  if (!score) return null;
  const label = trimField(p.label, LABEL_MAX_LENGTH);
  const role = trimField(p.role, ID_MAX_LENGTH);
  return {
    id: trimField(p.id, ID_MAX_LENGTH) || `part-${randomUUID().slice(0, 8)}`,
    label: label || 'Part',
    role,
    score,
  };
};

const sanitizeList = (arr, fn, max) =>
  (Array.isArray(arr) ? arr : [])
    .map(fn)
    .filter(Boolean)
    .slice(0, max);

// Partner-song ids — the "symbiotic" link that lets rounds declare which other
// songs they're sung together with (a quodlibet stack). Keeps only non-empty
// strings, dedupes, and drops a self-reference (a song can't partner itself —
// that would make the round-stack render the same song twice). `selfId` is the
// owning song's id so the self-drop survives a hand-edited file.
const sanitizePartnerIds = (arr, selfId) => {
  const seen = new Set();
  return (Array.isArray(arr) ? arr : [])
    .map((v) => trimField(v, ID_MAX_LENGTH))
    .filter((id) => id && id !== selfId && !seen.has(id) && seen.add(id))
    .slice(0, PARTNERS_MAX);
};

// No built-in ids — the default when a caller sanitizes outside the service's
// seed context (every song reads back builtIn: false).
const NO_BUILTIN_IDS = new Set();

// Project a stored or inbound record onto the canonical song shape. Used on
// read (defends hand-edited JSON) and on write (normalizes the input).
// `builtinIds` is the caller's bundled-default id set (services/rounds.js
// passes BUILTIN_ROUND_IDS) — derived from the shipped seeds, NOT from `raw`,
// so the flag can't be lost on edit or spoofed on a hand-edited custom song.
export const sanitizeRound = (raw, builtinIds = NO_BUILTIN_IDS) => {
  if (!raw || typeof raw !== 'object') return null;
  const id = trimField(raw.id, ID_MAX_LENGTH);
  if (!id) return null;
  const song = {
    id,
    title: trimField(raw.title, TITLE_MAX_LENGTH) || 'Untitled round',
    artist: trimField(raw.artist, ARTIST_MAX_LENGTH),
    key: trimField(raw.key, KEY_MAX_LENGTH),
    tempo: sanitizeTempo(raw.tempo),
    rhythmShapeId: trimField(raw.rhythmShapeId, ID_MAX_LENGTH),
    notation: trimField(raw.notation, FIELD_MAX_LENGTH),
    // Sheet-music notation in the PortOS lead-sheet DSL (client/src/lib/
    // scoreNotation.js). A bounded free-text string — the client parses + renders
    // it; the server only length-caps it, so a newer/older DSL revision can't 400.
    score: trimField(raw.score, SCORE_MAX_LENGTH),
    // Harmony variations of the base `score` (bass, mid/high harmonies …), each
    // its own lead-sheet DSL. Absent ⇒ [] — purely additive, so an older peer or
    // a pre-feature record reads back as a song with no parts (no migration of
    // the on-disk shape needed; the field simply appears when the user adds one).
    scoreParts: sanitizeList(raw.scoreParts, sanitizeScorePart, SCORE_PARTS_MAX),
    notes: trimField(raw.notes, FIELD_MAX_LENGTH),
    learned: raw.learned === true,
    sections: sanitizeList(raw.sections, sanitizeSection, SECTIONS_MAX),
    layers: sanitizeList(raw.layers, sanitizeLayer, LAYERS_MAX),
    recordings: sanitizeList(raw.recordings, sanitizeRecording, RECORDINGS_MAX),
    references: sanitizeList(raw.references, sanitizeReference, REFERENCES_MAX),
    // Ids of other songs this one is sung together with (round-stack partners).
    partnerRoundIds: sanitizePartnerIds(raw.partnerRoundIds, id),
    builtIn: builtinIds.has(id),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
  // Training progress (#1028). Absent ⇒ omit (legacy/untrained song); present ⇒
  // attach the bounded per-scope attempt history. Keeping the key off the record
  // when there's no progress avoids an empty husk on every untrained song.
  const progress = sanitizeProgress(raw.progress);
  if (progress) song.progress = progress;
  return song;
};
