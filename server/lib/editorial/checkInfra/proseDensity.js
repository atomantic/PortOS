/**
 * Density-scaled prose-tic finding helpers (#1306) (#2842 split of checkInfra.js).
 */

// ---------------------------------------------------------------------------
// Registry entries.
// ---------------------------------------------------------------------------

// Split a UI text field holding a phrase list (comma- or newline-separated) into
// trimmed, non-empty phrases — used by prose.cliches' allow/extra config fields.
export function splitPhraseList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Copy-edit prose-tic checks (#1306). The deterministic word-level scanners live
// in proseTics.js / repetition.js; these helpers turn raw occurrences into the
// density-scaled findings the registry emits. Density matters: one "just" is
// fine, forty is a tic — so each check measures per-1000-word frequency against
// a configurable threshold and only flags when the rate (not the raw count) is
// high. Findings anchor on the FIRST offending occurrence in each section.
// ---------------------------------------------------------------------------

// Word count of a section's prose (for per-1000-word density). Cheap word
// tokenization — apostrophes kept inside words so contractions count once.
export function countWords(text) {
  return (String(text || '').match(/[A-Za-z][A-Za-z']*/g) || []).length;
}

// Map a section to its issue label/number once (used by every prose-tic check).
export function sectionIssue(s) {
  const number = Number.isInteger(s?.number) ? s.number : null;
  return { number, location: number != null ? `Issue ${number}` : 'Manuscript' };
}

// Shared driver for the per-1000-word density checks (filter words, crutch
// words, passive voice). For each section it runs the supplied `scan`, computes
// the per-1000-word rate, and emits one finding per section whose rate is at or
// above the configured `densityPer1000` — anchored to the first occurrence.
// `opts` declares the section scan, a noun for messages, and problem/suggestion
// builders. `scan(text, cfg)` returns `[{ index, anchor }, …]` occurrences.
export function runDensityCheck(ctx, opts) {
  const cfg = ctx.config || {};
  const max = cfg.maxFindings ?? 20;
  const density = cfg.densityPer1000 ?? 0;
  const sections = Array.isArray(ctx.sections) ? ctx.sections : [];
  const findings = [];
  for (const s of sections) {
    if (findings.length >= max) break;
    const text = s?.content || '';
    const words = countWords(text);
    if (words === 0) continue;
    const hits = opts.scan(text, cfg);
    if (!hits.length) continue;
    const rate = Math.round((hits.length / words) * 1000 * 10) / 10;
    if (rate < density) continue;
    const { number, location } = sectionIssue(s);
    findings.push({
      severity: ctx.severityDefault,
      category: 'style',
      location,
      problem: opts.problem(hits.length, rate, hits[0].anchor),
      suggestion: opts.suggestion,
      anchorQuote: hits[0].anchor,
      issueNumber: number,
    });
  }
  return findings;
}

