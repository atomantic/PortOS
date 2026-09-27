/**
 * Music Video — timed lyric cues + musical-phrase annotations (#8964).
 *
 * Both lists live on the project record (`lyricCues`, `phrases`) and are
 * whole-list replaced by a project PATCH, so the director can edit, retime, or
 * delete any entry. This module owns the storage-agnostic pieces: importing
 * cue text (LRC / SRT / WebVTT / plain lines), normalizing an edited list so it
 * always persists a stable id and a sane time range, and invalidating the
 * timings when the project's audio source changes.
 *
 * Timings are alignment DERIVED from one specific audio file; the text is the
 * director's own. So an audio-source change keeps every line and label but
 * clears their times (`startSec`/`endSec` → null) — the planner then ignores
 * them until they are re-timed against the new track, instead of cutting the
 * new song on the old song's lyric positions.
 */

import { randomUUID } from 'crypto';

const MAX_CUE_TEXT = 500;
const MAX_SEC = 36000;

const round3 = (n) => Math.round(n * 1000) / 1000;

function toTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SEC
    ? round3(value)
    : null;
}

// A range with an end before its start keeps the start and drops the end —
// the start is what the planner cuts on; a missing end is derived from the next
// cue at plan time.
function normalizeRange(entry) {
  const startSec = toTime(entry?.startSec);
  const end = toTime(entry?.endSec);
  return { startSec, endSec: startSec != null && end != null && end > startSec ? end : null };
}

// Keep each entry's id (minting one for a new or duplicated entry) so a
// whole-list replace still addresses the same rows; `shape` returns the
// entry's authored fields, or null to drop it.
function normalizeList(list, prefix, shape) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const fields = entry && typeof entry === 'object' ? shape(entry) : null;
    if (!fields) continue;
    const given = typeof entry.id === 'string' && entry.id && !seen.has(entry.id) ? entry.id : null;
    const id = given || `${prefix}-${randomUUID()}`;
    seen.add(id);
    out.push({ id, ...fields, ...normalizeRange(entry) });
  }
  return out;
}

const trimmed = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Normalize an edited cue list: keep ids, trim text, drop empty lines. Order is kept (lyric order). */
export const normalizeLyricCues = (cues) => normalizeList(cues, 'lc', (cue) => {
  const text = trimmed(cue.text, MAX_CUE_TEXT);
  return text ? { text } : null;
});

/** Normalize an edited phrase list: keep ids, trim label/intent. */
export const normalizePhrases = (phrases) => normalizeList(phrases, 'mp', (phrase) => ({
  label: trimmed(phrase.label, 120),
  intent: trimmed(phrase.intent, 2000),
}));

/** Clear the audio-derived timings on every cue/phrase, keeping the authored text. */
export function invalidateTimedText(project) {
  const clear = (list) => (Array.isArray(list) ? list.map((e) => ({ ...e, startSec: null, endSec: null })) : list);
  return {
    ...(Array.isArray(project.lyricCues) ? { lyricCues: clear(project.lyricCues) } : {}),
    ...(Array.isArray(project.phrases) ? { phrases: clear(project.phrases) } : {}),
  };
}

// `[mm:ss]`, `[mm:ss.xx]`, `[mm:ss:xx]` and `[h:mm:ss.xxx]` all appear in the wild.
const LRC_STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LRC_OFFSET = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i;
const SRT_TIMING = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const VTT_SHORT_TIMING = /(\d{1,2}):(\d{2})[.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2})[.](\d{1,3})/;

const fraction = (digits) => (digits ? Number(digits) / 10 ** digits.length : 0);

function parseLrc(text) {
  let offsetSec = 0;
  const stamped = [];
  for (const line of text.split(/\r?\n/)) {
    const offset = line.match(LRC_OFFSET);
    // LRC offset is milliseconds; a positive offset shows lyrics sooner.
    if (offset) { offsetSec = -Number(offset[1]) / 1000; continue; }
    // Metadata tags ([ar:…], [ti:…]) carry no mm:ss stamp, so they fall out here.
    const stamps = [...line.matchAll(LRC_STAMP)];
    if (stamps.length === 0) continue;
    const lyric = line.replace(LRC_STAMP, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    for (const m of stamps) {
      stamped.push({ t: Number(m[1]) * 60 + Number(m[2]) + fraction(m[3]), text: lyric });
    }
  }
  stamped.sort((a, b) => a.t - b.t);
  // An empty-text stamp is a timed gap marker: it ends the previous line.
  const cues = [];
  for (let i = 0; i < stamped.length; i++) {
    const { t, text: lyric } = stamped[i];
    if (!lyric) continue;
    const next = stamped[i + 1];
    const startSec = Math.max(0, t + offsetSec);
    cues.push({ text: lyric, startSec, endSec: next ? Math.max(0, next.t + offsetSec) : null });
  }
  return cues;
}

function parseSrt(text) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx < 0) continue;
    const long = lines[timingIdx].match(SRT_TIMING);
    const short = long ? null : lines[timingIdx].match(VTT_SHORT_TIMING);
    let startSec;
    let endSec;
    if (long) {
      startSec = Number(long[1]) * 3600 + Number(long[2]) * 60 + Number(long[3]) + fraction(long[4]);
      endSec = Number(long[5]) * 3600 + Number(long[6]) * 60 + Number(long[7]) + fraction(long[8]);
    } else if (short) {
      startSec = Number(short[1]) * 60 + Number(short[2]) + fraction(short[3]);
      endSec = Number(short[4]) * 60 + Number(short[5]) + fraction(short[6]);
    } else {
      continue;
    }
    // Strip inline markup (<i>, <v Speaker>, {\an8}) that subtitle files carry.
    const lyric = lines.slice(timingIdx + 1).join(' ').replace(/<[^>]*>|\{[^}]*\}/g, '').trim();
    if (lyric) cues.push({ text: lyric, startSec, endSec });
  }
  return cues;
}

function parsePlain(text) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    // Section headers like "[Chorus]" are structure, not sung text.
    .filter((line) => line && !/^\[[^\]]*\]$/.test(line))
    .map((line) => ({ text: line, startSec: null, endSec: null }));
}

export function detectLyricsFormat(text) {
  if (/-->/.test(text)) return 'srt';
  if (/^\s*\[\d{1,3}:\d{1,2}/m.test(text)) return 'lrc';
  return 'text';
}

/**
 * Parse pasted/imported lyric text into cue inputs (not yet id'd — run the
 * result through `normalizeLyricCues`). Returns `{ format, cues }`.
 */
export function parseLyricCues(text, format = 'auto') {
  const source = typeof text === 'string' ? text : '';
  const resolved = format === 'auto' || !format ? detectLyricsFormat(source) : format;
  const cues = resolved === 'lrc' ? parseLrc(source)
    : resolved === 'srt' ? parseSrt(source)
      : parsePlain(source);
  return { format: resolved, cues };
}
