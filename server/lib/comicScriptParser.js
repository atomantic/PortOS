/**
 * Pure parser for the Marvel/DC-format comic script the pipeline-comic-script
 * stage produces (see data.reference/prompts/stages/pipeline-comic-script.md —
 * data/ is gitignored; data.reference/ is the authoritative template, copied
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
import { trimTo } from './storyBible.js';

const PAGE_RE = /^##\s+Page\s+([\dIVX]+)\b/i;
// `## Cover concept` — the optional cover-art section the comic-script
// template emits before the first `## Page 1` header. Also accepts the
// short `## Cover` form so a hand-edited script doesn't have to be exact.
const COVER_RE = /^##\s+Cover(?:\s+concept)?\b/i;
// `## Back cover concept` — the optional back-cover art section the
// comic-script template emits (typically right after `## Cover concept`,
// before the first `## Page 1`). Matched BEFORE `COVER_RE` in the parse
// loop because "Back cover" would otherwise pass the loose Cover regex.
const BACK_COVER_RE = /^##\s+Back\s+cover(?:\s+concept)?\b/i;
// Any `##` heading other than Page / Cover / Back cover ends an in-progress
// cover or back-cover block (e.g. a stray `## Notes` section).
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

// --- Bare-format normalization ---------------------------------------------
//
// Imported comic scripts (Create → Importer) commonly use the bare
// screenplay convention — uppercase `PAGE 1` / `PANEL 1` headers with the
// label on its own line and the content on the following line(s):
//
//   PAGE 1
//   <page-level art direction>
//   PANEL 1
//   <panel description>
//   CAPTION
//   <caption text>
//   GIANT
//   <spoken line>
//   SFX
//   Thud!
//
// The pipeline's own comic-script stage emits the field-labeled Markdown
// form (`## Page N`, `**Description:**`, `**Caption:**`, `Dialogue:`). Rather
// than rewrite the user's stored script, we detect the bare form and convert
// it to the canonical shape IN MEMORY before the main parse, so the verbatim
// text seeded into `stages.comicScript.output` is preserved while still
// rendering into pages/panels. Markers are matched case-INSENSITIVELY (so a
// Title Case `Page 1` / `Panel 1` import still parses — see BARE_PAGE_LINE /
// BARE_PANEL_LINE below), but guarded by a numeric token + standalone-header
// tail so prose like "Page after page…" isn't mistaken for a header.
// The number token that legitimately follows ISSUE/PAGE/PANEL in a header:
// a digit run or a spelled-out number word — NOT an open word class, so prose
// like "Page after page" / "Pages turned" isn't mistaken for a header. Shared
// with the importer's mechanical splitter (`server/services/importer.js`
// imports this) so the import-time split and the render-time parse agree on
// what a header looks like. Roman numerals are excluded: under `/i` the class
// matches prose words ("mild", "civic").
export const COMIC_NUM = '(?:\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
// What may legitimately follow the number in a STANDALONE PAGE/PANEL header:
// end-of-line, or a punctuation-led suffix (`(5 panels)`, `: Title`, `-2`,
// `/3`). Anything else after the number — most importantly a space + a word —
// means it's a prose CONTENT line that merely starts with the keyword
// (e.g. "Page 1 of the ancient book lies open."), which must NOT be treated as
// a header or the panel it belongs to gets dropped. Shared with the splitter.
export const COMIC_HEADER_TAIL = '\\s*(?:[(:.\\-–—/].*)?$';
// Case-INSENSITIVE so a Title Case `Page 1` / `Panel 1` script (which the
// splitter already accepts and seeds into stages.comicScript) also parses into
// pages/panels here — otherwise the import succeeds but renders zero panels.
const BARE_PAGE_LINE = new RegExp(`^\\s*pages?\\b\\s*#?\\s*${COMIC_NUM}\\b${COMIC_HEADER_TAIL}`, 'i');   // PAGE 1 / Page 1 / PAGES 2-3
const BARE_PANEL_LINE = new RegExp(`^\\s*panels?\\b\\s*#?\\s*${COMIC_NUM}\\b${COMIC_HEADER_TAIL}`, 'i'); // PANEL 1 / Panel 1 (DPS)
// Standalone CAPTION/SFX LABEL lines only (text on following lines). An inline
// "Caption: text" / "SFX: Thud!" is left for the canonical FIELD_RE to parse,
// and a prose line that merely starts with the word ("Caption this image.")
// is not matched.
const BARE_CAPTION_LINE = /^\s*caption(?:\s+\d+)?\s*:?\s*$/i;  // CAPTION / Caption / CAPTION 2:
const BARE_SFX_LINE = /^\s*sfx\s*:?\s*$/i;                     // SFX / Sfx / SFX:
// A standalone dialogue speaker cue: a short, NAME-like all-caps token,
// optionally with a parenthetical (`GIANT`, `KESSA (WHISPERED)`). It must NOT
// contain sentence punctuation (`. , ! ? :`) so a terse all-caps panel
// description ("THE CITY BURNS.") or a slugline ("INT. VAULT - NIGHT") is not
// misread as a speaker. Even so, the FIRST content line after a PANEL/CAPTION/
// SFX label is never treated as a speaker (see normalizeBareComicScript), which
// protects all-caps descriptions and all-caps SFX content ("KRAKOOM").
const BARE_SPEAKER_LINE = /^[A-Z][A-Z0-9 '’&-]{0,28}(?:\s*\([^)]*\))?$/;
// Canonical page header — its presence means the script is already in the
// pipeline's Markdown form, so we leave it untouched.
const CANONICAL_PAGE_RE = /^##\s+Page\s/im;

// Detect the bare form: no canonical `## Page` header, but at least one bare
// uppercase `PAGE N` line.
function isBareComicScript(script) {
  if (CANONICAL_PAGE_RE.test(script)) return false;
  return script.split(/\r?\n/).some((l) => BARE_PAGE_LINE.test(l));
}

// Convert the bare form to the canonical Markdown the main parser consumes.
// Pages and panels are renumbered sequentially (the numbers are cosmetic —
// the parser keys off the headers, not the values).
function normalizeBareComicScript(script) {
  const out = [];
  let pageNum = 0;
  let panelNum = 0;
  let inPanel = false;
  // Which field the current content lines belong to: 'description' | 'caption'
  // | 'sfx' | null (page-level, or right after a dialogue line).
  let field = null;
  // True for the line immediately after a label (PANEL→description, CAPTION,
  // SFX). That line is always the field's content, NEVER a speaker cue — this
  // is what keeps a terse all-caps description or an all-caps SFX ("KRAKOOM")
  // from being misread as dialogue.
  let awaitingFirst = false;
  let pendingSpeaker = null;
  // Speaker whose dialogue is currently open (field === 'dialogue'). Every
  // following line until the next cue/label/marker is attributed to them, so a
  // multi-line balloon doesn't lose its 2nd+ lines.
  let dialogueSpeaker = null;

  // A speaker cue whose spoken line never arrived (next line was a marker or
  // EOF) is emitted back as plain text rather than dropped, so no input line
  // is lost.
  const flushDanglingSpeaker = () => {
    if (pendingSpeaker) {
      out.push(pendingSpeaker);
      pendingSpeaker = null;
    }
  };

  // A line that begins a NEW structural block (page/panel/caption/sfx) or EOF
  // is what follows a trailing all-caps SHOUT in a balloon; a genuine second
  // speaker cue is instead followed by its own spoken (dialogue) line. The
  // one-line lookahead below uses this to disambiguate the two.
  const startsNewBlock = (t) =>
    BARE_PAGE_LINE.test(t) || BARE_PANEL_LINE.test(t)
    || BARE_CAPTION_LINE.test(t) || BARE_SFX_LINE.test(t);

  const lines = script.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const t = raw.trim();

    if (BARE_PAGE_LINE.test(t)) {
      flushDanglingSpeaker();
      pageNum += 1; panelNum = 0; inPanel = false; field = null; awaitingFirst = false; dialogueSpeaker = null;
      out.push(`## Page ${pageNum}`);
      continue;
    }
    if (BARE_PANEL_LINE.test(t)) {
      flushDanglingSpeaker();
      panelNum += 1; inPanel = true; field = 'description'; awaitingFirst = true; dialogueSpeaker = null;
      out.push(`Panel ${panelNum}`);
      continue;
    }
    if (inPanel && BARE_CAPTION_LINE.test(t)) {
      flushDanglingSpeaker();
      out.push('Caption:'); field = 'caption'; awaitingFirst = true; dialogueSpeaker = null;
      continue;
    }
    if (inPanel && BARE_SFX_LINE.test(t)) {
      flushDanglingSpeaker();
      out.push('SFX:'); field = 'sfx'; awaitingFirst = true; dialogueSpeaker = null;
      continue;
    }
    // First spoken line for a pending speaker. A speaker cue is ALWAYS followed
    // by its own dialogue, so emit this line as that speaker's dialogue even
    // when it is all-caps — a shouted line like `I DON'T KNOW` also matches
    // BARE_SPEAKER_LINE, and guarding here would drop it to the panel text.
    // (The first line after a cue can never itself be a second cue.)
    if (pendingSpeaker && t) {
      out.push('Dialogue:');
      out.push(`${pendingSpeaker}: ${t}`);
      dialogueSpeaker = pendingSpeaker;
      pendingSpeaker = null;
      field = 'dialogue'; // continuation lines stay attributed to this speaker
      continue;
    }
    // Continuation line of a multi-line balloon — attribute it to the same
    // speaker so parsePanelBody captures it (otherwise lines 2+ were dropped).
    // A fresh all-caps NAME-like line in continuation position is AMBIGUOUS: it
    // could be a SECOND speaker's cue (common — two speakers in one panel) or a
    // shouted continuation of the same balloon (`STOP`, `NO`). Disambiguate with
    // one-line lookahead: a real cue is followed by its own spoken line, while a
    // trailing shout is followed by a structural marker (PAGE/PANEL/CAPTION/SFX)
    // or EOF. So treat a NAME-like line as a continuation shout when the next
    // content line starts a new block or there is none; otherwise let it fall
    // through to the speaker-cue branch below.
    if (field === 'dialogue' && dialogueSpeaker && t) {
      if (!BARE_SPEAKER_LINE.test(t)) {
        out.push(`${dialogueSpeaker}: ${t}`);
        continue;
      }
      // NAME-like continuation line: peek at the next non-blank line.
      let next = '';
      for (let j = i + 1; j < lines.length; j += 1) {
        const nt = lines[j].trim();
        if (nt) { next = nt; break; }
      }
      if (next === '' || startsNewBlock(next)) {
        // Trailing shout — no following dialogue line, so it's not a new cue.
        out.push(`${dialogueSpeaker}: ${t}`);
        continue;
      }
      // Falls through: a spoken line follows, so this is a genuine 2nd cue.
    }
    // Speaker cue — only when NOT the forced first content line after a label.
    if (inPanel && t && !awaitingFirst && BARE_SPEAKER_LINE.test(t)) {
      flushDanglingSpeaker(); // a prior cue with no spoken line keeps its text
      pendingSpeaker = t;
      field = null; dialogueSpeaker = null; // end any in-progress dialogue
      continue;
    }
    // First content line after a PANEL opens the Description field — unless
    // it's already a canonical field label (e.g. an inline "Caption: …" first
    // line), which is passed through for the main parser's FIELD_RE to handle.
    if (awaitingFirst && t && field === 'description' && !FIELD_RE.test(t)) {
      out.push(`Description: ${t}`);
      awaitingFirst = false;
      continue;
    }
    // First content line after CAPTION/SFX, plus every continuation line and
    // page-level/blank line, passes through — the main parser appends it to
    // the open field.
    if (t) awaitingFirst = false;
    out.push(raw);
  }
  flushDanglingSpeaker();
  return out.join('\n');
}

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
 * @returns {{ coverConcept: string, backCoverConcept: string, pages: Array<{ rawText, panels: Array<{ description, caption, dialogue, sfx }> }> }}
 *
 *   - `coverConcept`: the body of an optional `## Cover concept` section that
 *     appears before the first `## Page 1` header. Empty string when the
 *     script doesn't include one (legacy scripts, hand-curated content).
 *   - `backCoverConcept`: the body of an optional `## Back cover concept`
 *     section. Same shape rules as `coverConcept`. Order with respect to
 *     `## Cover concept` doesn't matter — both are captured wherever they
 *     appear before the first `## Page 1`.
 *
 *   Each page carries:
 *   - `rawText`: the markdown slice from the page's `## Page N` header to
 *     (not including) the next page header. The merged Comic tab uses this
 *     for per-page editing while panels remain the source for the image
 *     prompt.
 *   - `panels`: structured panel breakdown for image-gen prompts.
 */
export function parseComicScript(script) {
  if (typeof script !== 'string' || !script.trim()) {
    return { coverConcept: '', backCoverConcept: '', pages: [] };
  }

  // Imported scripts often arrive in the bare `PAGE`/`PANEL`/`CAPTION` form
  // (see normalizeBareComicScript). Convert to canonical Markdown first so
  // the verbatim stored script still parses into pages/panels. Canonical
  // scripts are detected and left untouched, so existing behavior is unchanged.
  const bare = isBareComicScript(script);
  const normalized = bare ? normalizeBareComicScript(script) : script;
  const lines = normalized.split(/\r?\n/);
  const pages = [];
  let currentPage = null;
  let currentRawLines = null;
  let currentPanelLines = null;
  let inAnyPanel = false;
  // Cover / back-cover concept accumulators. Each is active between its
  // own `## …` heading and the next `##` heading (Page 1, the *other*
  // cover section, or any other H2).
  let inCover = false;
  let inBackCover = false;
  const coverLines = [];
  const backCoverLines = [];

  const flushPanel = () => {
    if (!inAnyPanel || !currentPage || !currentPanelLines) return;
    const panel = parsePanelBody(currentPanelLines);
    // Canonical (LLM-authored) scripts: keep only description-bearing panels —
    // a stray `**Caption:**` with no description is generator noise (a floating
    // header) and is intentionally dropped. Imported bare scripts: keep a panel
    // with ANY content, because a caption-only / dialogue-only / SFX-only panel
    // (e.g. a narration-over-black splash) is a legitimate authored beat and
    // dropping it would lose the user's verbatim text.
    const hasContent = bare
      ? (panel.description || panel.caption || panel.sfx || panel.dialogue.length > 0)
      : Boolean(panel.description);
    if (hasContent) {
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
    // `BACK_COVER_RE` must run before `COVER_RE` — "## Back cover concept"
    // would otherwise match the looser `## Cover` regex first.
    if (BACK_COVER_RE.test(line)) {
      inCover = false;
      inBackCover = true;
      continue;
    }
    if (COVER_RE.test(line)) {
      inCover = true;
      inBackCover = false;
      continue;
    }
    if (PAGE_RE.test(line)) {
      inCover = false;
      inBackCover = false;
      flushPanel();
      flushPageRawText();
      if (pages.length >= PANEL_LIMITS.PAGES_MAX) break;
      currentPage = { panels: [], rawText: '' };
      currentRawLines = [line];
      pages.push(currentPage);
      continue;
    }
    // Any *other* H2 also ends an in-progress cover / back-cover block
    // (e.g. a stray `## Notes`).
    if ((inCover || inBackCover) && ANY_H2_RE.test(line)) {
      inCover = false;
      inBackCover = false;
    }
    if (inCover) {
      coverLines.push(line);
      continue;
    }
    if (inBackCover) {
      backCoverLines.push(line);
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
  const backCoverConcept = trimTo(
    backCoverLines.join('\n').replace(/^\s*\n+|\n+\s*$/g, ''),
    PANEL_LIMITS.PAGE_SCRIPT_MAX,
  );
  return { coverConcept, backCoverConcept, pages: filtered };
}

export { PANEL_LIMITS };
