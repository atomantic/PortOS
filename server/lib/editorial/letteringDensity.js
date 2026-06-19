/**
 * Comic lettering density / balloon load (#1313) — pure word/balloon accounting
 * over the parsed comic-script pages the `comicScriptParser` emits.
 *
 * The #1 reader gripe in comics is a wall of text crammed into one panel: an
 * over-stuffed balloon, too many balloons fighting for room, or a page whose
 * total lettering load overwhelms the art. `comicScriptParser.js` already parses
 * per-panel dialogue / caption / SFX but never counts words — this module does
 * the counting and flags overflows against industry rules-of-thumb (all
 * configurable): ~25 words per balloon, ~50 words per panel, ~3 balloons per
 * panel, and a per-page lettering ceiling.
 *
 * PURE + side-effect-free so it is unit-testable and so the SAME helper backs
 * both the server-side editorial check (`comic.lettering-density` in
 * checkRegistry.js) and the client comic-script stage inline warnings (mirrored
 * to `client/src/lib/letteringDensity.js` — keep the two byte-for-byte in sync).
 *
 * A "balloon" is a discrete lettering element the reader's eye lands on: each
 * dialogue entry is one balloon, and each caption box is one (captions repeat —
 * the parser folds `Caption` / `Caption 2` into one newline-joined string, so
 * each non-empty line counts as a box). SFX is lettering and counts toward the
 * panel/page WORD load, but it is rendered as a sound effect rather than a
 * balloon, so it does NOT count toward the balloon tally.
 */

// Industry rules-of-thumb (all overridable via the check's config). A balloon
// much over ~20–25 words reads as a wall of text; a panel over ~45–50 words
// crowds the art; more than ~3 balloons in a panel is hard to follow; and a
// page much past ~150 words of lettering starts to bury the illustration.
export const DEFAULT_LETTERING_THRESHOLDS = Object.freeze({
  maxWordsPerBalloon: 25,
  maxWordsPerPanel: 50,
  maxBalloonsPerPanel: 3,
  maxWordsPerPage: 150,
});

// The severity ranks an overflow can scale to (high → low), most-severe first.
// Local copy so this stays self-contained and the client mirror needs nothing
// from checkRegistry.
const LETTERING_SEVERITIES = ['high', 'medium', 'low'];

// Count words in a free-text lettering string. A "word" is a run of
// non-whitespace, so hyphenates and contractions count once and punctuation
// rides along — close enough for a density heuristic. Non-strings → 0.
export function countWords(text) {
  if (typeof text !== 'string') return 0;
  const matched = text.trim().match(/\S+/g);
  return matched ? matched.length : 0;
}

// Severity scaled by how far over the threshold a count runs (#1313 "severity
// scaled by overflow"): ≥2× the limit is `high`, ≥1.4× is `medium`, otherwise a
// mild overflow is `low`. Pure so it's unit-testable. A count at/under the
// threshold returns `low` but callers only invoke it for genuine overflows.
export function overflowSeverity(count, threshold) {
  if (!(threshold > 0)) return 'medium';
  const ratio = count / threshold;
  if (ratio >= 2) return 'high';
  if (ratio >= 1.4) return 'medium';
  return 'low';
}

// Merge a (possibly hand-edited / partial) config object over the defaults,
// guarding each field's type so a bad value can't crash the scan. A
// non-positive threshold disables that rule (treated as Infinity).
export function sanitizeLetteringThresholds(config) {
  const c = config && typeof config === 'object' ? config : {};
  const pick = (key) => {
    const v = c[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    return DEFAULT_LETTERING_THRESHOLDS[key];
  };
  return {
    maxWordsPerBalloon: pick('maxWordsPerBalloon'),
    maxWordsPerPanel: pick('maxWordsPerPanel'),
    maxBalloonsPerPanel: pick('maxBalloonsPerPanel'),
    maxWordsPerPage: pick('maxWordsPerPage'),
  };
}

// Per-panel lettering metrics from a parsed panel
// (`{ description, caption, dialogue: [{ character, line }], sfx }`). Pure.
//
//   - `balloons`     — one entry per dialogue balloon: { speaker, words, line }.
//   - `captionBoxes` — one entry per non-empty caption line: { words, text }.
//   - `balloonCount` — dialogue balloons + caption boxes (the reader-facing tally).
//   - `totalWords`   — dialogue + caption + SFX words (the full lettering load).
export function panelLetteringMetrics(panel) {
  const dialogue = Array.isArray(panel?.dialogue) ? panel.dialogue : [];
  const balloons = dialogue.map((d) => {
    const line = typeof d?.line === 'string' ? d.line : '';
    return {
      speaker: typeof d?.character === 'string' ? d.character.trim() : '',
      words: countWords(line),
      line,
    };
  });
  const caption = typeof panel?.caption === 'string' ? panel.caption : '';
  const captionBoxes = caption
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ words: countWords(text), text }));
  const sfx = typeof panel?.sfx === 'string' ? panel.sfx : '';
  const dialogueWords = balloons.reduce((sum, b) => sum + b.words, 0);
  const captionWords = captionBoxes.reduce((sum, b) => sum + b.words, 0);
  const sfxWords = countWords(sfx);
  return {
    balloons,
    captionBoxes,
    balloonCount: balloons.length + captionBoxes.length,
    dialogueWords,
    captionWords,
    sfxWords,
    totalWords: dialogueWords + captionWords + sfxWords,
  };
}

// First real lettering text in a panel, for anchoring a panel/page-level finding
// to something the editor can actually locate in the script (prefer a dialogue
// line, then a caption, then SFX). '' when the panel has no lettering at all.
function firstLetteringText(metrics) {
  const balloon = metrics.balloons.find((b) => b.line.trim());
  if (balloon) return balloon.line.trim();
  const box = metrics.captionBoxes.find((b) => b.text);
  return box ? box.text : '';
}

/**
 * Analyze the parsed pages of ONE comic script for lettering overflows.
 *
 * @param {Array<{ panels: Array<object> }>} pages  parseComicScript(...).pages
 * @param {object} [config]  threshold overrides (see DEFAULT_LETTERING_THRESHOLDS)
 * @returns {Array<object>} flat list of violations, each:
 *   { kind, pageNumber, panelNumber?, balloonIndex?, boxIndex?, speaker?, count,
 *     threshold, limitLabel, severity, anchorQuote }
 *   `kind` ∈ 'balloon-words' | 'caption-words' | 'panel-words' | 'panel-balloons' | 'page-words'.
 *   `pageNumber` / `panelNumber` are 1-based (panel within its page).
 */
export function analyzeComicLettering(pages, config) {
  const t = sanitizeLetteringThresholds(config);
  const list = Array.isArray(pages) ? pages : [];
  const violations = [];
  list.forEach((page, pageIdx) => {
    const pageNumber = pageIdx + 1;
    const panels = Array.isArray(page?.panels) ? page.panels : [];
    let pageWords = 0;
    panels.forEach((panel, panelIdx) => {
      const panelNumber = panelIdx + 1;
      const m = panelLetteringMetrics(panel);
      pageWords += m.totalWords;

      // An individual balloon over the per-balloon word ceiling — the most
      // actionable signal (split it, or move some to a caption).
      m.balloons.forEach((balloon, balloonIndex) => {
        if (balloon.words > t.maxWordsPerBalloon) {
          violations.push({
            kind: 'balloon-words',
            pageNumber,
            panelNumber,
            balloonIndex,
            speaker: balloon.speaker,
            count: balloon.words,
            threshold: t.maxWordsPerBalloon,
            limitLabel: 'words in one balloon',
            severity: overflowSeverity(balloon.words, t.maxWordsPerBalloon),
            anchorQuote: balloon.line.trim(),
          });
        }
      });

      // A single caption box over the same per-balloon word ceiling. Caption boxes
      // count as balloons (toward `maxBalloonsPerPanel`) and the threshold's help
      // says it applies to caption boxes too, so an over-stuffed narration box must
      // trip the word limit just like a speech balloon — even when the panel total
      // stays under `maxWordsPerPanel`.
      m.captionBoxes.forEach((box, boxIndex) => {
        if (box.words > t.maxWordsPerBalloon) {
          violations.push({
            kind: 'caption-words',
            pageNumber,
            panelNumber,
            boxIndex,
            count: box.words,
            threshold: t.maxWordsPerBalloon,
            limitLabel: 'words in one caption box',
            severity: overflowSeverity(box.words, t.maxWordsPerBalloon),
            anchorQuote: box.text,
          });
        }
      });

      // The whole panel carries too much lettering across all its balloons.
      if (m.totalWords > t.maxWordsPerPanel) {
        violations.push({
          kind: 'panel-words',
          pageNumber,
          panelNumber,
          count: m.totalWords,
          threshold: t.maxWordsPerPanel,
          limitLabel: 'words in one panel',
          severity: overflowSeverity(m.totalWords, t.maxWordsPerPanel),
          anchorQuote: firstLetteringText(m),
        });
      }

      // Too many discrete balloons fighting for room in one panel.
      if (m.balloonCount > t.maxBalloonsPerPanel) {
        violations.push({
          kind: 'panel-balloons',
          pageNumber,
          panelNumber,
          count: m.balloonCount,
          threshold: t.maxBalloonsPerPanel,
          limitLabel: 'balloons in one panel',
          severity: overflowSeverity(m.balloonCount, t.maxBalloonsPerPanel),
          anchorQuote: firstLetteringText(m),
        });
      }
    });

    // The page's total lettering load would overwhelm the art.
    if (pageWords > t.maxWordsPerPage) {
      violations.push({
        kind: 'page-words',
        pageNumber,
        count: pageWords,
        threshold: t.maxWordsPerPage,
        limitLabel: 'words on one page',
        severity: overflowSeverity(pageWords, t.maxWordsPerPage),
        anchorQuote: '',
      });
    }
  });
  return violations;
}

// Re-export the severity vocabulary so a consumer can reason about ordering
// without importing the registry.
export { LETTERING_SEVERITIES };
