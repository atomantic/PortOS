/**
 * Comic-specific check helpers (#2842 split of checkInfra.js): lettering density
 * / balloon load accounting (#1313) and the comic↔prose synchronization pairing
 * (#1589).
 */

import { parseComicScript } from './externals.js';

// ---------------------------------------------------------------------------
// Comic lettering density / balloon load (#1313) — deterministic over each
// issue's parsed comic script. The pure word/balloon accounting + threshold
// evaluation lives in ./letteringDensity.js (shared with the client comic-script
// stage's inline warnings); the helpers below turn its violations into
// manuscriptReview findings and pre-flight whether any issue even has a script
// (the check's gate). Scope is 'issue' — findings carry the issue number so the
// editor groups them per issue / per page.
// ---------------------------------------------------------------------------

// The AUTHORITATIVE comic pages for an issue (parser-shaped `[{ panels: [...] }]`).
// A POPULATED per-page split (`stages.comicPages.pages[]`) WINS over the generated
// markdown (`stages.comicScript.output`): once a script is split into pages, edits
// in the Comic tab persist to `comicPages.pages[].rawText/panels` and never flow
// back to `comicScript.output`, so reading the raw script would analyze stale text
// (flag balloons the user already cut, miss ones they added). The client
// comic-script stage reads the same `comicPages.pages[].panels`, so both surfaces
// judge the same edited content.
//
// We key on `pages.length`, not `Array.isArray(pages)`, on purpose: the issue
// sanitizer (`sanitizeVisualStage`) ALWAYS materializes `comicPages.pages` as `[]`,
// so an EMPTY array can't distinguish "never split" from "split then all pages
// deleted" — they are byte-identical on disk. Falling back to the still-present
// generated script when the split is empty means an UNSPLIT or IMPORTED script
// (the common pre-render case, where lettering feedback matters most) is still
// checked; the script remains the issue's authored comic text even if a prior
// split was emptied.
export function comicIssuePages(issue) {
  const pages = issue?.stages?.comicPages?.pages;
  if (Array.isArray(pages) && pages.length) {
    return pages.filter((p) => p && typeof p === 'object');
  }
  const output = typeof issue?.stages?.comicScript?.output === 'string' ? issue.stages.comicScript.output : '';
  return output.trim() ? parseComicScript(output).pages : [];
}

// Issues with analyzable comic content, as { number, pages }, sorted by issue
// number for a stable scan order. Shared by the lettering check's `run` AND the
// staleness runner's fingerprint (which projects the lettering-relevant fields off
// this), so the fingerprinted content is exactly what the check analyzes.
export function comicLetteringIssues(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map((i) => ({
      number: Number.isInteger(i?.number) ? i.number : null,
      pages: comicIssuePages(i),
    }))
    .filter((i) => i.pages.length)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// Cheap presence test for the check's gate — true when any issue has an edited
// comic-pages split OR a non-empty generated script — without paying the parse
// that `comicLetteringIssues` does.
export function hasComicContent(issues) {
  return (Array.isArray(issues) ? issues : []).some((i) => {
    const pages = i?.stages?.comicPages?.pages;
    if (Array.isArray(pages) && pages.length) return true;
    return (typeof i?.stages?.comicScript?.output === 'string' ? i.stages.comicScript.output : '').trim();
  });
}

// One human-readable { problem, suggestion } per violation kind. Kept here (not
// in the pure helper) because the wording is PortOS-facing copy, while the helper
// stays a reusable counting primitive.
function comicLetteringText(v) {
  const who = v.speaker ? ` (${v.speaker})` : '';
  switch (v.kind) {
    case 'balloon-words':
      return {
        problem: `A balloon${who} runs ${v.count} words — over the ~${v.threshold}-word balloon limit. A wall of text crammed into one balloon is the #1 reader gripe in comics.`,
        suggestion: 'Split the balloon in two, move some of it to a caption, or trim the line.',
      };
    case 'caption-words':
      return {
        problem: `A caption box runs ${v.count} words — over the ~${v.threshold}-word limit. A dense narration box buries the art the same way an over-stuffed balloon does.`,
        suggestion: 'Tighten the caption, split it across panels, or cut it down.',
      };
    case 'panel-words':
      return {
        problem: `This panel carries ${v.count} words of lettering — over the ~${v.threshold}-word panel limit, crowding the art.`,
        suggestion: 'Spread the lettering across more panels, or cut copy so the art can breathe.',
      };
    case 'panel-balloons':
      return {
        problem: `This panel has ${v.count} balloons — more than the ~${v.threshold} a single panel reads cleanly with.`,
        suggestion: 'Break the exchange across more panels, or merge balloons from the same speaker.',
      };
    case 'page-words':
    default:
      return {
        problem: `This page carries ${v.count} words of lettering — over the ~${v.threshold}-word page ceiling; the text load would overwhelm the art.`,
        suggestion: 'Move some beats to adjacent pages, or trim copy so the page is not text-heavy.',
      };
  }
}

// Map a lettering violation to a manuscriptReview finding for issue `number`.
// `panelNumber` is absent for page-level findings, so the location degrades to
// "Issue N · Page P" cleanly. Severity rides the violation's overflow-scaled
// value (#1313).
export function comicLetteringFinding(v, number) {
  const { problem, suggestion } = comicLetteringText(v);
  const where = v.panelNumber != null
    ? `Page ${v.pageNumber} · Panel ${v.panelNumber}`
    : `Page ${v.pageNumber}`;
  return {
    severity: v.severity,
    category: 'lettering',
    location: number != null ? `Issue ${number} · ${where}` : where,
    problem,
    suggestion,
    anchorQuote: typeof v.anchorQuote === 'string' ? v.anchorQuote : '',
    issueNumber: number,
  };
}

// Map a balloon-attribution violation to a manuscriptReview finding for issue
// `number`. The wording is PortOS-facing copy (kept here, not in the pure
// helper). Severity rides the violation's risk-scaled value.
export function balloonAttributionFinding(v, number) {
  const where = `Page ${v.pageNumber} · Panel ${v.panelNumber}`;
  const more = v.panelCount > 1 ? ` (and ${v.panelCount - 1} more panel${v.panelCount - 1 === 1 ? '' : 's'} on this page)` : '';
  const target = Array.isArray(v.visibleOthers) && v.visibleOthers.length
    ? ` Another character (${v.visibleOthers.slice(0, 3).join(', ')}) IS shown on the page, so the balloon will likely be tailed to the wrong character.`
    : ' No one is clearly shown speaking it, so the balloon reads as orphaned.';
  return {
    severity: v.severity,
    category: 'continuity',
    location: number != null ? `Issue ${number} · ${where}` : where,
    problem: `${v.speaker} speaks here${more} but is not shown anywhere on the page and the line carries no off-panel/broadcast cue.${target}`,
    suggestion: `Either show ${v.speaker} in a panel on this page, or mark the line as spoken from elsewhere — e.g. ${v.speaker} (OFF-PANEL), (V.O.), (RADIO), or (SPEAKERS)/(PA) for a broadcast — so it renders as a disembodied balloon instead of being attributed to a visible character.`,
    anchorQuote: typeof v.anchorQuote === 'string' ? v.anchorQuote : '',
    issueNumber: number,
  };
}

// ---------------------------------------------------------------------------
// Comic ↔ prose synchronization helpers (#1589). The cross-media check pairs each
// hybrid issue's PROSE (a manuscript section) with its authoritative COMIC content
// and feeds the pair to the model. Pure + deterministic so they're unit-testable
// in isolation (the LLM caller is injected via ctx.callStagedLLM).
// ---------------------------------------------------------------------------

// Per-issue prose ceiling fed to the comic↔prose check (#1589) — so a long
// chapter can't blow a small/local provider's window. Unlike the manuscript-
// corpus checks (which chunk the whole series), this check makes ONE call per
// hybrid issue with that issue's prose + comic, so the bound is per-issue. The
// comic content is the smaller, authoritative anchor; the prose is sliced to this
// ceiling and the prompt warns the model the prose may be truncated. ~24k chars
// ≈ 6k tokens, which fits alongside the comic block on every supported provider.
export const PROSE_SYNC_PROSE_CHAR_CAP = 24_000;

// Extract an issue's PROSE-stage text. Inlines arcPlanner's `stageTextOf` (output
// then input) to keep the registry import-pure (no service import). Reads the
// `prose` stage SPECIFICALLY — NOT the default manuscript precedence (comicScript ▸
// teleplay ▸ prose), which for a hybrid comic+prose issue would return the comic
// script, not the prose (the bug this check exists to avoid). Returns '' when the
// issue has no prose-stage text.
function proseStageText(issue) {
  const stage = issue?.stages?.prose;
  const output = typeof stage?.output === 'string' ? stage.output.trim() : '';
  if (output) return output;
  return typeof stage?.input === 'string' ? stage.input.trim() : '';
}

// Per-issue PROSE-stage content, as `{ number, prose }`, sorted by issue number.
// The single source of truth for "the prose half" of the comic↔prose-sync check —
// read by BOTH the check's `run` AND the runner's `prose` staleness resolver
// (mirrors `comicLetteringIssues` for the comic half), so the fingerprinted text is
// exactly what the check compares. Only issues with prose-stage text contribute.
export function proseStageIssues(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map((i) => ({ number: Number.isInteger(i?.number) ? i.number : null, prose: proseStageText(i) }))
    .filter((i) => i.prose)
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// Render an issue's parsed comic pages into a compact, model-readable block —
// page/panel headers plus each panel's visual DESCRIPTION (what the panel SHOWS),
// DIALOGUE (`speaker: line`), CAPTION, and SFX — so the model can compare what the
// comic shows and says against the prose. Mirrors the field set in
// `projectComicPacingContent` (the `comicScript.pacing` source this check
// fingerprints), so the rendered content matches what staleness tracks. Returns ''
// when no panel carries any content.
export function renderComicForProseSync(pages) {
  const lines = [];
  (Array.isArray(pages) ? pages : []).forEach((p, pageIdx) => {
    const panels = Array.isArray(p?.panels) ? p.panels : [];
    panels.forEach((panel, panelIdx) => {
      const block = [];
      const desc = typeof panel?.description === 'string' ? panel.description.trim() : '';
      if (desc) block.push(`  Shows: ${desc}`);
      for (const d of (Array.isArray(panel?.dialogue) ? panel.dialogue : [])) {
        // The comic-script parser keys the speaker as `character` ({ character, line }),
        // the same field balloonAttribution/letteringDensity read — NOT `speaker`.
        // Tolerate a `speaker` alias for robustness, but `character` is the real shape.
        const rawSpeaker = typeof d?.character === 'string' ? d.character : (typeof d?.speaker === 'string' ? d.speaker : '');
        const speaker = rawSpeaker.trim();
        const line = typeof d?.line === 'string' ? d.line.trim() : '';
        if (line) block.push(`  ${speaker ? `${speaker}: ` : ''}${line}`);
      }
      const caption = typeof panel?.caption === 'string' ? panel.caption.trim() : '';
      if (caption) block.push(`  Caption: ${caption}`);
      const sfx = typeof panel?.sfx === 'string' ? panel.sfx.trim() : '';
      if (sfx) block.push(`  SFX: ${sfx}`);
      // Skip an entirely empty panel — no content to cross-check against prose.
      if (block.length) {
        lines.push(`Page ${pageIdx + 1} · Panel ${panelIdx + 1}`, ...block);
      }
    });
  });
  return lines.join('\n');
}

// The issues that have BOTH drafted PROSE-stage text AND comic content — the
// comparable set for the comic↔prose sync check. Returns `[{ number, prose, comic }]`
// sorted by issue number (`comicLetteringIssues` already sorts), prose sliced to
// PROSE_SYNC_PROSE_CHAR_CAP. An issue with comic but no prose (or prose but no
// comic) has nothing to cross-check and is skipped. Pure: reads ctx.issues only —
// both halves come off the already-loaded issue records (the prose STAGE, not the
// comicScript-precedence manuscript section).
export function proseSyncPairs(ctx) {
  const proseByIssue = new Map();
  for (const { number, prose } of proseStageIssues(ctx?.issues)) {
    if (Number.isInteger(number)) proseByIssue.set(number, prose);
  }
  const pairs = [];
  for (const { number, pages } of comicLetteringIssues(ctx?.issues)) {
    if (!Number.isInteger(number)) continue;
    const prose = proseByIssue.get(number);
    if (!prose) continue;
    const comic = renderComicForProseSync(pages);
    if (!comic.trim()) continue;
    pairs.push({ number, prose: prose.slice(0, PROSE_SYNC_PROSE_CHAR_CAP), comic });
  }
  return pairs;
}
