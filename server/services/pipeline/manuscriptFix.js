/**
 * Pipeline — Manuscript Fix generation + accept
 *
 * Turns a "Finish the draft" comment into one or more anchored edits. The LLM
 * returns `{ edits: [{ issueNumber, find, replace }] }` where each `find` is a
 * verbatim excerpt of an issue's drafted stage text and `replace` is that
 * excerpt rewritten to close the gap. The user can edit or skip each suggested
 * replacement before accepting; accept applies the selected edits through the
 * serialized stage-write path (which snapshots the prior text into runHistory).
 *
 * Read this alongside manuscriptReview.js (where the comment + fix persist) and
 * arcPlanner.js (which owns the completeness pass that creates the comments).
 */

import { randomUUID } from 'crypto';
import { runStagedLLM, resolveStageContext } from '../../lib/stageRunner.js';
import { planManuscriptPass, estimateTokens } from '../../lib/contextBudget.js';
import { getSeries, MANUSCRIPT_TYPES } from './series.js';
import { getIssue, updateStageWithLatest, updateStagesWithLatest } from './issues.js';
import { collectManuscriptSections, stageVersionsOf, sectionsCorpus, manuscriptSectionHeader } from './arcPlanner.js';
import { getComment, updateComment } from './manuscriptReview.js';

export const ERR_VALIDATION = 'PIPELINE_MANUSCRIPT_FIX_VALIDATION';
export const ERR_NOT_FOUND = 'PIPELINE_MANUSCRIPT_FIX_NOT_FOUND';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Output before input: the drafted artifact wins over the upstream seed.
// Mirrors arcPlanner's stageTextOf (inlined there to avoid an import cycle).
const stageTextOf = (stage) => (stage?.output?.trim() || stage?.input?.trim() || '');

async function loadStageText(issueId, stageId) {
  const issue = await getIssue(issueId).catch(() => null);
  if (!issue) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
  return stageTextOf(issue.stages?.[stageId]);
}

function sectionLabel(s) {
  return `Issue ${s.number}${s.title ? ` — ${s.title}` : ''}`;
}

// Resolve the manuscript sections a comment may edit. Narrow comments still
// get their one issue, while unanchored or story-level comments get the whole
// drafted manuscript so the model can produce multiple concrete insertions.
async function resolveTargets(seriesId, comment) {
  const sections = await collectManuscriptSections(seriesId);
  if (comment.issueId && comment.stageId) {
    const current = sections.find((s) => s.issueId === comment.issueId && s.stageId === comment.stageId);
    if (current) return [current];
    return [{
      issueId: comment.issueId,
      stageId: comment.stageId,
      number: comment.issueNumber,
      title: '',
      content: await loadStageText(comment.issueId, comment.stageId),
    }];
  }
  if (comment.issueNumber != null) {
    const section = sections.find((s) => s.number === comment.issueNumber);
    if (section) return [section];
    throw makeErr(
      'This comment points to an issue that no longer has drafted manuscript text — regenerate the editorial review',
      ERR_VALIDATION,
    );
  }
  if (sections.length) return sections;
  throw makeErr('No drafted manuscript text is available to edit', ERR_VALIDATION);
}

function normalizeModelEdits(content) {
  if (Array.isArray(content?.edits)) return content.edits;
  if (typeof content?.find === 'string' || typeof content?.replace === 'string') {
    return [{ find: content.find || '', replace: content.replace || '' }];
  }
  return [];
}

// The placeholder strings used as VALUES in the prompt's JSON example
// (pipeline-manuscript-fix.md, "Output contract"). Weaker models sometimes echo
// the example back verbatim instead of filling it in. Those strings are never a
// real manuscript span, so they'd surface as an un-appliable `fuzzy` edit whose
// Accept throws "Anchor text is no longer present". Detect and drop them here so
// the fix collapses to null → the caller's "did not return a usable fix" retry.
//
// Only the `find`/`replace` example values are listed (the only fields the guard
// checks) — not the `note` placeholder. Both the current bracketed wording AND
// the prior prose-style wording are included: an install whose prompt copy hasn't
// migrated to the bracketed shape yet still echoes the old text, so the guard must
// catch both. Keep these byte-identical to whichever example shipped in
// pipeline-manuscript-fix.md (a drift test in manuscriptFix.test.js pins the
// current ones to the live prompt so a future example edit can't silently rot it).
export const PROMPT_EXAMPLE_PLACEHOLDERS = new Set([
  // Current (bracketed) example.
  '<paste the verbatim manuscript span you are replacing>',
  '<that same span, rewritten to close the gap>',
  // Prior prose-style example (pre-bracket installs).
  "a verbatim excerpt copied EXACTLY from that issue's manuscript above — the span you are replacing",
  'that same span rewritten to close the gap',
]);

const isEchoedPlaceholder = (s) => typeof s === 'string' && PROMPT_EXAMPLE_PLACEHOLDERS.has(s.trim());

function resolveEditSection(raw, targets) {
  const issueNumber = Number.isInteger(raw?.issueNumber) ? raw.issueNumber : null;
  if (issueNumber != null) {
    const byNumber = targets.find((s) => s.number === issueNumber);
    if (byNumber) return byNumber;
  }
  if (targets.length === 1) return targets[0];
  const find = typeof raw?.find === 'string' ? raw.find : '';
  if (find) {
    // Whitespace-tolerant (same as accept), so a multi-section / story-level
    // comment whose `find` differs only in spacing still resolves to its section
    // instead of being dropped before normalizeFix's tolerant check.
    const matches = targets.filter((s) => locateFindSpan(s.content || '', find) !== null);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

/**
 * Shape one anchored edit from a `find`/`replace` pair against a resolved
 * manuscript section. Returns null when either side is empty. `fuzzy` is set
 * only when `find` can't be located even tolerating whitespace differences —
 * i.e. when accept would actually fail; a quote that differs only in spacing
 * still applies, so it doesn't warn. Shared by the fix pass (normalizeFix) and
 * the with-edits completeness pass (manuscriptReview.seedReviewFromFindings),
 * so both produce byte-identical edit shapes the accept path can consume.
 */
export function shapeAnchoredEdit(section, { find, replace, note } = {}) {
  if (!section || !find || !replace) return null;
  const edit = {
    issueNumber: section.number,
    issueId: section.issueId,
    stageId: section.stageId,
    title: section.title || '',
    find,
    replace,
  };
  if (typeof note === 'string' && note.trim()) edit.note = note.trim().slice(0, 1000);
  if (!locateFindSpan(section.content || '', find)) edit.fuzzy = true;
  return edit;
}

/**
 * Wrap a list of shaped edits into a `fix` record, rebuilding the single-edit
 * convenience fields (`find`/`replace`/`fuzzy`) the accept path reads. Returns
 * null for an empty list. Shared by normalizeFix, mergeFixes, and the seed path.
 */
export function fixFromEdits(edits) {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const fix = { edits };
  if (edits.length === 1) {
    fix.find = edits[0].find;
    fix.replace = edits[0].replace;
    if (edits[0].fuzzy) fix.fuzzy = true;
  }
  return fix;
}

export function normalizeFix(content, targets) {
  const edits = normalizeModelEdits(content)
    .map((raw) => {
      const find = typeof raw?.find === 'string' ? raw.find : '';
      const replace = typeof raw?.replace === 'string' ? raw.replace : '';
      if (!find || !replace) return null;
      // Drop an edit the model copied straight out of the prompt's JSON example
      // instead of synthesizing — it would only ever be an un-appliable fuzzy edit.
      if (isEchoedPlaceholder(find) || isEchoedPlaceholder(replace)) return null;
      return shapeAnchoredEdit(resolveEditSection(raw, targets), { find, replace, note: raw.note });
    })
    .filter(Boolean);
  return fixFromEdits(edits);
}

function editsFromAcceptRequest({ comment, find, replace, edits }) {
  if (Array.isArray(edits) && edits.length) {
    return edits.map((e) => ({
      issueId: typeof e.issueId === 'string' ? e.issueId : null,
      stageId: typeof e.stageId === 'string' ? e.stageId : null,
      issueNumber: Number.isInteger(e.issueNumber) ? e.issueNumber : null,
      find: typeof e.find === 'string' ? e.find : '',
      replace: typeof e.replace === 'string' ? e.replace : '',
    })).filter((e) => e.find);
  }
  if (find) {
    if (typeof replace !== 'string') {
      throw makeErr('replace is required when find is provided', ERR_VALIDATION);
    }
    return [{
      issueId: comment.issueId,
      stageId: comment.stageId,
      issueNumber: comment.issueNumber,
      find,
      replace,
    }];
  }
  return [];
}

// Locate the `find` span to replace. `indexOf` alone edits the FIRST match,
// which silently corrupts the wrong spot when `find` recurs in the issue. When
// it's ambiguous, disambiguate by the finding's `anchorQuote` — pick the
// occurrence nearest the anchor — so the edit lands where the comment points.
// Returns the start index, or -1 if `find` isn't present at all.
function locateFind(text, find, anchorQuote) {
  const first = text.indexOf(find);
  if (first === -1) return -1;
  if (text.indexOf(find, first + 1) === -1) return first; // unique — no ambiguity
  const anchorIdx = anchorQuote ? text.indexOf(anchorQuote) : -1;
  if (anchorIdx === -1) return first; // can't disambiguate — first match
  let best = first;
  let bestDist = Math.abs(first - anchorIdx);
  for (let i = text.indexOf(find, first + 1); i !== -1; i = text.indexOf(find, i + 1)) {
    const dist = Math.abs(i - anchorIdx);
    if (dist < bestDist) { best = i; bestDist = dist; }
  }
  return best;
}

// LLMs routinely reformat whitespace when "quoting" a passage (an extra blank
// line between a page header and its first panel, collapsed indentation, etc.),
// so an exact `find` often isn't a verbatim substring even when it clearly
// targets a real span. Locate the span tolerating whitespace-only differences:
// try exact first (with nearest-anchor disambiguation), then a regex where every
// run of whitespace in `find` matches any run of whitespace in the text. Returns
// the matched { start, end } in the ORIGINAL text (so the splice covers the real
// span, whose length may differ from `find.length`), or null if not found.
function buildWhitespaceTolerantRegex(find) {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped.replace(/\s+/g, '\\s+'));
}

export function locateFindSpan(text, find, anchorQuote) {
  if (!find) return null;
  const exact = locateFind(text, find, anchorQuote);
  if (exact !== -1) return { start: exact, end: exact + find.length };

  const re = new RegExp(buildWhitespaceTolerantRegex(find).source, 'g');
  const anchorIdx = anchorQuote ? text.indexOf(anchorQuote) : -1;
  let best = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cand = { start: m.index, end: m.index + m[0].length };
    if (!best) best = cand;
    else if (anchorIdx !== -1 && Math.abs(cand.start - anchorIdx) < Math.abs(best.start - anchorIdx)) best = cand;
    if (m.index === re.lastIndex) re.lastIndex += 1; // guard against zero-width matches
  }
  return best;
}

// Shape one manuscript section response from a freshly-written stage.
const sectionFrom = (issue, stageId, stage) => ({
  issueId: issue.id,
  number: issue.number,
  title: issue.title || '',
  stageId,
  content: stageTextOf(stage),
  versions: stageVersionsOf(stage),
});

async function resolveMissingEditTargets(seriesId, comment, edits) {
  const targets = await resolveTargets(seriesId, comment);
  const targetByKey = new Map(targets.map((s) => [`${s.issueId}:${s.stageId}`, s]));
  return edits.map((edit) => {
    const hasExplicitTarget = edit.issueId && edit.stageId;
    const section = hasExplicitTarget ? targetByKey.get(`${edit.issueId}:${edit.stageId}`) : resolveEditSection(edit, targets);
    if (hasExplicitTarget && !section) return { ...edit, issueId: null, stageId: null };
    return section
      ? { ...edit, issueId: section.issueId, stageId: section.stageId, issueNumber: section.number }
      : edit;
  });
}

async function planEditsBySection(edits, comment) {
  const groups = new Map();
  for (const edit of edits) {
    const key = `${edit.issueId}:${edit.stageId}`;
    if (!groups.has(key)) groups.set(key, { issueId: edit.issueId, stageId: edit.stageId, edits: [] });
    groups.get(key).edits.push(edit);
  }

  const planned = [];
  for (const group of groups.values()) {
    const issue = await getIssue(group.issueId).catch(() => null);
    if (!issue) throw makeErr(`Issue not found: ${group.issueId}`, ERR_NOT_FOUND);
    const originalText = stageTextOf(issue.stages?.[group.stageId]);
    const spans = [];
    for (const edit of group.edits) {
      const located = locateFindSpan(originalText, edit.find, comment.anchorQuote);
      if (!located) {
        throw makeErr('Anchor text is no longer present in the manuscript — regenerate the fix', ERR_VALIDATION);
      }
      const span = { start: located.start, end: located.end, replace: edit.replace };
      if (spans.some((other) => span.start < other.end && other.start < span.end)) {
        throw makeErr('Selected edits overlap in the manuscript — regenerate the fix', ERR_VALIDATION);
      }
      spans.push(span);
    }
    let output = originalText;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, span.start) + span.replace + output.slice(span.end);
    }
    planned.push({ ...group, originalText, output });
  }
  return planned;
}

async function applyPlannedEdits(seriesId, planned) {
  const sections = [];
  const updates = planned.map((group) => ({
    issueId: group.issueId,
    stageId: group.stageId,
    computeFn: (cur) => {
      if (stageTextOf(cur) !== group.originalText) {
        throw makeErr('Manuscript changed while applying the fix — regenerate the fix', ERR_VALIDATION);
      }
      return { output: group.output, status: 'edited', lastRunId: `fix-${randomUUID()}` };
    },
  }));
  const updated = await updateStagesWithLatest(seriesId, updates, { snapshotPrior: true });
  for (let i = 0; i < updated.length; i += 1) {
    const group = planned[i];
    const { issue, stage } = updated[i];
    sections.push(sectionFrom(issue, group.stageId, stage));
  }
  return sections;
}

/**
 * Free-text manuscript edit, versioned. Writes `output` to the issue's stage and
 * snapshots the PRIOR text into runHistory (via `snapshotPrior`) so every saved
 * edit is revertible — including the first edit of an imported stage that never
 * had a run id. A fresh `lastRunId` makes the new version itself restorable.
 */
export async function saveManuscriptSection(seriesId, { issueId, stageId, output } = {}) {
  if (!MANUSCRIPT_TYPES.includes(stageId)) {
    throw makeErr(`Not an editable manuscript stage: ${stageId}`, ERR_VALIDATION);
  }
  const { issue, stage } = await updateStageWithLatest(
    issueId,
    stageId,
    () => ({ output, status: 'edited', lastRunId: `edit-${randomUUID()}` }),
    { snapshotPrior: true },
  );
  return { section: sectionFrom(issue, stageId, stage) };
}

// === AI Reformat (repair paste artifacts via the LLM) ===

const MANUSCRIPT_FORMAT_LABEL = { prose: 'Prose', comicScript: 'Comic script', teleplay: 'Teleplay' };

// The "skeleton" a pure reformat leaves identical: letters, digits, and
// apostrophes (curly normalized to straight so a benign smart-quote pass isn't
// flagged), CASE-PRESERVING. No reformat op (reflow, de-hyphenation, drop-cap
// rejoin, quote re-attachment) changes case or touches an apostrophe, so
// comparing this catches a substituted/dropped/inserted word, a case-only
// rewrite ("US" → "us"), AND a mangled contraction ("don't" → "dont").
//
// Deliberately NOT guarded (these would break legitimate reformatting and are
// instead forbidden by the prompt + caught by eye / undone via Revert): a
// hyphen removed mid-word ("X-ray" → "Xray") is indistinguishable from the
// de-hyphenation of a wrap-split word, and a removed inter-word boundary
// ("now here" → "nowhere") is indistinguishable from a drop-cap rejoin
// ("T\nhe" → "The") — both are whitespace/hyphen edits the skeleton ignores by
// design so real reflow passes.
const wordSkeleton = (s) => (typeof s === 'string'
  ? s.replace(/[’ʼ]/g, '\'').replace(/[^\p{L}\p{N}']+/gu, '')
  : '');

// Reject any reformat that altered the actual wording. A pure reformat only
// moves whitespace and quotation-mark/punctuation glyphs (all non-alphanumeric)
// and de-hyphenates across a wrap (the hyphen is non-alphanumeric too) — so the
// letter/digit skeleton is IDENTICAL before and after. We require an exact
// skeleton match: no substitution, no insertion, and no deletion of even a
// short word (e.g. dropping "not" from "do not go" would slip past any
// deletion budget yet invert the meaning). A duplicated word the export left in
// place stays in place — the deterministic Format button handles that dedup;
// the AI pass is held to "change not one letter".
function assertWordsPreserved(before, after) {
  if (wordSkeleton(before) === wordSkeleton(after)) return;
  throw makeErr(
    'AI reformat changed the wording, so it was discarded and the text is unchanged. Try again or use the plain Format button.',
    ERR_VALIDATION,
  );
}

// Strip a stray ``` code fence or echoed ===MANUSCRIPT=== marker the model may
// wrap the output in despite the prompt's contract.
const stripReformatWrapper = (text) => String(text ?? '')
  .replace(/^﻿?\s*```[\w-]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  .replace(/^\s*===MANUSCRIPT===\s*\n?/, '').replace(/\n?\s*===MANUSCRIPT===\s*$/, '')
  .trim();

/**
 * Reformat a block of manuscript text with the LLM — repair paste artifacts
 * (wrapping, split drop-caps, hyphen splits, orphaned/duplicated quotes)
 * WITHOUT changing words. Returns `{ text, runId, changed }`. Throws
 * ERR_VALIDATION when the model altered the wording (integrity guard), so a
 * caller never persists silently-rewritten prose. Shared by the section
 * endpoint and the importer.
 */
export async function reformatManuscriptText(text, { stageId = 'prose', providerOverride, modelOverride } = {}) {
  const body = typeof text === 'string' ? text : '';
  if (!body.trim()) return { text: body, runId: null, changed: false };
  const format = MANUSCRIPT_FORMAT_LABEL[stageId] || MANUSCRIPT_FORMAT_LABEL.prose;
  const r = await runStagedLLM('manuscript-reformat', { format, body }, {
    providerOverride,
    modelOverride,
    returnsJson: false,
    source: 'pipeline-manuscript-reformat',
  });
  const cleaned = stripReformatWrapper(r?.content);
  if (!cleaned) throw makeErr('The model returned no text — try again', ERR_VALIDATION);
  assertWordsPreserved(body, cleaned);
  return { text: cleaned, runId: r?.runId || null, changed: cleaned !== body };
}

/**
 * Compute-only reformat of a stage's worth of text for the editor endpoint —
 * validates the stage and runs `reformatManuscriptText`, returning the cleaned
 * text WITHOUT persisting. The client owns the save (so it can fold in unsaved
 * edits and skip the write if the section changed during the call); the
 * importer calls `reformatManuscriptText` directly.
 */
export async function reformatManuscriptStageText(text, { stageId, providerOverride, modelOverride } = {}) {
  if (!MANUSCRIPT_TYPES.includes(stageId)) {
    throw makeErr(`Not an editable manuscript stage: ${stageId}`, ERR_VALIDATION);
  }
  if (!(typeof text === 'string' && text.trim())) {
    throw makeErr('There is no drafted text to reformat', ERR_VALIDATION);
  }
  return reformatManuscriptText(text, { stageId, providerOverride, modelOverride });
}

/**
 * Generate anchored fix edits for a comment and persist them on the comment
 * (status stays `open` — the user still has to accept). When an edit's `find`
 * can't be located verbatim in the current stage text, that edit is flagged
 * `fuzzy: true` so the client can warn before apply.
 */
const FIX_STAGE = 'pipeline-manuscript-fix';
// Output room for the edits list (each `replace` can be a full page rewrite).
const FIX_OUTPUT_RESERVE_TOKENS = 6_000;

// Merge per-chunk fixes into one, concatenating edits with first-wins dedupe on
// (issue, stage, find, replace), and rebuilding the single-edit convenience
// fields normalizeFix sets so the accept path stays uniform.
function mergeFixes(fixes) {
  const edits = [];
  const seen = new Set();
  for (const fx of fixes) {
    for (const e of (fx?.edits || [])) {
      const k = `${e.issueId}|${e.stageId}|${e.find}|${e.replace}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edits.push(e);
    }
  }
  return fixFromEdits(edits);
}

export async function generateManuscriptFix(seriesId, { commentId, providerOverride, providerDefault, modelOverride } = {}) {
  const series = await getSeries(seriesId);
  const comment = await getComment(seriesId, commentId);
  if (!comment) throw makeErr(`Comment not found: ${commentId}`, ERR_NOT_FOUND);

  const targets = await resolveTargets(seriesId, comment);
  if (targets.every((s) => !s.content)) {
    throw makeErr('There is no drafted text to edit', ERR_VALIDATION);
  }

  const arc = series.arc || {};
  const baseCtx = {
    series: { name: series.name, logline: series.logline, premise: series.premise },
    arc: {
      logline: arc.logline || '',
      themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
    },
    finding: {
      category: comment.category,
      severity: comment.severity,
      problem: comment.problem,
      suggestion: comment.suggestion,
      anchorQuote: comment.anchorQuote,
      // Boolean mirror of `replacementStrategy` for Mustache's section tags (it
      // can't compare strings) so the fix prompt can branch on whether
      // `suggestion` is a full-page rewrite (substitute it directly) or delta
      // advice (synthesize the edit).
      isFullPage: comment.replacementStrategy === 'full-page',
    },
  };
  const buildCtx = (sections) => ({
    ...baseCtx,
    scope: sections.length === 1 ? sectionLabel(sections[0]) : 'Full manuscript',
    sections: sections.map((s) => ({
      issueNumber: s.number,
      title: s.title || '',
      stageId: s.stageId,
      manuscript: s.content || '',
    })),
    manuscript: sectionsCorpus(sections),
  });
  const runChunk = (sections) => runStagedLLM(FIX_STAGE, buildCtx(sections), {
    providerOverride,
    providerDefault,
    modelOverride,
    returnsJson: true,
    source: 'pipeline-manuscript-fix',
  });

  // A whole-manuscript fix (unanchored/structural comment) must place edits
  // across the whole book — so we keep it whole when it fits the model's
  // window, and only chunk by issue (degrading the holistic view) when it
  // can't. Single-issue comments are always one section → always whole.
  const { contextWindow } = await resolveStageContext(FIX_STAGE, { providerOverride, providerDefault, modelOverride });
  const overheadTokens = estimateTokens(JSON.stringify(baseCtx)) + 2_000;
  const plan = planManuscriptPass({
    contextWindow,
    sections: targets.map((s) => ({ ...s, text: `${manuscriptSectionHeader(s)}\n\n${s.content || ''}` })),
    overheadTokens,
    outputReserveTokens: FIX_OUTPUT_RESERVE_TOKENS,
  });

  let fix;
  let runId;
  if (plan.mode === 'whole') {
    const r = await runChunk(targets);
    fix = normalizeFix(r.content, targets);
    runId = r.runId;
  } else {
    console.log(`📚 manuscript-fix: chunked series=${String(seriesId).slice(0, 12)} chunks=${plan.chunks.length} window=${contextWindow ?? 'floor'}`);
    const fixes = [];
    let first = null;
    for (const chunk of plan.chunks) {
      const r = await runChunk(chunk.sections);
      if (!first) first = r;
      const f = normalizeFix(r.content, chunk.sections);
      if (f) fixes.push(f);
    }
    fix = mergeFixes(fixes);
    runId = first?.runId;
  }
  if (!fix) throw makeErr('The model did not return a usable fix — try again', ERR_VALIDATION);

  const updated = await updateComment(seriesId, commentId, { fix });
  return {
    comment: updated,
    fix,
    runId,
    chunked: plan.mode === 'chunked',
    chunkCount: plan.mode === 'whole' ? 1 : plan.chunks.length,
  };
}

/**
 * Apply selected, optionally user-edited fix edits to manuscript stage output
 * and mark the comment accepted. Serialized through `updateStageWithLatest`,
 * which snapshots the prior output into runHistory when a fresh run id is
 * stamped. Returns refreshed manuscript sections + the accepted comment.
 */
export async function acceptManuscriptFix(seriesId, { commentId, find, replace, edits } = {}) {
  const comment = await getComment(seriesId, commentId);
  if (!comment) throw makeErr(`Comment not found: ${commentId}`, ERR_NOT_FOUND);
  const acceptedEdits = await resolveMissingEditTargets(
    seriesId,
    comment,
    editsFromAcceptRequest({ comment, find, replace, edits }),
  );
  if (acceptedEdits.length === 0) {
    throw makeErr('No applicable edits were selected', ERR_VALIDATION);
  }
  if (acceptedEdits.some((e) => !e.issueId || !e.stageId || !e.find)) {
    throw makeErr('One selected edit is not anchored to a manuscript section — regenerate the fix', ERR_VALIDATION);
  }

  const planned = await planEditsBySection(acceptedEdits, comment);
  const sections = await applyPlannedEdits(seriesId, planned);
  const updated = await updateComment(seriesId, commentId, { status: 'accepted' });
  return { comment: updated, section: sections[0] || null, sections };
}
