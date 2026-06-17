/**
 * Manuscript narration — full-prose "read aloud" proofing (#1304).
 *
 * Reading prose aloud is one of the most effective proofing techniques: clunky
 * rhythm, tongue-twisters, repeated words, and unnatural sentences are obvious
 * to the ear and invisible to the eye. PortOS already synthesizes storyboard
 * *dialogue* (`audio.js` → `synthesizeToFile`); this extends the same local TTS
 * engines (Kokoro/Piper) to arbitrary manuscript prose.
 *
 * Strategy — sentence-segmented synthesis for karaoke sync. Local TTS engines
 * return a WAV with no word-level timestamps, so we split the prose into
 * sentence segments, synthesize each one independently, and measure its WAV
 * duration. The client plays the segments back-to-back and highlights the
 * active sentence from those durations (no decoding, no timestamp metadata).
 * Each segment also carries a lightweight readability scan so likely
 * trouble-spots are marked before/while listening.
 *
 * Non-destructive: this never mutates the manuscript — the WAVs land in
 * PATHS.audio exactly like the dialogue render + voice preview paths.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { synthesizeToFile } from './audio.js';

// Upper bound on sentences synthesized in one narrate call. A whole section can
// be thousands of words; synthesizing every sentence is sequential + slow, so
// cap it and tell the caller to narrate a smaller selection rather than hang.
export const MAX_NARRATION_SEGMENTS = 400;

// Per-segment character cap handed to the TTS engine — matches the 4000-char
// limit the other TTS REST endpoints enforce. A run-on sentence (or prose with
// no terminal punctuation) can yield one huge segment; sending that straight to
// the engine can fail or wedge local synthesis, so we sub-split it on word
// boundaries first (the sub-spans are still highlightable, offsets preserved).
export const MAX_SEGMENT_CHARS = 4000;

/**
 * Break a single over-long segment into sub-spans no longer than `max`,
 * cutting on the last whitespace within each window (hard-cut only when a
 * single token exceeds `max`). Offsets stay anchored to the original text so
 * the client still reconstructs it verbatim. Returns [seg] unchanged when it
 * already fits.
 */
function chunkLongSegment(seg, text, max) {
  if (seg.end - seg.start <= max) return [seg];
  const out = [];
  let s = seg.start;
  while (seg.end - s > max) {
    let cut = -1;
    for (let p = s + max; p > s; p -= 1) {
      if (/\s/.test(text[p])) { cut = p; break; }
    }
    if (cut === -1) cut = s + max; // no whitespace to break on — hard cut
    let e = cut;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e > s) out.push({ text: text.slice(s, e), start: s, end: e });
    s = cut;
    while (s < seg.end && /\s/.test(text[s])) s += 1;
  }
  if (seg.end > s) out.push({ text: text.slice(s, seg.end), start: s, end: seg.end });
  return out;
}

// Abbreviations whose trailing period must NOT end a sentence — otherwise
// "Dr. Vane" or "U.S. Navy" split mid-phrase and the highlight stutters.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc',
  'e.g', 'i.e', 'a.m', 'p.m', 'no', 'vol', 'fig', 'gen', 'sgt', 'capt', 'lt',
]);

const isAbbreviation = (word) => {
  if (!word) return false;
  const w = word.toLowerCase().replace(/[^a-z.]/g, '');
  if (ABBREVIATIONS.has(w) || ABBREVIATIONS.has(w.replace(/\.$/, ''))) return true;
  // Single-letter initials ("J." in "J. R. R. Tolkien") and dotted acronyms
  // ("U.S.", "U.S.A.") — a run of single letters each followed by a period.
  return /^(?:[a-z]\.){1,}[a-z]?$/.test(w);
};

/**
 * Split prose into sentence segments, preserving char offsets into the original
 * text so the client can reconstruct the section verbatim (inter-sentence
 * whitespace lives in the gaps between [start, end] spans). Pure, no I/O.
 *
 * @param {string} text
 * @returns {Array<{ text: string, start: number, end: number }>}
 */
export function splitProseIntoSentences(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const segments = [];
  let cursor = 0; // start of the current pending sentence (incl. leading ws)
  let i = 0;
  const len = text.length;

  const push = (end) => {
    // Trim leading/trailing whitespace off the recorded span so the highlight
    // wraps the words, not the surrounding blank space.
    let s = cursor;
    let e = end;
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    if (e > s) segments.push({ text: text.slice(s, e), start: s, end: e });
    cursor = end;
  };

  while (i < len) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      // Consume a run of terminators + trailing closing quotes/brackets.
      let j = i + 1;
      while (j < len && /[.!?]/.test(text[j])) j += 1;
      while (j < len && /["'”’)\]]/.test(text[j])) j += 1;
      const priorWord = text.slice(cursor, i + 1).trim().split(/\s+/).pop();
      const nextChar = text[j] || '';
      // A lowercase letter after the terminator marks a continuation, not a
      // boundary — a dialogue tag (`"Run!" she cried.`) or a trailing-off
      // ellipsis (`Wait... what?`). Find the next significant (non-space) char.
      let k = j;
      while (k < len && /\s/.test(text[k])) k += 1;
      const continuation = /[a-z]/.test(text[k] || '');
      let boundary;
      if (ch === '.') {
        // A period is a boundary only when followed by whitespace/end (so
        // "3.14" / "U.S.A" don't split), isn't a known abbreviation, and isn't
        // a lowercase continuation.
        boundary = (nextChar === '' || /\s/.test(nextChar)) && !isAbbreviation(priorWord) && !continuation;
      } else {
        boundary = !continuation;
      }
      if (boundary) push(j);
      i = j;
      continue;
    }
    // A blank line (paragraph break) also ends the current sentence so prose
    // without terminal punctuation (poetry, fragments) still segments. The
    // window is bounded (a blank "line" is a newline + horizontal whitespace +
    // newline) but generous enough to span indented blank lines.
    if (ch === '\n' && /^\n[ \t]*\n/.test(text.slice(i, i + 64))) {
      push(i);
    }
    i += 1;
  }
  if (cursor < len) push(len);
  return segments;
}

const HARD_CLUSTER_RE = /[bcdfghjklmnpqrstvwxz]{4,}/i;
const LONG_SENTENCE_WORDS = 40;

/**
 * Lightweight "hard to say" scan for a single sentence — marks likely
 * trouble-spots an author would catch by ear: over-long sentences, hard
 * consonant clusters / tongue-twisters, and a word repeated in close
 * proximity. Pure, deterministic, no I/O. Returns `{ hard, reasons }` where
 * `reasons` is a short list of human-readable labels for the UI tooltip.
 *
 * @param {string} sentence
 * @returns {{ hard: boolean, reasons: string[] }}
 */
export function analyzeSentenceReadability(sentence) {
  const reasons = [];
  if (typeof sentence !== 'string' || !sentence.trim()) return { hard: false, reasons };
  const words = sentence.trim().split(/\s+/);
  // Lowercased, letters-only form of each word — reused by every scan below.
  const norm = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ''));

  if (words.length >= LONG_SENTENCE_WORDS) {
    reasons.push(`long sentence (${words.length} words)`);
  }

  // Hard consonant clusters — 4+ consonants in a row within a single token
  // (e.g. "twelfths", "strengths").
  if (norm.some((w) => HARD_CLUSTER_RE.test(w))) reasons.push('hard consonant cluster');

  // Alliteration spike — 3+ adjacent words sharing a first letter reads as a
  // tongue-twister aloud even when each word is fine on its own.
  let run = 1;
  for (let k = 1; k < norm.length; k += 1) {
    if (norm[k] && norm[k - 1] && norm[k][0] === norm[k - 1][0]) {
      run += 1;
      if (run >= 3) { reasons.push('alliteration run'); break; }
    } else {
      run = 1;
    }
  }

  // A content word repeated within a 5-word window — the kind of echo the ear
  // catches instantly. Skip short/common function words.
  const STOP = new Set(['the', 'and', 'that', 'with', 'for', 'was', 'were', 'had', 'have', 'his', 'her', 'she', 'him', 'they', 'their', 'you', 'are', 'but', 'not', 'this', 'from', 'into', 'out', 'all', 'one']);
  for (let k = 0; k < norm.length; k += 1) {
    const w = norm[k];
    if (w.length < 4 || STOP.has(w)) continue;
    if (norm.slice(k + 1, k + 6).includes(w)) { reasons.push(`repeated word "${w}"`); break; }
  }

  return { hard: reasons.length > 0, reasons };
}

/**
 * Synthesize a manuscript section's prose into an ordered list of sentence
 * segments with per-segment audio + duration + readability flags. The client
 * stitches these into a karaoke read-along (highlight the active sentence,
 * scrub by segment).
 *
 * @param {object} args
 * @param {string} args.text     prose to narrate
 * @param {string} [args.voiceId] namespaced narrator voice (e.g. kokoro:af_heart)
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{ segments: Array, voiceId: string|null, engine: string }>}
 */
export async function narrateProse({ text, voiceId, signal } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new ServerError('text is required', { status: 400, code: 'PIPELINE_NARRATION_EMPTY_TEXT' });
  }
  const sentences = splitProseIntoSentences(text)
    .flatMap((seg) => chunkLongSegment(seg, text, MAX_SEGMENT_CHARS));
  if (sentences.length === 0) {
    throw new ServerError('no narratable sentences found', {
      status: 400, code: 'PIPELINE_NARRATION_NO_SENTENCES',
    });
  }
  if (sentences.length > MAX_NARRATION_SEGMENTS) {
    throw new ServerError(
      `Too long to narrate in one pass (${sentences.length} sentences, max ${MAX_NARRATION_SEGMENTS}) — narrate a smaller selection.`,
      { status: 413, code: 'PIPELINE_NARRATION_TOO_LONG' },
    );
  }

  let usedEngine = null;
  let usedVoiceId = null;
  const segments = [];
  // Sequential synthesis: the local engines run in-process and one model is
  // loaded at a time, so parallelizing would just thrash. Order matters anyway
  // — the client plays them back-to-back.
  for (let idx = 0; idx < sentences.length; idx += 1) {
    const seg = sentences[idx];
    const result = await synthesizeToFile({ text: seg.text, voiceId, signal });
    usedEngine = result.engine;
    usedVoiceId = result.voiceId || usedVoiceId;
    segments.push({
      index: idx,
      text: seg.text,
      start: seg.start,
      end: seg.end,
      filename: result.filename,
      durationMs: result.durationMs,
      readability: analyzeSentenceReadability(seg.text),
    });
  }

  return { segments, voiceId: usedVoiceId, engine: usedEngine };
}
