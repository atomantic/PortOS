/**
 * Music Video lyric-sheet structure: section headers and stage directions.
 *
 * A lyric sheet carries more than sung text. `[Verse 1]`, `[Chorus]` and
 * `[Bridge — stripped groove]` name the song's structure, and directions like
 * `[Spoken, close]`, `[Whispered spoken]`, `[Shouts]` or `[Stop — silence]`
 * say how a line is delivered. The cue importer drops those lines from the
 * sung text; this module keeps them as `lyricMarkers` on the project, each
 * anchored to the index of the lyric line it precedes, so the planner can
 * frame a whispered line close and cut hard on a shout, and the analysis can
 * name its sections after the sheet once the lines are timed.
 *
 * Marker shape: `{ type: 'section' | 'direction', label, kind, line }`.
 * A section's `kind` is its normalized part (`verse`, `chorus`, …); a
 * direction's `kind` is its delivery (`spoken`, `whispered`, `shouted`,
 * `silence`, `hits`, `rhythm`, `note`). `line` is the lyric-cue index the
 * marker applies to; a marker after the last line carries the line count.
 */

import { trimTo } from '../../lib/textUtils.js';

export const LYRIC_MARKER_LABEL_MAX = 120;
export const LYRIC_MARKER_KIND_MAX = 32;
export const LYRIC_MARKERS_MAX = 500;

// Ordered: `pre-chorus` must win over `chorus`.
const SECTION_KINDS = [
  ['pre-chorus', /^pre[\s-]?chorus\b/],
  ['post-chorus', /^post[\s-]?chorus\b/],
  ['chorus', /^(?:(?:final|last|double|big)\s+)?chorus\b/],
  ['verse', /^verse\b/],
  ['bridge', /^(?:middle\s+(?:8|eight)|bridge)\b/],
  ['intro', /^intro\b/],
  ['outro', /^(?:outro|ending)\b/],
  ['hook', /^hook\b/],
  ['refrain', /^refrain\b/],
  ['interlude', /^interlude\b/],
  ['breakdown', /^breakdown\b/],
  ['drop', /^(?:beat\s+)?drop\b/],
  ['instrumental', /^(?:instrumental|(?:guitar\s+|piano\s+)?solo)\b/],
  ['coda', /^coda\b/],
];

// Ordered: "Whispered spoken" is a whisper; "Stop-time" is a rhythmic device,
// not a silence.
const DELIVERY_KINDS = [
  ['whispered', /whisper/],
  ['shouted', /shout|yell|scream|chant/],
  ['hits', /stop[\s-]?time|\bstabs?\b|\bhits?\b/],
  ['silence', /silen|\bstop\b|\bpause\b|a[\s-]?cappella|\bbreak\b/],
  ['spoken', /spoken|\bspeak|\bsaid\b|talk|narrat|recit/],
  ['rhythm', /clap|groove|drum|half[\s-]?time|double[\s-]?time|restart|beat|stomp/],
];

/** Normalized section kind for a header's leading words, or null. */
function sectionKind(text) {
  const head = String(text || '').toLowerCase().trim();
  for (const [kind, pattern] of SECTION_KINDS) if (pattern.test(head)) return kind;
  return null;
}

/** Delivery kind for a stage direction. Unrecognized text is a plain `note`. */
function deliveryKind(text) {
  const lower = String(text || '').toLowerCase();
  for (const [kind, pattern] of DELIVERY_KINDS) if (pattern.test(lower)) return kind;
  return 'note';
}

const clean = (text) => trimTo(String(text || '').replace(/\s+/g, ' ').trim(), LYRIC_MARKER_LABEL_MAX);

/**
 * Markers for one bracketed tag's content. `Bridge — stripped groove` is a
 * section plus a direction note; `Spoken, close` is a direction alone.
 */
function markersForTag(content, line) {
  const text = clean(content);
  if (!text) return [];
  const [head, ...rest] = text.split(/\s+[—–-]\s+|\s*:\s+/);
  const kind = sectionKind(head);
  if (!kind) return [{ type: 'direction', label: text, kind: deliveryKind(text), line }];
  const out = [{ type: 'section', label: clean(head), kind, line }];
  const note = clean(rest.join(' — '));
  if (note) out.push({ type: 'direction', label: note, kind: deliveryKind(note), line });
  return out;
}

const WHOLE_BRACKET = /^\[([^\]]*)\]$/;
const WHOLE_PAREN = /^\(([^)]*)\)$/;
const WHOLE_STAR = /^\*([^*]+)\*$/;
// Only a tag with words in it: `[00:12.50]` is a timestamp, not a direction.
const INLINE_BRACKET = /\[([^\]]*\p{L}[^\]]*)\]/gu;

/**
 * Split plain lyric text into sung lines and structure markers. A whole-line
 * `[…]` or `*…*` is always structure. A whole-line `(…)` is structure only when
 * it reads as a delivery direction — `(oh-oh)` is a sung ad-lib. A `[…]` tag
 * inside a sung line is lifted off the text as a direction for that line.
 */
export function parseLyricSheet(text) {
  const cues = [];
  const markers = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const bracket = line.match(WHOLE_BRACKET) || line.match(WHOLE_STAR);
    if (bracket) {
      markers.push(...markersForTag(bracket[1], cues.length));
      continue;
    }
    const paren = line.match(WHOLE_PAREN);
    if (paren && deliveryKind(paren[1]) !== 'note' && !sectionKind(paren[1])) {
      markers.push(...markersForTag(paren[1], cues.length));
      continue;
    }
    const inline = [...line.matchAll(INLINE_BRACKET)].map((m) => m[1]);
    const sung = inline.length ? line.replace(INLINE_BRACKET, ' ').replace(/\s+/g, ' ').trim() : line;
    if (!sung) {
      for (const tag of inline) markers.push(...markersForTag(tag, cues.length));
      continue;
    }
    for (const tag of inline) {
      markers.push(...markersForTag(tag, cues.length).map((m) => (m.type === 'section' ? m : { ...m, type: 'direction' })));
    }
    cues.push({ text: sung, startSec: null, endSec: null });
  }
  return { cues, markers };
}

/** Normalize a stored/edited marker list: known types, bounded text, a line inside the cue list. */
export function normalizeLyricMarkers(markers, cueCount = Infinity) {
  if (!Array.isArray(markers)) return [];
  const maxLine = Number.isFinite(cueCount) ? Math.max(0, cueCount) : 2000;
  const out = [];
  for (const marker of markers) {
    if (!marker || typeof marker !== 'object') continue;
    if (marker.type !== 'section' && marker.type !== 'direction') continue;
    const label = clean(marker.label);
    if (!label) continue;
    const line = Number(marker.line);
    if (!Number.isInteger(line) || line < 0) continue;
    const kind = trimTo(String(marker.kind || ''), LYRIC_MARKER_KIND_MAX)
      || (marker.type === 'section' ? (sectionKind(label) || 'section') : deliveryKind(label));
    out.push({ type: marker.type, label, kind, line: Math.min(line, maxLine) });
    if (out.length >= LYRIC_MARKERS_MAX) break;
  }
  return out;
}

/** Shift every marker's line by `offset` (appending an imported sheet after existing lines). */
export const offsetLyricMarkers = (markers, offset) => (markers || []).map((m) => ({ ...m, line: m.line + offset }));

const isTime = (value) => typeof value === 'number' && Number.isFinite(value);

// First timed cue at or after `line` and before `stop`.
function firstTimed(cues, line, stop) {
  for (let i = line; i < Math.min(stop, cues.length); i++) if (isTime(cues[i]?.startSec)) return cues[i];
  return null;
}

function lastTimedEnd(cues, from, stop) {
  for (let i = Math.min(stop, cues.length) - 1; i >= from; i--) {
    const cue = cues[i];
    if (isTime(cue?.endSec)) return cue.endSec;
    if (isTime(cue?.startSec)) return cue.startSec;
  }
  return null;
}

/**
 * Time spans of the sheet's sections once its lines are timed. A section runs
 * from its first timed line to the next section's first timed line (the last
 * one to its last timed line). Sections with no timed line are left out.
 */
function lyricSectionSpans(cues, markers) {
  const list = Array.isArray(cues) ? cues : [];
  const sections = (markers || []).filter((m) => m?.type === 'section');
  const spans = [];
  sections.forEach((section, index) => {
    const stop = index + 1 < sections.length ? sections[index + 1].line : list.length;
    const first = firstTimed(list, section.line, stop);
    if (!first) return;
    spans.push({ label: section.label, kind: section.kind, startSec: first.startSec, stop, line: section.line });
  });
  return spans.map((span, index) => {
    const next = spans[index + 1];
    const endSec = next ? next.startSec : lastTimedEnd(list, span.line, span.stop);
    return { label: span.label, kind: span.kind, startSec: span.startSec, endSec: isTime(endSec) && endSec > span.startSec ? endSec : span.startSec };
  }).filter((span) => span.endSec > span.startSec);
}

// An analysis section takes the sheet's name when at least this share of it
// lies inside one lyric section.
const RELABEL_MIN_SHARE = 0.45;

const overlap = (a, b) => Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));

function restore(section) {
  if (section.labelSource !== 'lyrics') return section;
  const { analysisLabel, labelSource, ...rest } = section;
  return { ...rest, label: analysisLabel || rest.label };
}

/**
 * Name the analysis sections after the lyric sheet. Each section keeps its
 * detector label in `analysisLabel` and is marked `labelSource: 'lyrics'`, so
 * a later pass can restore it. Stretches before the first sung section and
 * after the last become Intro/Outro. Boundaries, energy and every other
 * analysis field are untouched. Returns the analysis unchanged when nothing is
 * timed.
 */
export function relabelAnalysisSections(analysis, cues, markers) {
  if (!analysis || !Array.isArray(analysis.sections)) return analysis;
  const spans = lyricSectionSpans(cues, markers);
  const sections = analysis.sections.map((section) => {
    const base = restore(section);
    if (spans.length === 0) return base;
    const length = base.endSec - base.startSec;
    if (!(length > 0)) return base;
    let best = null;
    let bestShare = 0;
    for (const span of spans) {
      const share = overlap(base, span) / length;
      if (share > bestShare) { best = span; bestShare = share; }
    }
    const original = base.label;
    const named = (label) => ({ ...base, label, labelSource: 'lyrics', analysisLabel: original });
    if (best && bestShare >= RELABEL_MIN_SHARE) return named(best.label);
    if (base.endSec <= spans[0].startSec + 0.25) return named('Intro');
    if (base.startSec >= spans[spans.length - 1].endSec - 0.25) return named('Outro');
    return base;
  });
  return { ...analysis, sections };
}

/**
 * Delivery directions that fall inside [startSec, endSec): a direction is
 * placed at the start of the line it precedes, or at the end of the last
 * line when it trails the sheet. Returns the direction labels in order.
 */
export function deliveryNotesWithin(cues, markers, startSec, endSec) {
  const list = Array.isArray(cues) ? cues : [];
  const notes = [];
  for (const marker of markers || []) {
    if (marker?.type !== 'direction') continue;
    const cue = list[marker.line];
    const at = cue && isTime(cue.startSec) ? cue.startSec : (marker.line >= list.length ? lastTimedEnd(list, 0, list.length) : null);
    if (!isTime(at) || at < startSec || at >= endSec) continue;
    if (!notes.includes(marker.label)) notes.push(marker.label);
  }
  return notes;
}
