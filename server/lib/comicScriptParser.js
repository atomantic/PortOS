/**
 * Pure parser for the Marvel/DC-format comic script the pipeline-comic-script
 * stage produces (see data.sample/prompts/stages/pipeline-comic-script.md —
 * data/ is gitignored; data.sample/ is the authoritative template, copied
 * into data/ at setup time). Splits
 * the markdown into a structured `{ pages: [{ panels: [...] }] }` shape so
 * the comicPages stage UI can drop the LLM-authored panel descriptions
 * directly into image-gen prompts without a second round-trip.
 *
 * Strict-but-tolerant: requires `## Page N` / `### Panel N` headers, then
 * each panel's `**Description:** ...`, `**Caption:** ...`, `**Dialogue:** ...`,
 * `**SFX:** ...` blocks per the template. "(none)" / empty values normalize
 * to `''` for caption/sfx and `[]` for dialogue (never null) so downstream
 * template renderers don't need null-guards. Unexpected text between panels
 * is ignored.
 */
const PAGE_RE = /^##\s+Page\s+([\dIVX]+)\b/i;
const PANEL_RE = /^###\s+Panel\s+([\dIVX]+)\b/i;
const FIELD_RE = /^\*\*([A-Za-z][\w ]*?)\s*:\*\*\s*(.*)$/;

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
  // **Field:** label was most recently opened. Captions can repeat
  // (`**Caption:**` then `**Caption 2:**`), so concat them with newlines.
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
 * @returns {{ pages: Array<{ panels: Array<{ description, caption, dialogue, sfx }> }> }}
 */
export function parseComicScript(script) {
  if (typeof script !== 'string' || !script.trim()) return { pages: [] };

  const lines = script.split(/\r?\n/);
  const pages = [];
  // Two-pointer cursor: when we hit a Page or Panel header, flush the current
  // panel buffer (if any) into its page, then start a new buffer.
  let currentPage = null;
  let currentPanelLines = null;
  let inAnyPanel = false;

  const flushPanel = () => {
    if (!inAnyPanel || !currentPage || !currentPanelLines) return;
    const panel = parsePanelBody(currentPanelLines);
    // Drop panels with no description — image-gen has nothing to render
    // from them and they'd just add empty rows in the UI.
    if (panel.description) {
      // Wire-shape expected by ComicPagesStage.jsx: each panel needs
      // imageJobId for the per-panel render slot.
      currentPage.panels.push({ ...panel, imageJobId: null });
    }
    currentPanelLines = null;
    inAnyPanel = false;
  };

  for (const line of lines) {
    if (PAGE_RE.test(line)) {
      flushPanel();
      if (pages.length >= PANEL_LIMITS.PAGES_MAX) break;
      currentPage = { panels: [] };
      pages.push(currentPage);
      continue;
    }
    if (PANEL_RE.test(line)) {
      flushPanel();
      // A panel header before any Page header is malformed; coerce into an
      // implicit "Page 1" so the parser doesn't silently drop content.
      if (!currentPage) {
        currentPage = { panels: [] };
        pages.push(currentPage);
      }
      if (currentPage.panels.length >= PANEL_LIMITS.PANELS_PER_PAGE_MAX) {
        // Skip this panel — over the per-page cap — but keep scanning so a
        // following page header is still respected.
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

  // Drop pages that ended up empty (e.g. headers with no panels after them).
  const filtered = pages.filter((p) => p.panels.length > 0);
  return { pages: filtered };
}

export { PANEL_LIMITS };
