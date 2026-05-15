/**
 * Pure parser for the Marvel/DC-format comic script the pipeline-comic-script
 * stage produces (see data.sample/prompts/stages/pipeline-comic-script.md —
 * data/ is gitignored; data.sample/ is the authoritative template, copied
 * into data/ at setup time). Splits the markdown into a structured
 * `{ coverConcept, pages: [{ rawText, panels: [...] }] }` shape so the
 * comicPages stage UI can drop the LLM-authored panel descriptions
 * directly into image-gen prompts without a second round-trip.
 *
 * Strict-but-tolerant. Page headers are always `## Page N`. Panel headers
 * accept both the legacy `### Panel N` and the simpler plain `Panel N`
 * form. Field labels accept both `**Description:** ...` and the plain
 * `Description: ...` form for an allowlist of fields. "(none)" / empty
 * values normalize to `''` for caption/sfx and `[]` for dialogue (never
 * null) so downstream template renderers don't need null-guards.
 * Unexpected text between panels is ignored.
 */
const PAGE_RE = /^##\s+Page\s+([\dIVX]+)\b/i;
// `## Cover concept` — the optional cover-art section the comic-script
// template emits before the first `## Page 1` header. Also accepts the
// short `## Cover` form so a hand-edited script doesn't have to be exact.
const COVER_RE = /^##\s+Cover(?:\s+concept)?\b/i;
// Any `##` heading other than Page / Cover ends an in-progress cover block
// (e.g. a stray `## Notes` section).
const ANY_H2_RE = /^##\s+/;
// Plain `Panel N` is preferred by the current prompt template — `## Page N`
// is the deepest header level we use, so panels live below it without their
// own heading. Legacy `### Panel N` still accepted for back-compat.
//
// The line must be a standalone header — `Panel N` followed by nothing,
// an optional parenthetical (e.g. `Panel 1 (DPS)` for a double-page spread),
// or an optional trailing colon. Without the end-anchor a description line
// like "Panel 2 is offline on the monitor." starts a new panel and silently
// drops the rest of the prior panel's body.
const PANEL_RE = /^(?:###\s+)?Panel\s+([\dIVX]+)\s*(?:\([^)]+\))?\s*:?\s*$/i;
// Caption may repeat with a trailing index (`Caption 2:`); parsePanelBody
// folds those into one caption block.
const FIELD_RE = /^(?:\*\*)?(Description|Caption(?:\s+\d+)?|Dialogue|SFX)\s*:(?:\*\*)?\s*(.*)$/i;

const NONE_RE = /^\(\s*none\s*\)$/i;
const isNoneValue = (s) => !s || NONE_RE.test(s.trim());

const PANEL_LIMITS = Object.freeze({
  PAGES_MAX: 200,
  PANELS_PER_PAGE_MAX: 24,
  DESCRIPTION_MAX: 4000,
  CAPTION_MAX: 1000,
  DIALOGUE_LINE_MAX: 1000,
  DIALOGUE_ENTRIES_MAX: 24,
  SFX_MAX: 200,
  // Cap on the full per-page rawText the UI shows as a single editable
  // textarea. Wide enough for a maxed-out page (24 panels × ~1.5KB each)
  // with comfortable headroom.
  PAGE_SCRIPT_MAX: 40_000,
});

const trimTo = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

/**
 * Parse one panel body — the lines between this panel's header and the next
 * panel/page header. Combines multi-line field values (Description often
 * wraps), folds the Dialogue list into `[{ character, line }]`, and discards
 * "(none)" markers.
 */
function parsePanelBody(lines) {
  // Field collector: accumulate consecutive non-header lines under whichever
  // field label was most recently opened. Captions can repeat
  // (`Caption:` then `Caption 2:`), so concat them with newlines.
  let activeField = null;
  const fields = {}; // canonical key → joined string
  for (const raw of lines) {
    const line = raw ?? '';
    const m = line.match(FIELD_RE);
    if (m) {
      const label = m[1].toLowerCase().replace(/\s+\d+$/, '').trim(); // "Caption 2" → "caption"
      activeField = label;
      const rest = (m[2] || '').trim();
      if (fields[activeField] && rest) {
        fields[activeField] = `${fields[activeField]}\n${rest}`;
      } else {
        fields[activeField] = rest || fields[activeField] || '';
      }
    } else if (activeField && line.trim()) {
      fields[activeField] = fields[activeField]
        ? `${fields[activeField]}\n${line.trim()}`
        : line.trim();
    }
  }

  const dialogue = [];
  if (fields.dialogue && !isNoneValue(fields.dialogue)) {
    for (const dl of fields.dialogue.split('\n')) {
      const t = dl.trim();
      if (!t) continue;
      // Match: "- NAME: "line"" or "NAME: line" or "- NAME (whispered): "line""
      const dm = t.match(/^[-*]?\s*([A-Z][A-Z0-9 '"&./()\-]*?):\s*"?(.+?)"?$/);
      if (dm) {
        dialogue.push({
          character: trimTo(dm[1], 100),
          line: trimTo(dm[2], PANEL_LIMITS.DIALOGUE_LINE_MAX),
        });
        if (dialogue.length >= PANEL_LIMITS.DIALOGUE_ENTRIES_MAX) break;
      }
    }
  }

  return {
    description: trimTo(fields.description, PANEL_LIMITS.DESCRIPTION_MAX),
    caption: isNoneValue(fields.caption) ? '' : trimTo(fields.caption, PANEL_LIMITS.CAPTION_MAX),
    dialogue,
    sfx: isNoneValue(fields.sfx) ? '' : trimTo(fields.sfx, PANEL_LIMITS.SFX_MAX),
  };
}

/**
 * @param {string} script  markdown body from stages.comicScript.output
 * @returns {{ coverConcept: string, pages: Array<{ rawText, panels: Array<{ description, caption, dialogue, sfx }> }> }}
 *
 *   - `coverConcept`: the body of an optional `## Cover concept` section that
 *     appears before the first `## Page 1` header. Empty string when the
 *     script doesn't include one (legacy scripts, hand-curated content).
 *
 *   Each page carries:
 *   - `rawText`: the markdown slice from the page's `## Page N` header to
 *     (not including) the next page header. The merged Comic tab uses this
 *     for per-page editing while panels remain the source for the image
 *     prompt.
 *   - `panels`: structured panel breakdown for image-gen prompts.
 */
export function parseComicScript(script) {
  if (typeof script !== 'string' || !script.trim()) return { coverConcept: '', pages: [] };

  const lines = script.split(/\r?\n/);
  const pages = [];
  let currentPage = null;
  let currentRawLines = null;
  let currentPanelLines = null;
  let inAnyPanel = false;
  // Cover-concept accumulator. Active between a `## Cover concept` heading
  // and the next `##` heading (Page 1 or any other H2).
  let inCover = false;
  const coverLines = [];

  const flushPanel = () => {
    if (!inAnyPanel || !currentPage || !currentPanelLines) return;
    const panel = parsePanelBody(currentPanelLines);
    if (panel.description) {
      currentPage.panels.push({ ...panel, imageJobId: null });
    }
    currentPanelLines = null;
    inAnyPanel = false;
  };

  const flushPageRawText = () => {
    if (!currentPage || !currentRawLines) return;
    const joined = currentRawLines.join('\n').replace(/^\s*\n+|\n+\s*$/g, '');
    currentPage.rawText = trimTo(joined, PANEL_LIMITS.PAGE_SCRIPT_MAX);
  };

  for (const line of lines) {
    if (COVER_RE.test(line)) {
      inCover = true;
      continue;
    }
    if (PAGE_RE.test(line)) {
      inCover = false;
      flushPanel();
      flushPageRawText();
      if (pages.length >= PANEL_LIMITS.PAGES_MAX) break;
      currentPage = { panels: [], rawText: '' };
      currentRawLines = [line];
      pages.push(currentPage);
      continue;
    }
    // Any *other* H2 also ends the cover block (e.g. a stray `## Notes`).
    if (inCover && ANY_H2_RE.test(line)) {
      inCover = false;
    }
    if (inCover) {
      coverLines.push(line);
      continue;
    }
    if (currentRawLines) currentRawLines.push(line);
    if (PANEL_RE.test(line)) {
      flushPanel();
      if (!currentPage) {
        currentPage = { panels: [], rawText: '' };
        currentRawLines = [line];
        pages.push(currentPage);
      }
      if (currentPage.panels.length >= PANEL_LIMITS.PANELS_PER_PAGE_MAX) {
        currentPanelLines = null;
        inAnyPanel = false;
        continue;
      }
      currentPanelLines = [];
      inAnyPanel = true;
      continue;
    }
    if (inAnyPanel && currentPanelLines) {
      currentPanelLines.push(line);
    }
  }
  flushPanel();
  flushPageRawText();

  const filtered = pages.filter((p) => p.panels.length > 0);
  const coverConcept = trimTo(
    coverLines.join('\n').replace(/^\s*\n+|\n+\s*$/g, ''),
    PANEL_LIMITS.PAGE_SCRIPT_MAX,
  );
  return { coverConcept, pages: filtered };
}

export { PANEL_LIMITS };
