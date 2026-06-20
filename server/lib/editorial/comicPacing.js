/**
 * Pure comic-pacing primitives for the comic editorial checks (#1314) —
 * splash-page usage, panel rhythm, and page-turn beat placement. Operates on the
 * ALREADY-PARSED comic pages the runner produces from each issue's stored comic
 * script (`comicScriptParser.parseComicScript().pages`), so this module stays
 * dependency-free (the parser imports out to fileUtils, which the pure editorial
 * registry can't), matching nameSimilarity.js / proseTics.js.
 *
 * A parsed page is `{ rawText, panels: [{ description, caption, dialogue, sfx }] }`.
 * These helpers never read ctx, never throw on a malformed page, and return plain
 * data the registry's `run(ctx)` shapes into findings (with `ctx.severityDefault`).
 */

// A page with exactly one panel is a splash — a single full-page image. Zero
// panels can't happen for a kept page (the parser drops contentless panels and
// filters empty pages), but guard anyway so a hand-built page array is inert.
export const isSplashPage = (page) => Array.isArray(page?.panels) && page.panels.length === 1;

// The recto/verso layout of a comic interior, 1-indexed by page number.
//
// Print convention: page 1 is a RECTO (the right-hand page, paired with the
// inside front cover). From page 2 on, the reader sees two-page SPREADS —
// verso (even, left) + recto (odd, right). A page turn flips the recto and
// reveals the NEXT spread's pages all at once, so a beat on a page is "visible
// early" (pre-turn) once any page of its spread is on-screen. `beginsSpread`
// marks the first page of each spread — the page that only appears after a turn,
// where a reveal stays hidden until the reader commits to it.
export function comicSpreadLayout(pageCount) {
  const n = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : 0;
  const layout = [];
  for (let p = 1; p <= n; p += 1) {
    if (p === 1) {
      layout.push({ pageNumber: 1, side: 'recto', spread: 1, beginsSpread: true });
      continue;
    }
    const side = p % 2 === 0 ? 'verso' : 'recto';
    const spread = Math.floor(p / 2) + 1;
    // A verso (even page) opens each spread after page 1; its recto partner
    // completes the same spread. Page 1's spread is opened by page 1 itself.
    layout.push({ pageNumber: p, side, spread, beginsSpread: side === 'verso' });
  }
  return layout;
}

// A compact, type-guarded one-line digest of a panel's content for the page-turn
// LLM context — its description (truncated), plus a hint of caption/dialogue/SFX
// load so the model can reason about where a beat actually lands on the page.
function panelDigest(panel) {
  if (!panel || typeof panel !== 'object') return '';
  const desc = typeof panel.description === 'string' ? panel.description.trim().replace(/\s+/g, ' ') : '';
  const head = desc ? desc.slice(0, 160) : '(no description)';
  const extras = [];
  const caption = typeof panel.caption === 'string' ? panel.caption.trim() : '';
  if (caption) extras.push('caption');
  const dialogue = Array.isArray(panel.dialogue) ? panel.dialogue : [];
  if (dialogue.length) extras.push(`${dialogue.length} dialogue`);
  const sfx = typeof panel.sfx === 'string' ? panel.sfx.trim() : '';
  if (sfx) extras.push('sfx');
  return extras.length ? `${head} [${extras.join(', ')}]` : head;
}

// Per-page summary used by both the deterministic rhythm analysis and the
// page-turn LLM context: panel count, splash flag, recto/verso side + spread,
// and a short content digest. `pages` is one issue's parsed comic pages.
export function summarizeComicPages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const layout = comicSpreadLayout(list.length);
  return list.map((page, i) => {
    const panels = Array.isArray(page?.panels) ? page.panels : [];
    const pos = layout[i] || { pageNumber: i + 1, side: 'recto', spread: 1, beginsSpread: true };
    return {
      pageNumber: pos.pageNumber,
      panelCount: panels.length,
      isSplash: panels.length === 1,
      side: pos.side,
      spread: pos.spread,
      beginsSpread: pos.beginsSpread,
      panels: panels.map(panelDigest),
    };
  });
}

// Deterministic panel-rhythm + splash analysis over one issue's parsed pages.
// Returns plain signals (no severity / finding text — the registry's run() shapes
// those) so the heuristics stay unit-testable in isolation:
//
//   - splashPages         — page numbers that are full-page splashes.
//   - splashRatio         — splashes / total pages (0 when no pages).
//   - splashOveruse       — true when splashRatio is at/above `splashRatioWarn`
//                           AND there is more than one splash (a lone splash on a
//                           short script isn't overuse).
//   - backToBackSplashes  — runs of >= 2 consecutive splash pages, as
//                           { startPage, endPage, length }.
//   - overcrowded         — pages with more than `maxPanelsPerPage` panels, as
//                           { pageNumber, panelCount }.
//   - monotonyRuns        — runs of >= `monotonyRunLength` consecutive pages that
//                           all carry the SAME (multi-panel) panel count, as
//                           { startPage, endPage, panelCount, length }. Splash
//                           runs are reported separately, so a monotony run needs
//                           panelCount >= 2.
export function analyzePanelRhythm(pages, cfg = {}) {
  const list = Array.isArray(pages) ? pages : [];
  const totalPages = list.length;
  const maxPanelsPerPage = Number.isFinite(cfg.maxPanelsPerPage) ? cfg.maxPanelsPerPage : 9;
  const splashRatioWarn = Number.isFinite(cfg.splashRatioWarn) ? cfg.splashRatioWarn : 0.25;
  const monotonyRunLength = Number.isInteger(cfg.monotonyRunLength) ? cfg.monotonyRunLength : 4;

  const counts = list.map((p) => (Array.isArray(p?.panels) ? p.panels.length : 0));
  const splashPages = [];
  const overcrowded = [];
  counts.forEach((c, i) => {
    const pageNumber = i + 1;
    if (c === 1) splashPages.push(pageNumber);
    if (c > maxPanelsPerPage) overcrowded.push({ pageNumber, panelCount: c });
  });

  const splashRatio = totalPages > 0 ? splashPages.length / totalPages : 0;
  const splashOveruse = splashPages.length > 1 && splashRatio >= splashRatioWarn;

  // Consecutive-splash runs (length >= 2).
  const backToBackSplashes = collectRuns(counts, (c) => c === 1, 2)
    .map((r) => ({ startPage: r.start + 1, endPage: r.end + 1, length: r.length }));

  // Monotony runs: same multi-panel count repeated for >= monotonyRunLength pages.
  // A run of identical splashes is a back-to-back-splash signal, not grid monotony,
  // so monotony is gated to panelCount >= 2.
  const monotonyRuns = [];
  if (monotonyRunLength >= 2) {
    let start = 0;
    for (let i = 1; i <= counts.length; i += 1) {
      if (i < counts.length && counts[i] === counts[start]) continue;
      const length = i - start;
      const panelCount = counts[start];
      if (panelCount >= 2 && length >= monotonyRunLength) {
        monotonyRuns.push({ startPage: start + 1, endPage: i, panelCount, length });
      }
      start = i;
    }
  }

  return { totalPages, splashPages, splashRatio, splashOveruse, backToBackSplashes, overcrowded, monotonyRuns };
}

// Collect runs of >= minLength consecutive entries satisfying `pred`, as
// { start, end, length } (0-indexed, inclusive). Shared by the splash-run scan.
function collectRuns(arr, pred, minLength) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= arr.length; i += 1) {
    const ok = i < arr.length && pred(arr[i]);
    if (ok && start === -1) start = i;
    if (!ok && start !== -1) {
      const length = i - start;
      if (length >= minLength) runs.push({ start, end: i - 1, length });
      start = -1;
    }
  }
  return runs;
}

// Render one issue's page layout into a compact text block the page-turn-beats
// LLM check passes alongside the manuscript/script so the model knows each page's
// recto/verso side, spread, panel breakdown, and which pages are first-seen only
// after a page turn (`beginsSpread`). Pure + deterministic so it's unit-testable
// and its token cost can be counted into the per-chunk overhead. Returns '' for an
// empty page list. `issueNumber` (when an integer) prefixes the block.
export function comicPageTurnSummary(pages, issueNumber = null) {
  const summary = summarizeComicPages(pages);
  if (!summary.length) return '';
  const lines = summary.map((pg) => {
    const turn = pg.beginsSpread ? ', first page after a turn (reveal-safe)' : '';
    const kind = pg.isSplash ? 'splash' : `${pg.panelCount} panels`;
    const panels = pg.panels.length ? `\n    ${pg.panels.map((p, i) => `panel ${i + 1}: ${p}`).join('\n    ')}` : '';
    return `- Page ${pg.pageNumber} (${pg.side}, spread ${pg.spread}${turn}) — ${kind}${panels}`;
  });
  const header = Number.isInteger(issueNumber) ? `Issue ${issueNumber} page layout:` : 'Page layout:';
  return `${header}\n${lines.join('\n')}`;
}

// Render the authored reader-map REVEALS (beats with kind 'reveal') and
// CLIFFHANGERS into a compact text block the page-turn-beats check passes
// alongside the script, so the model reconciles WHICH beats are big reveals that
// need a protected page-turn against what the writer logged. Pure + deterministic
// (mirrors authoredCliffhangerSummary / authoredSetupPayoffSummary in the
// registry). Returns '' when nothing reveal-like is authored.
export function authoredRevealSummary(readerMap) {
  const beats = Array.isArray(readerMap?.beats) ? readerMap.beats : [];
  const cliffs = Array.isArray(readerMap?.cliffhangers) ? readerMap.cliffhangers : [];
  const revealLines = beats
    .filter((b) => b?.kind === 'reveal')
    .map((b) => {
      const note = typeof b?.note === 'string' ? b.note.trim() : '';
      if (!note) return '';
      const pos = Number.isFinite(b?.atArcPosition) ? ` (arc position ${b.atArcPosition})` : '';
      return `- ${note}${pos}`;
    })
    .filter(Boolean);
  const cliffLines = cliffs
    .map((c) => {
      const note = typeof c?.note === 'string' ? c.note.trim() : '';
      if (!note) return '';
      const at = Number.isInteger(c?.atIssueBoundary) ? ` (ending issue ${c.atIssueBoundary})` : '';
      return `- ${note}${at}`;
    })
    .filter(Boolean);
  if (!revealLines.length && !cliffLines.length) return '';
  const parts = [];
  if (revealLines.length) parts.push(`Authored reveals (beats the writer planted):\n${revealLines.join('\n')}`);
  if (cliffLines.length) parts.push(`Authored cliffhangers (issue-boundary tugs):\n${cliffLines.join('\n')}`);
  return parts.join('\n\n');
}
