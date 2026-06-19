// Mirror of server/lib/editorial/letteringDensity.js (#1313) — the comic
// lettering-density accounting (`countWords`, `panelLetteringMetrics`,
// `analyzeComicLettering`, `overflowSeverity`, `sanitizeLetteringThresholds`,
// `DEFAULT_LETTERING_THRESHOLDS`) must match the server side exactly. The server
// editorial check (`comic.lettering-density`) is authoritative and tested in
// server/lib/editorial/letteringDensity.test.js; this copy powers the comic-script
// stage's INLINE per-page warnings so the author sees over-stuffed panels while
// editing — without a round-trip through an editorial-checks run. Port any logic
// change to both sides verbatim; commentary is scoped per side.
//
// A "balloon" is a discrete lettering element: each dialogue entry is one, and
// each caption box is one (the parser folds repeated captions into one
// newline-joined string, so each non-empty line counts). SFX counts toward the
// panel/page WORD load but is not a balloon.

export const DEFAULT_LETTERING_THRESHOLDS = Object.freeze({
  maxWordsPerBalloon: 25,
  maxWordsPerPanel: 50,
  maxBalloonsPerPanel: 3,
  maxWordsPerPage: 150,
});

const LETTERING_SEVERITIES = ['high', 'medium', 'low'];

// Count words in a free-text lettering string (runs of non-whitespace). 0 for
// non-strings.
export function countWords(text) {
  if (typeof text !== 'string') return 0;
  const matched = text.trim().match(/\S+/g);
  return matched ? matched.length : 0;
}

// Severity scaled by how far over the threshold a count runs: ≥2× → high, ≥1.4×
// → medium, else low.
export function overflowSeverity(count, threshold) {
  if (!(threshold > 0)) return 'medium';
  const ratio = count / threshold;
  if (ratio >= 2) return 'high';
  if (ratio >= 1.4) return 'medium';
  return 'low';
}

// Merge a (possibly partial) config over the defaults, guarding each field. A
// non-positive threshold falls back to the default.
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
// (`{ description, caption, dialogue: [{ character, line }], sfx }`).
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

function firstLetteringText(metrics) {
  const balloon = metrics.balloons.find((b) => b.line.trim());
  if (balloon) return balloon.line.trim();
  const box = metrics.captionBoxes.find((b) => b.text);
  return box ? box.text : '';
}

// Analyze the parsed pages of ONE comic script for lettering overflows. Returns
// a flat list of violations: { kind, pageNumber, panelNumber?, balloonIndex?,
// speaker?, count, threshold, limitLabel, severity, anchorQuote }.
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

      // Caption boxes count as balloons, so an over-stuffed caption trips the same
      // per-balloon word ceiling as a speech balloon.
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

export { LETTERING_SEVERITIES };
