/**
 * arcPlanner/completenessPass.js — the manuscript-completeness analysis pass
 * (findings + optional edit generation). Built on ./context.js.
 */

import { resolveStageContext, runStagedLLM } from '../../../lib/stageRunner.js';
import { estimateTokens, planManuscriptPass } from '../../../lib/contextBudget.js';
import { getSeries } from '../series.js';
import { STAGE_OUTPUT_MAX } from '../issues.js';
import { getSeriesCanon } from '../seriesCanon.js';
import { ERR_VALIDATION, MANUSCRIPT_STAGES, VERIFY_SEVERITIES, buildArcBaseContext, collectManuscriptSections, makeErr, manuscriptSectionHeader, sectionsCorpus } from './context.js';

// ── Manuscript completeness ("finish the draft") ──────────────────────────
// Unlike verifyArc/verifyVolume (which read synopsis/beats from idea.input /
// idea.output), this pass reads the ACTUAL drafted manuscript (comicScript /
// prose / teleplay) so it can flag what's missing to FINISH a near-complete
// draft: gaps in content, holes in the arc, and under-developed characters.

// Findings carry a `category` on top of the verify shape so the UI can group
// them. Unknown categories collapse to 'other' rather than being dropped.
export const COMPLETENESS_CATEGORIES = new Set([
  'missing-content', 'arc-gap', 'character-gap', 'pacing', 'continuity', 'comic-structure', 'other',
]);

// How a finding's `suggestion` should be read. The narrative categories use it
// as delta advice ("the smallest concrete addition that closes the gap"); the
// comic-structure category instead carries a COMPLETE panel-by-panel rewrite of
// the malformed page in `suggestion` (it's directly substitutable). The strategy
// makes that dual use explicit so the fix prompt and UI don't have to special-case
// the category. Consumed by server/services/pipeline/manuscriptReview.js (it
// imports both from here — single source of truth, no duplicate definition).
export const REPLACEMENT_STRATEGIES = new Set(['delta', 'full-page']);

// Category → default strategy. comic-structure is the only full-page category;
// everything else (including legacy findings with no strategy field) is a delta.
export const replacementStrategyForCategory = (category) =>
  (category === 'comic-structure' ? 'full-page' : 'delta');

// Cap on a finding's `replace` span (the with-edits in-place rewrite). Matches
// the fix path's per-edit replace ceiling so a long page rewrite isn't clipped.
export const COMPLETENESS_REPLACE_MAX = STAGE_OUTPUT_MAX;

export function shapeCompletenessFindings(rawIssues, { withEdits = false } = {}) {
  if (!Array.isArray(rawIssues)) return [];
  const out = [];
  for (const raw of rawIssues) {
    const problem = typeof raw?.problem === 'string' ? raw.problem.trim() : '';
    if (!problem) continue;
    const category = COMPLETENESS_CATEGORIES.has(raw?.category) ? raw.category : 'other';
    const finding = {
      severity: VERIFY_SEVERITIES.has(raw?.severity) ? raw.severity : 'medium',
      category,
      // 'full-page' = suggestion is a complete replacement document (comic-structure);
      // 'delta' = suggestion is advice. Trust the model's value when valid, else derive
      // from category so older/un-annotated runs still classify correctly.
      replacementStrategy: REPLACEMENT_STRATEGIES.has(raw?.replacementStrategy)
        ? raw.replacementStrategy
        : replacementStrategyForCategory(category),
      location: typeof raw?.location === 'string' ? raw.location.trim().slice(0, 200) : '',
      problem: problem.slice(0, 2000),
      // comic-structure suggestions are full page rewrites (~4-6 panels); give them more room.
      suggestion: typeof raw?.suggestion === 'string' ? raw.suggestion.trim().slice(0, 8000) : '',
      // Structured anchor: lets the editor map a finding to its issue section
      // and jump to the verbatim excerpt. Both optional — older runs and
      // un-anchorable findings still render (just without click-to-jump).
      issueNumber: Number.isInteger(raw?.issueNumber) ? raw.issueNumber : null,
      anchorQuote: typeof raw?.anchorQuote === 'string' ? raw.anchorQuote.trim().slice(0, 400) : '',
    };
    // With-edits pass: carry the concrete in-place rewrite so the editor can seed
    // each comment's `fix` from { find: anchorQuote, replace } without a separate
    // "Generate fix" call. Absent/empty `replace` (or no anchor to splice over) →
    // the finding stays advice-only and falls back to manual fix generation.
    if (withEdits) {
      const replace = typeof raw?.replace === 'string' ? raw.replace.trim() : '';
      if (replace) finding.replace = replace.slice(0, COMPLETENESS_REPLACE_MAX);
    }
    out.push(finding);
  }
  return out;
}

export async function buildCompletenessContext(series, manuscript, preloadedWorld) {
  const [base, canon] = await Promise.all([
    buildArcBaseContext(series, preloadedWorld),
    getSeriesCanon(series),
  ]);
  return {
    ...base,
    manuscript,
    existingCharactersJson: JSON.stringify(canon.characters, null, 2),
    existingPlacesJson: JSON.stringify(canon.places, null, 2),
    existingObjectsJson: JSON.stringify(canon.objects, null, 2),
  };
}

export const COMPLETENESS_STAGE = 'pipeline-manuscript-completeness';

// Output room for the findings list; comic-structure suggestions are full page
// rewrites, so reserve generously.
export const COMPLETENESS_OUTPUT_RESERVE_TOKENS = 6_000;

// The with-edits pass returns a full `replace` span per finding on top of the
// advice, so it needs materially more output room or a long edit list truncates.
export const COMPLETENESS_WITH_EDITS_OUTPUT_RESERVE_TOKENS = 12_000;

// Earlier-chapter findings summarized into the rolling digest fed to later
// chunks, and the char cap on that digest (kept small so it fits the margin).
export const COMPLETENESS_PRIOR_DIGEST_MAX = 40;

export const COMPLETENESS_PRIOR_DIGEST_CHARS = 2_000;

// One-line digest of prior-chunk findings so later chunks keep cross-chapter
// continuity in view. Rides INSIDE the manuscript field, so the prompt template
// is unchanged (no migration).
export function priorFindingsDigest(findings) {
  if (!findings.length) return '';
  const lines = findings.slice(0, COMPLETENESS_PRIOR_DIGEST_MAX).map((f) => {
    const where = Number.isInteger(f.issueNumber) ? `Issue ${f.issueNumber}` : (f.location || 'general');
    return `- [${where}] ${f.category}: ${f.problem}`;
  });
  const more = findings.length > COMPLETENESS_PRIOR_DIGEST_MAX
    ? `\n(+${findings.length - COMPLETENESS_PRIOR_DIGEST_MAX} more earlier findings)` : '';
  const body = `${lines.join('\n')}${more}`.slice(0, COMPLETENESS_PRIOR_DIGEST_CHARS);
  return `# Editorial findings already recorded for EARLIER chapters\n`
    + `Do not repeat these. Flag only NEW gaps in the chapters below, plus any cross-chapter `
    + `continuity problems these earlier findings reveal.\n\n${body}\n\n---\n\n`;
}

// First-wins dedupe key across chunks — a finding identical on (issue,
// category, anchor, problem) is recorded once even if two chunks surface it.
export const findingKey = (f) => [
  f.issueNumber ?? '',
  f.category,
  (f.anchorQuote || '').trim().toLowerCase().slice(0, 120),
  (f.problem || '').trim().toLowerCase().slice(0, 120),
].join('|');

/**
 * Editor pass over the drafted manuscript itself: returns categorized
 * suggestions for rounding out and finishing a near-complete draft — missing
 * pages/beats, arc holes, and character-development gaps. Read-only; advisory
 * (no auto-resolve). Complements verifyArc/verifyVolume, which stay at synopsis
 * depth and never see the script.
 *
 * Context-window-aware: when the whole manuscript + canon context fits the
 * target model's window it runs in one call (frontier models hold the entire
 * book); otherwise it chunks by issue, feeds each chunk a digest of prior-chunk
 * findings for continuity, and merges with first-wins dedupe.
 *
 * `options.withEdits` (default false) asks the model to also return a concrete
 * `replace` per finding (an in-place rewrite of `anchorQuote`) so the editor can
 * pre-seed each comment's fix. It widens the output reserve accordingly.
 *
 * `options.onProgress(event)` — optional callback fired around the chunk loop so
 * the SSE runner can stream progress without re-implementing the chunk/merge/
 * digest logic. Events: `{ type:'plan', mode, total }`, `{ type:'chunk:start',
 * done, total }`, `{ type:'chunk:complete', done, total }`. `options.signal` —
 * optional AbortSignal; when aborted between chunks the loop stops and returns
 * the findings gathered so far (marked `canceled: true`).
 */
export async function analyzeManuscriptCompleteness(seriesId, options = {}) {
  const series = await getSeries(seriesId);
  // Manuscript-only: exclude `idea` so an outline/synopsis seed can't pass the
  // guard below and get graded as if it were a drafted manuscript.
  const sections = await collectManuscriptSections(seriesId, { stageOrder: MANUSCRIPT_STAGES });
  if (!sections.length) {
    throw makeErr(
      'No manuscript to analyze — write a comic script, prose, or teleplay on at least one issue first',
      ERR_VALIDATION,
    );
  }

  const withEdits = !!options.withEdits;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const signal = options.signal || null;

  // Base (non-manuscript) context is fixed overhead present in every call.
  const baseCtx = await buildCompletenessContext(series, '', options.preloadedWorld);
  const overheadTokens = estimateTokens(JSON.stringify(baseCtx)) + 2_000; // + template/instructions
  const { contextWindow } = await resolveStageContext(COMPLETENESS_STAGE, {
    providerOverride: options.providerOverride,
    modelOverride: options.modelOverride,
  });
  const plan = planManuscriptPass({
    contextWindow,
    sections: sections.map((s) => ({ ...s, text: `${manuscriptSectionHeader(s)}\n\n${s.content}` })),
    overheadTokens,
    outputReserveTokens: withEdits
      ? COMPLETENESS_WITH_EDITS_OUTPUT_RESERVE_TOKENS
      : COMPLETENESS_OUTPUT_RESERVE_TOKENS,
  });

  const runOne = (manuscript) => runStagedLLM(COMPLETENESS_STAGE, { ...baseCtx, manuscript, withEdits }, {
    providerOverride: options.providerOverride,
    modelOverride: options.modelOverride,
    returnsJson: true,
    source: 'pipeline-manuscript-completeness',
  });

  if (plan.mode === 'whole') {
    onProgress({ type: 'plan', mode: 'whole', total: 1 });
    onProgress({ type: 'chunk:start', done: 0, total: 1 });
    const { content, runId, providerId, model } = await runOne(sectionsCorpus(sections).slice(0, plan.usableChars));
    onProgress({ type: 'chunk:complete', done: 1, total: 1 });
    return { issues: shapeCompletenessFindings(content?.issues, { withEdits }), raw: content, runId, providerId, model, chunked: false, chunkCount: 1 };
  }

  console.log(`📚 completeness: chunked review series=${String(seriesId).slice(0, 12)} chunks=${plan.chunks.length} window=${contextWindow ?? 'floor'}`);
  onProgress({ type: 'plan', mode: 'chunked', total: plan.chunks.length });
  // Accumulate findings into one first-wins map so the per-chunk digest is O(1)
  // to derive (no re-merging every prior chunk).
  const merged = new Map();
  let first = null;
  let done = 0;
  let canceled = false;
  for (const chunk of plan.chunks) {
    if (signal?.aborted) { canceled = true; break; }
    onProgress({ type: 'chunk:start', done, total: plan.chunks.length });
    const digest = priorFindingsDigest([...merged.values()]);
    const corpus = sectionsCorpus(chunk.sections).slice(0, plan.usableChars);
    const result = await runOne(`${digest}${corpus}`);
    if (!first) first = result;
    for (const f of shapeCompletenessFindings(result.content?.issues, { withEdits })) {
      const k = findingKey(f);
      if (!merged.has(k)) merged.set(k, f);
    }
    done += 1;
    onProgress({ type: 'chunk:complete', done, total: plan.chunks.length });
  }
  const issues = [...merged.values()];
  return {
    issues,
    raw: { issues },
    runId: first?.runId,
    providerId: first?.providerId,
    model: first?.model,
    chunked: true,
    chunkCount: plan.chunks.length,
    canceled,
  };
}
