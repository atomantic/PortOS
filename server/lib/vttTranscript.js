/**
 * WebVTT/SRT subtitle → readable prose: `vttToPlainText(vtt)` (paragraph-joined transcript), `vttToLines(vtt)` (cleaned caption lines), `cleanCaptionLine(line)`; used by the brain YouTube ingest.
 *
 * yt-dlp hands us caption files, and YouTube's AUTO captions are a rolling two-line display (each cue repeats the previous cue's tail plus a few new words), so "strip timings and join" repeats most text two or three times; this owns the de-duplication and inline `<c>`/timestamp stripping so ingest stays about orchestration. Pure (no fs/network), so the messy rules are unit-pinned.
 */

// A cue-timing line is the only one that must contain `-->`; matching on the arrow alone covers `HH:MM:SS.mmm`, `MM:SS.mmm`, SRT's comma decimal and VTT trailing cue settings (`align:start position:0%`) without a brittle time regex.
const CUE_TIMING_RE = /-->/;

// WebVTT header + block-level metadata that carries no spoken content.
const HEADER_RE = /^(WEBVTT|Kind:|Language:|NOTE\b|STYLE\b|REGION\b|X-TIMESTAMP-MAP)/;

// SRT cue indices are a bare integer on their own line; VTT identifiers can be arbitrary text but yt-dlp emits numeric ones.
const CUE_INDEX_RE = /^\d+$/;

// Inline karaoke/positioning markup (`<00:00:01.234>`, `<c.colorE5E5E5>`, `</c>`, `<v Speaker>`, `<b>`…) that captions carry and prose shouldn't.
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
 * Extract the spoken lines from a VTT/SRT document, in order, with rolling auto-caption repetition collapsed. De-duplication is conservative: it drops only a line EXACTLY matching one kept in the recent window, or one the previous kept line already ends with (a cue tail repeated verbatim);
 * a real repeated phrase further apart survives (dropping spoken repetition would rewrite what the speaker said).
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
    // Rolling auto-captions also emit the previous line *plus* new words as one cue; when a cue merely extends the previous one, replace rather than append so the longer phrasing appears once.
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
 * Render a VTT/SRT document as readable prose: caption lines (~5 words) are joined with spaces and broken into paragraphs every `paragraphEvery` lines (arbitrary but stable; reads well in Obsidian).
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
