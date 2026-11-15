/**
 * WebVTT / SRT subtitle → readable plain-text transcript.
 *
 * WebVTT/SRT → readable prose. `vttToPlainText(vtt)` (paragraph-joined transcript), `vttToLines(vtt)`
 * (cleaned caption lines), `cleanCaptionLine(line)`. Collapses YouTube auto-captions' rolling
 * repetition and strips inline `<c>`/timestamp markup. Used by the brain YouTube ingest.
 *
 * yt-dlp hands us caption files, not prose. YouTube's AUTO-generated captions in
 * particular are a rolling two-line display: every cue repeats the tail of the
 * previous cue and appends a few new words, so a naive "strip the timings and
 * join" produces a transcript where most of the text appears two or three
 * times. This module owns the de-duplication and inline-tag stripping so the
 * ingest service can stay about orchestration.
 *
 * Pure and side-effect free — no fs, no network — so the messy parsing rules are
 * pinned by unit tests rather than only exercised behind a yt-dlp spawn.
 */

// A cue-timing line is the only line that must contain `-->`. VTT allows both
// `HH:MM:SS.mmm` and `MM:SS.mmm`; SRT uses a comma for the decimal separator.
// Matching on the arrow alone covers every variant (plus VTT's trailing cue
// settings, e.g. `align:start position:0%`) without a brittle time regex.
const CUE_TIMING_RE = /-->/;

// WebVTT header + block-level metadata that carries no spoken content.
const HEADER_RE = /^(WEBVTT|Kind:|Language:|NOTE\b|STYLE\b|REGION\b|X-TIMESTAMP-MAP)/;

// SRT cue indices are a bare integer on their own line. VTT cue *identifiers*
// can be arbitrary text, but yt-dlp emits numeric ones, so this covers both.
const CUE_INDEX_RE = /^\d+$/;

// Inline karaoke/positioning markup: `<00:00:01.234>`, `<c.colorE5E5E5>`,
// `</c>`, `<v Speaker>`, `<b>`… Captions carry these; prose shouldn't.
const INLINE_TAG_RE = /<[^>]*>/g;

// The handful of entities YouTube actually emits in caption text.
const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

const decodeEntities = (text) =>
  text.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);

/** Strip inline markup + entities from one caption line and normalize whitespace. */
export function cleanCaptionLine(line) {
  return decodeEntities(String(line).replace(INLINE_TAG_RE, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the spoken lines from a VTT/SRT document, in order, with the rolling
 * auto-caption repetition collapsed.
 *
 * De-duplication is deliberately conservative — it only drops a line that is
 * EXACTLY a line we already kept in the recent window, or that the previous kept
 * line already ends with (the "previous cue's tail is repeated verbatim at the
 * top of this cue" shape). A real repeated phrase further apart than the window
 * survives, because dropping genuinely-spoken repetition would silently rewrite
 * what the speaker said.
 *
 * @param {string} vtt   Raw subtitle file contents.
 * @param {object} [opts]
 * @param {number} [opts.dedupeWindow=4]  How many recent lines an exact repeat is checked against.
 * @returns {string[]}   Cleaned caption lines.
 */
export function vttToLines(vtt, { dedupeWindow = 4 } = {}) {
  if (typeof vtt !== 'string' || !vtt.trim()) return [];

  const kept = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (CUE_TIMING_RE.test(line)) continue;
    if (HEADER_RE.test(line)) continue;
    if (CUE_INDEX_RE.test(line)) continue;

    const text = cleanCaptionLine(line);
    if (!text) continue;

    const recent = kept.slice(-dedupeWindow);
    if (recent.includes(text)) continue;
    // Rolling auto-captions also emit the previous line *plus* new words as one
    // cue; when the new cue merely extends the previous one, replace rather than
    // append so the transcript keeps the longer, complete phrasing exactly once.
    const prev = kept[kept.length - 1];
    if (prev && text.startsWith(prev)) {
      kept[kept.length - 1] = text;
      continue;
    }
    kept.push(text);
  }
  return kept;
}

/**
 * Render a VTT/SRT document as readable prose.
 *
 * Caption lines are ~5 words each, so joining them one-per-line produces a
 * ragged wall. Lines are joined with spaces and broken into paragraphs every
 * `paragraphEvery` lines — arbitrary but stable, and the result reads far better
 * in Obsidian than either extreme.
 *
 * @param {string} vtt
 * @param {object} [opts]
 * @param {number} [opts.paragraphEvery=24]
 * @returns {string} Plain-text transcript ('' when there was nothing to extract).
 */
export function vttToPlainText(vtt, { paragraphEvery = 24, dedupeWindow = 4 } = {}) {
  const lines = vttToLines(vtt, { dedupeWindow });
  if (lines.length === 0) return '';

  const paragraphs = [];
  for (let i = 0; i < lines.length; i += paragraphEvery) {
    paragraphs.push(lines.slice(i, i + paragraphEvery).join(' '));
  }
  return paragraphs.join('\n\n');
}
